#!/usr/bin/env node
/**
 * Screenshots every finished screen at 360 px and at desktop width, and writes
 * what it saw to a verdict file (the closing sweep, D161).
 *
 *   pnpm harness:sweep                          # against https://localhost:5173
 *   pnpm harness:sweep -- https://127.0.0.1:5173
 *
 * Writes `scratch/shots/sweep-<time>/` (gitignored): one PNG per screen and
 * width, and `verdict.txt`, one line per screen and a summary line computed
 * from the file. **Read the verdict, not the images** (§7): open only the
 * screenshots of screens the current change touched.
 *
 * Signs in as the seeded account (`SEED_EMAIL`, `SEED_PASSWORD`, from the
 * environment or `.env`); nothing here holds a credential.
 *
 * ## How a screen is captured
 *
 * Measure the page, set a viewport that tall, capture it whole, and leave fixed
 * elements where they are. `captureBeyondViewport` made Recharts re-measure
 * mid-shot (blank charts), put the bottom bar across the middle of a tall page,
 * and hiding fixed elements to avoid that removed the navigation from every
 * phone shot: three false findings in a row.
 *
 * **Except where the page's height depends on the viewport.** The landing
 * page's hero is `min-h-[100svh]`, so a viewport set to the page's height makes
 * the hero alone that tall. The strategy is chosen per screen by measuring the
 * content at two viewport heights; a page whose content moves with the window
 * is captured beyond the viewport at the nominal height, scrolled down and back
 * first so its scroll-revealed sections have been revealed. The verdict line
 * names the strategy used.
 *
 * It lived in a temporary folder as `shoot2.mjs` until the folder was cleared
 * (§7, the candidate class); this is it, tracked.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { account, ROOT, signIn } from "./lib/account.mjs";
import { launch, sleep } from "./lib/browser.mjs";
import { pruneSets } from "./lib/housekeeping.mjs";
import { verdict } from "./lib/verdict.mjs";

const origin = (process.argv[2] ?? "https://localhost:5173").replace(/\/$/, "");
const parent = path.join(ROOT, "scratch", "shots");
mkdirSync(parent, { recursive: true });
const pruned = pruneSets(parent, 2);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const outDir = path.join(parent, `sweep-${stamp}`);
const v = verdict(outDir, `sweep origin=${origin}`);
if (pruned.length > 0) console.log(`pruned ${pruned.length} old set(s)`);

const SCREENS = [
  ["landing", "/"],
  // The two public text pages (D106), served from the landing bundle.
  ["integritet", "/integritet"],
  ["villkor", "/villkor"],
  ["dashboard", "/app/"],
  ["food", "/app/food"],
  // Måltider (Phase 14): the section, with its own list and the shared one.
  ["meals", "/app/maltider"],
  ["day", "/app/dag"],
  ["progress", "/app/framsteg"],
  ["profile", "/app/profile"],
  ["correlations", "/app/data?vy=samband"],
  ["data", "/app/data"],
  ["settings", "/app/installningar"],
  ["news", "/app/nyheter"],
  ["admin-requests", "/app/admin"],
  ["admin-users", "/app/admin?vy=konton"],
  ["admin-invites", "/app/admin?vy=koder"],
  ["admin-mail", "/app/admin?vy=mejl"],
  ["admin-mailserver", "/app/admin?vy=mejlserver"],
  ["admin-backup", "/app/admin?vy=backup"],
  ["admin-announcements", "/app/admin?vy=meddelanden"],
  ["admin-reports", "/app/admin?vy=anmalningar"],
  ["admin-log", "/app/admin?vy=logg"],
];

const WIDTHS = [
  ["360", 360, 800, 2, true],
  ["desktop", 1280, 900, 1, false],
];

/** Everything about the landing page that is a relationship between elements (D181). */
const LANDING = `
  (() => {
    const sections = [...document.querySelectorAll("main > section")];
    const paragraph = sections
      .find((s) => s.querySelector("h2")?.textContent.startsWith("Din data"))
      ?.querySelector("p");
    const frame = document.querySelector(".phone-frame");
    const [title, meta] = frame ? frame.closest("div").parentElement.querySelectorAll("p") : [];
    const size = (el) => (el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : 0);
    const footer = document.querySelector("footer");
    const last = sections.at(-1);
    const gap = Math.round(
      footer.getBoundingClientRect().top + window.scrollY -
        (last.getBoundingClientRect().bottom + window.scrollY),
    );
    const between = Math.round(parseFloat(getComputedStyle(sections.at(-1)).paddingTop));
    const problems = [];
    if (size(title) !== size(paragraph)) problems.push("row-sentence=" + size(title) + " paragraph=" + size(paragraph));
    if (!(size(meta) < size(title))) problems.push("row-meta=" + size(meta) + " is not below " + size(title));
    if (gap !== between) problems.push("footer-gap=" + gap + " section-gap=" + between);
    return problems.length === 0
      ? " landing-ok=sentence" + size(title) + "/meta" + size(meta) + "/gap" + gap
      : " LANDING-FAIL=" + problems.join(";");
  })()`;

/** The bottom of the last thing on the page: what moves only with a viewport-bound layout. */
const CONTENT_HEIGHT = `
  Math.ceil(Math.max(0, ...[...document.body.children].map(
    (el) => el.getBoundingClientRect().bottom + window.scrollY,
  )))`;

const browser = await launch();
const { page } = browser;
try {
  const who = account();
  v.check("signed in", await signIn(page, origin, who));

  for (const [label, width, baseHeight, scale, mobile] of WIDTHS) {
    const metrics = (height) =>
      page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: scale,
        mobile,
      });

    for (const [name, url] of SCREENS) {
      await metrics(baseHeight);
      await page.goto(origin + url, 5200);

      const atNominal = Math.ceil(
        (await page.evaluate("document.documentElement.scrollHeight")) ?? baseHeight,
      );
      const full = Math.min(atNominal + 40, 8000);
      const contentAtNominal = (await page.evaluate(CONTENT_HEIGHT)) ?? atNominal;
      await metrics(baseHeight + 400);
      await sleep(900);
      const contentStretched = (await page.evaluate(CONTENT_HEIGHT)) ?? contentAtNominal;
      const viewportBound = Math.abs(contentStretched - contentAtNominal) > 40;

      let shot;
      if (viewportBound) {
        await metrics(baseHeight);
        await page.goto(origin + url, 5200);
        const height = (await page.evaluate("document.documentElement.scrollHeight")) ?? baseHeight;
        for (let y = 0; y < height; y += Math.round(baseHeight * 0.7)) {
          await page.evaluate(`window.scrollTo(0, ${y})`);
          await sleep(320);
        }
        await page.evaluate("window.scrollTo(0, 0)");
        await sleep(700);
        shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      } else {
        await metrics(full);
        await page.goto(origin + url, 5200);
        await page.evaluate("window.scrollTo(0, 0)");
        await sleep(400);
        shot = await page.send("Page.captureScreenshot", { format: "png" });
      }
      if (!shot?.data) {
        v.check(`${name} ${label}`, false, "reason=no-screenshot-data");
        continue;
      }
      writeFileSync(path.join(outDir, `${name}-${label}.png`), Buffer.from(shot.data, "base64"));

      // One evaluate, so the numbers describe the same paint.
      const state = await page.evaluate(`(() => ({
        charts: document.querySelectorAll('.recharts-surface').length,
        nav: document.querySelectorAll('[data-testid=bottom-bar] a').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        text: (document.body.innerText || '').trim().length,
        track: (document.querySelector('[data-testid=section-track]')?.style.transform) || '',
      }))()`);
      const landing = name === "landing" ? ((await page.evaluate(LANDING)) ?? " landing=unchecked") : "";

      // Blank is judged on rendered text: a white page and a loading one are the same bytes.
      const blank = (state?.text ?? 0) < 40;
      const overflow = (state?.overflow ?? 0) > 0;
      // A transform left behind pins every fixed sheet to the column (D154).
      const stuck = (state?.track ?? "") !== "";
      v.check(
        `${name} ${label}`,
        !blank && !overflow && !stuck && !landing.includes("LANDING-FAIL"),
        `height=${atNominal} capture=${viewportBound ? "beyond-viewport" : "tall-viewport"} ` +
          `charts=${state?.charts ?? "?"} nav=${state?.nav ?? "?"} overflow=${state?.overflow ?? "?"}px ` +
          `text=${state?.text ?? "?"} track="${state?.track ?? "?"}"${landing}`,
      );
    }
  }
} catch (error) {
  v.check("sweep", false, `stopped: ${error.message}`);
} finally {
  browser.close();
  v.finish(SCREENS.length * WIDTHS.length + 1);
  console.log(`verdict: ${path.relative(ROOT, v.file)}`);
}
