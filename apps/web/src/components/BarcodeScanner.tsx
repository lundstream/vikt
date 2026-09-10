import { useEffect } from "react";
import { useBarcodeScanner } from "../lib/scanner.js";
import { t } from "../i18n/index.js";

/**
 * The camera sheet.
 *
 * Starts on mount so scanning is one tap from the logging screen rather than
 * two. Every unsupported case gets its own message, because the remedies are
 * completely different: an insecure origin is a developer problem, a denied
 * permission is a settings problem, and no camera at all means typing instead.
 */
export function BarcodeScanner({
  onResult,
  onClose,
}: {
  onResult: (barcode: string) => void;
  onClose: () => void;
}) {
  const { state, videoRef, start, stop } = useBarcodeScanner(onResult);

  useEffect(() => {
    void start();
    return () => stop();
  }, [start, stop]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          playsInline
          muted
          aria-label={t("food.cameraView")}
        />

        {/* A window to aim through, so people know where to point. */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="h-28 w-64 rounded-lg border-2 border-paper/80" />
        </div>

        {state.status === "unsupported" ? (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <p role="alert" className="max-w-prose text-note text-paper">
              {t(unsupportedKey(state.reason))}
            </p>
          </div>
        ) : null}
      </div>

      <div className="bg-ink px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
        <p className="mb-3 text-center text-micro text-paper/70">
          {state.status === "scanning"
            ? t("food.scanHint")
            : state.status === "starting"
              ? t("food.cameraStarting")
              : ""}
        </p>
        {/*
          The secondary style with the two colours the surface demands, rather
          than a button hand-rolled from scratch (D123). This bar is `bg-ink`
          on purpose — a dark strip under a live viewfinder glares less and
          reads better against it — so `border-edge text-ink` would be
          dark-on-dark. Everything else about the button, the height that
          clears a thumb, the radius, the focus ring and the disabled state,
          comes from the shared class and stays in step with it.
        */}
        <button
          type="button"
          className="btn-secondary border-paper/40 text-paper hover:border-paper"
          onClick={onClose}
        >
          {t("quick.cancel")}
        </button>
      </div>
    </div>
  );
}

function unsupportedKey(reason: "insecure" | "no-camera" | "denied" | "failed") {
  switch (reason) {
    case "insecure":
      return "food.cameraInsecure" as const;
    case "denied":
      return "food.cameraDenied" as const;
    case "no-camera":
      return "food.cameraMissing" as const;
    case "failed":
      return "food.cameraFailed" as const;
  }
}
