#!/usr/bin/env node
/**
 * The landing page's three phone screenshots, taken from the running app.
 *
 *   node --env-file=.env scripts/landing-shots.mjs      # against the dev server
 *   LANDING_SHOT_BASE=https://localhost:4173 node --env-file=.env scripts/landing-shots.mjs
 *
 * `--env-file` because the credentials live in `.env` like every other one and
 * are read from the environment rather than passed on a command line (§7).
 *
 * Writes `apps/web/public/screens/{oversikt,mat,framsteg}.png` at 360 x 760 CSS
 * pixels and a device pixel ratio of 2, which is the size the frames on the
 * landing page display them at (D173).
 *
 * ## Why this is a script rather than four files somebody once saved
 *
 * The screenshots on the old page were captures of an app from three passes
 * ago: the colours had moved, the dropdowns had been fixed, and the page went
 * on showing the version that was current when somebody last remembered. A
 * screenshot is a claim about what the app looks like, and a claim nothing
 * regenerates is a claim that rots. Running this is one command, and it is
 * named in the DECISIONS entry and in STATE.md as part of a release.
 *
 * ## Credentials
 *
 * `SEED_EMAIL` and `SEED_PASSWORD` come from the environment (CLAUDE.md §7).
 * The script exits naming the variable if either is missing, prints neither,
 * and has no interactive fallback.
 *
 * ## No browser dependency
 *
 * Chrome is driven over the DevTools protocol with `fetch` and Node 22's global
 * `WebSocket`. The alternative is a 300 MB dev dependency to take three
 * pictures.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "apps/web/public/screens");
const BASE = process.env.LANDING_SHOT_BASE ?? "https://localhost:5173";

/** The frame's own size, at the density a phone screen has. */
const WIDTH = 360;
const HEIGHT = 760;
const SCALE = 2;

/** Which screens, and what each has to have on it before it is worth shooting. */
const SCREENS = [
  { file: "oversikt.png", path: "/app/", waitFor: "[data-testid=trend-chart], main" },
  { file: "mat.png", path: "/app/food", waitFor: "main" },
  { file: "framsteg.png", path: "/app/framsteg", waitFor: "main" },
];

const CHROME =
  process.env.CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    process.stderr.write(`${name} is not set. Put it in .env and run again.\n`);
    process.exit(1);
  }
  return value;
}

async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(path.join(tmpdir(), "vikt-shots-"));

  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      // The dev server uses a self-signed certificate (scripts/dev-certs.mjs).
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return { child, port, profile };
    } catch {
      await sleep(250);
    }
  }

  child.kill();
  throw new Error("Chrome did not open a debugging port");
}

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    const waiting = pending.get(data.id);
    if (!waiting) return;
    pending.delete(data.id);
    if (data.error) waiting.reject(new Error(JSON.stringify(data.error)));
    else waiting.resolve(data.result);
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  return { send, close: () => socket.close() };
}

/** Evaluate in the page and return the value. */
async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "the page threw");
  }
  return result.result.value;
}

async function waitFor(page, selector, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(page, `!!document.querySelector(${JSON.stringify(selector)})`)) return;
    await sleep(250);
  }
  throw new Error(`never appeared: ${selector}`);
}

/** Type into a React-controlled field: the native setter, then an input event. */
function typeInto(selector, value) {
  return `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "missing";
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return "ok";
    })()`;
}

const email = requireEnv("SEED_EMAIL");
const password = requireEnv("SEED_PASSWORD");

const { child, port, profile } = await launch();
const page = await connect(port);

try {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: true,
  });

  await page.send("Page.navigate", { url: `${BASE}/app/login` });
  await waitFor(page, "#email");
  await evaluate(page, typeInto("#email", email));
  await evaluate(page, typeInto("#password", password));
  await evaluate(page, `document.querySelector("form").requestSubmit()`);
  await sleep(2500);

  const status = await evaluate(
    page,
    `fetch("/api/me", { credentials: "same-origin" }).then((r) => r.status)`,
  );
  if (status !== 200) throw new Error(`could not sign in as the seeded account (/api/me: ${status})`);

  mkdirSync(OUT, { recursive: true });

  for (const screen of SCREENS) {
    await page.send("Page.navigate", { url: `${BASE}${screen.path}` });
    await waitFor(page, screen.waitFor);
    // Charts measure their container and animate in; this is the settle.
    await sleep(1800);

    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, screen.file);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    process.stdout.write(`wrote ${path.relative(ROOT, file)} (${WIDTH}x${HEIGHT} at ${SCALE}x)\n`);
  }
} finally {
  page.close();
  child.kill();
  /*
    Best effort. On Windows Chrome holds its crash-metrics file open for a
    moment after the process is killed, and an EBUSY here would throw away a
    run whose screenshots are already written.
  */
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    process.stdout.write(`the temporary profile is still locked: ${profile}
`);
  }
}
