import { describe, expect, it } from "vitest";
import {
  assertNotHopCount,
  compileTrustedPeers,
  isTrustedPeer,
  resolveClientIp,
} from "../src/lib/trust-proxy.js";

/**
 * DECISIONS.md D14. Getting this wrong is silent — the logs still contain an IP
 * address, just the wrong one — so the behaviour is pinned rather than assumed.
 */
describe("TRUST_PROXY parsing", () => {
  it("rejects the old hop-count form instead of misreading it", () => {
    expect(() => assertNotHopCount("3")).toThrow(/hop count/i);
    expect(() => assertNotHopCount(" 0 ")).toThrow(/hop count/i);
  });

  it("points at the replacement in the message", () => {
    expect(() => assertNotHopCount("3")).toThrow(/D14/);
  });

  it("accepts a CIDR, an address, and a list", () => {
    expect(compileTrustedPeers("172.31.240.0/24")).toBeTypeOf("function");
    expect(compileTrustedPeers("10.1.2.3")).toBeTypeOf("function");
    expect(compileTrustedPeers("10.1.2.3, 172.31.240.0/24")).toBeTypeOf("function");
    expect(compileTrustedPeers("loopback")).toBeTypeOf("function");
  });

  it("trusts nothing when empty", () => {
    expect(compileTrustedPeers("")).toBe(false);
    expect(compileTrustedPeers("   ")).toBe(false);
  });

  it("throws at boot on a malformed CIDR rather than later", () => {
    expect(() => compileTrustedPeers("not-an-address")).toThrow();
  });
});

describe("peer validation", () => {
  const trust = compileTrustedPeers("172.31.240.0/24");

  it("accepts an address inside the trusted subnet", () => {
    expect(isTrustedPeer(trust, "172.31.240.5")).toBe(true);
  });

  it("rejects one outside it", () => {
    expect(isTrustedPeer(trust, "172.31.241.5")).toBe(false);
    expect(isTrustedPeer(trust, "203.0.113.9")).toBe(false);
  });

  it("rejects everything when nothing is trusted", () => {
    expect(isTrustedPeer(false, "172.31.240.5")).toBe(false);
  });

  it("rejects a missing peer address", () => {
    expect(isTrustedPeer(trust, undefined)).toBe(false);
  });
});

describe("resolving the client IP", () => {
  const trust = compileTrustedPeers("172.31.240.0/24");

  it("uses CF-Connecting-IP when the peer is trusted", () => {
    expect(
      resolveClientIp({
        trust,
        remoteAddress: "172.31.240.5",
        cfConnectingIp: "203.0.113.9",
        fallback: "172.31.240.5",
      }),
    ).toBe("203.0.113.9");
  });

  /**
   * The point of the whole exercise: a client that reaches the API directly can
   * put anything in that header, and must not be believed.
   */
  it("ignores CF-Connecting-IP from an untrusted peer", () => {
    expect(
      resolveClientIp({
        trust,
        remoteAddress: "198.51.100.7",
        cfConnectingIp: "10.0.0.1",
        fallback: "198.51.100.7",
      }),
    ).toBe("198.51.100.7");
  });

  it("ignores it entirely when nothing is trusted", () => {
    expect(
      resolveClientIp({
        trust: false,
        remoteAddress: "172.31.240.5",
        cfConnectingIp: "203.0.113.9",
        fallback: "172.31.240.5",
      }),
    ).toBe("172.31.240.5");
  });

  it("falls back when the header is absent", () => {
    expect(
      resolveClientIp({
        trust,
        remoteAddress: "172.31.240.5",
        cfConnectingIp: undefined,
        fallback: "192.0.2.4",
      }),
    ).toBe("192.0.2.4");
  });

  it("refuses a header that is not a bare IP", () => {
    for (const value of ["not-an-ip", "203.0.113.9, 10.0.0.1", "", "  "]) {
      expect(
        resolveClientIp({
          trust,
          remoteAddress: "172.31.240.5",
          cfConnectingIp: value,
          fallback: "192.0.2.4",
        }),
      ).toBe("192.0.2.4");
    }
  });

  it("takes the first value when the header arrives duplicated", () => {
    expect(
      resolveClientIp({
        trust,
        remoteAddress: "172.31.240.5",
        cfConnectingIp: ["203.0.113.9", "10.0.0.1"],
        fallback: "192.0.2.4",
      }),
    ).toBe("203.0.113.9");
  });

  it("accepts IPv6", () => {
    expect(
      resolveClientIp({
        trust,
        remoteAddress: "172.31.240.5",
        cfConnectingIp: "2001:db8::1",
        fallback: "192.0.2.4",
      }),
    ).toBe("2001:db8::1");
  });
});
