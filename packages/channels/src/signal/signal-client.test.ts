/**
 * Tests for Signal JSON-RPC HTTP client: normalizeBaseUrl protocol selection,
 * health check, and RPC request URL construction.
 *
 * Signal client defaults to https:// for non-localhost connections,
 * http:// for localhost/127.0.0.1/[::1].
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalHealthCheck, signalRpcRequest } from "./signal-client.js";

// ---------------------------------------------------------------------------
// Mock fetch to capture URLs
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>;

function successResponse(): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ jsonrpc: "2.0", result: "ok", id: "1" }),
  } as unknown as Response;
}

/** Extract the URL string passed to the first fetch call. */
function fetchedUrl(): string {
  expect(mockFetch).toHaveBeenCalled();
  return String(mockFetch.mock.calls[0][0]);
}

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue(successResponse());
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests: normalizeBaseUrl behavior via signalHealthCheck
// ---------------------------------------------------------------------------

describe("Signal client normalizeBaseUrl", () => {
  describe("localhost detection — defaults to http://", () => {
    it("uses http:// for localhost:8080", async () => {
      await signalHealthCheck("localhost:8080");
      expect(fetchedUrl()).toContain("http://localhost:8080/api/v1/check");
    });

    it("uses http:// for 127.0.0.1:8080", async () => {
      await signalHealthCheck("127.0.0.1:8080");
      expect(fetchedUrl()).toContain("http://127.0.0.1:8080/api/v1/check");
    });

    it("uses http:// for localhost without port", async () => {
      await signalHealthCheck("localhost");
      expect(fetchedUrl()).toContain("http://localhost/api/v1/check");
    });

    it("uses http:// for 127.0.0.1 without port", async () => {
      await signalHealthCheck("127.0.0.1");
      expect(fetchedUrl()).toContain("http://127.0.0.1/api/v1/check");
    });
  });

  describe("non-localhost — defaults to https://", () => {
    it("uses https:// for signal.example.com", async () => {
      await signalHealthCheck("signal.example.com");
      expect(fetchedUrl()).toContain("https://signal.example.com/api/v1/check");
    });

    it("uses https:// for signal.example.com:9090", async () => {
      await signalHealthCheck("signal.example.com:9090");
      expect(fetchedUrl()).toContain("https://signal.example.com:9090/api/v1/check");
    });

    it("uses https:// for 192.168.1.100:8080", async () => {
      await signalHealthCheck("192.168.1.100:8080");
      expect(fetchedUrl()).toContain("https://192.168.1.100:8080/api/v1/check");
    });
  });

  describe("explicit protocol — preserved as-is", () => {
    it("keeps explicit https://", async () => {
      await signalHealthCheck("https://signal.example.com");
      expect(fetchedUrl()).toContain("https://signal.example.com/api/v1/check");
    });

    it("keeps explicit http:// (user override)", async () => {
      await signalHealthCheck("http://signal.example.com");
      expect(fetchedUrl()).toContain("http://signal.example.com/api/v1/check");
    });

    it("keeps explicit http:// for localhost", async () => {
      await signalHealthCheck("http://localhost:8080");
      expect(fetchedUrl()).toContain("http://localhost:8080/api/v1/check");
    });

    it("keeps explicit https:// for localhost", async () => {
      await signalHealthCheck("https://localhost:8080");
      expect(fetchedUrl()).toContain("https://localhost:8080/api/v1/check");
    });
  });

  describe("edge cases", () => {
    it("throws on empty baseUrl", async () => {
      await expect(signalHealthCheck("")).rejects.toThrow("Signal base URL is required");
    });

    it("throws on whitespace-only baseUrl", async () => {
      await expect(signalHealthCheck("   ")).rejects.toThrow("Signal base URL is required");
    });

    it("strips trailing slashes", async () => {
      await signalHealthCheck("localhost:8080///");
      expect(fetchedUrl()).toContain("http://localhost:8080/api/v1/check");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: normalizeBaseUrl via signalRpcRequest
// ---------------------------------------------------------------------------

describe("Signal client RPC request URL construction", () => {
  it("uses https:// for remote host in RPC requests", async () => {
    await signalRpcRequest("listAccounts", undefined, {
      baseUrl: "signal.example.com:9090",
    });
    expect(fetchedUrl()).toContain("https://signal.example.com:9090/api/v1/rpc");
  });

  it("uses http:// for localhost in RPC requests", async () => {
    await signalRpcRequest("listAccounts", undefined, {
      baseUrl: "localhost:8080",
    });
    expect(fetchedUrl()).toContain("http://localhost:8080/api/v1/rpc");
  });
});
