// SPDX-License-Identifier: Apache-2.0
// Shared IPv4 primitives — dotted-quad parsing + CIDR membership.
//
// Single source of truth for both the SSRF blocklist (ssrf.ts) and the
// NO_PROXY matcher (proxy-env.ts). These two gates make opposite decisions
// (block egress vs. bypass the proxy) off the same address, so a divergence in
// how either parses an IP is a security-relevant inconsistency — keep the
// parsing here, once.
//
// PURE: zero runtime deps.

/**
 * Parse a dotted-quad IPv4 string (`a.b.c.d`) into its unsigned 32-bit value,
 * or `undefined` if it is not exactly four 0–255 decimal octets. Alternate
 * encodings (decimal/octal/hex/short-form) intentionally return undefined —
 * callers normalize via `new URL().hostname` before reaching here.
 */
export function parseIpv4Address(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return undefined;
    }
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * True if `targetHost` (a dotted-quad IPv4 literal) falls within the
 * `a.b.c.d/len` CIDR range. Returns false for a non-IPv4 target or a malformed
 * CIDR.
 */
export function matchesIpv4Cidr(targetHost: string, cidr: string): boolean {
  const target = parseIpv4Address(targetHost);
  if (target === undefined) {
    return false;
  }
  const cidrMatch = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!cidrMatch) {
    return false;
  }
  const network = parseIpv4Address(cidrMatch[1]);
  const prefixLength = Number(cidrMatch[2]);
  if (network === undefined || prefixLength < 0 || prefixLength > 32) {
    return false;
  }
  const mask = prefixLength === 0 ? 0 : ((0xffffffff << (32 - prefixLength)) >>> 0);
  return (target & mask) === (network & mask);
}
