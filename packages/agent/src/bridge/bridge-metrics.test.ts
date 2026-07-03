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
    // Warmup-turn counters
    expect(m.warmupTurnCount).toBe(0);
    expect(m.totalPendingCacheInvestmentUsd).toBe(0);
    // Cumulative cost-correction delta
    expect(m.totalCostCorrectionDeltaUsd).toBe(0);
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
    // Warmup-turn counters surfaced unconditionally so the
    // "Execution complete" bookend log has a stable shape.
    expect(r.warmupTurnCount).toBe(0);
    expect(r.totalPendingCacheInvestmentUsd).toBe(0);
    // Cumulative cost-correction delta surfaced unconditionally.
    expect(r.totalCostCorrectionDeltaUsd).toBe(0);
  });

  it("buildBridgeResult projects totalCostCorrectionDeltaUsd from metrics state", () => {
    const m = createBridgeMetrics();
    m.totalCostCorrectionDeltaUsd = 0.00042;
    const r = buildBridgeResult(m, 1);
    expect(r.totalCostCorrectionDeltaUsd).toBe(0.00042);
  });

  // The bridge must accumulate breakerTripCount + per-tool errorKind so the
  // session-health rollup is a pure reduce over the bridge result. These two
  // signals have no other durable source: the breaker-open transition is only
  // an event, and errorText alone carries no failure classification.
  it("buildBridgeResult forwards breakerTripCount and per-tool errorKind from metrics state", () => {
    const m = createBridgeMetrics();
    // Simulate the bridge's accumulation: one breaker trip + a failed tool that
    // was classified as a dependency error, then a successful tool.
    m.breakerTripCount = 1;
    m.toolExecResults.push({ toolName: "web_fetch", success: false, durationMs: 5, errorKind: "dependency" });
    m.toolExecResults.push({ toolName: "web_fetch", success: true, durationMs: 3 });
    const r = buildBridgeResult(m, 0);
    expect(r.breakerTripCount).toBe(1);
    expect(r.toolExecResults?.[0].errorKind).toBe("dependency");
    // A successful tool contributes no errorKind.
    expect(r.toolExecResults?.[1].errorKind).toBeUndefined();
  });

  it("buildBridgeResult reports breakerTripCount 0 for a fresh metrics state (init contract)", () => {
    const m = createBridgeMetrics();
    const r = buildBridgeResult(m, 0);
    expect(r.breakerTripCount).toBe(0);
  });
});
