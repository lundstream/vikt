import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertDateSource, DEVICE_DATE_SLACK_DAYS } from "../src/lib/date-source.js";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * `localDate` has always held two different facts (D61): the client's own day
 * boundary, and a day a person deliberately picked. The queue never rewrote
 * either at send time; what was missing was any way to tell them apart.
 *
 * The server stores neither, and still does not compute a day — §3's rule that
 * the client owns the boundary is unchanged. What it does now is notice when
 * the pair is impossible.
 */

describe("assertDateSource", () => {
  const server = "2026-06-15";

  it("checks nothing when the client did not say", () => {
    // Older clients and scripts omit it. Refusing them would break the contract
    // to enforce a property they cannot state.
    expect(() => assertDateSource("2020-01-01", undefined, server)).not.toThrow();
    expect(() => assertDateSource("2099-01-01", undefined, server)).not.toThrow();
  });

  it("accepts a device date one day either side, which covers every timezone", () => {
    expect(() => assertDateSource("2026-06-14", "device", server)).not.toThrow();
    expect(() => assertDateSource("2026-06-15", "device", server)).not.toThrow();
    expect(() => assertDateSource("2026-06-16", "device", server)).not.toThrow();
    expect(DEVICE_DATE_SLACK_DAYS).toBe(1);
  });

  it("refuses a device date that can only be a broken clock", () => {
    expect(() => assertDateSource("2026-06-13", "device", server)).toThrow();
    expect(() => assertDateSource("2026-06-17", "device", server)).toThrow();
    expect(() => assertDateSource("2019-06-15", "device", server)).toThrow();
  });

  it("accepts any past day as chosen, because backfilling is the point", () => {
    expect(() => assertDateSource("2020-01-01", "chosen", server)).not.toThrow();
    expect(() => assertDateSource("2026-06-14", "chosen", server)).not.toThrow();
  });

  it("accepts a chosen date one day ahead, for a client in UTC+14", () => {
    expect(() => assertDateSource("2026-06-16", "chosen", server)).not.toThrow();
  });

  it("refuses a chosen date in the future, since it has not happened", () => {
    expect(() => assertDateSource("2026-06-17", "chosen", server)).toThrow();
    expect(() => assertDateSource("2027-01-01", "chosen", server)).toThrow();
  });
});

describe("the write endpoints", () => {
  it("accepts a backfilled weight marked as chosen", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(-30),
        weightKg: 91.4,
        dateSource: "chosen",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().localDate).toBe(localDate(-30));
  });

  /**
   * The case this exists for. A backfill queued offline and synced days later
   * keeps the day it was filed under, and now says why that day is legitimate
   * rather than looking like a device thirty days behind.
   */
  it("refuses the same date presented as the device's own day", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(-30),
        weightKg: 91.4,
        dateSource: "device",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("device_clock_off");
  });

  it("refuses a chosen date in the future on the food endpoint", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/food-entry",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(30),
        freetext: "Nästa månad",
        grams: 100,
        kcal: 200,
        dateSource: "chosen",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("date_in_future");
  });

  it("accepts a backfilled manual intake", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(-3),
        kcal: 1900,
        dateSource: "chosen",
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it("leaves writes without the field alone", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(-200),
        weightKg: 95,
      },
    });

    expect(response.statusCode).toBe(200);
  });
});
