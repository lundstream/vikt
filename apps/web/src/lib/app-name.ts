/**
 * The app name comes from the `app-name` meta tag in index.html, which is
 * filled in at runtime from `APP_NAME` (dev: vite-plugin-app-name.ts,
 * production: the nginx container's 30-app-name.sh). Never hard-code it.
 */
const FALLBACK = "Vikt";

export function appName(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="app-name"]');
  const value = meta?.content?.trim();
  // If the placeholder is still here, the substitution step did not run.
  if (!value || value === "__APP_NAME__") return FALLBACK;
  return value;
}
