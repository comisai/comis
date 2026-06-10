// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for createRedirectPolicyFetch.
 *
 * Covers the behavior cases the factory's policy must enforce. Each test
 * uses a vi.fn() as `baseFetch` returning synthetic Response objects so the
 * suite never opens a real network socket. Cross-host/same-host semantics
 * are encoded by the Location header value the synthetic 302 carries.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import { createRedirectPolicyFetch } from "./mcp-client-redirect-policy.js";

// Deterministic SSRF stub for the header-scrub / method-rewrite suites below:
// those assert redirect mechanics, not SSRF, and their synthetic cross-host
// targets (other.example.com, etc.) must never trigger a real DNS lookup. The
// dedicated "SSRF guard on cross-host redirects" suite uses the REAL default
// (core validateUrl) against IP-literal targets that resolve locally.
const allowAllSsrf = async (): Promise<ReturnType<typeof ok>> => ok(undefined);

function makeRedirect(location: string): Response {
  return {
    status: 302,
    headers: new Headers({ location }),
    ok: false,
  } as unknown as Response;
}

function makeRedirectWithStatus(status: number, location: string): Response {
  return {
    status,
    headers: new Headers({ location }),
    ok: false,
  } as unknown as Response;
}

function makeOk(): Response {
  return {
    status: 200,
    headers: new Headers(),
    ok: true,
  } as unknown as Response;
}

// Cross-realm Response simulation. Mirrors what `undici@8`'s Response (or any
// non-globalThis Response class) looks like to the MCP SDK's `parseErrorResponse`
// at `@modelcontextprotocol/sdk/dist/esm/client/auth.js:126`. The object is
// Response-SHAPED but NOT `instanceof globalThis.Response`, has the canonical
// `[Symbol.toStringTag] = "Response"` so `String(it)` produces `"[object
// Response]"` (the exact substring observed in the production error log), and
// exposes the `arrayBuffer()` + `headers` surface the normalizer reads.
function makeCrossRealmResponse(status: number, bodyText: string): Response {
  return {
    status,
    statusText: status === 400 ? "Bad Request" : "",
    headers: new Headers({ "content-type": "application/json" }),
    ok: status >= 200 && status < 300,
    [Symbol.toStringTag]: "Response",
    async arrayBuffer() {
      return new TextEncoder().encode(bodyText).buffer;
    },
  } as unknown as Response;
}

describe("createRedirectPolicyFetch — cross-realm Response normalization (MCP-OAuth bug)", () => {
  it("returns a native globalThis.Response when baseFetch yields a cross-realm Response (instanceof check fails upstream)", async () => {
    const crossRealm = makeCrossRealmResponse(
      400,
      '{"error":"invalid_redirect_uri","error_description":"at least one redirect_uri is required"}',
    );
    // Sanity: the fixture must satisfy the production failure shape
    // (instanceof globalThis.Response === false, String() === "[object Response]").
    expect(crossRealm instanceof globalThis.Response).toBe(false);
    expect(String(crossRealm)).toBe("[object Response]");

    const baseFetch = vi.fn().mockResolvedValue(crossRealm);
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });

    const response = await wrapped("https://mcp.higgsfield.ai/oauth2/register", {});

    // The native globalThis.Response that the SDK's `instanceof Response`
    // check expects.
    expect(response instanceof globalThis.Response).toBe(true);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("invalid_redirect_uri");
  });

  it("passes through a real globalThis.Response unchanged (no buffering cost on the hot path)", async () => {
    const native = new globalThis.Response("ok", { status: 200 });
    const baseFetch = vi.fn().mockResolvedValue(native);
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });

    const response = await wrapped("https://example.com/", {});
    expect(response).toBe(native);
  });
});

describe("createRedirectPolicyFetch — cross-host header scrub", () => {
  it("returns a FetchLike-shaped function that accepts url and init and resolves to a Response", async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    expect(typeof wrapped).toBe("function");
    const response = await wrapped("http://api.example.com/v1", {});
    expect(response).toBeDefined();
    expect((response as Response).status).toBe(200);
  });

  it("returns the direct 200 response unchanged when baseFetch yields no redirect", async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    const response = await wrapped("http://api.example.com/v1", {
      headers: { authorization: "Bearer kept" },
    });
    expect((response as Response).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("cross-host redirect removes Authorization header from second-hop request", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("http://other.example.com/v1"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://api.example.com/v1", {
      headers: { authorization: "Bearer secret" },
    });
    expect(baseFetch).toHaveBeenCalledTimes(2);
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    const secondHeaders = new Headers(secondInit.headers as HeadersInit);
    expect(secondHeaders.get("authorization")).toBeNull();
  });

  it("cross-host redirect removes Cookie and Proxy-Authorization headers from second-hop request", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("http://other.example.com/v1"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://api.example.com/v1", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=abc",
        "proxy-authorization": "Basic xyz",
      },
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    const secondHeaders = new Headers(secondInit.headers as HeadersInit);
    expect(secondHeaders.get("cookie")).toBeNull();
    expect(secondHeaders.get("proxy-authorization")).toBeNull();
  });

  it("same-host redirect with identical host preserves Authorization header through second hop", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("/b"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://api.example.com/a", {
      headers: { authorization: "Bearer kept-token" },
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    const secondHeaders = new Headers(secondInit.headers as HeadersInit);
    expect(secondHeaders.get("authorization")).toBe("Bearer kept-token");
  });

  it("same-host http to https upgrade preserves Authorization (deviation from undici default)", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("https://api.example.com/v2"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://api.example.com/v1", {
      headers: { authorization: "Bearer upgrade-token" },
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    const secondHeaders = new Headers(secondInit.headers as HeadersInit);
    expect(secondHeaders.get("authorization")).toBe("Bearer upgrade-token");
  });

  it("cross-host http to https upgrade strips Authorization (cross-host beats upgrade-preserve)", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("https://b.example.com/v2"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://a.example.com/v1", {
      headers: { authorization: "Bearer cross-token" },
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    const secondHeaders = new Headers(secondInit.headers as HeadersInit);
    expect(secondHeaders.get("authorization")).toBeNull();
  });

  it("redirect chain exceeding 20 hops throws Error with bracketed max_redirects_exceeded code", async () => {
    const baseFetch = vi.fn().mockImplementation((url: unknown) => {
      const current = new URL(
        typeof url === "string" ? url : (url as URL).toString(),
      );
      const next = new URL(current.toString());
      next.pathname = `${current.pathname}/x`;
      return Promise.resolve(makeRedirect(next.toString()));
    });
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await expect(
      wrapped("http://api.example.com/start", {}),
    ).rejects.toThrow(/\[max_redirects_exceeded\]/);
  });

  it("3xx response without a Location header is returned unchanged without infinite loop", async () => {
    const noLocation = {
      status: 304,
      headers: new Headers(),
      ok: false,
    } as unknown as Response;
    const baseFetch = vi.fn().mockResolvedValue(noLocation);
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    const response = await wrapped("http://api.example.com/v1", {});
    expect((response as Response).status).toBe(304);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("non-3xx response (200 / 400 / 500) is returned unchanged with no second-hop request", async () => {
    const fiveHundred = {
      status: 500,
      headers: new Headers(),
      ok: false,
    } as unknown as Response;
    const baseFetch = vi.fn().mockResolvedValue(fiveHundred);
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    const response = await wrapped("http://api.example.com/v1", {});
    expect((response as Response).status).toBe(500);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("init headers given as a Headers instance are preserved through to baseFetch on first hop", async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    const headersInstance = new Headers({ "x-custom": "value-h" });
    await wrapped("http://api.example.com/v1", { headers: headersInstance });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    const firstInit = baseFetch.mock.calls[0]![1] as RequestInit;
    expect(firstInit.headers).toBeDefined();
  });

  it("init headers given as a plain object are preserved through to baseFetch on first hop", async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://api.example.com/v1", { headers: { "x-custom": "value-o" } });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    const firstInit = baseFetch.mock.calls[0]![1] as RequestInit;
    expect(firstInit.headers).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // RFC 7231 / 7538 method+body rewrite on redirect.
  //
  // The policy carries `body`, `method`, and every other init field forward
  // unchanged via `{ ...currentInit, headers: nextHeaders }`. On a 302/303
  // redirect, browsers convert POST -> GET and DROP the body
  // (RFC 7231 §6.4.3 / §6.4.4). The MCP SDK uses POST for tools/list and
  // tool calls; if a cross-host attacker controls the redirect target, they
  // can have the body (which may contain sensitive request data) re-POSTed
  // to their server. Authorization was already stripped, but the request
  // body was not.
  //
  // RFC 7538 (307/308 — "Permanent / Temporary Redirect") explicitly
  // PRESERVES both method and body. The implementation differentiates by
  // status code.
  // -------------------------------------------------------------------------
  it("cross-host 302 rewrites POST to GET and clears body", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectWithStatus(302, "http://other.example.com/v1"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://api.example.com/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "do-not-re-POST-cross-host" }),
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    expect(secondInit.method).toBe("GET");
    expect(secondInit.body).toBeUndefined();
  });

  it("same-host 302 rewrites POST to GET and clears body", async () => {
    // Per RFC, 302 rewrites POST to GET regardless of host. Cross-host
    // is the security-critical case for body protection, but same-host
    // 302s must still match the RFC contract.
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectWithStatus(302, "/v2"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://api.example.com/v1", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    expect(secondInit.method).toBe("GET");
    expect(secondInit.body).toBeUndefined();
  });

  it("cross-host 303 rewrites POST to GET and clears body (RFC 7231 §6.4.4)", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectWithStatus(303, "http://other.example.com/v1"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://api.example.com/v1", {
      method: "POST",
      body: JSON.stringify({ secret: "see-other" }),
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    expect(secondInit.method).toBe("GET");
    expect(secondInit.body).toBeUndefined();
  });

  it("cross-host 307 PRESERVES method and body (RFC 7538 — Temporary Redirect)", async () => {
    // 307 explicitly preserves the original method and body. Cross-host
    // still strips Authorization (the existing cross-host header scrub),
    // but the body and method survive.
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectWithStatus(307, "http://other.example.com/v1"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    const originalBody = JSON.stringify({ rpc: "tools/list" });
    await wrapped("http://api.example.com/v1", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: originalBody,
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBe(originalBody);
    // Authorization header is still stripped on cross-host.
    const secondHeaders = new Headers(secondInit.headers as HeadersInit);
    expect(secondHeaders.get("authorization")).toBeNull();
  });

  it("cross-host 308 PRESERVES method and body (RFC 7538 — Permanent Redirect)", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectWithStatus(308, "http://other.example.com/v1"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    const originalBody = JSON.stringify({ rpc: "tools/call", method: "foo" });
    await wrapped("http://api.example.com/v1", {
      method: "POST",
      body: originalBody,
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBe(originalBody);
  });

  it("same-host 307 PRESERVES method and body", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectWithStatus(307, "/v2"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    const originalBody = JSON.stringify({ a: 2 });
    await wrapped("http://api.example.com/v1", {
      method: "POST",
      body: originalBody,
    });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBe(originalBody);
  });

  it("GET request on 302 preserves the GET method (no rewrite needed, body is already absent)", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectWithStatus(302, "/v2"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("http://api.example.com/v1", { method: "GET" });
    const secondInit = baseFetch.mock.calls[1]![1] as RequestInit;
    expect(secondInit.method).toBe("GET");
    expect(secondInit.body).toBeUndefined();
  });
});

// =============================================================================
// Expanded header stripping
// =============================================================================
// These tests assert that the expanded allowlist (12+ headers) strips
// x-auth-token, x-api-key, and peers on cross-origin redirects.

describe("expanded header stripping on cross-origin redirect", () => {
  it("strips x-auth-token on cross-origin redirect to a different host", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("https://server-b.com/v1"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("https://server-a.com/v1", {
      headers: { "x-auth-token": "secret-token-abc" },
    });
    expect(baseFetch).toHaveBeenCalledTimes(2);
    const secondHeaders = new Headers((baseFetch.mock.calls[1]![1] as RequestInit).headers as HeadersInit);
    expect(secondHeaders.get("x-auth-token")).toBeNull();
  });

  it("strips x-api-key on cross-origin redirect to a different host", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("https://server-b.com/v1"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("https://server-a.com/v1", {
      headers: { "x-api-key": "api-key-xyz-12345" },
    });
    expect(baseFetch).toHaveBeenCalledTimes(2);
    const secondHeaders = new Headers((baseFetch.mock.calls[1]![1] as RequestInit).headers as HeadersInit);
    expect(secondHeaders.get("x-api-key")).toBeNull();
  });

  it("preserves authorization on same-origin redirect (same host — must NOT strip)", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("https://server-a.com/path2"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
      validateRedirectTarget: allowAllSsrf,
    });
    await wrapped("https://server-a.com/path1", {
      headers: { authorization: "Bearer same-host-token" },
    });
    expect(baseFetch).toHaveBeenCalledTimes(2);
    const secondHeaders = new Headers((baseFetch.mock.calls[1]![1] as RequestInit).headers as HeadersInit);
    expect(secondHeaders.get("authorization")).toBe("Bearer same-host-token");
  });
});

// =============================================================================
// SSRF guard on cross-host redirects (v2.20 review finding).
//
// A malicious/compromised MCP server (untrusted per THREAT_MODEL §5.7) can
// answer any request with a 3xx whose Location points at an internal address.
// This fetch runs in-process in the daemon (NOT behind the broker egress jail),
// so following it is host-control SSRF to cloud metadata / localhost / RFC-1918.
// The default guard is core validateUrl; these tests exercise it end-to-end
// (no injected fake) against IP-literal targets, which getaddrinfo resolves
// locally — so the suite stays deterministic with no real network.
// =============================================================================
describe("SSRF guard on cross-host redirects", () => {
  it("blocks a cross-host redirect to the cloud-metadata IP and never contacts it", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirectWithStatus(307, "http://169.254.169.254/latest/meta-data/iam/"))
      .mockResolvedValueOnce(makeOk());
    // No validateRedirectTarget -> the real default (core validateUrl) runs.
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
    });
    await expect(
      wrapped("https://mcp.example.test/sse", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/\[redirect_blocked_ssrf\]/);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("blocks a cross-host redirect to a loopback service address", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("http://127.0.0.1:6379/"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
    });
    await expect(
      wrapped("https://mcp.example.test/sse", {}),
    ).rejects.toThrow(/\[redirect_blocked_ssrf\]/);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("allows a cross-host redirect to a public address (does not over-block)", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("http://8.8.8.8/v2"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
    });
    const res = await wrapped("https://mcp.example.test/v1", {});
    expect((res as Response).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it("allows a same-host redirect even on a loopback host (local MCP server keeps working)", async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(makeRedirect("/mcp/v2"))
      .mockResolvedValueOnce(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
    });
    // Configured server is on loopback; staying on the same host is exempt
    // from the SSRF check (the operator-trusted target).
    const res = await wrapped("http://127.0.0.1:3000/mcp", {});
    expect((res as Response).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });
});
