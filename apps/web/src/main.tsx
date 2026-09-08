import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { LOCALE } from "./i18n/index.js";
import { applyTheme, cachedTheme } from "./lib/theme.js";
import "./styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      /**
       * Attempt the request even when the browser says there is no network,
       * and let it fail.
       *
       * React Query's default is to **pause** offline queries, which leaves
       * them `isPending` forever. That is a spinner that never resolves, which
       * §3 rules out as firmly as a stale number, and it is what kept the whole
       * app on "Laddar…" the first time the network was pulled in a browser.
       * Failing is also more honest: `navigator.onLine` reports a connection to
       * a captive portal and to a dropped tunnel, so the only reliable signal
       * is whether a request actually worked (D43).
       */
      networkMode: "always",
    },
    mutations: { networkMode: "always" },
  },
});

/**
 * The document language comes from the i18n layer rather than being a literal
 * in the markup, so `LOCALE` is the single place the app's language is decided
 * (D21: there is one language and no switcher).
 *
 * `lang` takes the language subtag, not the full locale: `sv`, not `sv-SE`.
 */
document.documentElement.lang = LOCALE.split("-")[0] ?? "sv";

/**
 * The first paint, from the cached choice (D117).
 *
 * The inline script in `app/index.html` has already done this before any module
 * loaded, which is the whole point of it. Repeating it here covers the case
 * where that script has not run: the landing bundle, a test harness mounting
 * the app directly, or a build where the markup changed and the script did not.
 *
 * Following the OS *while the app is open* is `ThemeApplier`'s job now, and it
 * only subscribes when the choice is `system`. It used to be an unconditional
 * listener here, which was right when following the OS was the only behaviour
 * and would now drag a chosen dark theme light at sunset.
 */
applyTheme(cachedTheme());

/**
 * Ask the browser to keep this origin's storage (D118).
 *
 * The diagnostics screen on the phone this was found on reported the bucket as
 * "kan rensas av webbläsaren": best effort, which is the default nobody chose.
 * An app whose whole offline story is a queue of writes somebody has made
 * should not have that queue sitting in a bucket the browser may drop under
 * pressure.
 *
 * A request, not a guarantee. Chrome grants it for an installed app or a site
 * with enough engagement and silently declines otherwise, and there is no way
 * to argue with the answer. Fire and forget: nothing here should delay the
 * first paint, and a refusal changes nothing about how the app behaves.
 */
void navigator.storage?.persist?.().catch(() => {});

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/*
        The app lives under /app/ (D90). Every route the app declares is
        relative to it, so nothing inside the router mentions the prefix and
        moving it again is one string.
      */}
      <BrowserRouter basename="/app">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
