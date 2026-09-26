/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { LabelPhotoEntry } from "../../src/components/LabelPhotoEntry.js";
import { sv } from "../../src/i18n/sv.js";

/**
 * The label photo's second guard (D190): the transcription beside the photo,
 * every figure confirmed or corrected, and no save while the figures disagree.
 *
 * jsdom decodes no images, so the photograph's preparation is replaced by its
 * result; the orientation and resize are `photo-orientation.test.ts` and a
 * browser. What is under test is the screen's rule about saving.
 */
vi.mock("../../src/lib/photo.js", () => ({
  preparePhoto: async () => ({
    ok: true,
    base64: "x".repeat(64),
    bytes: 48,
    blob: new Blob(["x"], { type: "image/jpeg" }),
  }),
}));

globalThis.URL.createObjectURL = () => "blob:label";
globalThis.URL.revokeObjectURL = () => {};

/** The sweets, with the fibre read as 5,6 where the bag says 56. */
const MISREAD = {
  name: "Sockerfria lakritsbitar",
  column: "per 100 g",
  basis: "100g",
  columns: 2,
  energyKj: null,
  energyKcal: 164,
  fat: 0,
  saturatedFat: 0,
  carbohydrate: 11,
  sugars: 1.6,
  polyols: 8.3,
  fibre: 5.6,
  protein: 4.1,
  salt: 0.07,
  alcohol: null,
  servingSize: null,
};

describe("confirming a transcribed label", () => {
  afterEach(cleanup);

  it("will not save figures that disagree, and saves them once corrected and confirmed", async () => {
    const saved: unknown[] = [];
    const onSaved = vi.fn();
    renderRoute(<LabelPhotoEntry barcode="7310000123459" onSaved={onSaved} />, {
      responses: [
        {
          match: "/api/llm/read-label",
          body: { available: true, label: MISREAD, model: "qwen3-vl:8b", ms: 1400 },
        },
      ],
      stateful: [
        {
          match: "/api/food/label",
          get: () => null,
          post: (body) => saved.push(body),
          wrote: { id: "00000000-0000-0000-0000-0000000000f9", name: "Sockerfria lakritsbitar" },
        },
      ],
    });

    // The capture screen says how to take the picture.
    const howto = screen.getByTestId("label-howto").textContent ?? "";
    for (const key of ["label.howFlat", "label.howStraight", "label.howFill", "label.howGlare"] as const) {
      expect(howto).toContain(sv[key]);
    }

    const input = screen.getByTestId("label-input");
    fireEvent.change(input, { target: { files: [new File(["x"], "label.jpg", { type: "image/jpeg" })] } });
    await screen.findByTestId("label-confirm");

    // Two columns seen: said so.
    expect(screen.getByTestId("label-column").textContent).toContain("2 kolumner");

    // 5,6 g of fibre does not add up to 164 kcal.
    expect(screen.getByTestId("label-check").textContent).toContain(sv["label.disagrees"]);
    const save = screen.getByTestId("label-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Corrected: the check passes, and the figures still have to be confirmed.
    fireEvent.change(screen.getByLabelText(sv["label.fibre"]), { target: { value: "56" } });
    await waitFor(() =>
      expect(screen.getByTestId("label-check").textContent).toContain("Siffrorna stämmer inbördes"),
    );
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId("label-unconfirmed").textContent).toMatch(/siffror kvar/);

    for (const key of ["energyKcal", "fat", "saturatedFat", "carbohydrate", "sugars", "polyols", "protein", "salt"]) {
      fireEvent.click(screen.getByTestId(`label-ok-${key}`));
    }
    await waitFor(() => expect(save.disabled).toBe(false));

    fireEvent.click(save);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ fibre: 56, energyKcal: 164, barcode: "7310000123459" });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
