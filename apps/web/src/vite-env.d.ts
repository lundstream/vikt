
/// <reference types="vite-plugin-pwa/client" />

/**
 * The build this bundle came from, stamped at build time.
 *
 * Declared here rather than imported, because it has to exist in the bundle
 * with no module to fetch: the question it answers is "is the installed app
 * running the code I just shipped", and a build id that arrives over the
 * network cannot answer it.
 */
declare const __BUILD_ID__: string;
