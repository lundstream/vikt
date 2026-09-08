import { useEffect, useState } from "react";
import { registerSW } from "virtual:pwa-register";

/**
 * Service worker registration, and the update prompt.
 *
 * `registerType: "prompt"` in the Vite config means a new version waits rather
 * than taking over. That is deliberate: this app is used at seven in the
 * morning with a phone in one hand, and a page that reloads itself mid-entry
 * loses what was being typed. The update is offered, and taken when the user is
 * not in the middle of something.
 *
 * Registration is a no-op wherever service workers are unavailable, which
 * includes every insecure context. On a LAN address without a trusted
 * certificate the app simply runs without one, and the offline queue still
 * works because it is IndexedDB, not the cache.
 */
export function useServiceWorker(): {
  updateReady: boolean;
  applyUpdate: () => void;
} {
  const [updateReady, setUpdateReady] = useState(false);
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    /**
     * Evict any worker left over from before the move to /app/ (D93).
     *
     * A worker registered at scope `/` keeps controlling the whole origin
     * forever, and **uninstalling a PWA does not unregister it**. So an install
     * that predates the move goes on being served the old app shell from the
     * old cache at the old URL, which looks exactly like "the app still opens
     * at /" and survives every reinstall.
     *
     * Nothing else can clean this up: the landing page deliberately registers
     * no worker and so never runs any code that could, and the old worker is
     * the very thing answering for that page. The app is the only surface that
     * can reach it, so the app does.
     */
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        if (!registration.scope.endsWith("/app/")) {
          void registration.unregister();
        }
      }
    });

    const updateSW = registerSW({
      onNeedRefresh() {
        setUpdateReady(true);
        setUpdate(() => () => updateSW(true));
      },
    });
  }, []);

  return {
    updateReady,
    applyUpdate: () => {
      void update?.();
    },
  };
}
