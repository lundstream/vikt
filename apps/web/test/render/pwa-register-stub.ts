/**
 * Stands in for `virtual:pwa-register`, which only exists while
 * `vite-plugin-pwa` is in the pipeline and therefore not in a test run.
 *
 * `App` imports it through `useServiceWorker`, so a route test that mounts the
 * whole app cannot resolve it. The stub registers nothing and never reports an
 * update, which is the correct behaviour for a jsdom page with no service
 * worker: the update banner should not appear.
 */
export function registerSW(_options?: unknown): (reload?: boolean) => Promise<void> {
  return async () => {};
}
