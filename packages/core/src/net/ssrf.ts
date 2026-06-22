// SPDX-License-Identifier: Apache-2.0
// SSRF blocklist — isSsrfBlocked(host) predicate + the blocked-range tables.
//
// Source of truth: ~/projects/openclaw/docs/security/network-proxy.md RFC range table.
// CIDR bit-mask logic ported from ~/projects/openclaw/src/infra/net/proxy-env.ts
// (parseIpv4Address / matchesIpv4NoProxyPattern).
//
// PURE: zero runtime deps. Lives in @comis/core so both the runtime dispatcher
// (@comis/infra `ssrfBlockInterceptor`, which owns the undici Dispatcher wiring
// and imports `isSsrfBlocked` from here) and the offline `comis proxy validate`
// command (@comis/cli) share one predicate without a cli→infra edge.

// ---------------------------------------------------------------------------
// Blocked hostname/address sets (O(1) lookup before IP parsing)
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set<string>([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

/** Special cloud metadata IPv4 addresses — explicit block regardless of CIDR range */
const CLOUD_METADATA_ADDRS = new Set<string>([
  "169.254.169.254", // AWS/GCP/Azure metadata
]);

// ---------------------------------------------------------------------------
// Blocked IPv4 CIDR ranges — exported so proxy validate can display them
// Source: ~/projects/openclaw/docs/security/network-proxy.md
// ---------------------------------------------------------------------------

export const BLOCKED_IPV4_CIDR_RANGES: readonly string[] = [
  "127.0.0.0/8", // IPv4 loopback
  "0.0.0.0/8", // Unspecified
  "10.0.0.0/8", // RFC1918 private
  "172.16.0.0/12", // RFC1918 private
  "192.168.0.0/16", // RFC1918 private
  "169.254.0.0/16", // Link-local / cloud metadata
  "100.64.0.0/10", // CGNAT (Carrier-grade NAT)
  "198.18.0.0/15", // Benchmarking (RFC2544)
  "192.0.0.0/24", // IETF Protocol Assignments
  "192.0.2.0/24", // TEST-NET-1 (documentation)
  "198.51.100.0/24", // TEST-NET-2 (documentation)
  "203.0.113.0/24", // TEST-NET-3 (documentation)
  "224.0.0.0/4", // Multicast
  "240.0.0.0/4", // Reserved IPv4
];

// ---------------------------------------------------------------------------
// Blocked IPv6 ranges
// ---------------------------------------------------------------------------

const BLOCKED_IPV6_RANGES: readonly string[] = [
  "::1/128", // IPv6 loopback
  "::/128", // Unspecified
  "fe80::/10", // Link-local
  "fc00::/7", // IPv6 Unique Local (RFC4193) — covers fd00::/8 as well
  "fec0::/10", // Legacy site-local
  "ff00::/8", // Multicast
  "100::/64", // IPv6 Discard prefix
  "2001:20::/28", // ORCHIDv2
  "2001:db8::/32", // Documentation
  "64:ff9b::/96", // NAT64 (embedded IPv4)
  "64:ff9b:1::/48", // NAT64 (embedded IPv4)
  "2002::/16", // 6to4 (embedded IPv4)
  "2001::/32", // Teredo (embedded IPv4)
  "::/96", // IPv4-compatible
  "::ffff:0:0/96", // IPv4-mapped
  "2001:2::/48", // Benchmarking
];

// ---------------------------------------------------------------------------
// IPv4 helpers — ported from ~/projects/openclaw/src/infra/net/proxy-env.ts
// (parseIpv4Address / matchesIpv4NoProxyPattern)
// ---------------------------------------------------------------------------

function parseIpv4Address(host: string): number | undefined {
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

function matchesIpv4Cidr(targetHost: string, cidr: string): boolean {
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

// ---------------------------------------------------------------------------
// IPv6 helpers — minimal prefix-match for the blocked ranges above
// ---------------------------------------------------------------------------

/**
 * Expand a full-form IPv6 address string to a 16-element numeric array.
 * Returns undefined if the input is not a valid IPv6 address.
 * Handles compressed form (::), IPv4-mapped (::ffff:a.b.c.d) and
 * IPv4-compatible (::a.b.c.d) notation.
 */
function expandIpv6(addr: string): Uint16Array | undefined {
  // Detect IPv4-in-IPv6 suffixes: ::ffff:a.b.c.d or ::a.b.c.d
  const ipv4Suffix = addr.match(
    /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (ipv4Suffix) {
    const ipv4Parts = ipv4Suffix[2].split(".").map(Number);
    if (ipv4Parts.some((p) => p > 255 || p < 0)) {
      return undefined;
    }
    // Replace the IPv4 suffix with two 16-bit groups
    const high = ((ipv4Parts[0] << 8) | ipv4Parts[1]) & 0xffff;
    const low = ((ipv4Parts[2] << 8) | ipv4Parts[3]) & 0xffff;
    const newAddr = `${ipv4Suffix[1]}${high.toString(16)}:${low.toString(16)}`;
    return expandIpv6(newAddr);
  }

  const halves = addr.split("::");
  if (halves.length > 2) {
    return undefined; // multiple "::" — invalid
  }

  const parseGroups = (s: string): number[] | undefined => {
    if (s === "") return [];
    const parts = s.split(":");
    const result: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
        return undefined;
      }
      result.push(parseInt(part, 16));
    }
    return result;
  };

  if (halves.length === 1) {
    const groups = parseGroups(halves[0]);
    if (!groups || groups.length !== 8) {
      return undefined;
    }
    return new Uint16Array(groups);
  }

  // compressed form: halves[0] :: halves[1]
  const left = parseGroups(halves[0]);
  const right = parseGroups(halves[1]);
  if (!left || !right) {
    return undefined;
  }
  const totalGroups = left.length + right.length;
  if (totalGroups > 8) {
    return undefined;
  }
  const zeros = new Array<number>(8 - totalGroups).fill(0);
  return new Uint16Array([...left, ...zeros, ...right]);
}

/**
 * Parse an IPv6 CIDR string (e.g. "fe80::/10") into address groups + prefix length.
 */
function parseIpv6Cidr(
  cidr: string,
): { addr: Uint16Array; prefixLen: number } | undefined {
  const slashIdx = cidr.lastIndexOf("/");
  if (slashIdx === -1) {
    return undefined;
  }
  const prefixLen = Number(cidr.slice(slashIdx + 1));
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 128) {
    return undefined;
  }
  const addr = expandIpv6(cidr.slice(0, slashIdx));
  if (!addr) {
    return undefined;
  }
  return { addr, prefixLen };
}

/**
 * Test whether an IPv6 address falls within a given prefix.
 * Both are 8-element Uint16Array. prefixLen is 0..128.
 */
function ipv6InPrefix(
  target: Uint16Array,
  network: Uint16Array,
  prefixLen: number,
): boolean {
  let bitsLeft = prefixLen;
  for (let i = 0; i < 8; i++) {
    if (bitsLeft <= 0) {
      break;
    }
    const bits = Math.min(bitsLeft, 16);
    const shift = 16 - bits;
    const mask = (0xffff << shift) & 0xffff;
    if ((target[i] & mask) !== (network[i] & mask)) {
      return false;
    }
    bitsLeft -= bits;
  }
  return true;
}

function matchesIpv6Cidr(addr: Uint16Array, cidr: string): boolean {
  const parsed = parseIpv6Cidr(cidr);
  if (!parsed) {
    return false;
  }
  return ipv6InPrefix(addr, parsed.addr, parsed.prefixLen);
}

// ---------------------------------------------------------------------------
// isSsrfBlocked — the main predicate
// ---------------------------------------------------------------------------

/**
 * Returns true if the host/IP must be blocked to prevent SSRF.
 *
 * Covers: loopback, RFC1918, link-local, CGNAT, multicast, reserved, IPv6 specials,
 * NAT64, 6to4, Teredo, IPv4-mapped/compatible, documentation, benchmarking.
 *
 * @param host - Hostname or IP literal (brackets already stripped, or still present).
 *               Bracket notation ([::1]) is stripped internally.
 */
export function isSsrfBlocked(host: string): boolean {
  // Normalize: lowercase and strip surrounding IPv6 brackets
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");

  // 1. Exact blocked hostnames (O(1))
  if (BLOCKED_HOSTNAMES.has(normalized)) {
    return true;
  }

  // 2. Cloud metadata IPs (O(1)) — explicit before range checks
  if (CLOUD_METADATA_ADDRS.has(normalized)) {
    return true;
  }

  // 3. IPv4 CIDR ranges
  if (parseIpv4Address(normalized) !== undefined) {
    for (const cidr of BLOCKED_IPV4_CIDR_RANGES) {
      if (matchesIpv4Cidr(normalized, cidr)) {
        return true;
      }
    }
    return false;
  }

  // 4. IPv6 prefix ranges
  const expanded = expandIpv6(normalized);
  if (expanded !== undefined) {
    for (const cidr of BLOCKED_IPV6_RANGES) {
      if (matchesIpv6Cidr(expanded, cidr)) {
        return true;
      }
    }
    return false;
  }

  // 5. Non-IP hostname not in blocklist — allow (hostname SSRF is the proxy's concern)
  // Fall through to false if the host is a hostname (not an IP).
  return false;
}
