// SPDX-License-Identifier: Apache-2.0
// SSRF blocklist tests — compose-interceptor zero-connect test.
// The PURE `isSsrfBlocked` + `BLOCKED_IPV4_CIDR_RANGES` per-range assertions
// moved to packages/core/src/net/ssrf.test.ts alongside the implementation.
// This file keeps only the `ssrfBlockInterceptor` test, which depends on undici.

import { describe, expect, it, vi } from "vitest";
import { ssrfBlockInterceptor, createSsrfBlockInterceptor } from "./ssrf-blocklist.js";

// ---------------------------------------------------------------------------
// ssrfBlockInterceptor — blocks BEFORE connect (zero-connect test)
// Network-free: wraps a plain dispatch spy, no MockAgent.
// ---------------------------------------------------------------------------

// Note: In undici 8.3.0, DispatchHandler uses onResponseError(controller, error)
// instead of onError(error). The interceptor calls handler.onResponseError?.(null, err)
// mirroring the undici dns interceptor pattern (null controller for errors before connect).
describe("ssrfBlockInterceptor", () => {
  it("calls handler.onResponseError and does NOT call dispatch for a blocked origin", () => {
    const mockDispatch = vi.fn();
    const guardedDispatch = ssrfBlockInterceptor(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];

    const result = guardedDispatch(
      { origin: "http://169.254.169.254", path: "/latest/meta-data/", method: "GET" } as Parameters<typeof guardedDispatch>[0],
      handler,
    );

    expect(onResponseError).toHaveBeenCalledOnce();
    // Called with (null, Error) — null controller per undici dns interceptor pattern
    const errorArg = onResponseError.mock.calls[0][1] as Error;
    expect(errorArg).toBeInstanceOf(Error);
    expect(errorArg.message).toMatch(/SSRF.*blocked/i);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("calls handler.onResponseError and does NOT call dispatch for RFC1918 blocked origin", () => {
    const mockDispatch = vi.fn();
    const guardedDispatch = ssrfBlockInterceptor(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];

    guardedDispatch(
      { origin: "http://192.168.1.1", path: "/", method: "GET" } as Parameters<typeof guardedDispatch>[0],
      handler,
    );

    expect(onResponseError).toHaveBeenCalledOnce();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("blocks an IPv6 loopback origin ::1 via onResponseError", () => {
    const mockDispatch = vi.fn();
    const guardedDispatch = ssrfBlockInterceptor(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];

    guardedDispatch(
      { origin: "http://[::1]:8080", path: "/", method: "GET" } as Parameters<typeof guardedDispatch>[0],
      handler,
    );

    expect(onResponseError).toHaveBeenCalledOnce();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("calls handler.onResponseError and does NOT call dispatch for a malformed origin", () => {
    const mockDispatch = vi.fn();
    const guardedDispatch = ssrfBlockInterceptor(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];

    guardedDispatch(
      { origin: "not-a-url-%%", path: "/", method: "GET" } as Parameters<typeof guardedDispatch>[0],
      handler,
    );

    expect(onResponseError).toHaveBeenCalledOnce();
    const errorArg = onResponseError.mock.calls[0][1] as Error;
    expect(errorArg.message).toMatch(/SSRF.*malformed/i);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("delegates to dispatch for a public allowed origin", () => {
    const mockDispatch = vi.fn().mockReturnValue(true);
    const guardedDispatch = ssrfBlockInterceptor(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];
    const opts = { origin: "https://api.openai.com", path: "/v1/chat/completions", method: "POST" } as Parameters<typeof guardedDispatch>[0];

    const result = guardedDispatch(opts, handler);

    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockDispatch).toHaveBeenCalledWith(opts, handler);
    expect(onResponseError).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("handles URL object origin by using .href", () => {
    const mockDispatch = vi.fn().mockReturnValue(true);
    const guardedDispatch = ssrfBlockInterceptor(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];

    guardedDispatch(
      { origin: new URL("https://api.openai.com"), path: "/", method: "GET" } as unknown as Parameters<typeof guardedDispatch>[0],
      handler,
    );

    expect(onResponseError).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// createSsrfBlockInterceptor — loopback/gateway carve-out (gateway-only mode)
// Regression: enabling a proxy must NOT block the local gateway + Ollama. The
// interceptor runs above the NO_PROXY routing decision, so the trusted loopback
// hosts must be exempt from the SSRF block, not merely routed direct.
// ---------------------------------------------------------------------------

describe("createSsrfBlockInterceptor allowlist carve-out", () => {
  it("delegates to dispatch for a loopback host in the allowlist (gateway 127.0.0.1)", () => {
    const mockDispatch = vi.fn().mockReturnValue(true);
    const guardedDispatch = createSsrfBlockInterceptor(new Set(["127.0.0.1", "localhost", "::1"]))(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];
    const opts = { origin: "http://127.0.0.1:4766", path: "/", method: "GET" } as Parameters<typeof guardedDispatch>[0];

    const result = guardedDispatch(opts, handler);

    // 127.0.0.1 IS SSRF-blocked, but the carve-out exempts it → dispatch is called
    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockDispatch).toHaveBeenCalledWith(opts, handler);
    expect(onResponseError).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("delegates to dispatch for the Ollama localhost host in the allowlist", () => {
    const mockDispatch = vi.fn().mockReturnValue(true);
    const guardedDispatch = createSsrfBlockInterceptor(new Set(["localhost", "127.0.0.1", "::1"]))(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];

    guardedDispatch(
      { origin: "http://localhost:11434", path: "/api/embeddings", method: "POST" } as Parameters<typeof guardedDispatch>[0],
      handler,
    );

    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(onResponseError).not.toHaveBeenCalled();
  });

  it("still BLOCKS a loopback host NOT in the allowlist (block mode → empty set)", () => {
    const mockDispatch = vi.fn();
    // Empty allowlist mirrors loopbackMode:"block"
    const guardedDispatch = createSsrfBlockInterceptor(new Set())(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];

    const result = guardedDispatch(
      { origin: "http://127.0.0.1:4766", path: "/", method: "GET" } as Parameters<typeof guardedDispatch>[0],
      handler,
    );

    expect(onResponseError).toHaveBeenCalledOnce();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("still BLOCKS cloud metadata even when loopback hosts are exempted", () => {
    const mockDispatch = vi.fn();
    const guardedDispatch = createSsrfBlockInterceptor(new Set(["127.0.0.1", "localhost", "::1"]))(mockDispatch);

    const onResponseError = vi.fn();
    const handler = { onResponseError } as Parameters<typeof guardedDispatch>[1];

    guardedDispatch(
      { origin: "http://169.254.169.254", path: "/latest/meta-data/", method: "GET" } as Parameters<typeof guardedDispatch>[0],
      handler,
    );

    // The carve-out only exempts the explicit loopback set — metadata stays blocked
    expect(onResponseError).toHaveBeenCalledOnce();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
