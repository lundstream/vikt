import { defineConfig } from "vitest/config";

/**
 * Two kinds of test live here.
 *
 * The guards (`test/*.test.ts`) read source and never mount anything: copy
 * style, class names, number formatting, the tick maths. They run in Node.
 *
 * The smoke renders (`test/render/*.test.tsx`) mount each route and assert it
 * is not blank. They need a DOM, which is set per-file with a docblock rather
 * than globally: making everything jsdom would slow the guards down for nothing.
 *
 * No `@vitejs/plugin-react` here, deliberately. Vitest's own esbuild transform
 * reads `jsx: "react-jsx"` from tsconfig and handles the JSX these tests need;
 * adding the plugin drags in `vite`'s types from `vitest/config`, which resolve
 * to v5 while the app builds on v6, and the config file itself stops
 * typechecking. Fast refresh is a dev-server concern and has no place in a test
 * run anyway.
 */
export default defineConfig({
  resolve: {
    alias: {
      /**
       * `vite-plugin-pwa` is not in the test pipeline, so the virtual module it
       * provides has to be stubbed for any test that mounts `App`.
       */
      "virtual:pwa-register": new URL(
        "./test/render/pwa-register-stub.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    globals: true,
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
    ],
    setupFiles: ["./test/render/setup.ts"],
  },
});
