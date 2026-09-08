import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * The app name is not final and must be changeable without a code edit, so it
 * never gets baked into the source.
 *
 * `index.html`, `app/index.html` and `public/app/manifest.webmanifest` carry the
 * literal placeholder `__APP_NAME__`. Two things fill it in:
 *
 *  - dev: this plugin, from `APP_NAME` in the environment;
 *  - production: `infra/nginx/30-app-name.sh`, which runs inside the nginx
 *    container at startup and rewrites the built files in place.
 *
 * So `vite build` deliberately leaves the placeholder intact. Changing the name
 * on the server is `APP_NAME=... docker compose up -d`, no rebuild. See
 * DECISIONS.md D13.
 *
 * ## The manifest is read from disk, never rebuilt here
 *
 * This plugin used to answer `/manifest.webmanifest` with a manifest it
 * composed itself. That made two manifests: the file, and a hand-written copy
 * that had to be remembered whenever the file changed. It was not remembered.
 * When D90 moved the app to `/app/` and D93 added the `id`, the copy kept
 * serving `start_url: "/"`, `scope: "/"`, no `id`, a light background colour
 * and one non-maskable icon, at a path nothing linked to any more — while the
 * real manifest, now at `/app/manifest.webmanifest`, was served straight off
 * disk with `__APP_NAME__` never substituted. The installed app on a phone was
 * called `__APP_NAME__`.
 *
 * So the rule is now the same one the rest of the file follows: the manifest on
 * disk is the only manifest, and the only thing done to it is the substitution.
 */
export const APP_NAME_PLACEHOLDER = "__APP_NAME__";
export const DEFAULT_APP_NAME = "Vikt";

/** Where the manifest lives, and therefore the one URL that serves it. */
export const MANIFEST_URL = "/app/manifest.webmanifest";
const MANIFEST_FILE = path.resolve(import.meta.dirname, "public/app/manifest.webmanifest");

export function appNamePlugin(): Plugin {
  const appName = process.env.APP_NAME?.trim() || DEFAULT_APP_NAME;

  return {
    name: "app-name",
    // Serve only. The build keeps the placeholder for nginx to substitute.
    apply: "serve",

    transformIndexHtml(html) {
      return html.replaceAll(APP_NAME_PLACEHOLDER, appName);
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Query strings and the trailing-slash form both reach the same file.
        const url = (req.url ?? "").split("?")[0];
        if (url !== MANIFEST_URL) return next();

        if (!existsSync(MANIFEST_FILE)) return next();
        const manifest = readFileSync(MANIFEST_FILE, "utf8").replaceAll(
          APP_NAME_PLACEHOLDER,
          appName,
        );

        res.setHeader("Content-Type", "application/manifest+json");
        // Never cached in development: a stale manifest is how an installed app
        // ends up identified as something it no longer is (D93).
        res.setHeader("Cache-Control", "no-store");
        res.end(manifest);
      });
    },
  };
}
