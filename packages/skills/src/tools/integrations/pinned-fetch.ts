// SPDX-License-Identifier: Apache-2.0
/**
 * DNS-pinned fetch primitive for SSRF-validated hosts (CR-01, Phase 197).
 *
 * `validateUrl` / `validateLocalServerUrl` resolve a hostname's IP and classify
 * it, but a subsequent BARE `fetch()` re-resolves DNS independently at connect
 * time — the classic check-then-use (TOCTOU) gap a DNS-rebinding attacker uses
 * to pass validation as loopback then connect to a different IP. This module is
 * the ONE place `@comis/skills` builds the undici `Agent` whose `connect.lookup`
 * always returns the PRE-VALIDATED IP, closing that window while preserving TLS
 * SNI (the original hostname stays in the URL).
 *
 * It is the shared extraction of the pattern that already lived inline in
 * `media/ssrf-fetcher.ts` (`createSsrfGuardedFetcher`) — that fetcher now imports
 * `createPinnedAgent` from here, and the two SEC-02 local-server surfaces
 * (`local-stt-probe.ts`, `openai-stt-adapter.ts`) use `fetchPinned` so all three
 * paths share ONE pinned implementation instead of each hand-rolling a bare
 * `fetch`.
 *
 * Both `fetch` and `Agent` are imported from undici directly (NOT
 * `globalThis.fetch`): Node's bundled fetch ships an older undici whose
 * request-handler lifecycle is incompatible with the v8 `Agent` used for DNS
 * pinning (mixing the two throws `InvalidArgumentError: invalid onRequestStart
 * method`). Do not swap this back to `globalThis.fetch` — the same constraint is
 * documented in `ssrf-fetcher.ts` and `ssrf-image-fetch.ts`.
 *
 * @module
 */
import { suppressError } from "@comis/shared";
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from "undici";

/**
 * Create a one-shot undici `Agent` that pins DNS resolution to a specific IP.
 *
 * The Agent's `connect.lookup` callback always returns the pre-validated IP,
 * preventing DNS rebinding (TOCTOU) between validation and connection while
 * preserving TLS SNI (because the original hostname stays in the URL).
 *
 * The caller owns the returned Agent's lifecycle and MUST `close()` it when the
 * request settles (use {@link fetchPinned}, which closes it in a `finally`).
 */
export function createPinnedAgent(ip: string): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        // Return the pre-validated IP for all lookups through this agent.
        // The address family is inferred from the IP format.
        const family = ip.includes(":") ? 6 : 4;

        // Node.js 22+ enables autoSelectFamily (Happy Eyeballs) by default,
        // which calls lookup with {all: true} expecting an array of addresses.
        if (options && typeof options === "object" && "all" in options && options.all) {
          (callback as (err: null, addresses: Array<{ address: string; family: number }>) => void)(
            null,
            [{ address: ip, family }],
          );
        } else {
          callback(null, ip, family);
        }
      },
    },
  });
}

/**
 * Fetch `url` with the connection PINNED to `pinnedIp` (no DNS rebind window).
 *
 * The caller MUST have already SSRF-validated `url` and obtained `pinnedIp` from
 * the validator's resolved IP (`ValidatedUrl.ip`). This helper builds a one-shot
 * pinned {@link createPinnedAgent}, issues the request through it as the undici
 * `dispatcher`, and ALWAYS closes the agent afterwards (the agent close is
 * fire-and-forget via `suppressError` — a cleanup failure must not mask the
 * fetch result/error).
 *
 * The original `url` (hostname) is preserved verbatim so TLS SNI / certificate
 * validation still works; only the IP the socket connects to is pinned.
 *
 * @param url      - The already-validated http(s) URL to fetch.
 * @param pinnedIp - The pre-validated IP to pin the connection to.
 * @param init     - Standard fetch init (method, headers, body, signal, …). The
 *                   `dispatcher` is set by this helper and must NOT be supplied.
 * @returns The undici `Response`. Network/connect errors propagate to the caller
 *   (each SEC-02 surface already wraps its fetch in a try → honest-degrade).
 */
export async function fetchPinned(
  url: string,
  pinnedIp: string,
  init?: Omit<RequestInit, "dispatcher">,
): Promise<Response> {
  const agent = createPinnedAgent(pinnedIp);
  try {
    return await undiciFetch(url, { ...init, dispatcher: agent });
  } finally {
    suppressError(agent.close(), "pinned-fetch agent cleanup");
  }
}
