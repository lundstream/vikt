import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    migrate: "src/db/migrate.ts",
    invite: "src/scripts/invite.ts",
    // `docker exec vikt-api-1 node dist/restore-check.js` on the host (D168).
    "restore-check": "src/scripts/restore-check.ts",
    /*
      The release's Nyheter post, run in the container the same way (D183).

      A script that has to run in production has to be **built into the image**.
      This one was written and wired as `pnpm --filter api news:publish`, which
      works on a workstation and cannot work there: `tsx` is a dev dependency
      and a production image has none, and the container has no pnpm either.
      The release stopped at its last step on `sh: 1: tsx: not found`, after the
      deploy had already succeeded.
    */
    "news-publish": "src/scripts/news-publish.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  // `shared` is a workspace package published as TypeScript source, so it has
  // to be bundled in rather than left as a runtime import.
  noExternal: ["shared"],
});
