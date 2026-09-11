/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { Coach } from "../../src/routes/Coach.js";
import { ReviewCard } from "../../src/components/ReviewCard.js";
import { destinationsFor } from "../../src/components/AppShell.js";
import { CoachTone } from "../../src/components/CoachTone.js";

/**
 * The coach's surfaces (D139), §6 phase 8b.
 *
 * What is worth testing here is what the eye cannot check: that a refused reply
 * shows the app's own sentence rather than the model's, that the unreachable
 * state offers nothing else, and that the whole thing is **absent** rather than
 * disabled when the layer is off. The streaming itself is exercised by feeding
 * the component a real event stream, because a mocked "it rendered" would pass
 * against a component that waited for the last event.
 */

/** An SSE body, as the server writes it. */
function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/**
 * `fetch` for the turn, which the harness stub does not cover: the answer is a
 * stream rather than a JSON body.
 */
function stubStream(body: string, rest: typeof globalThis.fetch) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/coach/ask")) {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return rest(input as RequestInfo, init);
  }) as typeof fetch;
}

function mountCoach(streamBody: string, options: { reachable?: boolean } = {}) {
  renderRoute(<Coach />, {
    responses: [
      { match: "/api/llm/health", body: { configured: true, reachable: options.reachable ?? true, models: { small: "s", large: "l" } } },
      { match: "/api/coach/conversations", body: { conversations: [] } },
      { match: "/api/coach/reviews", body: { reviews: [] } },
      { match: "/api/me", body: { profile: { timezone: "Europe/Stockholm" } } },
    ],
  });

  globalThis.fetch = stubStream(streamBody, globalThis.fetch);
}

describe("asking the coach", () => {
  afterEach(cleanup);

  it("shows sentences as they arrive", async () => {
    mountCoach(
      sse([
        { type: "sentence", text: "Det ser stadigt ut." },
        { type: "sentence", text: "Trendvikten ligger på 84,2 kg." },
        { type: "done", messageId: "1", body: "Det ser stadigt ut. Trendvikten ligger på 84,2 kg." },
      ]),
    );

    fireEvent.change(await screen.findByTestId("coach-question"), {
      target: { value: "Hur går det?" },
    });
    fireEvent.click(screen.getByTestId("coach-send"));

    expect(await screen.findByText(/Det ser stadigt ut/)).toBeTruthy();
    expect(await screen.findByText(/84,2 kg/)).toBeTruthy();
  });

  /**
   * The refusal is the app's sentence, and the reply that caused it never
   * appears. A component that rendered the stream first and corrected
   * afterwards would fail this.
   */
  it("shows the app's own words when a reply is refused", async () => {
    mountCoach(
      sse([
        {
          type: "refused",
          reason: "floor",
          message: "Jag får inte föreslå ett intag under 1 500 kcal per dag.",
        },
      ]),
    );

    fireEvent.change(await screen.findByTestId("coach-question"), {
      target: { value: "Vad händer om jag äter 800 kcal?" },
    });
    fireEvent.click(screen.getByTestId("coach-send"));

    expect(await screen.findByText(/får inte föreslå ett intag under/)).toBeTruthy();
    expect(screen.queryByText(/800 kcal om dagen/)).toBeNull();
  });

  it("says the coach is busy rather than spinning", async () => {
    mountCoach(sse([{ type: "busy" }]));

    fireEvent.change(await screen.findByTestId("coach-question"), {
      target: { value: "Hur går det?" },
    });
    fireEvent.click(screen.getByTestId("coach-send"));

    expect(await screen.findByTestId("coach-notice")).toBeTruthy();
    expect(screen.getByTestId("coach-notice").textContent).toContain("upptagen");
  });

  /** Unreachable says so and offers nothing else: chat is not queued (D6). */
  it("says the host is unreachable and offers nothing else", async () => {
    mountCoach(sse([{ type: "unreachable" }]), { reachable: false });

    expect(await screen.findByTestId("coach-offline")).toBeTruthy();
    expect(screen.getByTestId("coach-offline").textContent).toContain("går inte att nå");
  });
});

describe("the weekly review card", () => {
  afterEach(cleanup);

  it("shows the newest review with a way to read it and a way to put it away", async () => {
    const posts: string[] = [];

    renderRoute(<ReviewCard />, {
      responses: [
        {
          match: "/api/llm/health",
          body: { configured: true, reachable: true, models: { small: "s", large: "l" } },
        },
      ],
      stateful: [
        {
          match: "/api/coach/review/current",
          get: () => ({
            review: {
              id: "11111111-1111-1111-1111-111111111111",
              weekStart: "2026-09-07",
              body: "Fyra vägningar den här veckan, vilket är fler än förra.",
              createdAt: "2026-09-13T10:00:00.000Z",
            },
          }),
        },
        {
          match: "/api/coach/reviews/",
          get: () => ({}),
          post: () => posts.push("dismiss"),
          wrote: { ok: true },
        },
      ],
    });

    expect(await screen.findByTestId("review-card")).toBeTruthy();
    expect(screen.getByTestId("review-open").getAttribute("href")).toContain("/coach");

    fireEvent.click(screen.getByTestId("review-dismiss"));
    await waitFor(() => expect(posts).toEqual(["dismiss"]));
  });

  /** With the layer off there is no card at all, not an empty one (D94). */
  it("is not drawn when the LLM layer is off", async () => {
    renderRoute(<ReviewCard />, {
      responses: [
        {
          match: "/api/llm/health",
          body: { configured: false, reachable: false, models: { small: "s", large: "l" } },
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("review-card")).toBeNull();
  });
});

describe("the navigation entry", () => {
  /**
   * Absent rather than disabled, and from **both** surfaces at once: D115's
   * whole point is that the sidebar and the Mer sheet drifted because nothing
   * checked they listed the same places.
   */
  it("exists only where the LLM layer is configured", () => {
    const withLlm = destinationsFor(false, true).map((destination) => destination.to);
    const without = destinationsFor(false, false).map((destination) => destination.to);

    expect(withLlm).toContain("/coach");
    expect(without).not.toContain("/coach");
    // And nothing else moved.
    expect(without.length).toBe(withLlm.length - 1);
  });
});

describe("the tone", () => {
  afterEach(cleanup);

  /**
   * A whole identity, not a fragment.
   *
   * `api.me()` parses the response, so a partial profile fails the schema, the
   * query has no data, and the component falls back to the default tone — which
   * looked exactly like the component ignoring the setting.
   */
  function identity(coachTone: string) {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      email: "someone@example.test",
      displayName: "Someone",
      createdAt: "2026-01-01T00:00:00.000Z",
      isAdmin: false,
      profile: {
        heightCm: 180,
        birthDate: null,
        sex: "unspecified",
        timezone: "Europe/Stockholm",
        locale: "sv-SE",
        activityFactor: 1.35,
        addExerciseToTarget: false,
        soberAssumeUnloggedDry: false,
        newsMail: true,
        theme: "system",
        lastDrinkOn: null,
        coachTone,
        macroOverrides: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
      },
    };
  }

  function mountTone(current: string) {
    const patches: Record<string, unknown>[] = [];

    renderRoute(<CoachTone />, {
      responses: [{ match: "/api/me", body: identity(current) }],
      stateful: [
        {
          match: "/api/me/profile",
          get: () => ({}),
          post: (body) => patches.push(body as Record<string, unknown>),
          wrote: { profile: { coachTone: "peppig" } },
        },
      ],
    });

    return { patches };
  }

  it("offers exactly the three, with the chosen one marked", async () => {
    mountTone("torr");

    await waitFor(() =>
      expect(screen.getByTestId("coach-tone-torr").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.getByTestId("coach-tone-peppig").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("coach-tone-saklig")).toBeTruthy();
    // Three and no more: the set is closed by decision (D140).
    expect(document.querySelectorAll('[data-testid^="coach-tone-"]')).toHaveLength(4);
  });

  it("saves the choice to the profile", async () => {
    const { patches } = mountTone("torr");

    fireEvent.click(await screen.findByTestId("coach-tone-peppig"));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ coachTone: "peppig" });
  });

  it("describes the one that is chosen, not all three", async () => {
    mountTone("saklig");

    /**
     * Waited for rather than read once: the row renders on the first paint with
     * the default, and the chosen tone arrives with the identity a moment
     * later. Reading it immediately asserted the placeholder.
     */
    await waitFor(() =>
      expect(screen.getByTestId("coach-tone-what").textContent).toContain("Ingen personlighet"),
    );
    expect(screen.getByTestId("coach-tone-what").textContent).not.toContain("underdriven");
    expect(screen.getByTestId("coach-tone-saklig").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the neutral tone", () => {
  afterEach(cleanup);

  /**
   * Saklig has no persona, so it has no name either: calling it Bengt anyway
   * would be exactly the character somebody switched off.
   */
  it("drops the persona's name from the page", async () => {
    renderRoute(<Coach />, {
      responses: [
        {
          match: "/api/llm/health",
          body: { configured: true, reachable: true, models: { small: "s", large: "l" } },
        },
        { match: "/api/coach/conversations", body: { conversations: [] } },
        { match: "/api/coach/reviews", body: { reviews: [] } },
        {
          match: "/api/me",
          body: {
            id: "00000000-0000-0000-0000-000000000001",
            email: "someone@example.test",
            displayName: "Someone",
            createdAt: "2026-01-01T00:00:00.000Z",
            isAdmin: false,
            profile: {
              heightCm: 180, birthDate: null, sex: "unspecified",
              timezone: "Europe/Stockholm", locale: "sv-SE", activityFactor: 1.35,
              addExerciseToTarget: false, soberAssumeUnloggedDry: false, newsMail: true,
              theme: "system", lastDrinkOn: null, coachTone: "saklig",
              macroOverrides: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
            },
          },
        },
      ],
    });

    await waitFor(() => expect(screen.getByText(/Fråga Coachen/)).toBeTruthy());
    expect(screen.queryByText(/Fråga Bengt/)).toBeNull();
  });
});

describe("what the coach cannot promise", () => {
  afterEach(cleanup);

  /**
   * D139 found two limits a numeric check cannot cover, and D140 put them on
   * the screen rather than only in a decision file nobody reading the app will
   * open.
   */
  it("says that the words are not checked even though the numbers are", async () => {
    mountCoach(sse([]));

    const line = await screen.findByTestId("coach-limits");
    expect(line.textContent).toContain("kan ha fel");
    expect(line.textContent).toContain("andra skärmarna");
  });
});
