import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { profiles, weeklyReviews } from "../src/db/schema.js";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import {
  REVIEW_MIN_LOGGED_DAYS,
  REVIEW_MINUTE,
  runWeeklyReviews,
  weekStartOf,
} from "../src/services/review.service.js";

/**
 * The Sunday job (D141).
 *
 * Three rules carry it and each one is a way it could be quietly wrong: the
 * wrong Sunday for somebody in another timezone, a second review for a week
 * that already has one, and a summary of a week nobody logged — which would be
 * a paragraph about absence, which is the failure state §3 does not permit
 * arriving by the back door.
 *
 * Every instant is supplied. Nothing here reads a clock.
 */

/** A model that answers with a fixed summary and counts how often it was asked. */
function stubLlm() {
  let calls = 0;
  const reply: ChatResult = {
    ok: true,
    content: "Fyra vägningar den här veckan. Trendvikten ligger på 84,2 kg.",
    model: "qwen3.6:27b",
    ms: 1500,
  };

  const client: LlmClient = {
    enabled: true,
    chat: async () => {
      calls += 1;
      return reply;
    },
    chatStream: async (_options, onDelta) => {
      calls += 1;
      onDelta(reply.ok ? reply.content : "");
      return reply;
    },
    reachable: async () => true,
  };

  return { client, calls: () => calls };
}

describe("which week it is", () => {
  /** Monday starts the week here, as in Sweden. */
  it("runs from the Monday of the week the Sunday closes", () => {
    // 2026-09-13 is a Sunday; its week began on Monday the 7th.
    expect(weekStartOf("2026-09-13")).toBe("2026-09-07");
    expect(weekStartOf("2026-09-07")).toBe("2026-09-07");
    expect(weekStartOf("2026-09-12")).toBe("2026-09-07");
  });
});

describe("the Sunday sweep", () => {
  const stub = stubLlm();
  const ctx = useTestApp({}, { llm: stub.client });

  /** An account in a named timezone, with weights on `days` of the week. */
  async function accountLogging(timezone: string, days: string[]) {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(profiles).set({ timezone }).where(eq(profiles.userId, user.userId));

    for (const day of days) {
      await app.inject({
        method: "POST",
        url: "/api/weight",
        headers: auth(user),
        payload: {
          clientUuid: crypto.randomUUID(),
          localDate: day,
          weightKg: 84.2,
          loggedAt: `${day}T07:00:00.000Z`,
        },
      });
    }

    return user;
  }

  const WEEK = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];

  /** Sunday 2026-09-13, 20:00 in Stockholm, which is 18:00 UTC. */
  const SUNDAY_2000_STOCKHOLM = new Date("2026-09-13T18:00:00.000Z");

  it("writes a review for a week with enough logged days", async () => {
    const { db } = ctx();
    const user = await accountLogging("Europe/Stockholm", WEEK);

    const result = await runWeeklyReviews(db, ctx().app.config, stub.client, SUNDAY_2000_STOCKHOLM);
    expect(result.written).toBe(1);

    const [review] = await db
      .select()
      .from(weeklyReviews)
      .where(eq(weeklyReviews.userId, user.userId));

    expect(review?.weekStart).toBe("2026-09-07");
    expect(review?.body).toContain("84,2");
  });

  /**
   * Below four days there is no week to describe. The honest output is nothing
   * at all: no review, and therefore no card, and **no sentence about how
   * little was logged**.
   */
  it("writes nothing for a week with too few logged days", async () => {
    const { db } = ctx();
    const user = await accountLogging("Europe/Stockholm", WEEK.slice(0, REVIEW_MIN_LOGGED_DAYS - 1));

    const result = await runWeeklyReviews(db, ctx().app.config, stub.client, SUNDAY_2000_STOCKHOLM);

    expect(result.quiet).toBe(1);
    expect(result.written).toBe(0);
    expect(
      await db.select().from(weeklyReviews).where(eq(weeklyReviews.userId, user.userId)),
    ).toEqual([]);
  });

  /** A week away is a week away. Nothing is written and nothing is said. */
  it("writes nothing at all for a week nobody logged", async () => {
    const { db } = ctx();
    const user = await accountLogging("Europe/Stockholm", []);

    await runWeeklyReviews(db, ctx().app.config, stub.client, SUNDAY_2000_STOCKHOLM);

    expect(
      await db.select().from(weeklyReviews).where(eq(weeklyReviews.userId, user.userId)),
    ).toEqual([]);
  });

  it("writes one review however many times the sweep runs", async () => {
    const { db } = ctx();
    const user = await accountLogging("Europe/Stockholm", WEEK);

    const first = await runWeeklyReviews(db, ctx().app.config, stub.client, SUNDAY_2000_STOCKHOLM);
    const before = stub.calls();

    // A minute later, still inside the window.
    const second = await runWeeklyReviews(
      db,
      ctx().app.config,
      stub.client,
      new Date("2026-09-13T18:01:00.000Z"),
    );

    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    // And the second sweep did not spend a generation to find that out.
    expect(stub.calls()).toBe(before);

    expect(
      await db.select().from(weeklyReviews).where(eq(weeklyReviews.userId, user.userId)),
    ).toHaveLength(1);
  });

  it("is silent outside the window", async () => {
    const { db } = ctx();
    await accountLogging("Europe/Stockholm", WEEK);

    // Sunday at 18:00 local, two hours early.
    const early = await runWeeklyReviews(
      db,
      ctx().app.config,
      stub.client,
      new Date("2026-09-13T16:00:00.000Z"),
    );
    expect(early.considered).toBe(0);
  });

  it("is silent on a day that is not Sunday", async () => {
    const { db } = ctx();
    await accountLogging("Europe/Stockholm", WEEK);

    // Saturday 2026-09-12 at 20:00 in Stockholm.
    const saturday = await runWeeklyReviews(
      db,
      ctx().app.config,
      stub.client,
      new Date("2026-09-12T18:00:00.000Z"),
    );
    expect(saturday.considered).toBe(0);
  });

  /**
   * The case the whole arrangement turns on: it is **Monday for the server**
   * while the person is still having Sunday evening.
   */
  it("uses the user's Sunday, not the server's", async () => {
    const { db } = ctx();
    // Sunday 2026-09-13 at 20:00 in Los Angeles is Monday 03:00 UTC.
    const now = new Date("2026-09-14T03:00:00.000Z");
    expect(now.getUTCDay(), "the server is having Monday").toBe(1);

    const user = await accountLogging("America/Los_Angeles", WEEK);

    const result = await runWeeklyReviews(db, ctx().app.config, stub.client, now);
    expect(result.written).toBe(1);

    const [review] = await db
      .select()
      .from(weeklyReviews)
      .where(eq(weeklyReviews.userId, user.userId));
    // The week that just ended where the person is, not where the server is.
    expect(review?.weekStart).toBe("2026-09-07");
  });

  /** And that same instant is not anybody's Sunday evening in Stockholm. */
  it("leaves the other timezone alone at that instant", async () => {
    const { db } = ctx();
    await accountLogging("Europe/Stockholm", WEEK);

    const result = await runWeeklyReviews(
      db,
      ctx().app.config,
      stub.client,
      new Date("2026-09-14T03:00:00.000Z"),
    );

    expect(result.considered).toBe(0);
  });

  it("writes at 20:00 and not at midnight", () => {
    expect(REVIEW_MINUTE).toBe(20 * 60);
  });
});

describe("with the LLM layer off", () => {
  const offLlm: LlmClient = {
    enabled: false,
    chat: async () => ({ ok: false, reason: "disabled" }),
    chatStream: async () => ({ ok: false, reason: "disabled" }),
    reachable: async () => false,
  };

  const ctx = useTestApp({}, { llm: offLlm });

  it("sweeps nothing", async () => {
    const { app, db } = ctx();
    await createUser(app, db);

    const result = await runWeeklyReviews(
      db,
      app.config,
      offLlm,
      new Date("2026-09-13T18:00:00.000Z"),
    );

    expect(result).toEqual({ considered: 0, written: 0, quiet: 0 });
  });
});
