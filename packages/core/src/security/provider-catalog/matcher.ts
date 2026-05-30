// SPDX-License-Identifier: Apache-2.0
/**
 * Host/path matcher for the credential-injection broker.
 *
 * Port of OneCLI `apps.rs` host_rule_matches + provider_for_host_and_path
 * (Apache-2.0, https://github.com/anthropics/onecli/blob/main/src/gateway/apps.rs :71-909).
 *
 * Faithful-but-honest deltas from the original:
 *   - `normalizeHost` fixes the OneCLI `strip_port` IPv6 bug (`gateway.rs:866`) by detecting
 *     a leading `[` bracket and extracting the IPv6 literal before any colon scan.
 *   - `resolveBinding` implements two-pass priority (path-scoped rules beat host-only) as a
 *     provider-agnostic primitive; the curated `apps.rs` preset catalog is optional sugar only
 *     (see `presets.ts`).
 *   - Fail-closed defaults throughout: unknown host → undefined; empty `pathPolicy` → deny all.
 *
 * Consumed by the CredentialBroker (Phase 2) on every CONNECT request. No I/O, no logger,
 * no timestamps — fully deterministic pure functions.
 *
 * @module
 */

import type { BrokerBinding, HostRule } from "./types.js";

// ── normalizeHost ─────────────────────────────────────────────────────────────

/**
 * Normalise a CONNECT authority string to a bare lowercase hostname.
 *
 * Handles:
 *   - Port stripping (`api.example.com:443` → `api.example.com`)
 *   - Lowercasing (`API.Example.COM` → `api.example.com`)
 *   - FQDN trailing dot (`api.example.com.` → `api.example.com`)
 *   - Bracketed IPv6 with port (`[2606:4700::1]:443` → `2606:4700::1`)
 *   - Bare bracketed IPv6 (`[::1]` → `::1`)
 *
 * Fixes the OneCLI `gateway.rs:866` IPv6 bug where naive last-colon stripping would
 * corrupt `[2606:4700::1]:443` to `[2606`.
 */
export function normalizeHost(authority: string): string {
  if (authority === "") return "";

  let host: string;

  if (authority.startsWith("[")) {
    // Bracketed IPv6 address — extract everything between "[" and "]"
    const closeBracket = authority.indexOf("]");
    if (closeBracket === -1) {
      // Malformed; return lowercased as-is
      host = authority.toLowerCase();
    } else {
      host = authority.slice(1, closeBracket).toLowerCase();
    }
  } else {
    // Plain hostname or IPv4 — strip port by finding last ":"
    const lastColon = authority.lastIndexOf(":");
    host = lastColon === -1 ? authority.toLowerCase() : authority.slice(0, lastColon).toLowerCase();
  }

  // Strip FQDN trailing dot
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }

  return host;
}

// ── hostRuleMatches ───────────────────────────────────────────────────────────

/**
 * Test whether a host rule's pattern matches the (already-normalised) hostname.
 *
 * Exact: strict equality.
 * Suffix: `hostname.endsWith(suffix) && hostname.length > suffix.length` — the length guard
 *   is mandatory (T-02-01): the bare suffix string itself must never match its own rule.
 */
export function hostRuleMatches(rule: HostRule, hostname: string): boolean {
  switch (rule.pattern.kind) {
    case "exact":
      return rule.pattern.host === hostname;
    case "suffix":
      return (
        hostname.endsWith(rule.pattern.suffix) &&
        hostname.length > rule.pattern.suffix.length
      );
    default: {
      // WR-03: exhaustiveness guard — catches new HostPattern kinds at compile time.
      // Fail-closed at runtime: return false so an unknown pattern never grants access.
      const _exhaustive: never = rule.pattern;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      void _exhaustive;
      return false;
    }
  }
}

// ── pathAllowed ───────────────────────────────────────────────────────────────

/**
 * Evaluate the rule's `pathPolicy` glob allow-list against the request path.
 *
 * Port of path_matches (apps.rs :213-280). Four glob forms:
 *   - bare wildcard (*) matches all paths
 *   - boundary glob (/v1/*): path must start with /v1/ AND have at least one more segment
 *   - prefix glob (/v1/messages*): path must start with the literal prefix /v1/messages
 *   - segment wildcard (/repos/STAR/issues): exactly one path segment in the wildcard slot
 *
 * Query string is stripped before comparison (T-02-05).
 * Fail-closed: `pathPolicy: []` rejects all paths.
 *
 * WR-01 normalization: `/../` and `/./` segments are resolved before comparison
 * via `new URL(path, "https://x").pathname`. Malformed paths that cannot be
 * parsed return false (deny). This is defense-in-depth — the CredentialBroker
 * (Phase 2) MUST also normalize the raw path before calling this function.
 */
export function pathAllowed(rule: HostRule, path: string): boolean {
  // No policy → allow all paths (open policy when operator has not restricted)
  if (rule.pathPolicy === undefined) return true;

  // Empty policy → deny all (fail-closed)
  if (rule.pathPolicy.length === 0) return false;

  // WR-01: normalize dotdot and dot segments before comparison.
  // new URL resolves /v1/../admin/secret → /admin/secret so it cannot
  // escape the intended policy scope. Malformed paths deny fail-closed.
  let normalizedPath: string;
  try {
    normalizedPath = new URL(path, "https://x").pathname;
  } catch {
    return false;
  }

  // Strip query string before comparison (T-02-05)
  const cleanPath = normalizedPath.split("?")[0] ?? normalizedPath;

  for (const pattern of rule.pathPolicy) {
    if (matchPathPattern(pattern, cleanPath)) return true;
  }

  return false;
}

/**
 * Evaluate a single path glob pattern against a clean (query-stripped) path.
 * @internal
 */
function matchPathPattern(pattern: string, cleanPath: string): boolean {
  // Bare wildcard — allow everything
  if (pattern === "*") return true;

  // Boundary glob: ends with "/*"
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2); // strip "/*"
    // Path must start with prefix + "/" and have at least one character after
    return cleanPath.startsWith(prefix + "/") && cleanPath.length > prefix.length + 1;
  }

  // Check for a mid-pattern wildcard (segment wildcard: /repos/*/issues)
  const wildcardIdx = pattern.indexOf("*");
  if (wildcardIdx !== -1) {
    // Prefix glob: wildcard at end only (not "/*" since that was handled above)
    if (wildcardIdx === pattern.length - 1) {
      // e.g. "/v1/messages*"
      const prefix = pattern.slice(0, -1); // strip trailing "*"
      return cleanPath.startsWith(prefix);
    }

    // Segment wildcard: wildcard in the middle (e.g. "/repos/*/issues")
    // Split pattern into before/after the wildcard
    const before = pattern.slice(0, wildcardIdx); // "/repos/"
    const after = pattern.slice(wildcardIdx + 1); // "/issues"

    if (!cleanPath.startsWith(before)) return false;

    const remainder = cleanPath.slice(before.length); // "foo/issues" or "foo/bar/issues"

    // The wildcard slot must match exactly one path segment (no additional "/" allowed in the segment)
    const segmentEnd = remainder.indexOf("/");
    if (segmentEnd === -1) {
      // No slash after segment — can only match if `after` is empty
      return after === "";
    }

    const segment = remainder.slice(0, segmentEnd); // "foo" or "foo/bar"
    // segment must be non-empty (CR-01: empty segment must not match)
    if (segment.length === 0) return false;
    // segment must not itself contain "/" (exactly one segment in the slot)
    if (segment.includes("/")) return false;

    const rest = remainder.slice(segmentEnd); // "/issues" or "/bar/issues"
    return rest === after;
  }

  // Exact match
  return cleanPath === pattern;
}

// ── resolveBinding ────────────────────────────────────────────────────────────

/**
 * Resolve the best `{ binding, rule }` pair for a (hostname, path) request.
 *
 * Two-pass priority (port of `provider_for_host_and_path`, apps.rs):
 *   1. Path-scoped rules (those with `rule.pathPrefix` defined) are evaluated first.
 *   2. Host-only rules (no `pathPrefix`) are evaluated in config order as fallback.
 *
 * Returns `undefined` when no binding matches — fail-closed (T-02-03, INJECT-03).
 * `hostname` is assumed already normalised by the caller.
 */
export function resolveBinding(
  bindings: readonly BrokerBinding[],
  hostname: string,
  path: string,
): { binding: BrokerBinding; rule: HostRule } | undefined {
  let hostOnlyCandidate: { binding: BrokerBinding; rule: HostRule } | undefined;

  for (const binding of bindings) {
    for (const rule of binding.hostRules) {
      if (!hostRuleMatches(rule, hostname)) continue;
      if (!pathAllowed(rule, path)) continue;

      if (rule.pathPrefix !== undefined) {
        // Path-scoped rule: must also satisfy the prefix
        if (!path.startsWith(rule.pathPrefix)) continue;
        // First path-scoped match wins (highest priority)
        return { binding, rule };
      }

      // Host-only rule: record the first one, but keep scanning for a path-scoped match
      if (hostOnlyCandidate === undefined) {
        hostOnlyCandidate = { binding, rule };
      }
    }
  }

  // No path-scoped match found; fall back to first host-only candidate (may be undefined)
  return hostOnlyCandidate;
}
