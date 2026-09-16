/**
 * Who runs this installation, read at runtime rather than compiled in (D121).
 *
 * Vikt is self-hosted. Under the GDPR the **person who deploys it is the
 * controller**, not the person who wrote it, so the contact address and the
 * operator's name are facts about a deployment and cannot live in the source.
 * The repository used to carry one particular operator's address, which was
 * both a privacy question and simply wrong for everybody else who runs this.
 *
 * ## Why not the `__APP_NAME__` mechanism directly
 *
 * `30-app-name.sh` rewrites `*.html`, `*.webmanifest` and `*.json` at container
 * start (D13) and deliberately **not** the JavaScript bundles: their names carry
 * a content hash and the service worker's precache manifest records their size
 * and revision, so rewriting bytes inside one would leave the worker refusing
 * its own cache.
 *

 * The global is `viktSiteConfig`, deliberately not `__VIKT__`: the double
 * underscore shape is this project's convention for a *substitution token*, and
 * check-placeholders.mjs reads it that way. A runtime global wearing that shape
 * was reported as a placeholder nobody would ever fill, which is the guard being
 * right rather than noisy.
 *
 * So the values are substituted into a `<script>` tag in `index.html`, which
 * *is* rewritten, and read from there. `check-placeholders.mjs` discovers the
 * tokens from the source itself, so a placeholder that lands anywhere nginx will
 * not rewrite fails the build — which is the guard that exists because
 * `__APP_NAME__` once reached a phone (D98).
 *
 * ## The fallbacks
 *
 * Empty, never a plausible-looking default. A privacy page that names nobody is
 * visibly unfinished, and `assertProdSecrets` refuses to boot a production
 * install that serves a landing page without a contact address, so the empty
 * case should never reach a reader. A default address would instead be wrong
 * quietly, and would point at whoever happened to be in the source.
 */

type SiteConfig = {
  /** The controller's contact address. Required where the landing page is served. */
  contact: string;
  /** Who runs this installation, as they wish to be named. */
  operator: string;
  /** Where the source is. AGPL §13 obliges an offer of it to network users. */
  repo: string;
  /** Optional, and omitted from the footer when empty. */
  support: string;
};

const FALLBACK: SiteConfig = {
  contact: "",
  operator: "",
  repo: "https://github.com/lundstream/vikt",
  support: "",
};

/**
 * A placeholder that nginx never replaced, which means the container was
 * started without the variable. Treated as absent rather than rendered: a page
 * reading `__CONTACT_EMAIL__` is worse than a page that omits the sentence.
 */
function clean(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^__[A-Z0-9_]+__$/.test(trimmed) ? "" : trimmed;
}

export function siteConfig(): SiteConfig {
  const raw = (globalThis as { viktSiteConfig?: Partial<Record<keyof SiteConfig, unknown>> })
    .viktSiteConfig;
  if (!raw) return FALLBACK;

  return {
    contact: clean(raw.contact) || FALLBACK.contact,
    operator: clean(raw.operator) || FALLBACK.operator,
    repo: clean(raw.repo) || FALLBACK.repo,
    support: clean(raw.support) || FALLBACK.support,
  };
}

/**
 * How to name the operator in a sentence when nobody has configured one.
 *
 * "den som driver den här installationen" rather than a blank or a placeholder:
 * the sentence still reads, and it still says the true thing, which is that
 * somebody runs this and it is not the author of the code.
 */
export function operatorName(): string {
  return siteConfig().operator || "den som driver den här installationen";
}

/**
 * The operator's name, or nothing (D177).
 *
 * `operatorName()` has a fallback, and on an installation that has not set
 * `OPERATOR` the footer read **"Den här installationen drivs av den som driver
 * den här installationen"**: a sentence filled with itself, which is worse than
 * no sentence, because it looks like an answer.
 *
 * A caller that can drop its whole sentence should use this and drop it. A
 * caller that cannot, such as a paragraph of policy on /integritet, keeps the
 * fallback, where the phrase is at least a true description of somebody.
 */
export function operatorOrNone(): string | null {
  const name = siteConfig().operator.trim();
  return name === "" ? null : name;
}
