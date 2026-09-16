#!/usr/bin/env node
/**
 * The raw screenshots the landing page's phone pictures are framed from (D178).
 *
 *   pnpm shots:phone                    # against https://localhost:5173
 *   pnpm shots:phone -- https://host    # against something else
 *
 * Writes `docs/screens/raw/{oversikt,mat,framsteg}.png` at **440 x 956 CSS px,
 * device scale factor 3** (1320 x 2868), dark theme, scrolled to the top, no
 * browser chrome. Fredrik frames those three in his mockup tool, front view
 * only, and the framed results replace `docs/screens/*-portrait.png`, which is
 * what the page and the README both read.
 *
 * ## Why a script rather than three captures by hand
 *
 * The framed pictures go stale silently: nothing in CI notices when Översikt
 * changes and the page still shows last month's. Framing has to stay manual,
 * because a composed picture is not a capture, but **the raw input does not**,
 * and a repeatable command is the difference between "take them again" being a
 * five minute job and a half hour one.
 *
 * ## The assertions, and why they are in here
 *
 * These images are a stranger's first sight of the app, and the last pass fixed
 * three things that a screenshot showed and no test could see (D176). A
 * screenshot script is exactly where they can come back unnoticed, so each is
 * asserted **in the DOM, before the file is written**:
 *
 *  - the trend delta carries one decimal (§4.1), not two;
 *  - the day's kcal figure carries the nutrition token, not some other colour;
 *  - the estimate chip is lowercase, as the profile writes it.
 *
 * A failed assertion is a failed script and no file is written for that screen.
 * An assertion that never **ran** is also a failure: a figure that is absent
 * because nothing was logged today proves nothing, and silence is the failure
 * mode this repository has been caught by twice (§7). So the run ends by
 * checking that each of the three was exercised at least once, and says which
 * was not.
 *
 * ## The account
 *
 * `SEED_EMAIL` and `SEED_PASSWORD` from the environment, the same pair
 * `seed:dev` plants. They are read by name, passed to the page, and never
 * printed (§7). The screens need a **current** account: today's food log is
 * what puts a kcal figure on Översikt at all. If the assertions fail for that
 * reason the message says to re-seed rather than leaving you to guess.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs/screens/raw");

const ORIGIN = process.argv[2] ?? "https://localhost:5173";

/** The frame the mockup tool expects: a modern phone, at three times density. */
const VIEWPORT = { width: 440, height: 956, deviceScaleFactor: 3 };

const CHROME =
  process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ the account -- */

/**
 * The seeded account's credentials, by name, from the environment or `.env`.
 *
 * Read and handed to the page. Never printed, never written anywhere, and the
 * environment is never listed to find them (§7).
 */
function credentials() {
  const fromEnv = {
    email: process.env.SEED_EMAIL?.trim(),
    password: process.env.SEED_PASSWORD?.trim(),
  };
  if (fromEnv.email && fromEnv.password) return fromEnv;

  let text = "";
  try {
    text = readFileSync(path.join(ROOT, ".env"), "utf8");
  } catch {
    // No file. The check below reports the missing name, not the contents.
  }
  const read = (name) => {
    const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  };

  return {
    email: fromEnv.email ?? read("SEED_EMAIL") ?? "test@example.test",
    password: fromEnv.password ?? read("SEED_PASSWORD"),
  };
}

/* ------------------------------------------------------------ the verdict -- */

mkdirSync(OUT, { recursive: true });
const verdictPath = path.join(OUT, "verdict.txt");
writeFileSync(verdictPath, `phone shots ${new Date().toISOString()} origin=${ORIGIN}\n`);

/**
 * Every check, written down as it is made (§7). The exit code is read back off
 * this file at the end rather than counted in a variable, so a run that dies
 * half way through still leaves what it had established and the missing summary
 * line reads as "this did not finish".
 */
function record(line) {
  appendFileSync(verdictPath, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

/* ------------------------------------------------------------- the screens -- */

/**
 * What each screen has to be able to show before its picture is worth taking.
 *
 * `needs` names the checks this screen contributes, so the summary can tell
 * "passed" from "never ran".
 */
const SCREENS = [
  {
    name: "oversikt",
    url: "/app/",
    needs: ["one-decimal", "nutrition-token"],
    check: `(() => {
      const problems = [];
      const ran = [];

      const change = document.querySelector('[data-testid="trend-change"]');
      if (change === null) {
        problems.push("one-decimal: no trend delta on the screen, so the account has too little history");
      } else {
        const amount = (change.textContent || "").match(/(\\d+),(\\d+)\\s*kg/);
        if (amount === null) {
          problems.push("one-decimal: the trend delta does not read as a weight: " + change.textContent.trim());
        } else {
          ran.push("one-decimal");
          if (amount[2].length !== 1) {
            problems.push("one-decimal: the trend delta reads " + amount[0] + ", which is " + amount[2].length + " decimals");
          }
        }
      }

      const eaten = document.querySelector('[data-testid="day-eaten"]');
      if (eaten === null) {
        problems.push("nutrition-token: no kcal figure on the screen. Nothing is logged for today, so re-seed: pnpm --filter api seed:dev -- --days 90");
      } else {
        ran.push("nutrition-token");
        if (!eaten.classList.contains("text-nutrition")) {
          problems.push("nutrition-token: the kcal figure is " + eaten.className + ", which does not name nutrition");
        }
      }

      return JSON.stringify({ problems, ran });
    })()`,
  },
  {
    name: "mat",
    url: "/app/food",
    needs: ["lowercase-chip"],
    check: `(() => {
      const problems = [];
      const ran = [];
      const notes = [];

      /* The day's total under the title: Blåbär when there is one, Sten when
         there is not, which is the distinction being checked. */
      const total = [...document.querySelectorAll("p.num")].find((p) =>
        /kcal/.test(p.textContent || ""),
      );
      if (total === undefined) {
        /*
          Not a failure here, and the reason is worth knowing: Mat's total sums
          **food entries**, while seed:dev writes a manual intake row, which is
          what Översikt's figure counts. So a seeded account shows a figure on
          Översikt and "inget loggat i dag än" on Mat, and the token is checked
          on the screen that has one. Log a meal on the demo account if the
          picture should show a day with food in it.
        */
        notes.push("mat has no kcal total: the seed writes manual intake, not food entries");
      } else {
        ran.push("nutrition-token");
        if (!total.classList.contains("text-nutrition")) {
          problems.push("nutrition-token: Mat's kcal total is " + total.className + ", which does not name nutrition");
        }
      }

      const chips = [...document.querySelectorAll(".tag")].map((el) => (el.textContent || "").trim());
      const estimate = chips.find((text) => text.includes("≈"));
      if (estimate === undefined) {
        problems.push("lowercase-chip: no estimate chip on Mat, so nothing here says whether it is lowercase");
      } else {
        ran.push("lowercase-chip");
        /* The word after the ≈ and its space. Sentence case is what D176
           corrected: the profile writes it lowercase. */
        const word = estimate.replace(/^[^\\p{L}]+/u, "");
        if (word !== word.toLocaleLowerCase("sv")) {
          problems.push("lowercase-chip: the estimate chip reads " + JSON.stringify(estimate));
        }
      }

      return JSON.stringify({ problems, ran, notes });
    })()`,
  },
  {
    name: "framsteg",
    url: "/app/framsteg",
    needs: [],
    check: `JSON.stringify({ problems: [], ran: [] })`,
  },
];

/** Every check that has to have run somewhere before the set is worth keeping. */
const REQUIRED = ["one-decimal", "nutrition-token", "lowercase-chip"];

/* ------------------------------------------------------------- the browser -- */

const port = 9700 + Math.floor(Math.random() * 180);
const profile = mkdtempSync(path.join(tmpdir(), "vikt-phone-shots-"));

const child = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    // The development server is https with a certificate it made itself.
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
    // No scrollbar in the frame: the picture is of the app, not of a window.
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
  if (target === undefined) throw new Error("Chrome started but offered no page to drive");

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

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    evaluate: async (expression) =>
      (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
        .result?.value,
    close: () => socket.close(),
  };
}

const { email, password } = credentials();
if (!password) {
  record("FAIL SEED_PASSWORD is not set. It is read by name from the environment or .env.");
}

let client = null;
const exercised = new Set();

try {
  if (password) {
    client = await connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    /*
      Dark, and asserted rather than assumed. The account is the authority on
      the theme and `/api/me` overrides whatever the first paint used (D117), so
      emulating the OS preference is a request, not a guarantee. The check below
      is what makes it one.
    */
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });

    await client.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, mobile: true });
    await client.send("Page.navigate", { url: `${ORIGIN}/app/login` });
    await sleep(4500);

    await client.evaluate(`
      (() => { try { localStorage.setItem("vikt.theme", "dark"); } catch {} return 1; })()`);

    if (await client.evaluate(`!!document.querySelector("#password")`)) {
      /*
        The value setter rather than `el.value`: React reads its own tracker and
        ignores a value assigned around it, which is the long way to a form that
        submits two empty strings.
      */
      await client.evaluate(`
        (() => {
          const set = (selector, value) => {
            const el = document.querySelector(selector);
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          };
          set("#email", ${JSON.stringify(email)});
          set("#password", ${JSON.stringify(password)});
          document.querySelector("form").requestSubmit();
          return 1;
        })()`);
      await sleep(6000);
    }

    const signedIn = await client.evaluate(`!location.pathname.startsWith("/app/login")`);
    record(`signed-in ${signedIn === true}`);
    if (signedIn !== true) {
      record("FAIL could not sign in, so nothing below was checked or captured");
    } else {
      for (const screen of SCREENS) {
        await client.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, mobile: true });
        await client.send("Page.navigate", { url: ORIGIN + screen.url });
        await sleep(5200);
        await client.evaluate(`window.scrollTo(0, 0)`);
        /*
          Long enough for the route transition to finish. A capture taken while
          the section track is still sliding catches the previous screen ghosted
          behind this one, and a mockup is framed from whatever was in the file.
        */
        await sleep(1400);

        const dark = await client.evaluate(`document.documentElement.classList.contains("dark")`);
        const track = await client.evaluate(
          `document.querySelector('[data-testid=section-track]')?.style.transform ?? ""`,
        );
        const raw = await client.evaluate(screen.check);
        const parsed = JSON.parse(raw ?? `{"problems":["the check did not run"],"ran":[]}`);
        const { problems, ran } = parsed;
        for (const note of parsed.notes ?? []) record(`note ${screen.name} ${note}`);

        if (track !== "") {
          /* D154: a transform left at rest also pins every fixed sheet to the
             content column, so this is worth failing on rather than retrying. */
          problems.unshift(`settle: the section track is still at ${track}, so the screen is mid-transition`);
        }
        if (dark !== true) {
          problems.unshift(
            "theme: the app is not in the dark theme. The account's own setting wins over the " +
              "emulated one, so set it to Mörkt under Inställningar and run this again.",
          );
        }
        for (const check of ran) exercised.add(check);

        if (problems.length > 0) {
          for (const problem of problems) record(`FAIL ${screen.name} ${problem}`);
          continue;
        }

        const shot = await client.send("Page.captureScreenshot", { format: "png" });
        if (!shot?.data) {
          record(`FAIL ${screen.name} the capture came back empty`);
          continue;
        }

        const file = path.join(OUT, `${screen.name}.png`);
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        record(
          `ok   ${screen.name} ${VIEWPORT.width}x${VIEWPORT.height}@${VIEWPORT.deviceScaleFactor}x ` +
            `checked=${ran.length === 0 ? "-" : ran.join(",")} -> ${path.relative(ROOT, file).replaceAll("\\", "/")}`,
        );
      }
    }
  }

  /*
    A check that never ran is not a check that passed. This is the same reason
    `check-skips.mjs` exists: the suite that goes green because its subject was
    absent is the failure this project has been caught by twice.
  */
  for (const check of REQUIRED) {
    if (!exercised.has(check)) {
      record(`FAIL ${check} was never exercised on any screen, so nothing here holds it`);
    }
  }
} finally {
  client?.close();
  child.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome holds its profile for a moment on Windows; the run is done.
  }
}

/* The answer is read back off the file, never off a counter (§7). */
const verdict = readFileSync(verdictPath, "utf8");
const failures = verdict.split("\n").filter((line) => line.startsWith("FAIL"));
const taken = verdict.split("\n").filter((line) => line.startsWith("ok   ")).length;

appendFileSync(
  verdictPath,
  `summary screens=${taken}/${SCREENS.length} failed=${failures.length} complete=true\n`,
);
process.stdout.write(`summary screens=${taken}/${SCREENS.length} failed=${failures.length}\n`);

if (failures.length > 0) {
  process.stderr.write(
    "\nNo picture was written for a screen that failed its checks, on purpose: a raw shot " +
      "of a defect becomes a framed picture of it.\n",
  );
  process.exitCode = 1;
}
