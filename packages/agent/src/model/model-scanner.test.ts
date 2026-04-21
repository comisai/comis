// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createModelScanner, type ModelScanner, type ScanResult } from "./model-scanner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
): (url: string, init: RequestInit) => Promise<Response> {
  return handler;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModelScanner", () => {
  let scanner: ModelScanner;
  let fetchCalls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    fetchCalls = [];
  });

  function createScannerWithMock(
    handler: (url: string, init: RequestInit) => Promise<Response>,
  ): ModelScanner {
    const wrappedHandler = async (url: string, init: RequestInit): Promise<Response> => {
      fetchCalls.push({ url, init });
      return handler(url, init);
    };
    return createModelScanner({
      fetchFn: createMockFetch(wrappedHandler),
      timeoutMs: 5000,
    });
  }

  describe("scanProvider() - OpenAI-compatible", () => {
    it("returns valid result with discovered models for 200 response", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
      );

      const result = await scanner.scanProvider(
        "openai",
        { type: "openai", baseUrl: "https://api.openai.com" },
        "sk-test-key",
      );

      expect(result.provider).toBe("openai");
      expect(result.keyValid).toBe(true);
      expect(result.modelsDiscovered).toEqual(["gpt-4o", "gpt-4o-mini"]);
      expect(result.error).toBeUndefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("sends correct Authorization header", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({ data: [{ id: "gpt-4o" }] }),
      );

      await scanner.scanProvider(
        "openai",
        { type: "openai", baseUrl: "https://api.openai.com" },
        "sk-test-key",
      );

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]!.url).toBe("https://api.openai.com/v1/models");
      const headers = fetchCalls[0]!.init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test-key");
    });

    it("works for OpenAI-compatible providers like groq", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({ data: [{ id: "llama-3.3-70b" }] }),
      );

      const result = await scanner.scanProvider(
        "groq",
        { type: "openai", baseUrl: "https://api.groq.com/openai" },
        "gsk-test-key",
      );

      expect(result.keyValid).toBe(true);
      expect(result.modelsDiscovered).toEqual(["llama-3.3-70b"]);
      expect(fetchCalls[0]!.url).toBe("https://api.groq.com/openai/v1/models");
    });
  });

  describe("scanProvider() - Anthropic", () => {
    it("returns valid result with anthropic format", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({
          data: [
            { id: "claude-sonnet-4-5-20250929", type: "model" },
            { id: "claude-3-5-haiku-20241022", type: "model" },
          ],
          has_more: false,
        }),
      );

      const result = await scanner.scanProvider(
        "anthropic",
        { type: "anthropic", baseUrl: "https://api.anthropic.com" },
        "sk-ant-test",
      );

      expect(result.keyValid).toBe(true);
      expect(result.modelsDiscovered).toContain("claude-sonnet-4-5-20250929");
      expect(result.modelsDiscovered).toContain("claude-3-5-haiku-20241022");
    });

    it("sends correct Anthropic headers", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({ data: [], has_more: false }),
      );

      await scanner.scanProvider(
        "anthropic",
        { type: "anthropic", baseUrl: "https://api.anthropic.com" },
        "sk-ant-test",
      );

      const headers = fetchCalls[0]!.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-test");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(fetchCalls[0]!.url).toBe("https://api.anthropic.com/v1/models");
    });
  });

  describe("scanProvider() - Google", () => {
    it("returns valid result with google format", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({
          models: [
            { name: "models/gemini-2.5-pro" },
            { name: "models/gemini-2.0-flash" },
          ],
        }),
      );

      const result = await scanner.scanProvider(
        "google",
        { type: "google", baseUrl: "https://generativelanguage.googleapis.com" },
        "AIza-test-key",
      );

      expect(result.keyValid).toBe(true);
      expect(result.modelsDiscovered).toContain("gemini-2.5-pro");
      expect(result.modelsDiscovered).toContain("gemini-2.0-flash");
    });

    it("sends API key as query parameter for Google", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({ models: [] }),
      );

      await scanner.scanProvider(
        "google",
        { type: "google", baseUrl: "https://generativelanguage.googleapis.com" },
        "AIza-test-key",
      );

      expect(fetchCalls[0]!.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models?key=AIza-test-key",
      );
    });
  });

  describe("scanProvider() - error handling", () => {
    it("returns keyValid=false on 401 response", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({ error: { message: "Invalid API key" } }, 401),
      );

      const result = await scanner.scanProvider(
        "openai",
        { type: "openai", baseUrl: "https://api.openai.com" },
        "invalid-key",
      );

      expect(result.keyValid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.modelsDiscovered).toEqual([]);
    });

    it("returns keyValid=false on 403 response", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({ error: { message: "Forbidden" } }, 403),
      );

      const result = await scanner.scanProvider(
        "anthropic",
        { type: "anthropic", baseUrl: "https://api.anthropic.com" },
        "expired-key",
      );

      expect(result.keyValid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns keyValid=false on network timeout", async () => {
      scanner = createModelScanner({
        fetchFn: async () => {
          // Simulate a timeout by throwing an AbortError
          const err = new DOMException("The operation was aborted", "AbortError");
          throw err;
        },
        timeoutMs: 100,
      });

      const result = await scanner.scanProvider(
        "openai",
        { type: "openai", baseUrl: "https://api.openai.com" },
        "sk-test",
      );

      expect(result.keyValid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toContain("abort");
    });

    it("returns keyValid=false with error for unsupported type", async () => {
      scanner = createScannerWithMock(async () => jsonResponse({}));

      const result = await scanner.scanProvider(
        "ollama",
        { type: "ollama", baseUrl: "http://localhost:11434" },
        "no-key",
      );

      expect(result.keyValid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toContain("unsupported");
    });
  });

  describe("scanAll()", () => {
    it("skips disabled providers", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({ data: [{ id: "gpt-4o" }] }),
      );

      const results = await scanner.scanAll(
        {
          openai: { type: "openai", baseUrl: "", apiKeyName: "OPENAI_KEY", enabled: true },
          anthropic: { type: "anthropic", baseUrl: "", apiKeyName: "ANTHROPIC_KEY", enabled: false },
        },
        (keyName) => (keyName === "OPENAI_KEY" ? "sk-valid" : undefined),
      );

      expect(results.length).toBe(1);
      expect(results[0]!.provider).toBe("openai");
    });

    it("skips providers with no resolved API key", async () => {
      scanner = createScannerWithMock(async () =>
        jsonResponse({ data: [{ id: "gpt-4o" }] }),
      );

      const results = await scanner.scanAll(
        {
          openai: { type: "openai", baseUrl: "", apiKeyName: "OPENAI_KEY", enabled: true },
          anthropic: { type: "anthropic", baseUrl: "", apiKeyName: "ANTHROPIC_KEY", enabled: true },
        },
        (keyName) => (keyName === "OPENAI_KEY" ? "sk-valid" : undefined),
      );

      expect(results.length).toBe(1);
      expect(results[0]!.provider).toBe("openai");
    });

    it("runs providers in parallel via Promise.allSettled", async () => {
      const callOrder: string[] = [];
      let resolveFirst: (() => void) | undefined;
      const firstBlocked = new Promise<void>((r) => { resolveFirst = r; });

      scanner = createModelScanner({
        fetchFn: async (url: string) => {
          const provider = url.includes("anthropic") ? "anthropic" : "openai";
          callOrder.push(`start:${provider}`);

          if (provider === "openai") {
            // First provider starts but waits
            await firstBlocked;
          }

          callOrder.push(`end:${provider}`);
          return jsonResponse({ data: [{ id: "model-1" }] });
        },
        timeoutMs: 5000,
      });

      // Start scanAll -- both providers should start concurrently
      const promise = scanner.scanAll(
        {
          openai: { type: "openai", baseUrl: "https://api.openai.com", apiKeyName: "OPENAI_KEY", enabled: true },
          anthropic: { type: "anthropic", baseUrl: "https://api.anthropic.com", apiKeyName: "ANTHROPIC_KEY", enabled: true },
        },
        () => "test-key",
      );

      // Give time for both to start
      await new Promise((r) => setTimeout(r, 10));
      resolveFirst!();

      const results = await promise;
      expect(results.length).toBe(2);
      // Both started before either completed (proving parallel execution)
      expect(callOrder[0]).toMatch(/^start:/);
      expect(callOrder[1]).toMatch(/^start:/);
    });

    it("handles rejected promises from scanProvider", async () => {
      let callCount = 0;
      scanner = createModelScanner({
        fetchFn: async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error("Network failure");
          }
          return jsonResponse({ data: [{ id: "gpt-4o" }] });
        },
        timeoutMs: 5000,
      });

      const results = await scanner.scanAll(
        {
          anthropic: { type: "anthropic", baseUrl: "https://api.anthropic.com", apiKeyName: "ANTHROPIC_KEY", enabled: true },
          openai: { type: "openai", baseUrl: "https://api.openai.com", apiKeyName: "OPENAI_KEY", enabled: true },
        },
        () => "test-key",
      );

      // Both should be in results -- the failed one as an error ScanResult
      expect(results.length).toBe(2);
      const failed = results.find((r) => !r.keyValid);
      expect(failed).toBeDefined();
      expect(failed!.error).toBeDefined();
    });
  });
});
