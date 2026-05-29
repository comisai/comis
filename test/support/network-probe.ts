// SPDX-License-Identifier: Apache-2.0
/**
 * Network-availability probe for gating integration tests that depend on a
 * live external HTTP service.
 *
 * A handful of integration tests (web-tools, tool-link) make REAL requests to
 * `httpbin.org` — a free, frequently-overloaded public test service. When it
 * returns 503 (or is unreachable), those tests were producing false failures
 * unrelated to any code change. This helper lets such suites SKIP cleanly when
 * the dependency is unavailable instead of failing.
 *
 * Semantics: returns `true` ONLY on a `< 500` HTTP response within the timeout.
 * Any network error, DNS failure, timeout, or `5xx` yields `false` — i.e. the
 * dependent tests skip. It never throws.
 *
 * @module
 */

/**
 * True if `url` answers with a non-5xx status within `timeoutMs`.
 *
 * @param url - Health-probe URL (e.g. `https://httpbin.org/status/200`).
 * @param timeoutMs - Abort budget. Default 5000ms.
 */
export async function isServiceHealthy(url: string, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience probe for the `httpbin.org` dependency shared by the web-fetch /
 * link-understanding integration suites. Hits `/status/200` (the cheapest
 * always-200 endpoint when the host is healthy).
 */
export function isHttpbinHealthy(timeoutMs = 5000): Promise<boolean> {
  return isServiceHealthy("https://httpbin.org/status/200", timeoutMs);
}
