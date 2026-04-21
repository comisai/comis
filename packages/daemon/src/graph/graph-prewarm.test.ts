// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for graph cache pre-warm module.
 * Tests verify:
 * 1. Successful cache write (cacheWrite > 0) returns success
 * 2. Cache write of 0 returns failure (below minimum threshold)
 * 3. API call error returns failure with error message
 * 4. Non-Anthropic provider is skipped without API call
 * 5. Empty tools list is skipped without API call
 * 6. API call uses correct options (maxTokens=1, cacheRetention="long")
 */

import { describe, it, expect, vi } from "vitest";
import { preWarmGraphCache, type PreWarmDeps, type PreWarmSdk } from "./graph-prewarm.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<PreWarmDeps>): PreWarmDeps {
  return {
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    apiKey: "test-api-key",
    systemPrompt: "You are a helpful assistant.",
    tools: [
      { name: "web_search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "code_exec", description: "Execute code", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
    ],
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function createSdk(overrides?: Partial<PreWarmSdk>): PreWarmSdk {
  return {
    getModel: vi.fn().mockReturnValue({ id: "mock-model" }),
    completeSimple: vi.fn().mockResolvedValue({
      usage: { cacheWrite: 1500, totalTokens: 1501, cost: { total: 0.003 } },
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("preWarmGraphCache", () => {
  it("returns success when cacheWrite > 0", async () => {
    const deps = createDeps();
    const sdk = createSdk();

    const result = await preWarmGraphCache(deps, sdk);

    expect(result.success).toBe(true);
    expect(result.cacheWriteTokens).toBe(1500);
    expect(result.tokensUsed).toBe(1501);
    expect(result.cost).toBe(0.003);
    expect(result.skipped).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("returns failure when cacheWrite === 0", async () => {
    const deps = createDeps();
    const sdk = createSdk({
      completeSimple: vi.fn().mockResolvedValue({
        usage: { cacheWrite: 0, totalTokens: 100, cost: { total: 0.001 } },
      }),
    });

    const result = await preWarmGraphCache(deps, sdk);

    expect(result.success).toBe(false);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.tokensUsed).toBe(100);
    expect(result.cost).toBe(0.001);
  });

  it("returns failure with error message when completeSimple throws", async () => {
    const deps = createDeps();
    const sdk = createSdk({
      completeSimple: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
    });

    const result = await preWarmGraphCache(deps, sdk);

    expect(result.success).toBe(false);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.error).toBe("API rate limit exceeded");
  });

  it("skips without API call for non-Anthropic provider", async () => {
    const deps = createDeps({ provider: "google" });
    const sdk = createSdk();

    const result = await preWarmGraphCache(deps, sdk);

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(sdk.completeSimple).not.toHaveBeenCalled();
    expect(sdk.getModel).not.toHaveBeenCalled();
  });

  it("skips without API call when tools array is empty", async () => {
    const deps = createDeps({ tools: [] });
    const sdk = createSdk();

    const result = await preWarmGraphCache(deps, sdk);

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(sdk.completeSimple).not.toHaveBeenCalled();
  });

  it("uses maxTokens=1 and cacheRetention='long' in the API call", async () => {
    const deps = createDeps();
    const mockCompleteSimple = vi.fn().mockResolvedValue({
      usage: { cacheWrite: 2000, totalTokens: 2001, cost: { total: 0.004 } },
    });
    const sdk = createSdk({ completeSimple: mockCompleteSimple });

    await preWarmGraphCache(deps, sdk);

    expect(mockCompleteSimple).toHaveBeenCalledOnce();
    const callArgs = mockCompleteSimple.mock.calls[0]!;
    // callArgs[0] = model, callArgs[1] = context, callArgs[2] = options
    const options = callArgs[2] as Record<string, unknown>;
    expect(options.maxTokens).toBe(1);
    expect(options.cacheRetention).toBe("long");
    expect(options.apiKey).toBe("test-api-key");

    // Verify context has systemPrompt and tools
    const context = callArgs[1] as { systemPrompt: string; tools: unknown[]; messages: unknown[] };
    expect(context.systemPrompt).toBe("You are a helpful assistant.");
    expect(context.tools).toHaveLength(2);
    expect(context.messages).toHaveLength(1);
  });
});
