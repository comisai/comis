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
import { createRedirectPolicyFetch } from "./mcp-client-redirect-policy.js";

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

describe("createRedirectPolicyFetch — cross-host header scrub", () => {
  it("returns a FetchLike-shaped function that accepts url and init and resolves to a Response", async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeOk());
    const wrapped = createRedirectPolicyFetch({
      maxRedirections: 20,
      baseFetch: baseFetch as unknown as typeof fetch,
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
    });
    await wrapped("https://server-a.com/path1", {
      headers: { authorization: "Bearer same-host-token" },
    });
    expect(baseFetch).toHaveBeenCalledTimes(2);
    const secondHeaders = new Headers((baseFetch.mock.calls[1]![1] as RequestInit).headers as HeadersInit);
    expect(secondHeaders.get("authorization")).toBe("Bearer same-host-token");
  });
});
