import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hasJpegMetadata, type Meal } from "shared";
import type { Db } from "../src/db/index.js";
import { foodItems, users } from "../src/db/schema.js";
import { decryptBackup, encryptBackup, mediaArchiveName } from "../src/lib/backup-file.js";
import { directoryStore, mealPhotoKey, userMediaPrefix } from "../src/lib/media.js";
import { encryptedMediaArchive } from "../src/services/backup.service.js";
import { checkMediaArchive } from "../src/services/restore-check.service.js";
import { auth, createUser, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * Meal photos (Phase 14, D191): the first images this app stores, where they
 * live, who can see them, and that they leave with the meal, the account, the
 * export and both backups.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(here, "fixtures", name)).toString("base64");

const mediaDir = mkdtempSync(path.join(tmpdir(), "vikt-meal-photos-"));
const media = directoryStore(mediaDir);
afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const ctx = useTestApp({}, { media });

async function meal(app: FastifyInstance, db: Db, user: TestUser): Promise<Meal> {
  const [food] = await db
    .insert(foodItems)
    .values({ source: "manual", name: "Havregryn", kcalPer100: "370", visibility: "shared" })
    .returning({ id: foodItems.id });
  const response = await app.inject({
    method: "POST",
    url: "/api/meals",
    headers: auth(user),
    payload: {
      clientUuid: randomUUID(),
      name: "Gröt",
      items: [{ foodItemId: food!.id, nameSnapshot: "Havregryn", amount: 1, unit: "dl", grams: 35 }],
    },
  });
  return response.json<Meal>();
}

const upload = (app: FastifyInstance, user: TestUser, mealId: string, name: string) =>
  app.inject({
    method: "PUT",
    url: `/api/meals/${mealId}/photo`,
    headers: auth(user),
    payload: { image: fixture(name) },
  });

const storedFile = (key: string) => path.join(mediaDir, ...key.split("/"));

describe("the directory store", () => {
  it("keeps a key inside the user's folder, and refuses anything else", async () => {
    const userId = randomUUID();
    const key = mealPhotoKey(userId, randomUUID());
    await media.put(key, Buffer.from([0xff, 0xd8, 1, 2]));
    expect(await media.get(key)).toEqual(Buffer.from([0xff, 0xd8, 1, 2]));
    expect(await media.list(userMediaPrefix(userId))).toEqual([key]);

    for (const bad of ["../etc/passwd", `users/${userId}/../../x.jpg`, `users/${userId}/meals/x.jpg`, "users/x/meals/y.jpg"]) {
      await expect(media.put(bad, Buffer.from("x"))).rejects.toThrow(/not a media key/);
    }
    await expect(media.deletePrefix("users/")).rejects.toThrow(/refusing/);
    await expect(media.deletePrefix("../")).rejects.toThrow(/not a media prefix/);

    expect(await media.deletePrefix(userMediaPrefix(userId))).toBe(1);
    expect(await media.get(key)).toBeNull();
  });
});

describe("a meal's photo", () => {
  it("is stored without its metadata, and served only to its owner", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const made = await meal(app, db, owner);

    const response = await upload(app, owner, made.id, "meal-exif.jpg");
    expect(response.statusCode).toBe(200);
    const withPhoto = response.json<Meal>();
    expect(withPhoto.photoUrl).toMatch(new RegExp(`^/api/meals/${made.id}/photo\\?v=\\d+$`));

    const [key] = await media.list(userMediaPrefix(owner.userId));
    const stored = readFileSync(storedFile(key!));
    expect(hasJpegMetadata(new Uint8Array(stored))).toBe(false);
    expect(stored.includes(Buffer.from("VIKT-TEST-PHONE"))).toBe(false);
    expect(stored.includes(Buffer.from("VIKT-TEST-COMMENT"))).toBe(false);
    expect(readFileSync(path.join(here, "fixtures", "meal-exif.jpg")).includes(Buffer.from("VIKT-TEST-PHONE"))).toBe(true);

    const served = await app.inject({ method: "GET", url: withPhoto.photoUrl!, headers: auth(owner) });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/jpeg");
    expect(served.headers["cache-control"]).toContain("private");
    expect(served.rawPayload.equals(stored)).toBe(true);

    for (const [method, payload] of [["GET", undefined], ["PUT", { image: fixture("meal-exif.jpg") }], ["DELETE", undefined]] as const) {
      const theirs = await app.inject({
        method,
        url: `/api/meals/${made.id}/photo`,
        headers: auth(stranger),
        ...(payload ? { payload } : {}),
      });
      expect(theirs.statusCode, method).toBe(404);
    }
    const anonymous = await app.inject({ method: "GET", url: `/api/meals/${made.id}/photo` });
    expect(anonymous.statusCode).toBe(401);
  });

  it("refuses a picture too large or tagged as turned, and anything that is not a JPEG", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const made = await meal(app, db, owner);

    expect((await upload(app, owner, made.id, "meal-huge.jpg")).json()).toMatchObject({ error: "photo_too_large" });
    expect((await upload(app, owner, made.id, "meal-rotated.jpg")).json()).toMatchObject({ error: "photo_not_upright" });
    const notJpeg = await app.inject({
      method: "PUT",
      url: `/api/meals/${made.id}/photo`,
      headers: auth(owner),
      payload: { image: Buffer.from("not a photograph at all, just words").toString("base64") },
    });
    expect(notJpeg.json()).toMatchObject({ error: "not_a_photo" });
    expect(await media.list(userMediaPrefix(owner.userId))).toEqual([]);
  });

  it("is replaced under a new key and the old one removed, and removed on its own", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const made = await meal(app, db, owner);

    await upload(app, owner, made.id, "meal-exif.jpg");
    const [first] = await media.list(userMediaPrefix(owner.userId));
    await upload(app, owner, made.id, "meal-exif.jpg");
    const after = await media.list(userMediaPrefix(owner.userId));
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(first);

    const removed = await app.inject({ method: "DELETE", url: `/api/meals/${made.id}/photo`, headers: auth(owner) });
    expect(removed.json<Meal>().photoUrl).toBeNull();
    expect(await media.list(userMediaPrefix(owner.userId))).toEqual([]);
  });

  it("goes with the meal", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const made = await meal(app, db, owner);
    await upload(app, owner, made.id, "meal-exif.jpg");
    const [key] = await media.list(userMediaPrefix(owner.userId));

    await app.inject({ method: "DELETE", url: `/api/meals/${made.id}`, headers: auth(owner) });
    expect(existsSync(storedFile(key!))).toBe(false);
  });

  it("goes with the account", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const made = await meal(app, db, owner);
    await upload(app, owner, made.id, "meal-exif.jpg");

    const preview = await app.inject({ method: "GET", url: "/api/me/deletion", headers: auth(owner) });
    expect(preview.json().photos).toBe(1);

    const gone = await app.inject({
      method: "POST",
      url: "/api/me/delete",
      headers: auth(owner),
      payload: { password: owner.password },
    });
    expect(gone.statusCode).toBe(200);
    expect(await media.list(userMediaPrefix(owner.userId))).toEqual([]);
    expect(existsSync(path.join(mediaDir, "users", owner.userId))).toBe(false);
  });

  it("goes with an account an admin removes", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.userId));
    const owner = await createUser(app, db);
    const made = await meal(app, db, owner);
    await upload(app, owner, made.id, "meal-exif.jpg");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${owner.userId}`,
      headers: auth(admin),
    });
    expect(removed.statusCode).toBe(200);
    expect(await media.list(userMediaPrefix(owner.userId))).toEqual([]);
  });

  it("travels in the export, as a zip beside the data files", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const made = await meal(app, db, owner);
    await upload(app, owner, made.id, "meal-exif.jpg");
    const [key] = await media.list(userMediaPrefix(owner.userId));

    const response = await app.inject({ method: "GET", url: "/api/export/zip", headers: auth(owner) });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(response.rawPayload));
    const names = Object.keys(entries);
    expect(names.some((name) => /^vikt-\d{4}-\d{2}-\d{2}\.json$/.test(name))).toBe(true);
    expect(names).toContain("csv/meals.csv");
    expect(names).toContain(`media/${key}`);
    const json = JSON.parse(Buffer.from(entries[names.find((name) => name.endsWith(".json"))!]!).toString());
    expect(json.tables.meals[0].photo_key).toBe(key);
  });
});

describe("photos in the backups (D191)", () => {
  const SECRET = "t".repeat(64);

  it("archives every photo beside the dump, encrypted like it", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const made = await meal(app, db, owner);
    await upload(app, owner, made.id, "meal-exif.jpg");
    const [key] = await media.list(userMediaPrefix(owner.userId));

    const archive = await encryptedMediaArchive(media, { SECRET_KEY: SECRET });
    expect(archive.files).toBeGreaterThanOrEqual(1);
    const plain = decryptBackup(archive.body, SECRET);
    expect(plain.ok).toBe(true);
    const entries = unzipSync(new Uint8Array((plain as { archive: Buffer }).archive));
    expect(Buffer.from(entries[key!]!).equals(readFileSync(storedFile(key!)))).toBe(true);
  });

  it("is checked by the restore check: every photo named, present and a photograph", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vikt-restore-media-"));
    try {
      const dump = path.join(dir, "vikt-20260926T120000Z.dump.enc");
      const key = mealPhotoKey(randomUUID(), randomUUID());
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      writeFileSync(path.join(dir, mediaArchiveName("vikt-20260926T120000Z.dump.enc")), encryptBackup(Buffer.from(zipSync({ [key]: jpeg })), SECRET));

      expect(await checkMediaArchive(dump, SECRET, [key])).toEqual({ ok: true, files: 1 });
      expect(await checkMediaArchive(dump, SECRET, [key, mealPhotoKey(randomUUID(), randomUUID())])).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/lacks 1 of the 2/),
      });
      expect(await checkMediaArchive(dump, "u".repeat(64), [key])).toMatchObject({ ok: false });

      const older = path.join(dir, "vikt-20250101T000000Z.dump.enc");
      expect(await checkMediaArchive(older, SECRET, [])).toEqual({ ok: true, files: null });
      expect(await checkMediaArchive(older, SECRET, [key])).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/no photo archive/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
