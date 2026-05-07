// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createBridgeMetrics, buildBridgeResult } from "./bridge-metrics.js";

describe("bridge-metrics shape regression guard", () => {
  it("createBridgeMetrics returns the canonical zero-state with all known fields", () => {
    const m = createBridgeMetrics();
    // Token counters
    expect(m.totalInputTokens).toBe(0);
    expect(m.totalOutputTokens).toBe(0);
    expect(m.totalTokens).toBe(0);
    expect(m.totalCost).toBe(0);
    expect(m.totalCacheReadTokens).toBe(0);
    expect(m.totalCacheWriteTokens).toBe(0);
    expect(m.totalCacheSaved).toBe(0);
    expect(m.llmCallCount).toBe(0);
    // Tool tracking
    expect(m.toolStartTimes).toBeInstanceOf(Map);
    expect(m.toolCallHistory).toEqual([]);
    expect(m.lastActiveToolName).toBeUndefined();
    expect(m.toolArgSnapshots).toBeInstanceOf(Map);
    expect(m.toolExecResults).toEqual([]);
    expect(m.failedToolCount).toBe(0);
    expect(m.failedToolNames).toEqual([]);
    // Diagnostic counters
    expect(m.hashAssertionsRan).toBe(0);
    expect(m.hashAssertionMismatches).toBe(0);
    expect(m.signatureScrubs).toBe(0);
    expect(m.signatureScrubsToolCallsAffected).toBe(0);
  });

  it("buildBridgeResult builds a stable shape from a fresh metrics state", () => {
    const m = createBridgeMetrics();
    const r = buildBridgeResult(m, 0);
    expect(r.tokensUsed).toEqual({
      input: 0,
      output: 0,
      total: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(r.cost).toMatchObject({ total: 0, cacheSaved: 0 });
    expect(r.stepsExecuted).toBe(0);
    expect(r.llmCalls).toBe(0);
    expect(r.finishReason).toBe("stop");
    expect(r.textEmitted).toBe(false);
    // Diagnostic counters always populated (not gated on > 0).
    expect(r.hashAssertionsRan).toBe(0);
    expect(r.hashAssertionMismatches).toBe(0);
    expect(r.signatureScrubs).toBe(0);
    expect(r.signatureScrubsToolCallsAffected).toBe(0);
  });
});
