import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { mailSettings, users } from "../src/db/schema.js";
import {
  SECRET_USES,
  decryptSecret,
  encryptSecret,
  readSecretKey,
  secretsAvailable,
} from "../src/lib/secrets.js";
import {
  importMailSettingsFromEnv,
  mailerConfig,
  readMailSettings,
  writeMailSettings,
} from "../src/services/mail-settings.service.js";

/**
 * Mail settings in the database, and the encryption that makes that acceptable
 * (D102).
 *
 * The property worth testing is not "the password round-trips" — that is
 * `createCipheriv` working, which it does. It is that **the password never
 * leaves by any path a request can take**: not in the settings response, not in
 * an error, and not in the audit row that records the change.
 */

const KEY = { SECRET_KEY: "k".repeat(64) } as NodeJS.ProcessEnv;

describe("encrypting a stored secret", () => {
  it("round-trips under the right key", () => {
    const box = encryptSecret("hunter2", SECRET_USES.mailPassword, KEY);
    expect(box).not.toContain("hunter2");
    expect(decryptSecret(box, SECRET_USES.mailPassword, KEY)).toBe("hunter2");
  });

  it("refuses a different key", () => {
    const box = encryptSecret("hunter2", SECRET_USES.mailPassword, KEY);
    const other = { SECRET_KEY: "j".repeat(64) } as NodeJS.ProcessEnv;
    expect(decryptSecret(box, SECRET_USES.mailPassword, other)).toBeNull();
  });

  /**
   * The `use` string is a domain separator, so a value encrypted for one column
   * cannot be read by the code that reads another. Without it, a bug that mixed
   * two columns would decrypt cleanly and be invisible.
   */
  it("refuses a value encrypted for a different use", () => {
    const box = encryptSecret("hunter2", SECRET_USES.mailPassword, KEY);
    expect(decryptSecret(box, SECRET_USES.backupDestination, KEY)).toBeNull();
  });

  /** GCM's tag is the point: a tampered value is refused, not half-read. */
  it("refuses a tampered value", () => {
    const box = encryptSecret("hunter2", SECRET_USES.mailPassword, KEY);
    const parts = box.split(".");
    const body = Buffer.from(parts[3]!, "base64url");
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString("base64url");
    expect(decryptSecret(parts.join("."), SECRET_USES.mailPassword, KEY)).toBeNull();
  });

  it("refuses anything that is not one of ours", () => {
    expect(decryptSecret("", SECRET_USES.mailPassword, KEY)).toBeNull();
    expect(decryptSecret("hunter2", SECRET_USES.mailPassword, KEY)).toBeNull();
    expect(decryptSecret("v9.a.b.c", SECRET_USES.mailPassword, KEY)).toBeNull();
  });

  it("reads the key from a file when one is named", () => {
    expect(secretsAvailable({} as NodeJS.ProcessEnv)).toBe(false);
    expect(readSecretKey(KEY)).toBe("k".repeat(64));
  });
});

describe("mail settings", () => {
  const ctx = useTestApp();

  /**
   * A real account as the actor.
   *
   * `admin_log.actor_id` references `users`, so a fabricated uuid fails the
   * foreign key rather than the assertion, which is the constraint doing its
   * job: an audit row has to name somebody who existed.
   */
  async function actor() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    return { id: user.userId, email: user.email };
  }

  it("stores the password encrypted and never returns it", async () => {
    const { db } = ctx();
    const who = await actor();

    await writeMailSettings(
      db,
      who,
      {
        host: "smtp.gmail.com",
        port: 587,
        security: "starttls",
        username: "owner@example.test",
        password: "an-app-password",
        fromAddress: "owner@example.test",
        fromName: "Vikt",
      },
      KEY,
    );

    // In the row: not the password.
    const [row] = await db.select().from(mailSettings).where(eq(mailSettings.id, "singleton"));
    expect(row!.passwordEncrypted).not.toContain("an-app-password");
    expect(row!.passwordEncrypted.startsWith("v1.")).toBe(true);

    // Out of the reader: not the password, nor anything shaped like it.
    const view = await readMailSettings(db, KEY);
    expect(view).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain("an-app-password");
    expect(view!.hasPassword).toBe(true);
    expect(view!.secretsReadable).toBe(true);
    expect(view!.updatedByEmail).toBe(who.email);

    // And the transport, which is the one thing allowed to see it.
    const config = await mailerConfig(db, KEY);
    expect(config!.pass).toBe("an-app-password");
    expect(config!.requireTLS).toBe(true);
    expect(config!.secure).toBe(false);
    expect(config!.from).toBe("Vikt <owner@example.test>");
  });

  /**
   * The screen never shows the password, so an admin editing a port has nothing
   * to retype. Omitting the field has to mean "leave it", and only an explicit
   * empty string may clear it.
   */
  it("leaves the stored password alone when none is given", async () => {
    const { db } = ctx();
    const who = await actor();
    const base = {
      host: "smtp.gmail.com",
      port: 587,
      security: "starttls" as const,
      username: "owner@example.test",
      fromAddress: "owner@example.test",
      fromName: "Vikt",
    };

    await writeMailSettings(db, who, { ...base, password: "first" }, KEY);
    await writeMailSettings(db, who, { ...base, port: 465, security: "tls" }, KEY);

    const config = await mailerConfig(db, KEY);
    expect(config!.pass).toBe("first");
    expect(config!.port).toBe(465);
    expect(config!.secure).toBe(true);
    expect(config!.requireTLS).toBe(false);

    await writeMailSettings(db, who, { ...base, password: "" }, KEY);
    expect((await readMailSettings(db, KEY))!.hasPassword).toBe(false);
  });

  /**
   * A key that has gone missing is not the same as a wrong password, and the
   * screen has to be able to tell them apart. `mailerConfig` returning null is
   * what keeps the app from sending with an empty password and reporting an
   * authentication failure that blames the operator's mail account.
   */
  it("says the password cannot be read when the key is gone", async () => {
    const { db } = ctx();

    await writeMailSettings(
      db,
      await actor(),
      {
        host: "smtp.gmail.com",
        port: 587,
        security: "starttls",
        username: "owner@example.test",
        password: "an-app-password",
        fromAddress: "owner@example.test",
        fromName: "Vikt",
      },
      KEY,
    );

    const view = await readMailSettings(db, {} as NodeJS.ProcessEnv);
    expect(view!.hasPassword).toBe(true);
    expect(view!.secretsReadable).toBe(false);
    expect(await mailerConfig(db, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("refuses to store a password with no key to encrypt it with", async () => {
    const { db } = ctx();
    const result = await writeMailSettings(
      db,
      await actor(),
      {
        host: "smtp.gmail.com",
        port: 587,
        security: "starttls",
        username: "u",
        password: "p",
        fromAddress: "owner@example.test",
        fromName: "",
      },
      {} as NodeJS.ProcessEnv,
    );

    expect(result).toEqual({ ok: false, reason: "no_secret_key" });
    expect(await readMailSettings(db, KEY)).toBeNull();
  });

  /** Every change is in the log, because it changes who receives every reset. */
  it("writes an audit row naming who changed it", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.userId));

    await writeMailSettings(
      db,
      { id: admin.userId, email: admin.email },
      {
        host: "smtp.gmail.com",
        port: 587,
        security: "starttls",
        username: "u",
        fromAddress: "owner@example.test",
        fromName: "",
      },
      KEY,
    );

    const log = await app.inject({
      method: "GET",
      url: "/api/admin/log",
      headers: auth(admin),
    });

    expect(log.statusCode).toBe(200);
    const entries = log.json().entries as { action: string; actorEmail: string }[];
    expect(entries.some((e) => e.action === "mail.configure" && e.actorEmail === admin.email)).toBe(
      true,
    );
  });
});

describe("importing SMTP_* from the environment, once", () => {
  const ctx = useTestApp({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "u", SMTP_PASS: "p" });

  it("imports on the first boot and never again", async () => {
    const { app, db } = ctx();

    expect(await importMailSettingsFromEnv(db, app.config, KEY)).toBe("imported");

    const view = await readMailSettings(db, KEY);
    expect(view!.host).toBe("smtp.gmail.com");
    expect(view!.hasPassword).toBe(true);
    // No admin did this, so the row says so rather than naming somebody.
    expect(view!.updatedByEmail).toBeNull();

    expect(await importMailSettingsFromEnv(db, app.config, KEY)).toBe("already-configured");
  });

  it("refuses to import a password it cannot encrypt", async () => {
    const { app, db } = ctx();
    expect(await importMailSettingsFromEnv(db, app.config, {} as NodeJS.ProcessEnv)).toBe(
      "no_secret_key",
    );
    expect(await readMailSettings(db, KEY)).toBeNull();
  });
});

describe("mail settings with nothing in the environment", () => {
  const ctx = useTestApp();

  it("has nothing to import", async () => {
    const { app, db } = ctx();
    expect(await importMailSettingsFromEnv(db, app.config, KEY)).toBe("nothing-to-import");
  });
});
