/**
 * Shared setup for every test file, guard and render alike.
 *
 * Only two things, both of which exist because jsdom is not a browser:
 *
 * `matchMedia` is missing entirely, and `usePrefersReducedMotion` and the theme
 * hook both call it on mount. Without it every route that draws a chart throws
 * before rendering anything, which would make these tests fail for a reason
 * that has nothing to do with the code under test.
 *
 * `ResizeObserver` is missing too, and Recharts' responsive container needs it.
 * A stub that never fires is correct here: the container falls back to its
 * given dimensions, which in a smoke test is all that is wanted.
 */
if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof globalThis.matchMedia;
}

if (typeof globalThis.ResizeObserver !== "function") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}
