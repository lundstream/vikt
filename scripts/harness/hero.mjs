#!/usr/bin/env node
/**
 * The landing page's motion, measured on the production build (D178 to D185).
 *
 *   pnpm --filter web build && pnpm --filter web preview   # in another terminal
 *   pnpm harness:hero                                     # against https://localhost:4173
 *   pnpm harness:hero -- https://127.0.0.1:4173
 *
 * Milestones rather than samples: a watcher in the page records the first
 * frame on which each thing is true (the line drawn, the ring showing and gone,
 * each word, the sentence). **The intervals are what is checked**, against the
 * gap `landing.css` declares, because the absolute times move with how long the
 * page took to load and what the sequence is made of is the gaps.
 *
 * Also checked: the phone frame's turn through the viewport (the one named
 * exception in §5), the daily card stopping while off screen, and the final
 * frame under reduced motion. Writes `scratch/shots/hero-<time>/verdict.txt`.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/account.mjs";
import { launch, sleep } from "./lib/browser.mjs";
import { pruneSets } from "./lib/housekeeping.mjs";
import { verdict } from "./lib/verdict.mjs";

const origin = (process.argv[2] ?? "https://localhost:4173").replace(/\/$/, "");
const parent = path.join(ROOT, "scratch", "shots");
mkdirSync(parent, { recursive: true });
pruneSets(parent, 2);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const outDir = path.join(parent, `hero-${stamp}`);
const v = verdict(outDir, `hero origin=${origin}`);

/** The gap the stylesheet declares, so the check follows the design rather than a copy of it. */
const css = readFileSync(path.join(ROOT, "apps/web/src/styles/landing.css"), "utf8");
const GAP = Number(css.match(/--hero-word-gap:\s*(\d+)ms/)?.[1] ?? NaN);
/** A frame or two either way: the watcher records a thing when it crosses 2 % opacity. */
const SLACK = 40;

const WATCH = `
  (() => {
    const seen = {};
    const mark = (n) => { if (seen[n] === undefined) seen[n] = Math.round(performance.now()); };
    window.__hero = seen;
    const tick = () => {
      const line = document.querySelector(".hero-line");
      const ring = document.querySelector(".hero-ring");
      const words = [...document.querySelectorAll(".hero-word")];
      const sentence = document.querySelector(".hero-sentence");
      if (line && Number(getComputedStyle(line).strokeDashoffset.replace("px", "")) <= 0.001) mark("line");
      if (ring) {
        const o = Number(getComputedStyle(ring).opacity);
        if (o > 0.02) mark("ring");
        if (seen.ring !== undefined && o <= 0.02) mark("ringGone");
      }
      words.forEach((w, i) => { if (Number(getComputedStyle(w).opacity) > 0.02) mark("word" + (i + 1)); });
      if (sentence && Number(getComputedStyle(sentence).opacity) > 0.02) mark("sentence");
      if (seen.sentence === undefined) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return "watching";
  })()`;

const FRAME_AT = (fraction) => `
  (() => {
    const f = document.querySelector(".phone-frame");
    const box = f.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, box.top + window.scrollY + box.height / 2 - window.innerHeight * ${fraction}));
    return true;
  })()`;

const ANGLE = `
  (() => {
    const t = getComputedStyle(document.querySelector(".phone-frame")).transform;
    const m = t === "none" ? null : t.slice(t.indexOf("(") + 1, t.lastIndexOf(")")).split(",").map(Number);
    return m === null ? 0 : Math.round((Math.atan2(-m[2], m[0]) * 180) / Math.PI * 10) / 10;
  })()`;

const CARD = `document.querySelectorAll("#sa-funkar-det [data-figure-value]")[0]?.textContent ?? ""`;

const browser = await launch();
const { page } = browser;
try {
  v.check("the stylesheet declares a word gap", Number.isFinite(GAP), `--hero-word-gap=${GAP}ms`);

  /* ------------------------------------------------------------ the hero */
  await page.size(1280, 900);
  await page.send("Page.navigate", { url: `${origin}/` });
  await sleep(60);
  await page.evaluate(WATCH);
  await sleep(9000);
  const t = JSON.parse(await page.evaluate("JSON.stringify(window.__hero)"));
  v.record(`note milestones ${JSON.stringify(t)}`);
  const gap = (a, b) => (t[a] === undefined || t[b] === undefined ? NaN : t[b] - t[a]);
  v.check("the ring starts after the line completes", gap("line", "ring") >= 0, `${gap("line", "ring")} ms`);
  v.check("the first word after the ring has gone", gap("ringGone", "word1") > 0, `${gap("ringGone", "word1")} ms`);
  for (const [a, b] of [["word1", "word2"], ["word2", "word3"], ["word3", "sentence"]]) {
    const measured = gap(a, b);
    v.check(`${a} to ${b} at the declared gap`, Math.abs(measured - GAP) <= SLACK, `${measured} ms of ${GAP}`);
  }

  /* -------------------------------------------------------- a phone frame */
  await page.goto(`${origin}/`, 2600);
  const angles = [];
  for (const fraction of [1.6, 0.95, 0.5, 0.05, -0.6]) {
    await page.evaluate(FRAME_AT(fraction));
    await sleep(650);
    angles.push(await page.evaluate(ANGLE));
  }
  v.check(
    "the phone frame turns about 22 degrees and is square in the middle",
    Math.abs(angles[0] - 22) < 1 && angles[2] === 0 && Math.abs(angles[4] + 22) < 1,
    angles.join(" / "),
  );

  /* ------------------------------------------------- the daily card, off screen */
  await page.evaluate(`document.querySelector("#sa-funkar-det").scrollIntoView({ block: "center" }); 1`);
  await sleep(2000);
  await page.evaluate("window.scrollTo(0, 0)");
  await sleep(1000);
  const away = await page.evaluate(CARD);
  await sleep(2700);
  v.check("the daily card holds still off screen", away === (await page.evaluate(CARD)), away);

  /* ------------------------------------------------------- reduced motion */
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await page.goto(`${origin}/`, 900);
  const reduced = JSON.parse(await page.evaluate(`JSON.stringify({
    ring: getComputedStyle(document.querySelector(".hero-ring")).display,
    words: [...document.querySelectorAll(".hero-word")].map((w) => Number(getComputedStyle(w).opacity)),
  })`));
  v.check(
    "reduced motion gets the final frame",
    reduced.ring === "none" && reduced.words.every((o) => o === 1),
    JSON.stringify(reduced),
  );
  await page.send("Emulation.setEmulatedMedia", { features: [] });

  /* --------------------------------------------------------- both widths */
  for (const [width, height, mobile] of [[360, 760, true], [1280, 900, false]]) {
    await page.size(width, height, mobile);
    await page.goto(`${origin}/`, 3000);
    const overflow = await page.evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    v.check(`no horizontal overflow at ${width} px`, overflow === 0, `${overflow} px`);
  }
} catch (error) {
  v.check("hero", false, `stopped: ${error.message}`);
} finally {
  browser.close();
  v.finish();
  console.log(`verdict: ${path.relative(ROOT, v.file)}`);
}
