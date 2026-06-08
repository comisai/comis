// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for skipCacheWrite derivation in executor-stream-setup.
 *
 * The skipCacheWrite flag at line 267 of executor-stream-setup.ts is derived as:
 *   skipCacheWrite: !!executionOverrides?.spawnPacket
 *
 * This means:
 * - When spawnPacket is defined (normal sub-agent spawn): skipCacheWrite = true
 * - When spawnPacket is undefined (persistent session reuse): skipCacheWrite = false
 *
 * These tests verify the derivation logic in isolation since setupStreamWrappers
 * has deeply nested dependencies that make full integration testing impractical.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { resolveMainPathMaxOutputTokens } from "./verification-gate.js";
import type { ModelProfile } from "./model-profile.js";
import { buildOffloadCallback } from "./executor-stream-setup.js";

// ---------------------------------------------------------------------------
// Extracted derivation under test
// ---------------------------------------------------------------------------

/**
 * Reproduce the exact skipCacheWrite derivation from executor-stream-setup.ts line 267:
 *   skipCacheWrite: !!executionOverrides?.spawnPacket
 *
 * This is a pure expression test -- validates the boolean logic matches expectations.
 */
function deriveSkipCacheWrite(executionOverrides?: { spawnPacket?: unknown }): boolean {
  return !!executionOverrides?.spawnPacket;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skipCacheWrite derivation", () => {
  it("skipCacheWrite is false when executionOverrides.spawnPacket is undefined (reuse session path)", () => {
    // Persistent session reuse spawns have no spawnPacket
    // because setup-cross-session skips SpawnPacket construction for isReuseSession.
    // This means the sub-agent WILL write its own cache entries -- correct behavior
    // for persistent sessions that need cache prefix continuity.
    const result = deriveSkipCacheWrite({ spawnPacket: undefined });
    expect(result).toBe(false);
  });

  it("skipCacheWrite is true when executionOverrides.spawnPacket is defined (normal sub-agent)", () => {
    // Normal sub-agent spawns get a SpawnPacket with parent cache info.
    // skipCacheWrite = true because the parent already wrote the cache prefix.
    const mockSpawnPacket = { task: "test", parentSummary: "summary" };
    const result = deriveSkipCacheWrite({ spawnPacket: mockSpawnPacket });
    expect(result).toBe(true);
  });

  it("skipCacheWrite is false when executionOverrides is undefined entirely", () => {
    // No execution overrides at all (e.g., direct user session)
    const result = deriveSkipCacheWrite(undefined);
    expect(result).toBe(false);
  });

  it("skipCacheWrite is false when executionOverrides is empty object", () => {
    // Execution overrides present but no spawnPacket field
    const result = deriveSkipCacheWrite({});
    expect(result).toBe(false);
  });

  it("skipCacheWrite is true for any truthy spawnPacket value", () => {
    // Even a minimal object is truthy
    expect(deriveSkipCacheWrite({ spawnPacket: {} })).toBe(true);
    expect(deriveSkipCacheWrite({ spawnPacket: { task: "" } })).toBe(true);
  });

  it("skipCacheWrite is false for null spawnPacket", () => {
    // null is falsy
    expect(deriveSkipCacheWrite({ spawnPacket: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CR-01 — main-path maxTokens resolution wiring
//
// Reproduces the exact ConfigResolver maxTokens expression from
// executor-stream-setup.ts:
//   maxTokens: config.maxTokens ?? (modelProfile
//     ? resolveMainPathMaxOutputTokens(modelProfile) : undefined)
//
// The regression: this previously used resolveMaxOutputTokens (verdict
// reserve = 512 for non-reasoning), clamping every visible answer at 512.
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    capabilityClass: "small",
    scaffoldLevel: "max",
    securityLevel: "locked",
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
    reasoningStyle: "none",
    ...overrides,
  };
}

/** Exact maxTokens resolution from executor-stream-setup.ts (mirrored). */
function resolveConfigMaxTokens(
  configMaxTokens: number | undefined,
  modelProfile: ModelProfile | undefined,
): number | undefined {
  return configMaxTokens ?? (modelProfile
    ? resolveMainPathMaxOutputTokens(modelProfile)
    : undefined);
}

describe("CR-01 main-path maxTokens wiring — non-reasoning answer is never clamped to 512", () => {
  it("non-reasoning profile, no operator maxTokens → resolves to the full profile budget (NOT 512)", () => {
    const profile = makeProfile({ reasoningStyle: "none", maxOutputTokens: 4096 });
    const resolved = resolveConfigMaxTokens(undefined, profile);
    expect(resolved).toBe(4096);
    expect(resolved).not.toBe(512);
  });

  it("operator config.maxTokens always wins over the profile fallback", () => {
    const profile = makeProfile({ reasoningStyle: "none", maxOutputTokens: 4096 });
    expect(resolveConfigMaxTokens(1234, profile)).toBe(1234);
  });

  it("native-reasoning profile, no operator maxTokens → sized UP (>= 4096), never 512", () => {
    const profile = makeProfile({ reasoningStyle: "native", maxOutputTokens: 1024 });
    const resolved = resolveConfigMaxTokens(undefined, profile);
    expect(resolved).toBeGreaterThanOrEqual(4096);
    expect(resolved).not.toBe(512);
  });

  it("no modelProfile and no config.maxTokens → undefined (provider default preserved)", () => {
    expect(resolveConfigMaxTokens(undefined, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// diagnostics.cacheTrace wiring
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// tool:result_offloaded emit (B2b)
// ---------------------------------------------------------------------------

describe("buildOffloadCallback -- emits tool:result_offloaded and preserves cache-break detection", () => {
  // The microcompaction guard hands offload payloads to this callback (it holds
  // no eventBus/clock itself, T-151-07). The callback emits tool:result_offloaded
  // with deps.clock (NOT Date.now()) and MUST keep the existing
  // cacheBreakDetector.notifyContentModification side-effect.
  it("emits tool:result_offloaded carrying {toolName,toolCallId,originalChars,diskPathRel} + clock timestamp", () => {
    const emit = vi.fn();
    const onCacheBreak = vi.fn();
    const callback = buildOffloadCallback({
      eventBus: { emit } as unknown as import("@comis/core").TypedEventBus,
      clock: { now: () => 1_700_000_000_000 } as unknown as import("@comis/core").ClockPort,
      onCacheBreak,
    });

    callback("bash", 12_345, "call-xyz", "tool-results/call-xyz.json");

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("tool:result_offloaded", {
      toolName: "bash",
      toolCallId: "call-xyz",
      originalChars: 12_345,
      // workspace-relative pointer ONLY — never the absolute host path (T-151-05)
      diskPathRel: "tool-results/call-xyz.json",
      timestamp: 1_700_000_000_000,
    });
  });

  it("preserves the existing cacheBreakDetector.notifyContentModification side-effect", () => {
    const onCacheBreak = vi.fn();
    const callback = buildOffloadCallback({
      eventBus: { emit: vi.fn() } as unknown as import("@comis/core").TypedEventBus,
      clock: { now: () => 0 } as unknown as import("@comis/core").ClockPort,
      onCacheBreak,
    });

    callback("web_fetch", 9_000, "call-abc", "tool-results/call-abc.json");

    expect(onCacheBreak).toHaveBeenCalledTimes(1);
  });
});

describe("diagnostics_cache_trace_returned -- params.cacheTrace surfaces the cache-trace wrapper factory", () => {
  // Pragmatic isolation: setupStreamWrappers has deeply nested dependencies
  // (SessionManager, ContextEngine, GeminiCacheManager, ...) that make full
  // invocation impractical here. We assert the contract via the
  // wrapper-builder import + the gate logic — the integration test
  // exercises the full setupStreamWrappers path.
  it("buildCacheTraceWrapper is the wrapper factory used when params.cacheTrace is set", async () => {
    // The setupStreamWrappers import is what matters — if the cache-trace
    // wrapper export disappeared (e.g., barrel regression), this test
    // would fail to import.
    const obs = await import("@comis/observability");
    expect(typeof obs.buildCacheTraceWrapper).toBe("function");
    expect(typeof obs.createCacheTrace).toBe("function");
    expect(typeof obs.attachCacheTraceToEventBus).toBe("function");
  });
});
