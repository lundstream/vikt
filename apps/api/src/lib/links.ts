import type { Env } from "../env.js";

/**
 * Every link that leaves this server (D109).
 *
 * ## The defect this exists to make impossible
 *
 * `PUBLIC_ORIGIN` defaulted to the empty string, and the invite mail built its
 * link as `` `${env.PUBLIC_ORIGIN}/app/register?kod=…` ``. With the default in
 * place that is `/app/register?kod=…`, a **relative** URL, which is a perfectly
 * good link inside a page and is not a link at all inside an email: no mail
 * client has a base to resolve it against, so it renders as text or as a dead
 * anchor.
 *
 * Nothing failed. The mail sent, the queue said sent, and the recipient got a
 * code they could not use.
 *
 * The template-level fix is a test that every rendered link is absolute, and it
 * is here. The structural fix is that string interpolation is no longer how a
 * link gets built: `linkTo` is the only way, it refuses to produce a relative
 * URL, and the refusal is loud.
 *
 * ## Why the base is its own variable
 *
 * `PUBLIC_BASE_URL` replaces `PUBLIC_ORIGIN`, which is a rename rather than an
 * addition: two variables meaning the same thing is the shape of every defect
 * this project has spent a pass on — two manifests (D98), two mail drainers
 * (D104). The old name is still read as a fallback so an existing deployment
 * does not lose its links on upgrade, and the boot log says to move it.
 */

export class NoPublicBaseUrl extends Error {
  constructor() {
    super(
      "PUBLIC_BASE_URL is not set, so a link in an email would be relative and unusable.",
    );
    this.name = "NoPublicBaseUrl";
  }
}

/**
 * The configured base, trailing slash removed, or null.
 *
 * Reads the old name too. Returning null rather than "" is deliberate: an empty
 * string concatenates into a relative URL without complaint, which is the whole
 * defect, and null does not concatenate into anything by accident.
 */
export function publicBaseUrl(env: Pick<Env, "PUBLIC_BASE_URL" | "PUBLIC_ORIGIN">): string | null {
  const raw = (env.PUBLIC_BASE_URL || env.PUBLIC_ORIGIN || "").trim();
  if (raw === "") return null;
  return raw.replace(/\/+$/, "");
}

/**
 * An absolute URL for a path in this installation.
 *
 * Throws rather than returning something unusable. The callers are mail
 * templates, and a template that silently produced a relative link is exactly
 * what happened; a throw reaches the queue row as an error somebody can read on
 * the admin screen, which is the outcome D104 built that screen for.
 */
export function linkTo(
  env: Pick<Env, "PUBLIC_BASE_URL" | "PUBLIC_ORIGIN">,
  path: string,
  params: Record<string, string> = {},
): string {
  const base = publicBaseUrl(env);
  if (base === null) throw new NoPublicBaseUrl();

  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${base}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Whether a string is a link a mail client can open. The test's definition. */
export function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Whether a base URL only resolves on the machine or network it was set on
 * (D113).
 *
 * `https://localhost:5173` was live on an instance served through nginx at a
 * real hostname, so every invite went out with a link that opened nothing for
 * anybody but the owner, on the one machine the dev server runs on. The
 * previous guard (D109) only asked whether the URL was *absolute*, and
 * `https://localhost:5173` is absolute. Absolute was the wrong question: the
 * question is whether the recipient can reach it.
 *
 * What counts as local:
 *
 *  - `localhost`, `127.0.0.0/8`, `::1` and the `.local` mDNS suffix;
 *  - the three private IPv4 ranges, `10/8`, `172.16/12` and `192.168/16`, which
 *    is what a LAN address looks like on this network and every other one;
 *  - `169.254/16`, link-local, which is what a machine picks when DHCP fails.
 *
 * Deliberately **not** a check for "does it resolve" or "can I reach it". This
 * runs at boot with no network and must give the same answer every time. A
 * hostname that resolves to a private address is not caught here and is caught
 * by reading the mail, which is what the admin screen exists for.
 */
export function isLocalBaseUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }

  // IPv6 arrives from `URL` wrapped in brackets.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (bare === "localhost" || bare === "::1" || bare.endsWith(".localhost")) return true;
  if (bare.endsWith(".local")) return true;

  const octets = bare.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part))) return false;

  const [a, b] = octets.map(Number) as [number, number, number, number];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;

  return false;
}
