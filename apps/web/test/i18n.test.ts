import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCALE, t, translationKeys } from "../src/i18n/index.js";
import { REMINDER_TEXT } from "shared";
import { sv } from "../src/i18n/sv.js";

/**
 * The interface is in Swedish, with no switcher — DECISIONS.md D21.
 *
 * These guard the two ways a single-language app rots: a key referenced but
 * never written, and an English string left inline where nobody will look for
 * it again.
 */

const WEB_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const files = sourceFiles(WEB_SRC).filter((file) => !file.includes(`${path.sep}i18n${path.sep}`));

/** Every `t("...")` reference in the app source. */
function referencedKeys(): { key: string; file: string }[] {
  const refs: { key: string; file: string }[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) {
      refs.push({ key: match[1]!, file: path.relative(WEB_SRC, file) });
    }
  }
  return refs;
}

/**
 * Keys handed around as values rather than called directly — `lowLabel=
 * "daily.energyLow"` on a scale, or the axis labels in the correlation view's
 * pane table. They are typed `TranslationKey`, so the compiler has already
 * checked them; this only has to find them so they do not read as dead strings.
 *
 * Matching every dotted literal would be too loose, so this counts a literal
 * only when it is already a known key — which is exactly the question being
 * asked.
 */
function keysUsedAsValues(): Set<string> {
  const known = new Set<string>(translationKeys());
  const found = new Set<string>();

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/"([a-z][\w]*(?:\.[\w]+)+)"/g)) {
      if (known.has(match[1]!)) found.add(match[1]!);
    }
  }
  return found;
}

/**
 * Prefixes reached only through a computed key — `t(\`activity.type.${type}\`)`
 * over the MET table, and `t(\`measure.${site}\`)` over the measurement sites.
 * The source lists are in `packages/shared`, so a missing entry shows up as the
 * key itself on screen rather than as blank space.
 */
const COMPUTED_PREFIXES = [
  // `t(`admin.action.${entry.action}`)` in the audit log, over the action
  // strings `admin.service.ts` writes. A missing entry renders as the raw
  // action rather than as a blank line, which is deliberate (D100).
  "admin.action.",
  "activity.type.",
  "measure.",
  // `t(`cadence.${rule.cadence}`)` and `t(`metric.${milestone.metric}`)`, over
  // the enums in `packages/shared`. A missing entry shows on screen as the key.
  "cadence.",
  "metric.",
  // `t(`queue.kind.${row.kind}`)` and `t(`queue.status.${row.status}`)` in the
  // queue inspector, and `t(`offline.${what}`)` in the offline notice.
  "queue.kind.",
  "queue.status.",
  "offline.",
  // `t(`portion.from.${suggested.source}`)` on the portion sheet, over the
  // `AmountSource` union in `packages/shared` (D85).
  "portion.from.",
  // `t(`admin.mail.${row.status}`)` in the admin view, over the queue's status
  // column (D88).
  "admin.mail.",
];

describe("the translation layer", () => {
  it("interpolates named placeholders", () => {
    expect(t("insights.daysCount", { days: 12 })).toContain("12");
  });

  it("leaves an unmatched placeholder alone rather than printing undefined", () => {
    expect(t("insights.daysCount", {})).toContain("{days}");
  });

  it("returns the key itself for an unknown id, so a gap is visible", () => {
    // @ts-expect-error deliberately not a key
    expect(t("nope.not.a.key")).toBe("nope.not.a.key");
  });

  it("formats dates and numbers in the same locale as the copy", () => {
    expect(LOCALE).toBe("sv-SE");
  });
});

describe("translation coverage", () => {
  it("has a Swedish string for every key the app asks for", () => {
    const known = new Set<string>(translationKeys());
    const missing = referencedKeys()
      .filter((ref) => !known.has(ref.key))
      // `field.${...}` is built from the API's `missing` array.
      .filter((ref) => !ref.key.startsWith("field."))
      .map((ref) => `${ref.key} (${ref.file})`);

    expect(missing).toEqual([]);
  });

  it("covers every profile field the API can report as missing", () => {
    for (const field of ["sex", "birthDate", "heightCm", "weightKg"]) {
      expect(sv, field).toHaveProperty(`field.${field}`);
    }
  });

  it("has no unused keys", () => {
    const referenced = new Set(referencedKeys().map((ref) => ref.key));
    // These are reached through computed keys or through the range table.
    const indirect = new Set([
      "field.sex",
      "field.birthDate",
      "field.heightCm",
      "field.weightKg",
      // Reached through unsupportedKey() in BarcodeScanner.
      "food.cameraInsecure",
      "food.cameraDenied",
      "food.cameraMissing",
      "food.cameraFailed",
      "range.30",
      "range.90",
      "range.365",
      "range.all",
      // `t(`macro.${name}`)` in the day card and the override form.
      "macro.protein",
      "macro.carbs",
      "macro.fat",
      "macro.fiber",
      // `t(`bmi.${bmiBand(value)}`)` under the BMI figure.
      "bmi.underweight",
      "bmi.normal",
      "bmi.overweight",
      "bmi.obese",
    ]);

    const asValues = keysUsedAsValues();
    const unused = translationKeys().filter(
      (key) =>
        !referenced.has(key) &&
        !indirect.has(key) &&
        !asValues.has(key) &&
        !COMPUTED_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    expect(unused).toEqual([]);
  });

  it("is actually in Swedish", () => {
    // A cheap smell test: several strings that would be identical in English
    // if someone pasted the wrong file in.
    expect(sv["auth.signIn"]).toBe("Logga in");
    expect(sv["dash.trendWeight"]).toBe("Trendvikt");
    expect(sv["insights.maintenance"]).toBe("Underhåll");
  });

  it("keeps the tone free of failure language (CLAUDE.md §3)", () => {
    // No scolding, no "you failed to", no red-flag words.
    const forbidden = /\b(misslyckad|misslyckats|du missade|fel på dig|bruten)\b/i;
    const offenders = Object.entries(sv).filter(([, value]) => forbidden.test(value));
    expect(offenders).toEqual([]);
  });
});

/**
 * The notification copy has one owner (D136).
 *
 * The server builds the payload and the settings screen previews it, so the
 * words live in `shared`. The dictionary keeps its own entries because that is
 * where the copy guards look — a string that arrives on a lock screen is
 * interface copy that happens to be displayed somewhere else — and this is what
 * stops the two from drifting apart.
 */
describe("the reminder notifications", () => {
  it("say the same thing in the dictionary as on the wire", () => {
    expect(sv["push.notifyWeigh"]).toBe(REMINDER_TEXT.weigh);
    expect(sv["push.notifyDay"]).toBe(REMINDER_TEXT.day);
  });
});
