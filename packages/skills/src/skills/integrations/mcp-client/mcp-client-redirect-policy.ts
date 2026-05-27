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
 * @module
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const SENSITIVE_HEADERS_TO_STRIP_ON_CROSS_HOST: readonly string[] = [
  // Standard auth headers
  "authorization",
  "cookie",
  "proxy-authorization",
  // Extended auth headers (OpenClaw 13-header set — cross-origin exfil vectors)
  "x-auth-token",
  "x-api-key",
  "x-authorization",
  "authorization-token",
  "x-forwarded-authorization",
  "x-access-token",
  "x-amz-security-token",
  "x-goog-api-key",
  "x-client-id",
  "x-client-secret",
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
      // Deviation: same-host http→https upgrade preserves headers.
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

      // RFC 7231 §6.4.3 (302) / §6.4.4 (303): on 302/303 a
      // POST is rewritten to GET and the body is DROPPED. RFC 7538
      // (307/308) PRESERVES both method and body. Pre-fix the policy
      // carried `body` and `method` forward unchanged across all 3xx,
      // which would silently re-POST a body (potentially containing
      // sensitive request data — the MCP SDK uses POST for tools/list
      // and tool calls) to an attacker-controlled redirect target.
      // Differentiate by status code:
      //   - 302 / 303 -> method := GET, body := undefined
      //   - 307 / 308 -> method + body preserved (the existing
      //                  cross-host header scrub still applies)
      const status = response.status;
      const isPostToGetRewrite = status === 302 || status === 303;
      const nextInit: RequestInit = isPostToGetRewrite
        ? { ...currentInit, method: "GET", body: undefined, headers: nextHeaders }
        : { ...currentInit, headers: nextHeaders };

      currentUrl = nextUrl;
      currentInit = nextInit;
      hops += 1;
    }
  };
}
