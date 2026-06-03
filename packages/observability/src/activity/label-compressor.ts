// SPDX-License-Identifier: Apache-2.0
/**
 * label-compressor — pure, one-pass, idempotent display-shortener for activity
 * labels (spec §8.4). Consumes strings that redactValue has already
 * sanitized and path-compacted: it does NOT mask secrets (redactValue owns that
 * upstream) and does NOT re-compact paths (a `~`-rooted or ≤2-segment path is a
 * fixed point — Pitfall 2). It handles ONLY three display categories:
 *
 *   - URLs:       `https://api.tavily.com/v1/search?q=…` → `tavily.com/search`
 *   - Timestamps: `2025-05-22T18:42:00.123Z`            → `18:42:00`
 *   - Long names: `mcp_yfinance_get_historical_quotes`   → `yfinance: get historical quotes`
 *
 * Each category transform is shape-disjoint, applied once in a fixed order, so a
 * second pass cannot match an already-shortened output: `compressLabel` is
 * idempotent (`compressLabel(compressLabel(x)) === compressLabel(x)`) for every
 * category and never grows the output. All regexes are non-global (no `g` flag)
 * and linear — no stateful `lastIndex`, no catastrophic backtracking.
 *
 * Boundary: secret masking and path compaction live solely in
 * `core/security/redact-value.ts` (the egress chokepoint). This module is PURE —
 * no I/O, no logger, no clock, never throws.
 *
 * @module
 */

/**
 * A URL token: `scheme://host[/path][?query][#hash]`, captured as
 * `[, host, path]`. The trailing `(?:[?#]\S*)?` consumes (and thereby discards)
 * the query string and fragment so they are not left dangling after the
 * replacement. Non-global: one URL per label in the activity domain; a second
 * pass finds no scheme to match, so the result is a fixed point.
 *
 * ReDoS-safe: every quantifier is a single-character-class star
 * with no overlapping alternation and no nested quantifier — the host, path and
 * query segments are mutually exclusive on their boundary chars (`/`, `?`, `#`),
 * so matching is linear. The never-grows test drives a 12 KB pathological URL.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- linear: disjoint char-class stars, no nested quantifier (proven by the long-input never-grows test)
const URL_RE = /https?:\/\/([^\s/?#]+)(\/[^\s?#]*)?(?:[?#]\S*)?/;

/** A leading `api.` / `www.` host label to drop (display noise). */
const HOST_PREFIX_RE = /^(?:api|www)\./;

/** A leading API version path segment (`/v1`, `/v2`, …) to drop. */
const VERSION_SEGMENT_RE = /^v\d+$/;

/**
 * An ISO-8601 timestamp; the `HH:MM:SS` clock is captured. The required
 * `\d{4}-\d{2}-\d{2}T` date prefix means a bare `18:42:00` is NOT a match, so
 * the replacement is a fixed point. Non-global: one timestamp per label.
 *
 * ReDoS-safe: all but one quantifier are fixed-width (`\d{N}`); the
 * single unbounded `\d+` sits inside an optional fractional-seconds group with no
 * adjacent overlapping match, so there is no backtracking ambiguity.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- linear: fixed-width \d{N} runs + one bounded \d+ in an optional group, no overlap
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?/;

/**
 * A label that IS exactly a long `mcp_<server>_<rest…>` tool-name token. Anchored
 * with `^…$` so it never fires on an mcp name embedded mid-sentence (scope stays
 * tight — no prose mangling). The output carries `": "` and spaces and no longer
 * matches this anchor, so it is a fixed point.
 */
const MCP_NAME_RE = /^mcp_([a-z0-9]+)_(.+)$/;

/** Drop a leading `api.`/`www.` label, then keep only the last non-empty path segment. */
function compressUrl(host: string, path: string | undefined): string {
  const cleanHost = host.replace(HOST_PREFIX_RE, "");
  const segments = (path ?? "")
    .split("/")
    .filter((seg) => seg.length > 0 && !VERSION_SEGMENT_RE.test(seg));
  const last = segments.at(-1);
  return last === undefined ? cleanHost : `${cleanHost}/${last}`;
}

/**
 * One-pass, idempotent display-shortener for an activity label.
 *
 * Shortens a URL, an ISO timestamp, or a long `mcp_` tool name. Everything else
 * — including already-compacted paths and secret-shaped strings that redactValue
 * masked upstream — is returned unchanged. Output never exceeds the input length.
 */
export function compressLabel(label: string): string {
  // (1) URL → host + last meaningful path segment (scheme/api./version/query dropped).
  let out = label.replace(URL_RE, (_match, host: string, path?: string) =>
    compressUrl(host, path),
  );

  // (2) ISO-8601 timestamp → HH:MM:SS.
  out = out.replace(ISO_TIMESTAMP_RE, (_match, clock: string) => clock);

  // (3) Long mcp tool name → "<server>: <rest words>".
  out = out.replace(MCP_NAME_RE, (_match, server: string, rest: string) => {
    return `${server}: ${rest.replace(/_/g, " ")}`;
  });

  // (4) PATHS: nothing to do. redactValue already compacted `$HOME`→`~` and
  //     absolute paths to their last 2 segments; a `~`-rooted or ≤2-segment path
  //     is a fixed point here, and none of the regexes above match one.
  return out;
}
