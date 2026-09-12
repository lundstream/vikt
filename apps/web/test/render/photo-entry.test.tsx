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

    renderRoute(<FoodPhotoEntry />, {
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

    await screen.findByTestId("photo-proposal");
  });

  /**
   * The one that matters. Every other write on this screen is queued when it
   * fails; this one must not be, because queueing means writing the photograph
   * to this device and keeping it.
   */
  it("puts the photograph in neither the queue nor local storage", async () => {
    const posted: unknown[] = [];

    renderRoute(<FoodPhotoEntry />, {
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
