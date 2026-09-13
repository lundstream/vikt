/**
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { FoodPhotoEntry } from "../../src/components/FoodPhotoEntry.js";
import { db } from "../../src/lib/queue/db.js";

/**
 * The photograph leaves and is not kept (D143), from the browser's side.
 *
 * The server side of this promise is held by `photo-transport.test.ts`. This is
 * the other half: the client must not put the image anywhere either. The
 * offline queue is the obvious risk — every other write on the food screen goes
 * through it, and a photograph that went through it would be written to this
 * device's storage and kept there until the network came back.
 */

/**
 * jsdom has no canvas and no `createImageBitmap`, so the resize itself is
 * tested as arithmetic in `photo-resize.test.ts` and stubbed here. What this
 * file is about is what happens to the result.
 */
vi.mock("../../src/lib/photo.js", () => ({
  fitWithin: (width: number, height: number) => ({ width, height }),
  preparePhoto: async () => ({ ok: true, base64: "SU1BR0VCWVRFUw==", bytes: 90_000 }),
}));

afterEach(cleanup);

function aPhoto(): File {
  return new File(["not really a jpeg"], "plate.jpg", { type: "image/jpeg" });
}

describe("sending a photograph", () => {
  it("posts the image and the words beside it in one request", async () => {
    const posted: unknown[] = [];

    renderRoute(<FoodPhotoEntry localDate="2026-09-12" onLogged={() => {}} />, {
      stateful: [
        {
          match: "/llm/parse-photo",
          get: () => ({}),
          post: (body) => posted.push(body),
          wrote: {
            available: true,
            model: "qwen3-vl:8b",
            ms: 14_200,
            items: [
              {
                name: "kebabpizza",
                estimatedGrams: 500,
                portion: null,
                portionSource: "estimate",
                confidence: 0.6,
                match: null,
              },
            ],
          },
        },
      ],
    });

    fireEvent.change(screen.getByPlaceholderText("kebabpizza, hela"), {
      target: { value: "kebabpizza, hela" },
    });
    fireEvent.change(screen.getByTestId("photo-input"), {
      target: { files: [aPhoto()] },
    });

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ image: "SU1BR0VCWVRFUw==", note: "kebabpizza, hela" });

    await screen.findByTestId("parse-proposal");
  });

  /**
   * The one that matters. Every other write on this screen is queued when it
   * fails; this one must not be, because queueing means writing the photograph
   * to this device and keeping it.
   */
  it("puts the photograph in neither the queue nor local storage", async () => {
    const posted: unknown[] = [];

    renderRoute(<FoodPhotoEntry localDate="2026-09-12" onLogged={() => {}} />, {
      stateful: [
        {
          match: "/llm/parse-photo",
          get: () => ({}),
          post: (body) => posted.push(body),
          wrote: { available: false, reason: "unreachable" },
        },
      ],
    });

    fireEvent.change(screen.getByTestId("photo-input"), {
      target: { files: [aPhoto()] },
    });

    await waitFor(() => expect(posted).toHaveLength(1));

    /**
     * The queue is IndexedDB, so this is the assertion that actually covers
     * "never in the offline queue": the request failed, and every other write
     * on this screen would now be sitting in `mutations` waiting for the
     * network to come back.
     */
    expect(await db.mutations.toArray()).toEqual([]);

    const stored = Object.keys(window.localStorage).map(
      (key) => `${key}=${window.localStorage.getItem(key) ?? ""}`,
    );
    expect(stored.join("\n")).not.toContain("SU1BR0VCWVRFUw==");

    /**
     * And the person is told the picture is gone rather than left to assume it
     * was kept. "Bilden sparades inte" is the honest sentence; the usual
     * offline copy would be a lie here.
     */
    expect(await screen.findByText(/sparades inte/)).toBeTruthy();
  });
});

/* ------------------------------------------- the proposal a photograph makes */

/** Two rows: one the model could quantify, one it could not. */
const TWO_ROWS = {
  available: true,
  model: "qwen3-vl:8b",
  ms: 14_200,
  items: [
    {
      name: "kebabpizza",
      estimatedGrams: 450,
      portion: null,
      portionSource: "hint",
      confidence: 0.6,
      match: {
        foodItemId: "11111111-1111-4111-8111-111111111111",
        name: "Pizza kebab",
        brand: null,
        kcalPer100: 240,
        kcal: 1080,
        servingHints: null,
      },
    },
    {
      name: "friterad potatis",
      estimatedGrams: null,
      portion: null,
      portionSource: "unknown",
      confidence: 0.6,
      match: {
        foodItemId: "22222222-2222-4222-8222-222222222222",
        name: "Friterad potatis",
        brand: null,
        kcalPer100: 290,
        kcal: null,
        servingHints: null,
      },
    },
  ],
};

async function photographTwoRows(confirmed: unknown[]) {
  renderRoute(<FoodPhotoEntry localDate="2026-09-12" onLogged={() => {}} />, {
    stateful: [
      { match: "/llm/parse-photo", get: () => ({}), post: () => {}, wrote: TWO_ROWS },
      {
        match: "/llm/parse-food/confirm",
        get: () => ({}),
        post: (body) => confirmed.push(body),
        wrote: { entries: [] },
      },
    ],
  });

  fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [aPhoto()] } });
  await screen.findByTestId("parse-proposal");
}

describe("the proposal list", () => {
  /**
   * The row the model could not quantify. An empty field and "inte än" where
   * the figure would be, rather than a number nobody stated — and the row is
   * still there, because the food was real even when the amount was not.
   */
  it("shows a row with no amount as empty, not as a guess", async () => {
    await photographTwoRows([]);

    const fields = screen.getAllByLabelText("Gram");
    expect((fields[0] as HTMLInputElement).value).toBe("450");
    expect((fields[1] as HTMLInputElement).value).toBe("");
    expect(screen.getAllByText("inte än").length).toBeGreaterThan(0);
  });

  /**
   * Marked as an estimate because of where it came from, not because of which
   * food it is. Sten with a dashed edge and a `≈`, per the profile: uncertainty
   * is not one of the five areas and gets no accent of its own.
   */
  it("marks every row from a photograph", async () => {
    await photographTwoRows([]);
    expect(screen.getAllByText("Uppskattad")).toHaveLength(2);
  });

  /**
   * The amount-less row does not hold the others hostage. What has a figure is
   * written; what does not stays on screen, and the note says how many.
   */
  it("saves the rows that have amounts and keeps the one that does not", async () => {
    const confirmed: unknown[] = [];
    await photographTwoRows(confirmed);

    fireEvent.click(screen.getByTestId("confirm-parsed"));

    await waitFor(() => expect(confirmed).toHaveLength(1));
    const body = confirmed[0] as {
      confidence: number;
      items: { name: string; grams: number }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ name: "Pizza kebab", grams: 450 });
    // Lowered, like D55's estimates. The coverage still counts these, because
    // the database is what priced them.
    expect(body.confidence).toBe(0.6);

    // And the unquantified row is still there, waiting for a figure.
    expect(await screen.findByText(/saknar mängd/)).toBeTruthy();
    expect(screen.getByText("Friterad potatis")).toBeTruthy();
  });

  /**
   * Once the person types the missing figure, it saves like any other row.
   */
  it("saves the remaining row once an amount is typed in", async () => {
    const confirmed: unknown[] = [];
    await photographTwoRows(confirmed);

    fireEvent.click(screen.getByTestId("confirm-parsed"));
    await waitFor(() => expect(confirmed).toHaveLength(1));

    fireEvent.change(screen.getByLabelText("Gram"), { target: { value: "180" } });
    fireEvent.click(screen.getByTestId("confirm-parsed"));

    await waitFor(() => expect(confirmed).toHaveLength(2));
    const body = confirmed[1] as { items: { name: string; grams: number }[] };
    expect(body.items[0]).toMatchObject({ name: "Friterad potatis", grams: 180 });
  });

  /**
   * D81's estimate is not reachable from here. It is licensed by the app having
   * tried and failed, and a photograph is a new input rather than an exhausted
   * one — so the text path's way out is simply not on this screen.
   */
  it("offers no model estimate", async () => {
    await photographTwoRows([]);
    expect(screen.queryByTestId("estimate-fallback")).toBeNull();
    expect(screen.queryByTestId("reject-parse")).toBeNull();
  });
});

describe("while the model works", () => {
  /**
   * The measured figure, in the app's own register. No spinner metaphor and no
   * "snart klart": a warm model answers in under a second and a cold one in
   * about six, and the honest thing to give somebody waiting is the numbers.
   */
  it("says how long it takes", async () => {
    renderRoute(<FoodPhotoEntry localDate="2026-09-12" onLogged={() => {}} />, {
      stateful: [
        {
          match: "/llm/parse-photo",
          get: () => ({}),
          post: () => {},
          wrote: TWO_ROWS,
          delayMs: 30,
        },
      ],
    });

    fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [aPhoto()] } });

    expect(await screen.findByText(/ett par sekunder/)).toBeTruthy();
  });
});
