import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    migrate: "src/db/migrate.ts",
    invite: "src/scripts/invite.ts",
    // `docker exec vikt-api-1 node dist/restore-check.js` on the host (D168).
    "restore-check": "src/scripts/restore-check.ts",
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
