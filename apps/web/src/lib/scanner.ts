import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Barcode scanning.
 *
 * `BarcodeDetector` where it exists — Chromium on Android, and nowhere else —
 * with a ZXing fallback everywhere it does not. Both need the camera, and
 * **both are secure-context only**: over plain http on a LAN address
 * `navigator.mediaDevices` is not merely missing `getUserMedia`, the whole
 * object is `undefined`. See `docs/secure-context.md`; the dev server serves
 * HTTPS for exactly this reason.
 *
 * ZXing is loaded lazily, so a phone with the native detector never downloads
 * it — this is the highest-traffic screen and the library is not small.
 */

export type ScannerState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "scanning"; engine: "native" | "zxing" }
  | { status: "unsupported"; reason: "insecure" | "no-camera" | "denied" | "failed" };

export function barcodeSupport(): {
  secureContext: boolean;
  camera: boolean;
  native: boolean;
} {
  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  const camera =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";
  const native = typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector !== "undefined";
  return { secureContext, camera, native };
}

type BarcodeDetectorLike = {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
};

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];

/**
 * Runs the camera and calls `onResult` with the first barcode it reads.
 *
 * Stops itself on unmount, on a result, and when the tab is hidden — a camera
 * left running in the background is both a battery drain and, on a phone, a
 * small red light that makes people uneasy.
 */
export function useBarcodeScanner(onResult: (barcode: string) => void) {
  const [state, setState] = useState<ScannerState>({ status: "idle" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stoppedRef = useRef(false);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;

  const stop = useCallback(() => {
    stoppedRef.current = true;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    setState({ status: "idle" });
  }, []);

  const start = useCallback(async () => {
    const support = barcodeSupport();
    if (!support.secureContext) {
      setState({ status: "unsupported", reason: "insecure" });
      return;
    }
    if (!support.camera) {
      setState({ status: "unsupported", reason: "no-camera" });
      return;
    }

    stoppedRef.current = false;
    setState({ status: "starting" });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // The rear camera, which is the one pointed at a barcode.
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (error) {
      const denied = (error as DOMException)?.name === "NotAllowedError";
      setState({ status: "unsupported", reason: denied ? "denied" : "failed" });
      return;
    }

    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    await video.play().catch(() => undefined);

    if (support.native) {
      setState({ status: "scanning", engine: "native" });
      void runNative(video, stoppedRef, (code) => {
        resultRef.current(code);
        stop();
      });
      return;
    }

    setState({ status: "scanning", engine: "zxing" });
    void runZxing(video, stoppedRef, (code) => {
      resultRef.current(code);
      stop();
    });
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  // A camera running behind a hidden tab helps nobody.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stop]);

  return { state, videoRef, start, stop };
}

async function runNative(
  video: HTMLVideoElement,
  stopped: { current: boolean },
  onResult: (code: string) => void,
): Promise<void> {
  const Detector = (globalThis as unknown as {
    BarcodeDetector: new (options: { formats: string[] }) => BarcodeDetectorLike;
  }).BarcodeDetector;
  const detector = new Detector({ formats: FORMATS });

  while (!stopped.current) {
    try {
      const [first] = await detector.detect(video);
      if (first?.rawValue) return onResult(first.rawValue);
    } catch {
      // A frame that cannot be decoded is the normal case, not an error.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/**
 * ZXing, loaded only when the native detector is missing.
 *
 * The dynamic import keeps it out of the initial bundle for the phones that do
 * not need it, which is the ones this screen is designed around.
 */
async function runZxing(
  video: HTMLVideoElement,
  stopped: { current: boolean },
  onResult: (code: string) => void,
): Promise<void> {
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  const reader = new BrowserMultiFormatReader();

  await reader.decodeFromVideoElement(video, (result) => {
    if (stopped.current || !result) return;
    onResult(result.getText());
  });
}
