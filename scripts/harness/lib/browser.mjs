/**
 * A headless browser driven over the DevTools protocol, for the harness.
 *
 * No browser library: Node has `fetch` and `WebSocket`, and the protocol is a
 * handful of calls (D173). What this adds over a raw socket is the three things
 * every harness run got wrong at least once before it lived here:
 *
 *  - **a port per run**, because a killed run leaves its browser holding the
 *    old port and the next run attached to it and drove the previous run's page;
 *  - **a profile per run, in the system's temporary directory, removed when
 *    the process exits** however it exits, because forty abandoned profiles
 *    once filled 5.4 GB and a stale service worker is a false finding waiting;
 *  - **the browser is found by name**: `CHROME_PATH` when set, then Chrome,
 *    then Edge, in their usual Windows places.
 *
 * It lived in a session's temporary folder until that folder was cleared and
 * it had to be rebuilt from a transcript (CLAUDE.md §7, the candidate class).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { deleteOnExit } from "./housekeeping.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

function browserPath() {
  const found = CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      "no browser found: set CHROME_PATH to a Chrome or Edge executable " +
        `(looked in ${CANDIDATES.join(", ")})`,
    );
  }
  return found;
}

/**
 * Starts a browser and returns it with one page to drive. `close()` ends both;
 * the profile goes on exit whether or not anybody calls it.
 */
export async function launch() {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(path.join(tmpdir(), "vikt-harness-"));
  const child = spawn(
    browserPath(),
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const removeProfile = deleteOnExit(profile, () => child.kill());

  let pageTarget = null;
  for (let attempt = 0; attempt < 60 && !pageTarget; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      pageTarget = list.find((target) => target.type === "page") ?? null;
    } catch {
      // Not listening yet.
    }
    if (!pageTarget) await sleep(250);
  }
  if (!pageTarget) {
    child.kill();
    throw new Error("the browser did not open a debugging port");
  }

  const page = await connect(pageTarget.webSocketDebuggerUrl);
  return {
    page,
    close() {
      page.close();
      child.kill();
      // After the browser has let go of its files; exit removes it otherwise.
      setTimeout(removeProfile, 800);
    },
  };
}

/** The calls the harness makes, on one page target. */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");

  const page = {
    send,
    close: () => socket.close(),

    /** Runs in the page, awaits a promise, and returns the value. */
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "the page threw");
      }
      return result.result.value;
    },

    async goto(url, settle = 1500) {
      await send("Page.navigate", { url });
      await sleep(settle);
    },

    async size(width, height, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: mobile ? 2 : 1,
        mobile,
      });
    },

    /** A PNG of the viewport, or beyond it. */
    async shot(file, beyond = false) {
      const result = await send("Page.captureScreenshot", {
        format: "png",
        ...(beyond ? { captureBeyondViewport: true } : {}),
      });
      writeFileSync(file, Buffer.from(result.data, "base64"));
      return file;
    },
  };
  return page;
}
