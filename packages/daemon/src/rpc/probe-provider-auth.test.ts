// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
import { probeProviderAuth } from "./probe-provider-auth.js";

describe("probeProviderAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok() on 2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));

    const result = await probeProviderAuth("https://api.example.com/v1", "test-key");

    expect(result.ok).toBe(true);
  });

  it("returns err() on 401 response with descriptive message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));

    const result = await probeProviderAuth("https://api.example.com/v1", "test-key");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("API key rejected");
      expect(result.error).toContain("401");
    }
  });

  it("returns err() on 403 response with descriptive message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 403 }));

    const result = await probeProviderAuth("https://api.example.com/v1", "test-key");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("API key rejected");
      expect(result.error).toContain("403");
    }
  });

  it("returns ok() on 5xx response (transient — do not block)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 500 }));

    const result = await probeProviderAuth("https://api.example.com/v1", "test-key");

    expect(result.ok).toBe(true);
  });

  it("returns ok() on network error (unreachable — do not block)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const result = await probeProviderAuth("https://api.example.com/v1", "test-key");

    expect(result.ok).toBe(true);
  });

  it("returns ok() on timeout (do not block)", async () => {
    const timeoutError = new DOMException("The operation was aborted", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError));

    const result = await probeProviderAuth("https://api.example.com/v1", "test-key");

    expect(result.ok).toBe(true);
  });

  it("returns ok() when baseUrl is empty (nothing to probe)", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await probeProviderAuth("", "test-key");

    expect(result.ok).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns ok() when apiKey is empty (nothing to probe)", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await probeProviderAuth("https://api.example.com/v1", "");

    expect(result.ok).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("respects custom timeoutMs (AbortSignal.timeout)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    await probeProviderAuth("https://api.example.com/v1", "test-key", 2_000);

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0]!;
    expect(callArgs[0]).toBe("https://api.example.com/v1/models");
    expect(callArgs[1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer test-key" },
    });
    // AbortSignal.timeout is used — verify signal is present
    expect(callArgs[1].signal).toBeDefined();
  });

  it("sends GET /models with Authorization header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    await probeProviderAuth("https://api.example.com/v1", "test-key");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer test-key" },
      }),
    );
  });
});
