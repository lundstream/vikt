#!/usr/bin/env node
/**
 * The three phone pictures on the landing page, resized for the web (D177).
 *
 *   node scripts/landing-screens.mjs
 *
 * Reads `docs/screens/{oversikt,mat,framsteg}-portrait.png`, which are **made by
 * hand**: framed screenshots of the demo account, produced by the owner. Writes
 * `apps/web/public/screens/*.png` at a width the page actually displays.
 *
 * ## Why a step at all
 *
 * The sources are a megabyte and a half each, at whatever size the mockup tool
 * exports. The page shows them a few hundred pixels wide, so serving the
 * originals would send four megabytes to show three thumbnails, on a page
 * measured at mobile settings for a performance score. This resizes them to
 * 640 px wide, which is more than twice what the layout uses.
 *
 * **The height follows the source**, read out of the PNG's own header. It was
 * hardcoded from the first set's 1419 x 2796, so the day the mockup tool
 * exported a different shape the page would have stretched all three pictures
 * and nothing would have said so. The script prints the size it wrote, and
 * `landing-screens.test.ts` holds the page's declared `width`/`height` to the
 * files on disk, because a wrong pair there is layout shift on the one page
 * whose score is measured.
 *
 * ## Why they are not generated
 *
 * They were, by `landing-shots.mjs`, which drove a browser through the app and
 * captured each screen. That script is gone (D177): these are framed, composed
 * pictures rather than raw captures, and a screenshot sweep cannot produce one.
 * The cost is that **they go stale silently**, so STATE.md and the release
 * runbook both carry the rule: regenerate them whenever Översikt, Mat or
 * Framsteg changes visibly.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROM = path.join(ROOT, "docs/screens");
const TO = path.join(ROOT, "apps/web/public/screens");

/** Twice the widest the layout draws them, and no more. */
const WIDTH = 640;

const SCREENS = ["oversikt", "mat", "framsteg"];

/**
 * The size in a PNG's header.
 *
 * Eight bytes of signature, then the IHDR chunk's length and type, then width
 * and height as big-endian 32-bit integers. Every PNG has this and it is the
 * first chunk, so there is nothing to search for and no library to add.
 */
function pngSize(file) {
  const header = readFileSync(file).subarray(0, 24);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

const CHROME =
  process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const missing = SCREENS.filter((name) => !existsSync(path.join(FROM, `${name}-portrait.png`)));
if (missing.length > 0) {
  process.stderr.write(
    `missing in docs/screens: ${missing.map((n) => `${n}-portrait.png`).join(", ")}\n` +
      "These are made by hand. Put them there and run this again.\n",
  );
  process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), "vikt-screens-"));
const port = 9600 + Math.floor(Math.random() * 180);
const profile = mkdtempSync(path.join(tmpdir(), "vikt-screens-profile-"));

const child = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--allow-file-access-from-files",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function connect() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((entry) => entry.type === "page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
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

  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        id += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
}

const client = await connect();

try {
  await client.send("Page.enable");
  mkdirSync(TO, { recursive: true });

  for (const name of SCREENS) {
    const sourceFile = path.join(FROM, `${name}-portrait.png`);
    const source = sourceFile.replaceAll("\\", "/");
    // Whatever the mockup tool exported; the height follows the width.
    const original = pngSize(sourceFile);
    const height = Math.round((original.height / original.width) * WIDTH);
    const page = path.join(dir, `${name}.html`);

    writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8">
       <style>html,body{margin:0;background:transparent}
         img{display:block;width:${WIDTH}px;height:${height}px}</style>
       <img src="${source}" alt="">`,
      "utf8",
    );

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Page.navigate", { url: `file:///${page.replaceAll("\\", "/")}` });
    await sleep(1200);

    const shot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    const file = path.join(TO, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    process.stdout.write(`wrote ${path.relative(ROOT, file)} (${WIDTH}x${height})\n`);
  }
} finally {
  client.close();
  child.kill();
  for (const temporary of [dir, profile]) {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch {
      // Chrome holds its profile for a moment on Windows; the run is done.
    }
  }
}
