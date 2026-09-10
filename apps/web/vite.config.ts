import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import {
  APP_NAME_PLACEHOLDER,
  DEFAULT_APP_NAME,
  appNamePlugin,
} from "./vite-plugin-app-name.js";

const API_TARGET = process.env.VITE_API_PROXY ?? "http://127.0.0.1:3000";

/**
 * HTTPS in development, when the certificate is there.
 *
 * Not a nicety. `BarcodeDetector`, `getUserMedia` and `crypto.randomUUID` are
 * all **secure-context only**, so over plain http on a LAN address they simply
 * do not exist — and the phone on a LAN address is exactly how this app gets
 * tested. Phase 3's barcode scanner is untestable without this, and D18 was the
 * same failure in a smaller form. See `docs/secure-context.md`.
 *
 * `pnpm dev:certs` writes these with mkcert. Absent, the server falls back to
 * http and says why, so a fresh clone still runs.
 */
const CERT_DIR = path.resolve(import.meta.dirname, "../../infra/certs");
const CERT = path.join(CERT_DIR, "dev-cert.pem");
const KEY = path.join(CERT_DIR, "dev-key.pem");

function httpsConfig(serving: boolean) {
  if (!existsSync(CERT) || !existsSync(KEY)) {
    // Only worth saying when a server is about to start. `vite build` has no
    // business printing a certificate warning, least of all inside Docker.
    if (serving) console.warn(
      [
        "",
        "  No dev certificate found — serving plain http.",
        "  The camera and the barcode scanner will not exist on a phone.",
        "  Run `pnpm dev:certs`, then `mkcert -install` once.",
        "",
      ].join("\n"),
    );
    return undefined;
  }
  return { cert: readFileSync(CERT), key: readFileSync(KEY) };
}

/**
 * A build identity the running app can state.
 *
 * There was no way to ask an installed PWA which build it was running, and that
 * cost real time: `registerType: "prompt"` keeps the old bundle until someone
 * accepts an update, so an installed app can sit on a build indefinitely — and
 * during one verification pass `vite preview` served a bundle three builds old
 * while a control that had just been added was missing from the DOM, with
 * nothing on screen to say so.
 *
 * A timestamp plus a short random suffix rather than a git hash, because this
 * tree is not always a git checkout and a build id that is sometimes absent is
 * a build id nobody trusts. It only has to answer one question: is this the
 * same build I just deployed.
 */
const BUILD_ID = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

/**
 * `vite preview` falls back to the landing page for deep links under `/app/`.
 *
 * Vite's SPA fallback only knows about `index.html` at the root, so a request
 * for `/app/food` is answered with the landing bundle. Production does not do
 * this — nginx has `try_files $uri $uri/ /app/index.html` for exactly this
 * reason — so the preview server was quietly a different application from the
 * one it exists to stand in for.
 *
 * It cost a verification pass. The fast-path harness deep-links to
 * `/app/food`, got the landing page, waited for a control that was never going
 * to appear, and hung. The number it should have produced was not wrong; there
 * was no number at all, and the reason was in the server rather than the app.
 *
 * This mirrors the nginx rule, and only for navigations: an asset that is
 * genuinely missing must still 404 rather than be answered with HTML.
 *
 * The name substitution is here for the same reason. `vite build` leaves
 * `__APP_NAME__` in the HTML and the manifest on purpose (D13), and nginx fills
 * it in at container start. A preview server that skipped that step would serve
 * an app called `__APP_NAME__`, which is exactly the defect this pass was asked
 * to fix, found on a phone rather than here.
 */
/**
 * The public text pages (D106), which are the landing bundle on another path.
 *
 * nginx maps them to `/index.html` with a `location =` block each. Vite serves
 * `index.html` only at the root, so without this both are a 404 in dev and in
 * preview, which is a difference from production of exactly the kind the
 * preview server exists to not have.
 */
const PUBLIC_PAGES = ["/integritet", "/villkor"];

/**
 * `/kod`, which is the same bundle again but behind a flag (D127).
 *
 * nginx serves it only where `REQUEST_ENABLED` is on and returns 404 otherwise.
 * Mirrored here rather than always-on, because "the path does not exist unless
 * it is switched on" is the whole point of that decision, and a dev server that
 * served it unconditionally would be the one place the flag could be believed
 * to work without ever having been tried.
 */
function requestEnabled(): boolean {
  return ["true", "1", "yes"].includes((process.env.REQUEST_ENABLED ?? "").trim().toLowerCase());
}

function rewritePublicPage(url: string): string | null {
  const path = url.split("?")[0]?.replace(/\/+$/, "") ?? "";
  if (path === "/kod") return requestEnabled() ? "/index.html" : null;
  return PUBLIC_PAGES.includes(path) ? "/index.html" : null;
}

function nginxLikePreviewPlugin(): Plugin {
  const appName = process.env.APP_NAME?.trim() || DEFAULT_APP_NAME;

  return {
    name: "vikt-preview-like-nginx",

    // Dev too: the same two paths, the same rewrite.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if ((url.split("?")[0]?.replace(/\/+$/, "") ?? "") === "/kod" && !requestEnabled()) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const rewritten = rewritePublicPage(url);
        if (rewritten) req.url = rewritten;
        next();
      });
    },

    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";

        /**
         * `/kod` with the flag off is a 404, not a fallback (D127).
         *
         * The preview server's SPA fallback answers any unknown path with the
         * landing HTML, so without this the path existed whatever the flag
         * said, and the one thing the flag is for could never be tried here.
         * nginx returns 404; so does this.
         */
        if ((url.split("?")[0]?.replace(/\/+$/, "") ?? "") === "/kod" && !requestEnabled()) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        const rewritten = rewritePublicPage(url);
        if (rewritten) {
          req.url = rewritten;
          return next();
        }
        const wantsHtml = (req.headers.accept ?? "").includes("text/html");
        if (wantsHtml && url.startsWith("/app/") && !path.extname(url.split("?")[0] ?? "")) {
          req.url = "/app/index.html";
        }
        next();
      });

      // The same file types `30-app-name.sh` rewrites, and the same
      // substitution, so what preview serves is what production would.
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        const named = /\.(?:html|webmanifest|json)$/.test(url);
        const navigation = (req.headers.accept ?? "").includes("text/html");
        if (!named && !navigation) return next();

        /**
         * Ask for it uncompressed, because this rewrites the bytes.
         *
         * sirv serves a gzipped body when the client accepts one, and the
         * substitution below is a string replace: run over gzip it produces
         * bytes that are still labelled `Content-Encoding: gzip` and are no
         * longer valid gzip. The browser then fails the navigation with
         * `ERR_CONTENT_DECODING_FAILED` and renders nothing at all, while
         * `curl` — which does not ask for compression unless told to — sees a
         * perfectly good page. That difference is why this survived: every
         * check of the preview server had been made with curl.
         *
         * Only these responses are affected. Scripts and stylesheets are not
         * intercepted and stay compressed.
         */
        // `identity` rather than deleting it: a missing header is read as
        // "anything goes" by some compressors, while `identity` is the
        // explicit way to ask for the bytes as they are.
        req.headers["accept-encoding"] = "identity";

        const write = res.write.bind(res);
        const end = res.end.bind(res);
        const writeHead = res.writeHead.bind(res);
        const chunks: Buffer[] = [];

        /**
         * The substitution changes the body's length, so the original
         * `Content-Length` must never reach the client.
         *
         * `__APP_NAME__` is twelve characters and "Vikt" is four, so a static
         * file served with the length sirv measured leaves the browser waiting
         * for eight bytes per occurrence that will never arrive. The page then
         * sits at `readyState: "loading"` forever, which looks like a hung app
         * and is a hung preview server. Dropping the header makes Node use
         * chunked encoding, which is correct whatever the substitution does.
         */
        res.writeHead = ((status: number, ...rest: unknown[]) => {
          res.removeHeader("Content-Length");
          const headers = rest.find((value) => value && typeof value === "object");
          if (headers && !Array.isArray(headers)) {
            for (const key of Object.keys(headers as Record<string, unknown>)) {
              if (key.toLowerCase() === "content-length") {
                delete (headers as Record<string, unknown>)[key];
              }
            }
          }
          return (writeHead as (...args: unknown[]) => typeof res)(status, ...rest);
        }) as typeof res.writeHead;

        res.write = ((chunk: unknown, ...rest: unknown[]) => {
          if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
            chunks.push(Buffer.from(chunk as string | Buffer));
            return true;
          }
          return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof res.write;

        res.end = ((chunk?: unknown, ...rest: unknown[]) => {
          if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
            chunks.push(Buffer.from(chunk as string | Buffer));
          }
          const body = Buffer.concat(chunks).toString("utf8");
          const filled = body.replaceAll(APP_NAME_PLACEHOLDER, appName);
          res.write = write;
          res.end = end;
          res.writeHead = writeHead;

          /**
           * No `Content-Length` is set here either.
           *
           * Setting one after `writeHead` has run throws
           * `ERR_HTTP_HEADERS_SENT` from inside a stream callback, which is an
           * uncaught exception that kills the preview server on its first
           * static file. The header was stripped above instead, so this
           * response is chunked and needs no length.
           */
          return end(filled, ...(rest as []));
        }) as typeof res.end;

        next();
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    appNamePlugin(),
    nginxLikePreviewPlugin(),

    /**
     * The service worker only. `manifest: false` is deliberate and load-bearing
     * for D13: the plugin would otherwise generate a manifest with the app name
     * baked in at build time, and the whole point of `public/manifest.webmanifest`
     * is that nginx substitutes `__APP_NAME__` at container start, so renaming
     * the app is an env var rather than a rebuild.
     *
     * `registerType: "prompt"` rather than `autoUpdate`: this app is used at
     * seven in the morning with a phone in one hand, and a page that reloads
     * itself mid-entry loses what was being typed. The update is offered and
     * the user takes it when they are not in the middle of something.
     */
    /**
     * The app's own SPA fallback in development (D90).
     *
     * Vite serves `index.html` for any HTML request it cannot resolve to a
     * file, which with two entries means every client-side route under `/app/`
     * was answered with the **landing page**. Production does not have this
     * problem because nginx has an explicit `location /app/` block; this is the
     * same rule, so the two behave alike rather than only looking alike.
     */
    ({
      name: "vikt-app-fallback",
      apply: "serve",
      configureServer(server: ViteDevServer) {
        server.middlewares.use((req, _res, next) => {
          const url = req.url ?? "";
          const wantsHtml = (req.headers.accept ?? "").includes("text/html");
          if (wantsHtml && url.startsWith("/app") && !url.includes(".")) {
            req.url = "/app/index.html";
          }
          next();
        });
      },
    } satisfies Plugin),
    VitePWA({
      registerType: "prompt",
      /**
       * The worker owns `/app/` and nothing above it (D90).
       *
       * The landing page at `/` must never be served from a cache: it is the
       * public face of the site, it changes independently of the app, and an
       * installed app that could answer for `/` would show a visitor a page
       * from whenever the owner last accepted an update. Scoping the worker is
       * what makes that structurally impossible rather than merely unlikely.
       */
      scope: "/app/",
      manifest: false,
      injectRegister: null,
      includeAssets: ["icon.svg", "icon-maskable.svg"],
      workbox: {
        // The app shell. Everything else is data and goes through the queue.
        // woff2 included: the fonts are local now, and an offline app that
        // falls back to a system sans is the thing this phase exists to stop.
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        // The ZXing chunk is 454 kB and only phones without BarcodeDetector
        // ever fetch it; precaching it would cost every install that bandwidth.
        globIgnores: ["**/zxing*", "**/*.map"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: "/app/index.html",
        // Never serve a cached API response. A stale maintenance figure
        // presented as current is the one thing §3 rules out, so the app asks
        // the network and says plainly when it could not reach it.
        // The API, and the landing page and everything it loads. A fallback
        // that answered `/` with the app shell would defeat the scope.
        navigateFallbackDenylist: [/^\/api\//, /^\/$/, /^\/screens\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: "NetworkOnly",
          },
        ],
      },
      devOptions: {
        // Off in dev: a service worker caching an app that changes on every
        // save is a debugging session waiting to happen.
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    https: httpsConfig(command === "serve"),
    // `--host` in the dev script binds 0.0.0.0 so the phone can reach the dev
    // server over the LAN. The API itself stays on loopback: the phone talks to
    // Vite, and Vite proxies /api to 127.0.0.1.
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
  /**
   * `vite preview` serves the built bundle with the same HTTPS certificate and
   * API proxy as the dev server. That is what the tap-count measurements run
   * against: on the dev server every module is a separate request, so a phone
   * on a throttled connection spends seventeen seconds fetching hundreds of
   * files that production ships as three.
   */
  preview: {
    port: 4173,
    // Bound to every interface so the phone can reach the built bundle.
    host: true,
    https: httpsConfig(true),
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false },
    },
  },
  /**
   * Two HTML entries (D90): the landing page at `/`, the app at `/app/`.
   *
   * One Vite project rather than two, so both share the tokens, the fonts and
   * the component layer and cannot drift apart visually. They share nothing
   * else: the landing bundle imports no router, no query client and no service
   * worker registration.
   */
  build: {
    rollupOptions: {
      input: {
        landing: path.resolve(import.meta.dirname, "index.html"),
        app: path.resolve(import.meta.dirname, "app/index.html"),
      },
    },
    outDir: "dist",
    sourcemap: true,
  },
}));
