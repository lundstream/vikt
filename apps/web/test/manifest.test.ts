import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME_PLACEHOLDER, MANIFEST_URL } from "../vite-plugin-app-name.js";

/**
 * The manifest, and the three ways it went wrong at once (D93, D98).
 *
 * The installed app on a phone was called `__APP_NAME__`. Three separate things
 * had to line up for that, and each of them is pinned here:
 *
 *  1. **One manifest, not two.** The dev plugin used to compose a manifest of
 *     its own, so the file on disk and the served copy could disagree, and did:
 *     the copy still said `start_url: "/"` and had no `id` long after D90 and
 *     D93 moved and identified the app.
 *  2. **The plugin watches the path the HTML links.** The copy was served at
 *     `/manifest.webmanifest`, where the manifest used to live. The app links
 *     `/app/manifest.webmanifest`. Nothing connected the two, so the
 *     substitution simply never ran on the file anybody fetched.
 *  3. **The identity fields are what D93 decided.** They are the reason a
 *     reinstall opens the app rather than the landing page, and they are the
 *     kind of thing that gets edited by hand during an unrelated change.
 */

const WEB = path.resolve(import.meta.dirname, "..");
const MANIFEST_FILE = path.join(WEB, "public/app/manifest.webmanifest");
const APP_HTML = path.join(WEB, "app/index.html");

const raw = readFileSync(MANIFEST_FILE, "utf8");
const manifest = JSON.parse(raw) as Record<string, unknown>;

describe("the web app manifest", () => {
  it("is served at the path the app actually links", () => {
    const html = readFileSync(APP_HTML, "utf8");
    const linked = html.match(/<link[^>]+rel="manifest"[^>]+href="([^"]+)"/)?.[1];

    expect(linked, "app/index.html no longer links a manifest").toBeTruthy();
    expect(linked).toBe(MANIFEST_URL);
  });

  /**
   * The file is the only manifest. A second one anywhere is the defect above
   * waiting to happen again, whichever of the two is edited.
   */
  it("is the only manifest in the source tree", () => {
    // Comments stripped first: the plugin's own docstring explains the defect
    // and quotes the fields, and a guard that failed on the explanation would
    // pass on the recurrence.
    const plugin = readFileSync(path.join(WEB, "vite-plugin-app-name.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // The plugin may name the file and the URL. It may not contain a manifest.
    expect(plugin).not.toMatch(/"start_url"|start_url:/);
    expect(plugin).not.toMatch(/"display"|display:/);
  });

  /** D93. Chrome identifies an installed app by `id`, not by `start_url`. */
  it("states the identity D93 settled on", () => {
    expect(manifest.id).toBe("/app/");
    expect(manifest.start_url).toBe("/app/");
    expect(manifest.scope).toBe("/app/");
  });

  /**
   * The name is substituted at runtime (D13), so the file must still carry the
   * placeholder. A literal "Vikt" here would be the rename path quietly broken.
   */
  it("carries the placeholder rather than a baked-in name", () => {
    expect(manifest.name).toBe(APP_NAME_PLACEHOLDER);
    expect(manifest.short_name).toBe(APP_NAME_PLACEHOLDER);
  });

  /** Dark by default, because the app is (§5). A light splash is a flash. */
  it("uses the dark background", () => {
    expect(manifest.background_color).toBe("#0F1418");
  });

  it("offers a maskable icon", () => {
    const icons = manifest.icons as { purpose?: string }[];
    expect(icons.some((icon) => icon.purpose?.includes("maskable"))).toBe(true);
  });
});
