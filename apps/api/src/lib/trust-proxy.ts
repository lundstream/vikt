import { isIP } from "node:net";
import proxyAddr from "@fastify/proxy-addr";

/**
 * Who is allowed to tell us where a request came from.
 *
 * The chain is Cloudflare → Nginx Proxy Manager → nginx → this process. Two
 * separate questions have to be answered, and conflating them is how this goes
 * wrong:
 *
 *  1. **Is the immediate peer one of ours?** Answered by `TRUST_PROXY`, which
 *     holds the address or CIDR of the peer that is allowed to speak for a
 *     client — the nginx container, or the compose network's subnet. Fastify
 *     compiles this and refuses to read any forwarding header from a connection
 *     that does not match.
 *
 *  2. **Which address is the client?** Answered by `CF-Connecting-IP`, which
 *     Cloudflare sets and overwrites on every request, so a browser cannot
 *     forge it *through* Cloudflare. We read it only when question 1 says yes.
 *
 * An earlier version used a hop count. Fastify 4 supported that; Fastify 5
 * deliberately turned it into a no-op, because hop-count trust cannot check the
 * immediate peer at all — anything able to open a socket to the API can send
 * `X-Forwarded-For: <whatever>, <padding>, <padding>` and be believed. Peer
 * validation is the fix, not a reimplementation of the hop count. See
 * DECISIONS.md D14.
 *
 * `CF-Connecting-IP` is only as good as the guarantee that traffic cannot reach
 * nginx except through Cloudflare. `infra/nginx/default.conf` carries the
 * matching note; in production that server block must be restricted to
 * Cloudflare's published ranges, or a client that reaches nginx directly can
 * set the header itself.
 */

/** proxy-addr's function form: is the address at `index` a proxy we trust? */
export type TrustProxyFn = (address: string, index: number) => boolean;

export const CF_CONNECTING_IP = "cf-connecting-ip";

/**
 * Rejects the old hop-count form loudly rather than silently misreading it as
 * something else. `TRUST_PROXY=3` used to mean "three hops"; if an old .env
 * still says that, the operator needs to know it now and not from a wrong IP
 * in an abuse report six months later.
 */
export function assertNotHopCount(raw: string): void {
  if (/^\d+$/.test(raw.trim())) {
    throw new Error(
      `TRUST_PROXY is "${raw}", which looks like a hop count. It now takes the ` +
        `address or CIDR of the immediate peer instead — the nginx container or ` +
        `the compose subnet, e.g. "172.31.240.0/24". A hop count cannot validate ` +
        `the peer and is spoofable; see DECISIONS.md D14.`,
    );
  }
}

/**
 * Compiles `TRUST_PROXY` into a predicate. Accepts a comma-separated list of
 * addresses, CIDRs, or proxy-addr's names (`loopback`, `linklocal`,
 * `uniquelocal`). An empty value trusts nothing, which is correct when the
 * process is reachable directly.
 */
export function compileTrustedPeers(raw: string): TrustProxyFn | false {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) return false;

  values.forEach(assertNotHopCount);
  // Throws on a malformed CIDR, at boot, which is where we want to hear about it.
  return proxyAddr.compile(values);
}

/**
 * Is the socket peer itself trusted? Index 0 is the immediate peer, so this
 * asks question 1 above and nothing else.
 */
export function isTrustedPeer(
  trust: TrustProxyFn | false,
  remoteAddress: string | undefined,
): boolean {
  if (trust === false || !remoteAddress) return false;
  return trust(remoteAddress, 0);
}

/**
 * The address to attribute a request to.
 *
 * `fallback` is Fastify's `request.ip`, which already honours the compiled peer
 * list. `CF-Connecting-IP` wins over it when the peer is trusted, because it is
 * the one header in the chain that Cloudflare sets rather than appends, and so
 * the only one a client cannot prepend a forgery to.
 */
export function resolveClientIp(options: {
  trust: TrustProxyFn | false;
  remoteAddress: string | undefined;
  cfConnectingIp: string | string[] | undefined;
  fallback: string;
}): string {
  const { trust, remoteAddress, cfConnectingIp, fallback } = options;

  if (!isTrustedPeer(trust, remoteAddress)) return fallback;

  const header = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
  if (typeof header === "string") {
    const candidate = header.trim();
    // Anything that is not a bare IP is a forgery attempt or a broken proxy.
    if (isIP(candidate) !== 0) return candidate;
  }

  return fallback;
}
