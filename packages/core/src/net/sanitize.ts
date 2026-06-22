// SPDX-License-Identifier: Apache-2.0
/**
 * Proxy URL credential sanitizer — SEC-04 / D-08.
 *
 * `sanitizeProxyUrl` strips the userinfo component (`user:password@`) from a
 * proxy URL before the result is used in an `Error()` message, a log call, or
 * any other operator-visible surface. It is the explicit-construction half of
 * the two-layer credential defence (the second half is the `proxyUrl`/`proxy_url`
 * entries in `CREDENTIAL_KEYS` that make Pino auto-redact any raw `proxyUrl`
 * log field).
 *
 * Pure: no runtime deps (uses only the WHATWG URL parser). Lives in @comis/core
 * so both @comis/infra (the runtime dispatcher) and @comis/cli (the offline
 * `comis proxy validate` command) can share it without a cli→infra edge.
 *
 * @module
 */

/** Placeholder returned when the input cannot be parsed as a URL. */
const MALFORMED_PLACEHOLDER = "[proxy-url: malformed]";

/**
 * Strip userinfo (`user:password@`) from a proxy URL string and return
 * `scheme://host:port` (or `scheme://host` when no port is present).
 *
 * Uses the WHATWG URL parser — the same engine Node.js `fetch` / undici use —
 * so the resulting host is authoritative: `parsed.host` is always
 * `hostname:port` (or just `hostname` when the port is the scheme default or
 * absent), with no userinfo.
 *
 * @param url - Any string that may be a proxy URL.  May carry credentials in
 *   the userinfo component (`http://user:secret@host:port/…`).
 * @returns The sanitized URL string (`scheme://host:port`), or a safe
 *   non-secret placeholder when parsing fails — never throws.
 */
export function sanitizeProxyUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return MALFORMED_PLACEHOLDER;
  }
  // `parsed.host` is `hostname:port` (port omitted when it is the default for
  // the scheme).  Neither `username` nor `password` appears in `.host`.
  return `${parsed.protocol}//${parsed.host}`;
}
