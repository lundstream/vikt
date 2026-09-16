#!/usr/bin/env node
/**
 * The share card: `docs/landing/hero.png`, cropped to 1200 x 630 (D173).
 *
 *   node scripts/share-image.mjs
 *
 * Writes `apps/web/public/share.png`, which is what `og:image` and
 * `twitter:image` point at. The source is the owner's own artwork and is not
 * served: it is 5504 x 3072 and twenty megabytes, and a landing page that made
 * a browser download that to show a thumbnail would be the opposite of every
 * other decision on the page.
 *
 * **The image is never used inside the page.** It exists so that a link to this
 * installation, pasted into a chat, shows something other than a grey box.
 *
 * ## Why Chrome does the cropping
 *
 * The repository has no image library and this is the only thing that would
 * need one. Chrome is already a development dependency of the screenshot sweep,
 * it decodes PNG properly, and `object-fit: cover` is a crop expressed in one
 * line rather than in arithmetic about aspect ratios. The output is a
 * screenshot of a page holding one image, which is exactly the crop.
 *
 * Missing source: the script says so and changes nothing, so a checkout without
 * the owner's artwork keeps whatever share image is already committed rather
 * than losing it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "docs/landing/hero.png");
const TARGET = path.join(ROOT, "apps/web/public/share.png");

/** What Open Graph and Twitter both want, and what every reader has seen. */
const WIDTH = 1200;
const HEIGHT = 630;

const CHROME =
  process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(SOURCE)) {
  process.stdout.write(
    `docs/landing/hero.png is not here, so the share image was left as it is.\n` +
      `Put the artwork there and run this again.\n`,
  );
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), "vikt-share-"));
const page = path.join(dir, "share.html");

/**
 * One image, covering the card exactly. `object-position` favours the top,
 * because the artwork's subject is above the middle and a centred crop takes
 * its head off.
 */
writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8">
   <style>
     html, body { margin: 0; background: #0F1418; }
     img { display: block; width: ${WIDTH}px; height: ${HEIGHT}px;
           object-fit: cover; object-position: 50% 40%; }
   </style>
   <img src="${path.resolve(SOURCE).replaceAll("\\", "/")}" alt="">`,
  "utf8",
);

const port = 9800 + Math.floor(Math.random() * 180);
const profile = mkdtempSync(path.join(tmpdir(), "vikt-share-profile-"));

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
    `--window-size=${WIDTH},${HEIGHT}`,
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
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send("Page.navigate", { url: `file:///${page.replaceAll("\\", "/")}` });
  // Twenty megabytes of PNG takes a moment to decode.
  await sleep(2500);

  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(TARGET, Buffer.from(shot.data, "base64"));
  process.stdout.write(`wrote ${path.relative(ROOT, TARGET)} (${WIDTH}x${HEIGHT})\n`);
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
