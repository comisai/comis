// SPDX-License-Identifier: Apache-2.0
/**
 * SSRF Guard: DNS-pinned URL validation for server-side request forgery prevention.
 *
 * Validates URLs before any outbound HTTP request to ensure the resolved IP
 * is not in a blocked range (loopback, private, link-local, cloud metadata).
 *
 * Every web-facing tool must pass through validateUrl() before fetch.
 *
 * `validateLocalServerUrl` (SEC-02) is the co-located INVERSE: it guards an
 * operator-configured LOCAL server URL (`transcription.local.baseUrl`) by
 * ALLOWING loopback + an explicit allowlist and DENYING public/arbitrary
 * egress — the opposite allow/deny of `validateUrl`, sharing the same
 * parse → protocol → DNS-resolve → ipaddr-classify flow and the
 * cloud-metadata deny.
 *
 * @module
 */

import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";

// ---------------------------------------------------------------------------
// Blocked IP ranges (ipaddr.js range names)
// ---------------------------------------------------------------------------

/**
 * IP range names from ipaddr.js that are blocked for outbound requests.
 *
 * - "private": RFC 1918 (10.x, 172.16-31.x, 192.168.x)
 * - "loopback": 127.0.0.0/8 and ::1
 * - "linkLocal": 169.254.0.0/16 and fe80::/10
 * - "uniqueLocal": fc00::/7 (IPv6 private)
 * - "unspecified": 0.0.0.0 and ::
 * - "reserved": IANA reserved ranges
 */
export const BLOCKED_RANGES: ReadonlyArray<string> = [
  "private",
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "unspecified",
  "reserved",
];

// ---------------------------------------------------------------------------
// Cloud metadata IP blocklist
// ---------------------------------------------------------------------------

/**
 * Explicit cloud metadata service IPs that must be blocked regardless
 * of their IP range classification.
 *
 * - 169.254.169.254: AWS, GCP, Azure instance metadata
 * - 169.254.170.2: AWS ECS task metadata
 * - 100.100.100.200: Alibaba Cloud metadata
 */
export const CLOUD_METADATA_IPS: ReadonlyArray<string> = [
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
];

// ---------------------------------------------------------------------------
// Allowed protocols
// ---------------------------------------------------------------------------

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------

export interface ValidatedUrl {
  hostname: string;
  ip: string;
  url: URL;
}

/**
 * Validate a URL for SSRF safety by resolving DNS and checking the IP.
 *
 * This is a pure validation function -- it does NOT perform the actual fetch.
 * Call this before every outbound HTTP request from agent-facing tools.
 *
 * Checks performed:
 * 1. URL parsing (must be valid)
 * 2. Protocol check (only http/https allowed)
 * 3. DNS resolution (hostname must resolve)
 * 4. Cloud metadata IP blocklist (explicit IPs)
 * 5. IP range classification (private, loopback, link-local, etc.)
 *
 * @param urlString - The URL to validate
 * @returns ok with hostname, resolved IP, and parsed URL on success; err on failure
 */
export async function validateUrl(
  urlString: string,
): Promise<Result<ValidatedUrl, Error>> {
  // Wrap entire body in fromPromise to catch any unexpected errors
  return fromPromise(
    (async (): Promise<ValidatedUrl> => {
      // 1. Parse URL
      let parsed: URL;
      try {
        parsed = new URL(urlString);
      } catch {
        throw new Error(`Invalid URL: ${urlString}`);
      }

      // 2. Protocol check
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(
          `Blocked protocol: ${parsed.protocol} — only http and https are allowed`,
        );
      }

      // 3. DNS resolution
      const hostname = parsed.hostname;
      // Strip brackets from IPv6 literal hostnames (e.g., "[::1]" -> "::1")
      const lookupHost = hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname;
      const { address } = await lookup(lookupHost);

      // 4. Cloud metadata IP blocklist
      if (CLOUD_METADATA_IPS.includes(address)) {
        throw new Error(
          `Blocked: resolved IP ${address} is a cloud metadata service address`,
        );
      }

      // 5. IP range classification
      const ip = ipaddr.parse(address);
      const range = ip.range();

      if (BLOCKED_RANGES.includes(range)) {
        throw new Error(
          `Blocked: resolved IP ${address} is in ${range} range`,
        );
      }

      return { hostname, ip: address, url: parsed };
    })(),
  );
}

// ---------------------------------------------------------------------------
// validateLocalServerUrl (SEC-02) — the INVERSE of validateUrl
// ---------------------------------------------------------------------------

/**
 * Validate an operator-configured LOCAL server URL (e.g.
 * `transcription.local.baseUrl` for a keyless local whisper server) for SSRF
 * safety, with the INVERSE policy of {@link validateUrl}.
 *
 * `validateUrl` is the guard for UNTRUSTED public fetches (reference_image,
 * web-fetch): it BLOCKS loopback/private as SSRF targets. That policy is wrong
 * for a local server URL — the legitimate target IS loopback (a local whisper
 * server on 127.0.0.1). So this function FLIPS the verdict:
 *
 * - **ALLOW** loopback (127.0.0.1 / ::1 / a hostname resolving to loopback) —
 *   the legitimate local server.
 * - **ALLOW** a host in the explicit `allowedHosts` allowlist (operator opt-in;
 *   default `[]` → loopback-only).
 * - **DENY** every other resolved range — private, public, link-local, etc.
 *   (the SEC-02 core inversion: no arbitrary egress through a local-server knob).
 * - **DENY** the `CLOUD_METADATA_IPS` regardless (defense-in-depth — a
 *   `local.baseUrl` must NEVER reach 169.254.169.254 even if mis-resolved).
 *
 * It reuses `validateUrl`'s parse → protocol-check → DNS-resolve → ipaddr-
 * classify flow verbatim through DNS resolution; only the final verdict differs.
 * Pure validation — it does NOT fetch. Returns `Result`, never throws.
 *
 * @param urlString - The local server URL to validate
 * @param allowedHosts - Hostnames explicitly permitted beyond loopback (default `[]`)
 * @returns ok with hostname, resolved IP, and parsed URL on success; err on a
 *   non-loopback/unallowed host, a cloud-metadata IP, a bad protocol, or a
 *   parse/DNS failure
 */
export async function validateLocalServerUrl(
  urlString: string,
  allowedHosts: ReadonlyArray<string> = [],
): Promise<Result<ValidatedUrl, Error>> {
  return fromPromise(
    (async (): Promise<ValidatedUrl> => {
      // 1. Parse URL (identical to validateUrl).
      let parsed: URL;
      try {
        parsed = new URL(urlString);
      } catch {
        throw new Error(`Invalid URL: ${urlString}`);
      }

      // 2. Protocol check (identical — only http/https).
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(
          `Blocked protocol: ${parsed.protocol} — only http and https are allowed`,
        );
      }

      // 3. DNS resolution (identical — strip IPv6 brackets for the lookup).
      const hostname = parsed.hostname;
      const lookupHost = hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname;
      const { address } = await lookup(lookupHost);

      // 4. Cloud metadata IP blocklist — KEPT as defense-in-depth (a local
      //    server URL must never reach a cloud metadata endpoint).
      if (CLOUD_METADATA_IPS.includes(address)) {
        throw new Error(
          `Blocked: resolved IP ${address} is a cloud metadata service address`,
        );
      }

      // 5. INVERTED verdict: ALLOW loopback or an explicitly-allowed host;
      //    DENY everything else (private/public/etc.).
      const ip = ipaddr.parse(address);
      const isLoopback = ip.range() === "loopback";
      const isExplicit = allowedHosts.includes(parsed.hostname);
      if (!isLoopback && !isExplicit) {
        throw new Error(
          `Blocked: ${parsed.hostname} is not a loopback or explicitly-allowed local host`,
        );
      }

      return { hostname, ip: address, url: parsed };
    })(),
  );
}
