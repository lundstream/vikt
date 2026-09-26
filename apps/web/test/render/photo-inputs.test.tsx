/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PhotoInputs } from "../../src/components/PhotoInputs.js";
import { sv } from "../../src/i18n/sv.js";

/**
 * Take a picture, or choose one (D200): the camera input keeps `capture`, the
 * gallery input has none, and both go to the tool's one handler.
 */

afterEach(cleanup);

describe("the two ways to give a photo tool a picture", () => {
  it("opens the camera with one and the gallery with the other", () => {
    render(<PhotoInputs takeLabel={sv["photo.shutter"]} working={false} testId="photo-input" onChosen={() => {}} />);
    const take = screen.getByTestId("photo-input") as HTMLInputElement;
    const pick = screen.getByTestId("photo-input-pick") as HTMLInputElement;
    expect(take.getAttribute("capture")).toBe("environment");
    expect(pick.hasAttribute("capture")).toBe(false);
    for (const input of [take, pick]) {
      expect(input.type).toBe("file");
      expect(input.accept).toBe("image/*");
    }
    expect(screen.getByText(sv["photo.choose"])).toBeTruthy();
  });

  it("hands either to the same handler, and both wait while one is read", () => {
    const onChosen = vi.fn();
    const { rerender } = render(
      <PhotoInputs takeLabel="Ta" working={false} testId="x" onChosen={onChosen} />,
    );
    const file = new File(["png"], "skarmbild.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("x-pick"), { target: { files: [file] } });
    fireEvent.change(screen.getByTestId("x"), { target: { files: [file] } });
    expect(onChosen).toHaveBeenCalledTimes(2);

    rerender(<PhotoInputs takeLabel="Ta" working testId="x" onChosen={onChosen} />);
    expect((screen.getByTestId("x") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("x-pick") as HTMLInputElement).disabled).toBe(true);
  });
});

/**
 * No tool grows its own camera-only input again (§7, class 2): `capture` is
 * written in one place, the shared control, and every photo tool uses it.
 */
describe("the photo tools", () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? files(full) : /\.tsx$/.test(entry) ? [full] : [];
    });

  /**
   * Comments only: a doc block, a JSX comment, a line comment. Not every
   * slash-star: `accept="image/*"` does not start one, and the first version of
   * this test thought it did and deleted the very line it was looking for.
   */
  const withoutComments = (source: string) =>
    source
      .replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("write capture only in PhotoInputs", () => {
    const offenders = files(SRC)
      .filter((file) => !file.endsWith("PhotoInputs.tsx"))
      .filter((file) => /\bcapture=/.test(withoutComments(readFileSync(file, "utf8"))))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("all three use the shared control", () => {
    for (const tool of ["FoodPhotoEntry.tsx", "RecipePhotoEntry.tsx", "LabelPhotoEntry.tsx"]) {
      expect(readFileSync(path.join(SRC, "components", tool), "utf8"), tool).toContain("<PhotoInputs");
    }
  });
});
