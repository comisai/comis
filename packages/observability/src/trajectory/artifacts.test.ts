// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for buildTraceArtifacts.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { buildTraceArtifacts, type TraceArtifactsRunState } from "./artifacts.js";

const baseRunState: TraceArtifactsRunState = {
  finalStatus: "stop",
  aborted: false,
  usage: {
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  cumulativeCostUsd: 0.005,
  turnCount: 1,
};

describe("buildTraceArtifacts", () => {
  it("returns payload with required top-level keys", () => {
    const payload = buildTraceArtifacts(baseRunState);
    expect(payload).toHaveProperty("finalStatus", "stop");
    expect(payload).toHaveProperty("aborted", false);
    expect(payload).toHaveProperty("usage");
    expect(payload).toHaveProperty("cumulativeCostUsd");
    expect(payload).toHaveProperty("turnCount", 1);
  });

  it("computes promptCacheHitRate from cacheReadTokens / (cacheReadTokens + inputTokens)", () => {
    const payload = buildTraceArtifacts({
      ...baseRunState,
      usage: {
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        cacheReadTokens: 25,
        cacheWriteTokens: 0,
      },
    });
    // 25 / (25 + 100) = 0.2
    expect(payload.promptCacheHitRate).toBe(0.2);
  });

  it("omits lastToolError when undefined", () => {
    const payload = buildTraceArtifacts({ ...baseRunState, lastToolError: undefined });
    expect("lastToolError" in payload).toBe(false);
  });

  it("includes lastToolError when provided", () => {
    const payload = buildTraceArtifacts({
      ...baseRunState,
      lastToolError: { toolName: "fs.read", errorText: "ENOENT", durationMs: 12 },
    });
    expect(payload.lastToolError).toBeDefined();
    const err = payload.lastToolError as Record<string, unknown>;
    expect(err.toolName).toBe("fs.read");
    expect(err.errorText).toBe("ENOENT");
    expect(err.durationMs).toBe(12);
  });

  it("return value satisfies Record<string, unknown> (assignable to recordEvent data param)", () => {
    const payload = buildTraceArtifacts(baseRunState);
    // Compile-time check: assign to a Record<string, unknown> variable
    const data: Record<string, unknown> = payload;
    expect(typeof data).toBe("object");
    expect(data).not.toBeNull();
  });

  it("omits optional fields when not provided", () => {
    const payload = buildTraceArtifacts(baseRunState);
    expect("timedOut" in payload).toBe(false);
    expect("compactionCount" in payload).toBe(false);
    expect("durationMs" in payload).toBe(false);
  });

  it("includes optional fields when provided", () => {
    const payload = buildTraceArtifacts({
      ...baseRunState,
      timedOut: true,
      compactionCount: 2,
      durationMs: 5000,
    });
    expect(payload.timedOut).toBe(true);
    expect(payload.compactionCount).toBe(2);
    expect(payload.durationMs).toBe(5000);
  });

  it("omits promptCacheHitRate when cacheBase is zero", () => {
    // inputTokens=0 and cacheReadTokens=0 → denominator is 0
    const payload = buildTraceArtifacts({
      ...baseRunState,
      usage: {
        inputTokens: 0,
        outputTokens: 10,
        totalTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
    expect("promptCacheHitRate" in payload).toBe(false);
  });
});
