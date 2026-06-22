// SPDX-License-Identifier: Apache-2.0
// SSRF blocklist tests — compose-interceptor zero-connect test.
// The PURE `isSsrfBlocked` + `BLOCKED_IPV4_CIDR_RANGES` per-range assertions
// moved to packages/core/src/net/ssrf.test.ts alongside the implementation.
// This file keeps only the `ssrfBlockInterceptor` test, which depends on undici.

import { describe, expect, it, vi } from "vitest";
import { ssrfBlockInterceptor } from "./ssrf-blocklist.js";

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
