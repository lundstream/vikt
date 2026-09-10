import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { barcodeSupport } from "../lib/scanner.js";
import { db } from "../lib/queue/db.js";
import { SaveStalled, withTimeout } from "../lib/queue/enqueue.js";
import { clientUuid } from "../lib/uuid.js";
import { LOCALE, t } from "../i18n/index.js";

/**
 * What this browser actually does, on this URL, on this device.
 *
 * It exists because a handful of questions cannot be answered from a
 * development machine and have been open since Phase 3 as a result:
 * `BarcodeDetector` does not exist in headless Edge, a service worker in an
 * installed PWA is not the same object as one in a tab, native controls are
 * drawn by the OS, and a `<input type="date">` takes its format from the OS
 * locale rather than from `lang`.
 *
 * The design goal is **one visit, no guesswork**. Everything answerable without
 * a tap is answered on load; everything else is a button that writes its own
 * result next to it. The summary at the foot is a block of text meant to be
 * copied straight into STATE.md, so the record is what the phone said rather
 * than what someone remembered it saying.
 *
 * Deliberately not linked from anywhere. It is a tool, not a feature.
 */

type Check = { label: string; value: string; note?: string };

/**
 * How long each step of the save probe may take.
 *
 * Deliberately longer than the app's own budgets. The probe is meant to
 * *measure* a stall, so cutting it off at the same moment the app does would
 * report "tog slut" for every step the app would also have given up on, and
 * would not say whether it was about to answer.
 */
const PROBE_BUDGET_MS = 10000;

/**
 * The build this bundle was made from.
 *
 * Read through a guard because the constant is injected by Vite's `define` and
 * is therefore absent under the test runner, where a bare reference would be a
 * ReferenceError at module scope and would take the whole page down.
 */
const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

export function Diagnostics() {
  const support = barcodeSupport();

  const [formats, setFormats] = useState<string | null>(null);
  const [cameraResult, setCameraResult] = useState<string | null>(null);
  const [sw, setSw] = useState<string | null>(null);
  const [queue, setQueue] = useState<string | null>(null);
  const [dateFormat, setDateFormat] = useState<string | null>(null);
  const [tapLog, setTapLog] = useState<string[]>([]);
  const [saveProbe, setSaveProbe] = useState<string | null>(null);
  const [storage, setStorage] = useState<string | null>(null);

  /**
   * How the OS actually renders a date input.
   *
   * Read from the shadow DOM's text rather than from the value, because the
   * value is always ISO. What is wanted is the *displayed* order, which is the
   * thing that looked wrong: `09/02/2026` on a Swedish interface. There is no
   * API for it, so the input is rendered off-screen with a known date and its
   * rendered text is read back.
   */
  useEffect(() => {
    const probe = document.createElement("input");
    probe.type = "date";
    probe.value = "2026-03-04";
    probe.style.position = "fixed";
    probe.style.left = "-9999px";
    document.body.append(probe);

    // A frame, so the OS has drawn it.
    const id = requestAnimationFrame(() => {
      const shown = probe.shadowRoot?.textContent?.trim() ?? "";
      setDateFormat(
        shown === ""
          ? `okänt (value=${probe.value}, typ stöds=${probe.type === "date"})`
          : shown,
      );
      probe.remove();
    });

    return () => {
      cancelAnimationFrame(id);
      probe.remove();
    };
  }, []);

  async function checkFormats() {
    const Detector = (
      globalThis as { BarcodeDetector?: { getSupportedFormats(): Promise<string[]> } }
    ).BarcodeDetector;
    if (!Detector) {
      setFormats("BarcodeDetector saknas i den här webbläsaren");
      return;
    }
    try {
      setFormats((await Detector.getSupportedFormats()).join(", "));
    } catch (error) {
      setFormats(`fel: ${(error as Error).message}`);
    }
  }

  async function checkCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      const label = stream.getVideoTracks()[0]?.label ?? "okänd";
      for (const track of stream.getTracks()) track.stop();
      setCameraResult(label);
    } catch (error) {
      setCameraResult(`nekad: ${(error as Error).name}`);
    }
  }

  /**
   * The service worker, as the installed app sees it.
   *
   * Registration alone is not the answer: a controller can be absent on the
   * very first load, and a stale one is the difference between "the PWA has a
   * service worker" and "the PWA is running code from three deploys ago".
   */
  async function checkServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      setSw("serviceWorker saknas i navigator");
      return;
    }
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const controller = navigator.serviceWorker.controller;
      const caches_ = "caches" in globalThis ? await caches.keys() : [];

      setSw(
        [
          `registreringar: ${registrations.length}`,
          `scope: ${registrations[0]?.scope ?? "ingen registrering"}`,
          `aktiv: ${registrations[0]?.active?.state ?? "ingen"}`,
          `väntande: ${registrations[0]?.waiting?.state ?? "ingen"}`,
          `controller: ${controller ? new URL(controller.scriptURL).pathname : "ingen"}`,
          `cachelager: ${caches_.length === 0 ? "inga" : caches_.join(", ")}`,
        ].join(" · "),
      );
    } catch (error) {
      setSw(`fel: ${(error as Error).message}`);
    }
  }


  /**
   * The save path, step by step, with a stopwatch on each step.
   *
   * This exists because of a report the rest of this page could not answer:
   * logging food hangs on "Sparar…" on a phone and works on every desktop
   * browser tried. Counting the rows already in the queue says nothing about
   * *why* a write into it never returns, and the three steps of a save have
   * completely different causes when they stall.
   *
   * So each is timed separately and none of them is allowed to hang the probe:
   *
   *  - **opening the database.** Blocked by another connection, or refused by a
   *    browser that will not grant storage. Milliseconds when it works;
   *  - **writing a row.** The step that IndexedDB stalls on when it stalls,
   *    which on some phones happens after the app has been backgrounded;
   *  - **the network.** A POST that never answers, which on a phone means the
   *    tunnel and not the code.
   *
   * The network step is a `GET /api/health`, not a real write. A diagnostic
   * that logs food to find out whether logging works would put a row in
   * someone's day every time they ran it.
   *
   * Whichever line reads "tog slut" is the answer, and it is the line to bring
   * back here.
   */
  /**
   * How much room the origin has, which is the number missing when a write
   * stalls (D118).
   *
   * A save probe that reads "1 öppna databasen: 1 ms · 2 skriv en rad: tog slut
   * efter 10000 ms · 3 nå servern: 115 ms" says the database opens, the network
   * is fine, and a single row will not go in. That leaves two explanations and
   * no way to tell them apart from the phone: the origin is out of room, or its
   * storage is wedged and needs clearing. `navigator.storage.estimate()`
   * separates them in one line, and the app had no way to ask.
   *
   * `persisted()` too, because a bucket the browser considers evictable behaves
   * differently under pressure than one it has promised to keep, and "best
   * effort" is the default that nobody chose.
   *
   * Run on load rather than behind a button: the person reading this screen is
   * already here because something failed, and a number they have to ask for is
   * a number they will not have when they report it.
   */
  async function checkStorage() {
    try {
      if (!navigator.storage?.estimate) {
        setStorage(t("diag.storageUnsupported"));
        return;
      }

      const { usage, quota } = await navigator.storage.estimate();
      const persisted = (await navigator.storage.persisted?.()) ?? false;

      if (usage === undefined || quota === undefined) {
        setStorage(t("diag.storageUnknown"));
        return;
      }

      const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      const share = quota === 0 ? 0 : Math.round((usage / quota) * 100);

      setStorage(
        `${mb(usage)} ${t("diag.storageOf")} ${mb(quota)} (${share} %), ` +
          (persisted ? t("diag.storagePersisted") : t("diag.storageBestEffort")),
      );
    } catch (error) {
      setStorage(`fel: ${(error as Error).message}`);
    }
  }

  // Once, on load. Nothing on this screen changes the number, and the person
  // reading it is already here because something failed.
  useEffect(() => {
    void checkStorage();
  }, []);

  async function checkSavePath() {
    setSaveProbe(t("diag.running"));
    const lines: string[] = [];

    const time = async (label: string, work: () => Promise<string>, budget: number) => {
      const started = Date.now();
      try {
        const detail = await withTimeout(work(), budget, "queue");
        lines.push(`${label}: ${Date.now() - started} ms, ${detail}`);
      } catch (error) {
        const stalled = error instanceof SaveStalled;
        lines.push(
          `${label}: ${stalled ? `tog slut efter ${budget} ms` : `fel, ${(error as Error).message}`}`,
        );
      }
      setSaveProbe(lines.join("\n"));
    };

    await time(
      t("diag.stepOpen"),
      async () => {
        await db.open();
        return `version ${db.verno}`;
      },
      PROBE_BUDGET_MS,
    );

    await time(
      t("diag.stepWrite"),
      async () => {
        /**
         * Written and then removed, in the real table, because a probe against
         * a different store would not touch the index that a real write goes
         * through and is exactly the kind of test that passes while the thing
         * it stands for is broken.
         */
        const uuid = `diagnostik-${clientUuid()}`;
        const id = await db.mutations.add({
          clientUuid: uuid,
          kind: "food-entry",
          body: {},
          localDate: "1970-01-01",
          timezone: "Europe/Stockholm",
          createdAt: new Date().toISOString(),
          status: "pending",
          attempts: 0,
          nextAttemptAt: null,
          failure: null,
        });
        await db.mutations.delete(id);
        return t("diag.wroteAndRemoved");
      },
      PROBE_BUDGET_MS,
    );

    await time(
      t("diag.stepNetwork"),
      async () => {
        const response = await fetch("/api/health", { credentials: "same-origin" });
        return `HTTP ${response.status}`;
      },
      PROBE_BUDGET_MS,
    );
  }

  /** Whether IndexedDB is actually usable here, and what is waiting in it. */
  async function checkQueue() {
    try {
      const pending = await db.mutations.where("status").equals("pending").count();
      const failed = await db.mutations.where("status").anyOf("failed", "conflict").count();
      const all = await db.mutations.count();
      setQueue(`totalt ${all} · väntar ${pending} · behöver hjälp ${failed}`);
    } catch (error) {
      setQueue(`IndexedDB otillgänglig: ${(error as Error).message}`);
    }
  }

  /**
   * The evidence for "Igen does nothing in the installed PWA".
   *
   * Three candidate causes were named, and they leave different traces, so this
   * records all three at once rather than testing one and guessing:
   *
   * - **touch versus click.** A `pointerdown` with no following `click` means
   *   the tap never became a click at all, which is a gesture or overlay
   *   problem, not a data one. A `click` that arrives means the handler ran and
   *   the failure is downstream;
   * - **standalone display mode.** Recorded on load, because "works in a tab,
   *   not in the installed app" is the whole shape of the report;
   * - **the service worker.** A `NetworkOnly` route that is nonetheless being
   *   answered from a cache, or a controller from an old deploy, shows up in
   *   the service worker line above.
   *
   * What to look at tomorrow, in order: press this button in the installed app.
   * If no `click` line appears, it is the gesture path. If `click` appears but
   * the fetch line says the request never left, it is the service worker. If
   * the fetch line shows a response, the write reached the server and the fault
   * is in the cache refresh, which is what D68 fixed.
   */
  function record(event: string) {
    setTapLog((log) => [
      ...log,
      `${new Date().toISOString().slice(11, 23)} ${event}`,
    ]);
  }

  async function probeWrite() {
    record("click");
    try {
      const response = await fetch("/api/food-entry/recent?limit=1", {
        credentials: "same-origin",
      });
      record(
        `fetch ${response.status} ${
          response.headers.get("x-cache") ?? response.type
        }`,
      );
    } catch (error) {
      record(`fetch kastade: ${(error as Error).name}`);
    }
  }

  const standalone =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as { standalone?: boolean }).standalone === true);

  /** The lines meant to be copied into STATE.md. */
  const summary: Check[] = [
    /**
     * First, because everything below it is worthless if the app is old.
     *
     * `registerType: "prompt"` means an installed PWA keeps its bundle until an
     * update is accepted, so "the fix is deployed" and "the phone has the fix"
     * are different facts, and until now there was no way to tell them apart
     * from the device. Compare this with the id printed by the deploy.
     */
    { label: t("diag.build"), value: BUILD_ID },
    { label: t("diag.device"), value: navigator.userAgent },
    {
      label: t("diag.mode"),
      value: standalone ? t("diag.modeStandalone") : t("diag.modeBrowser"),
    },
    { label: t("diag.language"), value: `${navigator.language} · ${LOCALE}` },
    { label: t("diag.secureContext"), value: yesNo(support.secureContext) },
    { label: t("diag.camera"), value: yesNo(support.camera) },
    { label: t("diag.native"), value: yesNo(support.native) },
    {
      label: t("diag.engine"),
      value:
        !support.secureContext || !support.camera
          ? t("diag.engineNone")
          : support.native
            ? t("diag.engineNative")
            : t("diag.engineZxing"),
    },
    { label: t("diag.formats"), value: formats ?? t("diag.notRun") },
    { label: t("diag.cameraLabel"), value: cameraResult ?? t("diag.notRun") },
    { label: t("diag.serviceWorker"), value: sw ?? t("diag.notRun") },
    { label: t("diag.queue"), value: queue ?? t("diag.notRun") },
    { label: t("diag.savePath"), value: saveProbe ?? t("diag.notRun") },
    {
      label: t("diag.storage"),
      value: storage ?? t("diag.notRun"),
      note: t("diag.storageNote"),
    },
    {
      label: t("diag.dateFormat"),
      value: dateFormat ?? t("app.loading"),
      note: "2026-03-04",
    },
  ];

  return (
    <main className="mx-auto w-full max-w-lg px-5 py-10">
      <Link className="text-note text-muted underline underline-offset-4" to="/">
        {t("nav.dashboard")}
      </Link>
      <h1 className="mt-4 text-title text-ink">{t("diag.title")}</h1>
      <p className="mt-2 max-w-prose text-note text-muted">{t("diag.intro")}</p>

      <dl className="mt-6 space-y-3 text-note">
        {summary.map((check) => (
          <div key={check.label}>
            <dt className="text-muted">
              {check.label}
              {check.note ? <span className="ml-2 text-micro">({check.note})</span> : null}
            </dt>
            <dd className="break-words text-ink">{check.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-8 space-y-3">
        <button type="button" className="btn" onClick={() => void checkFormats()}>
          {t("diag.checkFormats")}
        </button>
        <button type="button" className="btn" onClick={() => void checkCamera()}>
          {t("diag.checkCamera")}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="check-sw"
          onClick={() => void checkServiceWorker()}
        >
          {t("diag.checkServiceWorker")}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="check-queue"
          onClick={() => void checkQueue()}
        >
          {t("diag.checkQueue")}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-lg border border-edge px-4 text-note text-ink"
          data-testid="check-save-path"
          onClick={() => void checkSavePath()}
        >
          {t("diag.checkSavePath")}
        </button>
      </div>

      {/*
        The native controls, rendered rather than described. Whether the OS draws
        a select as a wheel, a sheet or a dropdown is not knowable from here; the
        check is that someone opens each one and says what happened.
      */}
      <section className="mt-10 border-t border-edge pt-6">
        <h2 className="text-base text-ink">{t("diag.nativeControls")}</h2>
        <p className="mt-1 max-w-prose text-micro text-muted">{t("diag.nativeControlsHint")}</p>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="label">{t("diag.controlSelect")}</span>
            <select className="select" defaultValue="b">
              <option value="a">Alternativ ett</option>
              <option value="b">Alternativ två</option>
              <option value="c">Alternativ tre</option>
            </select>
          </label>

          <label className="block">
            <span className="label">{t("diag.controlDate")}</span>
            <input type="date" className="field num" defaultValue="2026-03-04" />
          </label>

          <label className="flex items-center gap-3">
            <input type="checkbox" className="check" defaultChecked />
            <span className="text-note text-ink">{t("diag.controlCheckbox")}</span>
          </label>
        </div>
      </section>

      {/*
        The "Igen" investigation. Not a fix and not a guess: a button that leaves
        a trace for each of the three candidate causes.
      */}
      <section className="mt-10 border-t border-edge pt-6">
        <h2 className="text-base text-ink">{t("diag.tapTitle")}</h2>
        <p className="mt-1 max-w-prose text-micro text-muted">{t("diag.tapHint")}</p>

        <button
          type="button"
          data-testid="tap-probe"
          className="btn mt-4"
          onPointerDown={() => record("pointerdown")}
          onTouchStart={() => record("touchstart")}
          onClick={() => void probeWrite()}
        >
          {t("diag.tapProbe")}
        </button>

        {tapLog.length > 0 ? (
          <ol className="num mt-3 space-y-1 text-micro text-muted" data-testid="tap-log">
            {tapLog.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ol>
        ) : null}
      </section>

      <p className="mt-10 max-w-prose text-micro text-muted">{t("diag.copyHint")}</p>
      <pre
        className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border border-edge bg-card p-3 text-micro text-ink"
        data-testid="summary"
      >
        {summary.map((check) => `${check.label}: ${check.value}`).join("\n")}
        {tapLog.length > 0 ? `\nTryck: ${tapLog.join(" | ")}` : ""}
      </pre>
    </main>
  );
}

const yesNo = (value: boolean) => (value ? t("diag.yes") : t("diag.no"));
