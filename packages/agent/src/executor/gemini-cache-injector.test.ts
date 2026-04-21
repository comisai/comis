// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for Gemini cache injector stream wrapper.
 *
 * Tests: provider guard, enabled guard, AI Studio guard, cache injection
 * with field stripping, fallback on error, stale cache eviction, and
 * Phase 1 detection callback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// Mock capabilities before importing the SUT
vi.mock("../provider/capabilities.js", () => ({
  isGoogleFamily: vi.fn(),
  isGoogleAIStudio: vi.fn(),
}));

vi.mock("./gemini-cache-manager.js", () => ({
  computeCacheContentHash: vi.fn().mockReturnValue("mock-hash-abc123"),
}));

import { createGeminiCacheInjector } from "./gemini-cache-injector.js";
import type { GeminiCacheInjectorConfig } from "./gemini-cache-injector.js";
import type { GeminiCacheManager, CacheEntry } from "./gemini-cache-manager.js";
import { isGoogleFamily, isGoogleAIStudio } from "../provider/capabilities.js";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCacheManager(): GeminiCacheManager {
  return {
    getOrCreate: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    disposeAll: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(ok(undefined)),
    getActiveCount: vi.fn().mockReturnValue(0),
  };
}


function buildGeminiPayload(overrides?: Record<string, unknown>) {
  return {
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    config: {
      systemInstruction: "You are a helpful assistant.",
      tools: [{ functionDeclarations: [{ name: "tool_a", description: "A tool" }] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      temperature: 0.7,
      maxOutputTokens: 8192,
      ...overrides,
    },
  };
}

const GOOGLE_MODEL = { id: "gemini-2.5-flash", provider: "google" };
const ANTHROPIC_MODEL = { id: "claude-sonnet-4-20250514", provider: "anthropic" };

/**
 * Create a mock next function that simulates the SDK behavior:
 * when options.onPayload exists, it calls it with a Gemini payload,
 * then yields the (possibly mutated) result.
 */
function mockNextWithOnPayload(payload?: Record<string, unknown>) {
  const geminiPayload = payload ?? buildGeminiPayload();
  return vi.fn().mockImplementation(
    (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
      return (async function* () {
        // Simulate the SDK calling onPayload before streaming
        if (options?.onPayload && typeof options.onPayload === "function") {
          const onPayload = options.onPayload as (
            params: Record<string, unknown>,
            model: { id: string; provider: string },
          ) => Promise<Record<string, unknown>> | Record<string, unknown>;
          const mutated = onPayload(
            geminiPayload as unknown as Record<string, unknown>,
            _model as { id: string; provider: string },
          );
          // Await if async
          if (mutated instanceof Promise) await mutated;
        }
        yield { type: "text", text: "response" };
      })();
    },
  );
}

/** Simple passthrough mock next that does NOT invoke onPayload. */
function mockNextSimple() {
  return vi.fn().mockReturnValue(
    (async function* () {
      yield { type: "text", text: "response" };
    })(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGeminiCacheInjector", () => {
  let cacheManager: GeminiCacheManager;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheManager = createMockCacheManager();
    logger = createMockLogger();
  });

  function createConfig(overrides?: Partial<GeminiCacheInjectorConfig>): GeminiCacheInjectorConfig {
    return {
      enabled: true,
      cacheManager,
      sessionKey: "test-session",
      agentId: "test-agent",
      ...overrides,
    };
  }

  it("passes through for non-Google provider", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(false);

    const cfg = createConfig();
    const wrapper = createGeminiCacheInjector(cfg, logger);
    const next = mockNextSimple();
    const wrappedFn = wrapper(next);

    const context = { messages: [] };
    const result = wrappedFn(ANTHROPIC_MODEL, context as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(next).toHaveBeenCalledWith(ANTHROPIC_MODEL, context, {});
    expect(cacheManager.getOrCreate).not.toHaveBeenCalled();
  });

  it("passes through when enabled=false", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    const cfg = createConfig({ enabled: false });
    const wrapper = createGeminiCacheInjector(cfg, logger);
    const next = mockNextSimple();
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(next).toHaveBeenCalled();
    expect(cacheManager.getOrCreate).not.toHaveBeenCalled();
  });

  it("passes through for non-AI Studio Google provider", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(false);

    const cfg = createConfig();
    const wrapper = createGeminiCacheInjector(cfg, logger);
    const next = mockNextSimple();
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(next).toHaveBeenCalled();
    expect(cacheManager.getOrCreate).not.toHaveBeenCalled();
  });

  it("injects cachedContent and strips 3 fields on cache hit", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    const entry: CacheEntry = {
      name: "cachedContents/abc123",
      contentHash: "mock-hash-abc123",
      model: "gemini-2.5-flash",
      agentId: "test-agent",
      sessionKey: "test-session",
      expiresAt: Date.now() + 3600_000,
      createdAt: Date.now(),
      cachedTokens: 5000,
    };
    vi.mocked(cacheManager.getOrCreate).mockResolvedValue(ok(entry));

    const cfg = createConfig();
    const wrapper = createGeminiCacheInjector(cfg, logger);

    const payload = buildGeminiPayload();
    const next = mockNextWithOnPayload(payload);
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(next).toHaveBeenCalled();
    expect(cacheManager.getOrCreate).toHaveBeenCalled();

    // Verify field stripping and injection on the payload
    const configObj = payload.config as Record<string, unknown>;
    expect(configObj.cachedContent).toBe("cachedContents/abc123");
    expect(configObj.systemInstruction).toBeUndefined();
    expect(configObj.tools).toBeUndefined();
    expect(configObj.toolConfig).toBeUndefined();
  });

  it("preserves temperature and maxOutputTokens after stripping", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    const entry: CacheEntry = {
      name: "cachedContents/xyz789",
      contentHash: "mock-hash-abc123",
      model: "gemini-2.5-flash",
      agentId: "test-agent",
      sessionKey: "test-session",
      expiresAt: Date.now() + 3600_000,
      createdAt: Date.now(),
      cachedTokens: 5000,
    };
    vi.mocked(cacheManager.getOrCreate).mockResolvedValue(ok(entry));

    const cfg = createConfig();
    const wrapper = createGeminiCacheInjector(cfg, logger);

    const payload = buildGeminiPayload();
    const next = mockNextWithOnPayload(payload);
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    // temperature and maxOutputTokens must survive stripping
    const configObj = payload.config as Record<string, unknown>;
    expect(configObj.temperature).toBe(0.7);
    expect(configObj.maxOutputTokens).toBe(8192);
    expect(configObj.cachedContent).toBe("cachedContents/xyz789");
  });

  it("logs WARN and passes through on getOrCreate error", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    vi.mocked(cacheManager.getOrCreate).mockResolvedValue(
      err(new Error("API rate limit exceeded")),
    );

    const cfg = createConfig();
    const wrapper = createGeminiCacheInjector(cfg, logger);

    const payload = buildGeminiPayload();
    const next = mockNextWithOnPayload(payload);
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(next).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    // Verify stale cache eviction via dispose
    expect(cacheManager.dispose).toHaveBeenCalledWith("test-session");

    // Verify payload was NOT mutated (passed through uncached)
    const configObj = payload.config as Record<string, unknown>;
    expect(configObj.cachedContent).toBeUndefined();
    expect(configObj.systemInstruction).toBe("You are a helpful assistant.");
  });

  it("passes through when getOrCreate returns undefined (below min tokens)", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    vi.mocked(cacheManager.getOrCreate).mockResolvedValue(ok(undefined));

    const cfg = createConfig();
    const wrapper = createGeminiCacheInjector(cfg, logger);

    const payload = buildGeminiPayload();
    const next = mockNextWithOnPayload(payload);
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(next).toHaveBeenCalled();
    expect(cacheManager.getOrCreate).toHaveBeenCalled();

    // Payload should not be mutated
    const configObj = payload.config as Record<string, unknown>;
    expect(configObj.cachedContent).toBeUndefined();
    expect(configObj.systemInstruction).toBe("You are a helpful assistant.");
  });

  it("evicts stale cache when expected fields missing from config (D-03)", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    const entry: CacheEntry = {
      name: "cachedContents/stale123",
      contentHash: "mock-hash-abc123",
      model: "gemini-2.5-flash",
      agentId: "test-agent",
      sessionKey: "test-session",
      expiresAt: Date.now() + 3600_000,
      createdAt: Date.now(),
      cachedTokens: 5000,
    };
    vi.mocked(cacheManager.getOrCreate).mockResolvedValue(ok(entry));

    const cfg = createConfig();
    const wrapper = createGeminiCacheInjector(cfg, logger);

    // Create a payload with systemInstruction missing from config (stale scenario)
    const stalePayload = {
      model: "gemini-2.5-flash",
      contents: [],
      config: {
        // systemInstruction intentionally MISSING
        tools: [{ functionDeclarations: [] }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        temperature: 0.7,
      },
    };

    const next = mockNextWithOnPayload(stalePayload);
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(next).toHaveBeenCalled();
    // D-03: Should log WARN and evict stale cache
    expect(logger.warn).toHaveBeenCalled();
    expect(cacheManager.dispose).toHaveBeenCalledWith("test-session");

    // Payload should NOT have cachedContent injected
    const configObj = stalePayload.config as Record<string, unknown>;
    expect(configObj.cachedContent).toBeUndefined();
  });

  it("calls onCacheHit when cache entry is successfully injected", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    const onCacheHit = vi.fn();
    const entry: CacheEntry = {
      name: "cachedContents/hit123",
      contentHash: "mock-hash-abc123",
      model: "gemini-2.5-flash",
      agentId: "test-agent",
      sessionKey: "test-session",
      expiresAt: Date.now() + 3600_000,
      createdAt: Date.now(),
      cachedTokens: 7500,
    };
    vi.mocked(cacheManager.getOrCreate).mockResolvedValue(ok(entry));

    const cfg = createConfig({ onCacheHit });
    const wrapper = createGeminiCacheInjector(cfg, logger);

    const payload = buildGeminiPayload();
    const next = mockNextWithOnPayload(payload);
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(onCacheHit).toHaveBeenCalledOnce();
    expect(onCacheHit).toHaveBeenCalledWith(entry);
  });

  it("does not call onCacheHit when cache returns undefined (below min tokens)", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    const onCacheHit = vi.fn();
    vi.mocked(cacheManager.getOrCreate).mockResolvedValue(ok(undefined));

    const cfg = createConfig({ onCacheHit });
    const wrapper = createGeminiCacheInjector(cfg, logger);

    const payload = buildGeminiPayload();
    const next = mockNextWithOnPayload(payload);
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(onCacheHit).not.toHaveBeenCalled();
  });

  it("does not call onCacheHit when getOrCreate fails (error path)", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    const onCacheHit = vi.fn();
    vi.mocked(cacheManager.getOrCreate).mockResolvedValue(
      err(new Error("API error")),
    );

    const cfg = createConfig({ onCacheHit });
    const wrapper = createGeminiCacheInjector(cfg, logger);

    const payload = buildGeminiPayload();
    const next = mockNextWithOnPayload(payload);
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    expect(onCacheHit).not.toHaveBeenCalled();
  });

  it("invokes onPayloadForCacheDetection callback with params and model", async () => {
    vi.mocked(isGoogleFamily).mockReturnValue(true);
    vi.mocked(isGoogleAIStudio).mockReturnValue(true);

    vi.mocked(cacheManager.getOrCreate).mockResolvedValue(ok(undefined));

    const detectionCallback = vi.fn();
    const cfg = createConfig({ onPayloadForCacheDetection: detectionCallback });
    const wrapper = createGeminiCacheInjector(cfg, logger);

    const payload = buildGeminiPayload();
    const next = mockNextWithOnPayload(payload);
    const wrappedFn = wrapper(next);

    const result = wrappedFn(GOOGLE_MODEL, { messages: [] } as never, {});
    for await (const _chunk of result) { /* consume */ }

    // The detection callback should be invoked inside onPayload
    expect(detectionCallback).toHaveBeenCalled();
    const [callParams, callModel] = detectionCallback.mock.calls[0];
    expect(callModel).toEqual(GOOGLE_MODEL);
    expect(callParams).toBeDefined();
  });
});
