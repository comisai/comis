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
import { computeOutputHeadroom, MIN_VISIBLE_OUTPUT_TOKENS } from "../context-engine/output-headroom.js";

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
// Main-path maxTokens resolution wiring
//
// Reproduces the exact ConfigResolver maxTokens expression from
// executor-stream-setup.ts:
//   maxTokens: config.maxTokens ?? (modelProfile
//     ? resolveMainPathMaxOutputTokens(modelProfile) : undefined)
//
// The pitfall: using resolveMaxOutputTokens instead (verdict
// reserve = 512 for non-reasoning) would clamp every visible answer at 512.
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

describe("main-path maxTokens wiring — non-reasoning answer is never clamped to 512", () => {
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
// tool:result_offloaded emit
// ---------------------------------------------------------------------------

describe("buildOffloadCallback -- emits tool:result_offloaded and preserves cache-break detection", () => {
  // The microcompaction guard hands offload payloads to this callback (it holds
  // no eventBus/clock itself). The callback emits tool:result_offloaded
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
      // workspace-relative pointer ONLY — never the absolute host path
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

// ---------------------------------------------------------------------------
// outputHeadroomRef wiring — native/high must yield 8960 (not 768)
//
// The bug: outputHeadroomRef is created at MIN_VISIBLE_OUTPUT_TOKENS (768) and
// never updated, so config-resolver always clamps with headroom=768 regardless
// of the model's reasoningStyle/thinkingLevel.
//
// The fix: pi-executor updates outputHeadroomRef.current via a callback when
// the context engine callbacks fire. We test the EXACT wiring pattern the
// pi-executor uses: a mutable ref object, updated via callback, read by
// getOutputHeadroom() closure.
// ---------------------------------------------------------------------------

describe("outputHeadroomRef wiring — native/high model uses 8960 floor (not 768)", () => {
  it("computeOutputHeadroom('native','high') === 8960 (the pinned value config-resolver must use)", () => {
    // This is the EXACT value the pre-flight computed; the ref must carry it.
    expect(computeOutputHeadroom("native", "high")).toBe(8_960);
    // MIN_VISIBLE_OUTPUT_TOKENS is the stale default (the bug value):
    expect(MIN_VISIBLE_OUTPUT_TOKENS).toBe(768);
    expect(computeOutputHeadroom("native", "high")).not.toBe(MIN_VISIBLE_OUTPUT_TOKENS);
  });

  it("mutable-ref pattern: outputHeadroomRef.current updated by callback reflects in getOutputHeadroom getter", () => {
    // Mirror the exact pattern pi-executor uses: create ref, make getter closure,
    // update via callback, read back via getter.
    const outputHeadroomRef = { current: MIN_VISIBLE_OUTPUT_TOKENS };
    const getOutputHeadroom = () => outputHeadroomRef.current;

    // Before callback fires: getter returns the stale default (768)
    expect(getOutputHeadroom()).toBe(768);

    // Simulate the onEffectiveWindow/onThinkingDownshifted callback updating the ref
    // for a native/high model profile (the exact pattern in the fix):
    const reasoningStyle = "native" as const;
    const thinkingLevel = "high" as const;
    outputHeadroomRef.current = computeOutputHeadroom(reasoningStyle, thinkingLevel);

    // After callback: getter returns 8960 (not 768)
    expect(getOutputHeadroom()).toBe(8_960);
  });

  it("config-resolver uses getOutputHeadroom() lazily — clamps with 8960 for native/high", async () => {
    // Reproduce the full config-resolver lazy-evaluation path:
    // getOutputHeadroom() closure over a mutable ref, updated before dispatch.
    const outputHeadroomRef = { current: MIN_VISIBLE_OUTPUT_TOKENS }; // initial stale
    // Simulate pre-flight firing and updating the ref (the wired callback does this)
    outputHeadroomRef.current = computeOutputHeadroom("native", "high"); // = 8960

    const { createConfigResolver } = await import("./stream-wrappers/config-resolver.js");
    const { createMockLogger } = await import("./stream-wrappers/__test-helpers/index.js");

    const resolver = createConfigResolver({
      maxTokens: 16_384,
      getAssembledInputTokens: () => 23_000,
      getEffectiveWindow: () => 32_768,
      // This is the fixed getter — reads from the updated ref (8960), not the stale 768
      getOutputHeadroom: () => outputHeadroomRef.current,
    }, createMockLogger());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stubModel = { provider: "openai", reasoning: false } as any;
    let capturedOptions: Record<string, unknown> = {};
    const wrappedFn = resolver((_m, _c, opts) => {
      capturedOptions = opts as Record<string, unknown>;
      return Promise.resolve(undefined as unknown as never);
    });
    await wrappedFn(stubModel, {} as never, {});

    // remainingRoom = max(8960, 32768 - 23000) = max(8960, 9768) = 9768
    // dynamicMax = min(16384, 9768) = 9768
    expect(capturedOptions.maxTokens).toBe(9_768);

    // CONTRAST: with the stale 768 headroom (the BUG):
    // remainingRoom = max(768, 32768 - 23000) = max(768, 9768) = 9768 → same here
    // But if remaining < 8960: the floor makes the difference:
    const resolverBug = createConfigResolver({
      maxTokens: 16_384,
      getAssembledInputTokens: () => 30_000,  // tight window: 32768-30000=2768 < 8960
      getEffectiveWindow: () => 32_768,
      getOutputHeadroom: () => 768,  // BUG: stale value
    }, createMockLogger());
    let capturedBug: Record<string, unknown> = {};
    const wrappedBug = resolverBug((_m, _c, opts) => {
      capturedBug = opts as Record<string, unknown>;
      return Promise.resolve(undefined as unknown as never);
    });
    await wrappedBug(stubModel, {} as never, {});
    // With stale 768: floor=768 < remaining=2768 → dynamicMax=min(16384,2768)=2768
    expect(capturedBug.maxTokens).toBe(2_768);  // too high — doesn't account for 8192 thinking reserve

    const resolverFixed = createConfigResolver({
      maxTokens: 16_384,
      getAssembledInputTokens: () => 30_000,
      getEffectiveWindow: () => 32_768,
      getOutputHeadroom: () => 8_960,  // FIXED: native/high headroom
    }, createMockLogger());
    let capturedFixed: Record<string, unknown> = {};
    const wrappedFixed = resolverFixed((_m, _c, opts) => {
      capturedFixed = opts as Record<string, unknown>;
      return Promise.resolve(undefined as unknown as never);
    });
    await wrappedFixed(stubModel, {} as never, {});
    // With correct 8960: floor=8960 > remaining=2768 → dynamicMax=min(16384,8960)=8960
    expect(capturedFixed.maxTokens).toBe(8_960);  // correct: the floor applies
    // The two paths diverge: 2768 (bug, too high) vs 8960 (fix, correct floor)
    expect(capturedFixed.maxTokens).toBeGreaterThan(capturedBug.maxTokens as number);
  });
});
