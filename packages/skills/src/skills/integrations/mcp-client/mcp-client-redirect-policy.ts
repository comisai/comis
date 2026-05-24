// SPDX-License-Identifier: Apache-2.0
// @allow-throw: HTTP redirect-policy boundary; throws caught by MCP SDK transport error path.
/**
 * Custom FetchLike with cross-host redirect header scrub.
 *
 * Wraps `fetch` with manual redirect handling. On cross-host redirect:
 * strips Authorization / Cookie / Proxy-Authorization headers. Same-host
 * http→https upgrade PRESERVES headers (deviation from undici default
 * which compares full origin scheme+host+port; we compare host string
 * only, so legitimate provider migrations keep working).
 *
 * Passed to SSEClientTransport / StreamableHTTPClientTransport via the
 * SDK's `opts.fetch?: FetchLike` extension hook. Max 20 hops; throws
 * [max_redirects_exceeded] on overflow.
 *
 * Per RESEARCH.md §"Pattern 1" + REQUIREMENTS.md SAFETY-07.
 *
 * @module
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const SENSITIVE_HEADERS_TO_STRIP_ON_CROSS_HOST: readonly string[] = [
  "authorization",
  "cookie",
  "proxy-authorization",
];

export interface RedirectPolicyOptions {
  readonly maxRedirections: number;
  readonly baseFetch?: typeof fetch;
}

/**
 * Create a FetchLike that manually follows redirects with cross-host
 * header scrub. See module JSDoc for policy details.
 */
export function createRedirectPolicyFetch(opts: RedirectPolicyOptions): FetchLike {
  const baseFetch = opts.baseFetch ?? fetch;
  return async (input, init) => {
    let currentUrl =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(String(input));
    let currentInit: RequestInit = { ...(init ?? {}), redirect: "manual" };
    let hops = 0;

    while (true) {
      const response = await baseFetch(currentUrl, currentInit);

      // Only 3xx with Location header is a redirect we follow.
      const isRedirect =
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has("location");
      if (!isRedirect) {
        return response;
      }

      if (hops >= opts.maxRedirections) {
        throw new Error(
          `[max_redirects_exceeded] Redirect chain exceeded ${opts.maxRedirections} hops at ${currentUrl.toString()}. ` +
            `Hint: verify the MCP server URL or reduce redirect chain.`,
        );
      }

      const locationHeader = response.headers.get("location") as string;
      const nextUrl = new URL(locationHeader, currentUrl);

      // Cross-host = URL.host string mismatch (host includes port).
      // Phase 63 deviation: same-host http→https upgrade preserves headers.
      const sameHost = nextUrl.host === currentUrl.host;
      const shouldStripSensitive = !sameHost;

      // Build next-hop headers from existing init.headers.
      const nextHeaders = new Headers();
      if (currentInit.headers !== undefined) {
        const existing = new Headers(currentInit.headers as HeadersInit);
        existing.forEach((value, key) => {
          nextHeaders.set(key, value);
        });
      }
      if (shouldStripSensitive) {
        for (const headerName of SENSITIVE_HEADERS_TO_STRIP_ON_CROSS_HOST) {
          nextHeaders.delete(headerName);
        }
      }

      currentUrl = nextUrl;
      currentInit = { ...currentInit, headers: nextHeaders };
      hops += 1;
    }
  };
}
