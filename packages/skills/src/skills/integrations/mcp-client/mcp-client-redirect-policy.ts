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
import type { Result } from "@comis/shared";
import { validateUrl } from "@comis/core";

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
  /**
   * SSRF guard applied to every CROSS-HOST redirect target before it is
   * followed. Defaults to core `validateUrl` (DNS-pinned block of private /
   * loopback / link-local / cloud-metadata addresses + http/https-only).
   *
   * Same-host redirects are exempt: they stay on the operator-configured
   * (trusted) MCP host, so a legitimately-local server (`http://localhost:…`)
   * keeps redirecting within itself. Cross-host targets are server-chosen and
   * therefore untrusted (THREAT_MODEL §5.7 — malicious/compromised MCP server),
   * so they must resolve to a public address.
   *
   * Injectable so unit tests stay deterministic (no real DNS).
   */
  readonly validateRedirectTarget?: (
    urlString: string,
  ) => Promise<Result<unknown, Error>>;
}

/**
 * Normalize a cross-realm Response into a native `globalThis.Response`.
 *
 * **Why this exists** — when a `Response` from a different module realm
 * (typically `undici@8` loaded via a peer's `import { fetch } from "undici"`)
 * reaches the MCP SDK's `parseErrorResponse` (`@modelcontextprotocol/sdk/dist/
 * esm/client/auth.js:126`), the SDK's `input instanceof Response` check uses
 * the SDK's `globalThis.Response` reference. The cross-realm Response is
 * structurally identical but a DIFFERENT class — `instanceof` returns false.
 * The SDK falls through to `body = input` (the object), `JSON.parse(input)`
 * coerces it via `toString()` to `"[object Response]"`, and we get the
 * production-observed error: *"Invalid OAuth error response: SyntaxError:
 * Unexpected token 'o', '[object Response]' is not valid JSON. Raw body:
 * [object Response]"* (daemon.1.log:181, 2026-05-28).
 *
 * The fix repackages a non-native Response as a native one by buffering its
 * body. Feature-detects `arrayBuffer` so synthetic test fixtures (object
 * literals lacking the method) pass through unchanged.
 */
async function ensureNativeResponse(response: Response): Promise<Response> {
  if (response instanceof globalThis.Response) {
    return response;
  }
  // Treat the response as a structural Response (cross-realm — passes our
  // ducktype but fails `instanceof globalThis.Response`). TypeScript would
  // narrow to `never` after the instanceof above, so reassert the surface
  // here.
  const r = response as unknown as {
    readonly status: number;
    readonly statusText?: string;
    readonly headers?: { forEach?: (cb: (v: string, k: string) => void) => void };
    readonly arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof r.arrayBuffer !== "function") {
    return response;
  }
  const body = await r.arrayBuffer();
  const headers = new Headers();
  r.headers?.forEach?.((value, key) => {
    headers.append(key, value);
  });
  return new globalThis.Response(body, {
    status: r.status,
    statusText: r.statusText ?? "",
    headers,
  });
}

/**
 * Create a FetchLike that manually follows redirects with cross-host
 * header scrub. See module JSDoc for policy details.
 */
export function createRedirectPolicyFetch(opts: RedirectPolicyOptions): FetchLike {
  const baseFetch = opts.baseFetch ?? fetch;
  const validateRedirectTarget = opts.validateRedirectTarget ?? validateUrl;
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
        // Normalize cross-realm Response BEFORE returning to the SDK so the
        // SDK's `instanceof Response` check (parseErrorResponse / etc.)
        // succeeds even if a peer module's named-import of `fetch` from
        // undici@8 leaked a different Response class into our chain. See
        // ensureNativeResponse JSDoc for the production failure mode.
        return ensureNativeResponse(response);
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

      // SSRF guard on cross-host redirects. A malicious or compromised MCP
      // server (untrusted per THREAT_MODEL §5.7) can answer any request with a
      // 3xx whose Location points at an internal address — cloud metadata
      // (169.254.169.254), a localhost admin port, or an RFC-1918 service.
      // This fetch runs IN-PROCESS in the daemon (not behind the broker egress
      // jail), so following such a redirect is host-control SSRF. Validate the
      // resolved IP of every cross-host target before following it; same-host
      // redirects stay on the operator-configured host and are exempt so a
      // local MCP server keeps working. Mirrors the validateUrl guard every
      // other outbound path in this package already uses.
      if (!sameHost) {
        const ssrf = await validateRedirectTarget(nextUrl.toString());
        if (!ssrf.ok) {
          throw new Error(
            `[redirect_blocked_ssrf] Refusing MCP redirect to ${nextUrl.host}: ${ssrf.error.message}. ` +
              `Hint: the MCP server redirected to a private / loopback / link-local / cloud-metadata address.`,
          );
        }
      }

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
      // (307/308) PRESERVES both method and body. A naive policy that
      // carries `body` and `method` forward unchanged across all 3xx
      // would silently re-POST a body (potentially containing sensitive
      // request data — the MCP SDK uses POST for tools/list and tool
      // calls) to an attacker-controlled redirect target.
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
