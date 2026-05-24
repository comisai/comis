// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 63 SAFETY-07 — co-located unit tests for createRedirectPolicyFetch.
 *
 * Covers the 12 behavior cases the factory's policy must enforce. Each test
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

function makeOk(): Response {
  return {
    status: 200,
    headers: new Headers(),
    ok: true,
  } as unknown as Response;
}

describe("createRedirectPolicyFetch — Phase 63 SAFETY-07 cross-host header scrub", () => {
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

  it("same-host http to https upgrade preserves Authorization (Phase 63 deviation from undici default)", async () => {
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
});
