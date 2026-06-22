// SPDX-License-Identifier: Apache-2.0
// SSRF blocklist tests — per-range assertions for the PURE predicate.
// The compose-interceptor test (`ssrfBlockInterceptor`) lives in
// packages/infra/src/net/ssrf-blocklist.test.ts because it needs undici.
//
// RFC range table: ~/projects/openclaw/docs/security/network-proxy.md

import { describe, expect, it } from "vitest";
import { BLOCKED_IPV4_CIDR_RANGES, isSsrfBlocked } from "./ssrf.js";

// ---------------------------------------------------------------------------
// isSsrfBlocked — per-range positive assertions
// ---------------------------------------------------------------------------

describe("isSsrfBlocked — positive (blocked) cases", () => {
  it("blocks IPv4 loopback 127.0.0.1", () => {
    expect(isSsrfBlocked("127.0.0.1")).toBe(true);
  });

  it("blocks unspecified 0.0.0.0", () => {
    expect(isSsrfBlocked("0.0.0.0")).toBe(true);
  });

  it("blocks RFC1918 class A 10.0.0.1", () => {
    expect(isSsrfBlocked("10.0.0.1")).toBe(true);
  });

  it("blocks RFC1918 class B 172.16.0.1", () => {
    expect(isSsrfBlocked("172.16.0.1")).toBe(true);
  });

  it("blocks RFC1918 class B high end 172.31.255.255", () => {
    expect(isSsrfBlocked("172.31.255.255")).toBe(true);
  });

  it("blocks RFC1918 class C 192.168.1.1", () => {
    expect(isSsrfBlocked("192.168.1.1")).toBe(true);
  });

  it("blocks link-local / cloud-metadata 169.254.169.254 (CLOUD_METADATA_ADDRS)", () => {
    expect(isSsrfBlocked("169.254.169.254")).toBe(true);
  });

  it("blocks link-local range 169.254.0.1 (CIDR 169.254.0.0/16)", () => {
    expect(isSsrfBlocked("169.254.0.1")).toBe(true);
  });

  it("blocks CGNAT 100.64.0.3 (RFC6598 100.64.0.0/10)", () => {
    expect(isSsrfBlocked("100.64.0.3")).toBe(true);
  });

  it("blocks benchmarking 198.18.0.1 (RFC2544 198.18.0.0/15)", () => {
    expect(isSsrfBlocked("198.18.0.1")).toBe(true);
  });

  it("blocks IETF Protocol Assignment 192.0.0.1 (192.0.0.0/24)", () => {
    expect(isSsrfBlocked("192.0.0.1")).toBe(true);
  });

  it("blocks documentation TEST-NET-1 192.0.2.1 (192.0.2.0/24)", () => {
    expect(isSsrfBlocked("192.0.2.1")).toBe(true);
  });

  it("blocks documentation TEST-NET-2 198.51.100.1 (198.51.100.0/24)", () => {
    expect(isSsrfBlocked("198.51.100.1")).toBe(true);
  });

  it("blocks documentation TEST-NET-3 203.0.113.1 (203.0.113.0/24)", () => {
    expect(isSsrfBlocked("203.0.113.1")).toBe(true);
  });

  it("blocks multicast 224.0.0.1 (224.0.0.0/4)", () => {
    expect(isSsrfBlocked("224.0.0.1")).toBe(true);
  });

  it("blocks reserved IPv4 240.0.0.1 (240.0.0.0/4)", () => {
    expect(isSsrfBlocked("240.0.0.1")).toBe(true);
  });

  it("blocks blocked hostname 'localhost'", () => {
    expect(isSsrfBlocked("localhost")).toBe(true);
  });

  it("blocks blocked hostname 'localhost.localdomain'", () => {
    expect(isSsrfBlocked("localhost.localdomain")).toBe(true);
  });

  it("blocks cloud metadata hostname 'metadata.google.internal'", () => {
    expect(isSsrfBlocked("metadata.google.internal")).toBe(true);
  });

  // IPv6 specials
  it("blocks IPv6 loopback ::1", () => {
    expect(isSsrfBlocked("::1")).toBe(true);
  });

  it("blocks IPv6 unspecified ::", () => {
    expect(isSsrfBlocked("::")).toBe(true);
  });

  it("blocks IPv6 link-local fe80::1 (fe80::/10)", () => {
    expect(isSsrfBlocked("fe80::1")).toBe(true);
  });

  it("blocks IPv6 unique local fc00::1 (fc00::/7)", () => {
    expect(isSsrfBlocked("fc00::1")).toBe(true);
  });

  it("blocks IPv6 unique local fd00::1 (fc00::/7, fd prefix)", () => {
    expect(isSsrfBlocked("fd00::1")).toBe(true);
  });

  it("blocks IPv6 legacy site-local fec0::1 (fec0::/10)", () => {
    expect(isSsrfBlocked("fec0::1")).toBe(true);
  });

  it("blocks IPv6 multicast ff02::1 (ff00::/8)", () => {
    expect(isSsrfBlocked("ff02::1")).toBe(true);
  });

  it("blocks NAT64 prefix 64:ff9b::1 (64:ff9b::/96)", () => {
    expect(isSsrfBlocked("64:ff9b::1")).toBe(true);
  });

  it("blocks NAT64 prefix 64:ff9b:1::1 (64:ff9b:1::/48)", () => {
    expect(isSsrfBlocked("64:ff9b:1::1")).toBe(true);
  });

  it("blocks 6to4 2002::1 (2002::/16)", () => {
    expect(isSsrfBlocked("2002::1")).toBe(true);
  });

  it("blocks Teredo 2001::1 (2001::/32)", () => {
    expect(isSsrfBlocked("2001::1")).toBe(true);
  });

  it("blocks IPv4-mapped ::ffff:127.0.0.1 (::ffff:0:0/96)", () => {
    expect(isSsrfBlocked("::ffff:127.0.0.1")).toBe(true);
  });

  it("blocks IPv4-compatible ::127.0.0.1 (::/96)", () => {
    expect(isSsrfBlocked("::127.0.0.1")).toBe(true);
  });

  it("blocks ORCHIDv2 2001:20::1 (2001:20::/28)", () => {
    expect(isSsrfBlocked("2001:20::1")).toBe(true);
  });

  it("blocks documentation 2001:db8::1 (2001:db8::/32)", () => {
    expect(isSsrfBlocked("2001:db8::1")).toBe(true);
  });

  it("blocks IPv6 benchmarking 2001:2::1 (2001:2::/48)", () => {
    expect(isSsrfBlocked("2001:2::1")).toBe(true);
  });

  it("blocks IPv6 discard 100::1 (100::/64)", () => {
    expect(isSsrfBlocked("100::1")).toBe(true);
  });

  // Bracket-stripped form (from URL parsing)
  it("blocks bracket-stripped IPv6 loopback [::1] → ::1", () => {
    expect(isSsrfBlocked("[::1]")).toBe(true);
  });

  it("blocks bracket-stripped link-local [fe80::1] → fe80::1", () => {
    expect(isSsrfBlocked("[fe80::1]")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSsrfBlocked — negative (allowed) cases
// ---------------------------------------------------------------------------

describe("isSsrfBlocked — negative (public / allowed) cases", () => {
  it("allows public DNS 8.8.8.8", () => {
    expect(isSsrfBlocked("8.8.8.8")).toBe(false);
  });

  it("allows public hostname api.openai.com", () => {
    expect(isSsrfBlocked("api.openai.com")).toBe(false);
  });

  it("allows another public IP 1.1.1.1", () => {
    expect(isSsrfBlocked("1.1.1.1")).toBe(false);
  });

  it("allows public IPv6 2607:f8b0::1 (Google)", () => {
    expect(isSsrfBlocked("2607:f8b0::1")).toBe(false);
  });

  // IPv6 edge cases that exercise expandIpv6 internal branches
  it("returns false for malformed IPv6 with multiple :: (invalid address)", () => {
    // Covers expandIpv6 line 153-154: halves.length > 2 → undefined → isSsrfBlocked returns false
    expect(isSsrfBlocked("1::2::3")).toBe(false);
  });

  it("returns false for IPv6 with invalid hex group", () => {
    // Covers expandIpv6 parseGroups returning undefined for invalid hex
    // This hits the left || right null-check branch (line 181-182)
    expect(isSsrfBlocked("::zzzz")).toBe(false);
  });

  it("returns false for IPv6 compressed form with too many groups", () => {
    // Covers expandIpv6 line 185-186: totalGroups > 8 → undefined
    expect(isSsrfBlocked("1:2:3:4:5::6:7:8:9")).toBe(false);
  });

  it("blocks IPv4-in-IPv6 mapped address ::ffff:127.0.0.1 (IPv4-mapped loopback)", () => {
    // This exercises the IPv4-in-IPv6 suffix expansion path (lines 140-149)
    // and then checks the IPv6 prefix for ::ffff:0:0/96 (IPv4-mapped range)
    expect(isSsrfBlocked("::ffff:127.0.0.1")).toBe(true);
  });

  it("returns false for IPv4 address with out-of-range octet (256.1.1.1)", () => {
    // Covers parseIpv4Address line 100: octet > 255 → return undefined
    // isSsrfBlocked sees parseIpv4Address(undefined) → skips IPv4 branch → not IPv6 → false
    expect(isSsrfBlocked("256.1.1.1")).toBe(false);
  });

  it("returns false for IPv4-in-IPv6 with out-of-range octet (::ffff:256.0.0.1)", () => {
    // Covers expandIpv6 line 143: IPv4 suffix octet > 255 → return undefined
    expect(isSsrfBlocked("::ffff:256.0.0.1")).toBe(false);
  });

  it("allows full non-compressed public IPv6 address (2607:f8b0:400a:0809:0000:0000:0000:200e)", () => {
    // Covers expandIpv6 line 175: full 8-group form (halves.length === 1)
    expect(isSsrfBlocked("2607:f8b0:400a:0809:0000:0000:0000:200e")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BLOCKED_IPV4_CIDR_RANGES — export smoke test
// ---------------------------------------------------------------------------

describe("BLOCKED_IPV4_CIDR_RANGES export", () => {
  it("is a non-empty array of CIDR strings", () => {
    expect(Array.isArray(BLOCKED_IPV4_CIDR_RANGES)).toBe(true);
    expect(BLOCKED_IPV4_CIDR_RANGES.length).toBeGreaterThan(0);
  });

  it("contains 127.0.0.0/8 for loopback", () => {
    expect(BLOCKED_IPV4_CIDR_RANGES).toContain("127.0.0.0/8");
  });

  it("contains 10.0.0.0/8 for RFC1918", () => {
    expect(BLOCKED_IPV4_CIDR_RANGES).toContain("10.0.0.0/8");
  });

  it("contains 169.254.0.0/16 for link-local", () => {
    expect(BLOCKED_IPV4_CIDR_RANGES).toContain("169.254.0.0/16");
  });
});
