// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for lcd-preflight.ts (Phase 166 CWF-02).
 *
 * Covers:
 *  - WR-01: errorKind "resource" (not "capacity") in WARN calls
 *  - CR-03: onAssembledInputTokens reports actual assembled count (not simulated undercount)
 *  - IN-01: fresh-tail token estimation handles non-string (multi-part) content
 *  - WR-02: minVisibleOutputTokens config value threads into computeOutputHeadroom
 *  - Escalation ladder: governor fire + exhaustion throw
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { runPreflightFitCheck } from "./lcd-preflight.js";
import type { ContextEngineDeps } from "./types-core.js";
import type { BudgetItem } from "./lcd-budget-eviction.js";
import { ContextExhaustionError } from "./errors.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(function() { return this; }),
  };
}

/** Minimal deps for tests that don't need security pins or downshift. */
function makeDeps(overrides: Partial<ContextEngineDeps> = {}): ContextEngineDeps {
  return {
    logger: makeLogger() as unknown as ContextEngineDeps["logger"],
    getModel: () => ({
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 8_192,
    }),
    ...overrides,
  } as unknown as ContextEngineDeps;
}

/** Build a BudgetItem array of N messages each with `tokensEach`. */
function makeBudgetItems(count: number, tokensEach: number): BudgetItem[] {
  return Array.from({ length: count }, (_, i) => ({
    msg: { role: "user" as const, content: `message ${i}` },
    tokens: tokensEach,
  }));
}

// ---------------------------------------------------------------------------
// OF-01 (v2.19): the pre-flight must count the FULL SDK prompt (system + tools)
//
// Live qwen3.6 re-measure: systemTokens=25584 (the dominant term) was OMITTED
// from the fit-check, so a real ~31.5K prompt looked like ~6.5K, passed the
// check, and the model truncated silently at stopReason:length — the governor /
// clamp / context-exhausted ladder never engaged. These tests reproduce that:
// with S counted, the check fires (governor down-shift, or loud context_exhausted)
// instead of a silent pass. See design/small-model-orchestration-fidelity.md §6 Fix 1.
// ---------------------------------------------------------------------------
describe("OF-01: pre-flight counts systemTokens in the assembled-input fit check", () => {
  it("engages the thinking governor when system+history exceeds the headroom bound (was: silent pass)", () => {
    // Live turn: S=25584, effectiveWindow=32000, native/high → headroom 8960, bound 23040.
    // Pre-patch: assembledInput = history(200) only → 200 < 23040 → check never fires (silent).
    // Post-patch: S(25584)+200 = 25784 > 23040 → governor fires; at medium (bound 28160) it fits.
    const onThinkingDownshifted = vi.fn();
    const onAssembledInputTokens = vi.fn();
    const deps = makeDeps({
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 25_584,
      onThinkingDownshifted,
      onAssembledInputTokens,
      eventBus: { emit: vi.fn() } as unknown as ContextEngineDeps["eventBus"],
      onEffectiveWindow: vi.fn(),
    });
    const evictable = makeBudgetItems(2, 100); // 200 tokens of history
    runPreflightFitCheck(deps, 32_000, evictable, 2, [], "native");
    expect(onThinkingDownshifted).toHaveBeenCalled();
    // onAssembledInputTokens reports the FULL prompt incl. systemTokens (not the ~200 undercount).
    const reported = onAssembledInputTokens.mock.calls[0]?.[0] as number;
    expect(reported).toBeGreaterThanOrEqual(25_584);
  });

  it("throws ContextExhaustionError when system+freshTail is infeasible even at the thinking floor (live turn-4)", () => {
    // S=25584 + a ~6000-token fresh tail (the accumulated tool results) = ~31584,
    // which exceeds even the off-thinking bound (32000-768=31232) → loud degrade.
    // Pre-patch: assembledInput = freshTail(6000) only → 6000 < 23040 → no throw (silent length-trunc).
    const deps = makeDeps({
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 25_584,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit: vi.fn() } as unknown as ContextEngineDeps["eventBus"],
    });
    const freshTail = [{ role: "user", content: "x".repeat(21_000) }]; // ~6000 tokens
    expect(() => runPreflightFitCheck(deps, 32_000, [], 0, freshTail as never, "native")).toThrow(ContextExhaustionError);
  });

  it("is byte-identical when no systemTokens estimate is supplied (frontier/test path)", () => {
    // getSystemTokensEstimate unset → S=0 → assembledInput = history only → no fire (as before).
    const onThinkingDownshifted = vi.fn();
    const deps = makeDeps({
      getThinkingLevel: () => "high",
      onThinkingDownshifted,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
    });
    const evictable = makeBudgetItems(2, 100); // 200 tokens, S=0 → 200 < 23040 → no fire
    runPreflightFitCheck(deps, 32_000, evictable, 2, [], "native");
    expect(onThinkingDownshifted).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// W1 (obs-llm-troubleshooting): capped-window provenance must reach the throw
// and the exhaustion WARN. Live incident: the WARN said effectiveWindow=32000
// while config declared 131072 — the clamp (effectiveContextCapSmall) was
// invisible from the log line and the error string.
// ---------------------------------------------------------------------------
describe("capped-window provenance in the exhaustion throw and WARN", () => {
  it("the thrown error names the cap knob when capInfo reports a capped window", () => {
    const deps = makeDeps({
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 25_584,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit: vi.fn() } as unknown as ContextEngineDeps["eventBus"],
    });
    const freshTail = [{ role: "user", content: "x".repeat(21_000) }]; // ~6000 tokens
    let thrown: unknown;
    try {
      runPreflightFitCheck(deps, 32_000, [], 0, freshTail as never, "native", {
        rawContextWindowTokens: 131_072,
        windowCapSource: "effectiveContextCapSmall",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContextExhaustionError);
    const message = (thrown as Error).message;
    expect(message).toContain("131072");
    expect(message).toContain("contextEngine.budget.effectiveContextCapSmall");
  });

  it("the exhaustion WARN payload carries rawContextWindowTokens and windowCapSource", () => {
    const logger = makeLogger();
    const deps = makeDeps({
      logger: logger as unknown as ContextEngineDeps["logger"],
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 25_584,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit: vi.fn() } as unknown as ContextEngineDeps["eventBus"],
    });
    const freshTail = [{ role: "user", content: "x".repeat(21_000) }];
    expect(() =>
      runPreflightFitCheck(deps, 32_000, [], 0, freshTail as never, "native", {
        rawContextWindowTokens: 131_072,
        windowCapSource: "effectiveContextCapSmall",
      }),
    ).toThrow(ContextExhaustionError);
    const exhaustionWarn = logger.warn.mock.calls.find(
      (c) => c[1] === "pre-flight fit check: context exhausted",
    );
    expect(exhaustionWarn).toBeDefined();
    const payload = exhaustionWarn?.[0] as Record<string, unknown>;
    expect(payload.rawContextWindowTokens).toBe(131_072);
    expect(payload.windowCapSource).toBe("effectiveContextCapSmall");
  });

  it("emits a fits-verdict context:budget_computed event carrying the full budget equation", () => {
    // W2 (obs-llm-troubleshooting): the budget math must reach the trajectory.
    const emit = vi.fn();
    const deps = makeDeps({
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 1_000,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      eventBus: { emit } as unknown as ContextEngineDeps["eventBus"],
    });
    const evictable = makeBudgetItems(2, 100); // 200 history tokens, all kept
    runPreflightFitCheck(deps, 32_000, evictable, 2, [], "native", {
      rawContextWindowTokens: 131_072,
      windowCapSource: "effectiveContextCapSmall",
    });
    const call = emit.mock.calls.find((c) => c[0] === "context:budget_computed");
    expect(call).toBeDefined();
    const p = call?.[1] as Record<string, unknown>;
    expect(p.verdict).toBe("fits");
    expect(p.windowTokens).toBe(32_000);
    expect(p.rawContextWindowTokens).toBe(131_072);
    expect(p.windowCapSource).toBe("effectiveContextCapSmall");
    expect(p.systemTokens).toBe(1_000);
    expect(p.budgetedHistoryTokens).toBe(200);
    expect(p.keptCount).toBe(2);
    expect(p.assembledInputTokens).toBe(1_200);
    expect(p.outputHeadroom).toBeGreaterThan(0);
    expect(p.agentId).toBe("agent-1");
    expect(p.sessionKey).toBe("t1:u1:c1");
  });

  it("emits a downshifted-verdict budget event when the thinking governor fires", () => {
    const emit = vi.fn();
    const deps = makeDeps({
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 25_584,
      onThinkingDownshifted: vi.fn(),
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      eventBus: { emit } as unknown as ContextEngineDeps["eventBus"],
    });
    const evictable = makeBudgetItems(2, 100);
    runPreflightFitCheck(deps, 32_000, evictable, 2, [], "native");
    const call = emit.mock.calls.find((c) => c[0] === "context:budget_computed");
    expect(call).toBeDefined();
    const p = call?.[1] as Record<string, unknown>;
    expect(p.verdict).toBe("downshifted");
    expect(p.windowCapSource).toBe("none");
    expect(p.rawContextWindowTokens).toBe(32_000);
  });

  it("emits an exhausted-verdict budget event before throwing ContextExhaustionError", () => {
    const emit = vi.fn();
    const deps = makeDeps({
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 25_584,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit } as unknown as ContextEngineDeps["eventBus"],
    });
    const freshTail = [{ role: "user", content: "x".repeat(21_000) }]; // ~6000 tokens
    expect(() =>
      runPreflightFitCheck(deps, 32_000, [], 0, freshTail as never, "native", {
        rawContextWindowTokens: 131_072,
        windowCapSource: "effectiveContextCapSmall",
      }),
    ).toThrow(ContextExhaustionError);
    const call = emit.mock.calls.find((c) => c[0] === "context:budget_computed");
    expect(call).toBeDefined();
    const p = call?.[1] as Record<string, unknown>;
    expect(p.verdict).toBe("exhausted");
    expect(p.freshTailTokens).toBe(6_000);
    expect(p.systemTokens).toBe(25_584);
    expect(p.assembledInputTokens).toBe(31_584);
    expect(p.rawContextWindowTokens).toBe(131_072);
    expect(p.windowCapSource).toBe("effectiveContextCapSmall");
  });

  it("KNOB-02-9: a served-bound exhaustion names the Ollama knobs in the throw, the WARN hint, and the budget event", () => {
    // KNOB-02 (Phase 176): when the served window bound the effective window,
    // the exhaustion remedy is OLLAMA_CONTEXT_LENGTH / PARAMETER num_ctx — not
    // a contextEngine.budget.* knob. Both the thrown message and the WARN hint
    // must carry the served-shaped remedy with the TRUE configured number, and
    // the context:budget_computed payload must carry the "served" source.
    const logger = makeLogger();
    const emit = vi.fn();
    const deps = makeDeps({
      logger: logger as unknown as ContextEngineDeps["logger"],
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 25_584,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit } as unknown as ContextEngineDeps["eventBus"],
    });
    const freshTail = [{ role: "user", content: "x".repeat(21_000) }]; // ~6000 tokens
    let thrown: unknown;
    try {
      runPreflightFitCheck(deps, 32_000, [], 0, freshTail as never, "native", {
        rawContextWindowTokens: 131_072,
        windowCapSource: "served",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContextExhaustionError);
    const message = (thrown as Error).message;
    expect(message).toMatch(/OLLAMA_CONTEXT_LENGTH=131072/);
    expect(message).toMatch(/PARAMETER num_ctx 131072/);

    const exhaustionWarn = logger.warn.mock.calls.find(
      (c) => c[1] === "pre-flight fit check: context exhausted",
    );
    expect(exhaustionWarn).toBeDefined();
    const payload = exhaustionWarn?.[0] as Record<string, unknown>;
    expect(payload.hint).toMatch(/OLLAMA_CONTEXT_LENGTH=131072/);
    expect(payload.hint).toMatch(/PARAMETER num_ctx 131072/);

    const call = emit.mock.calls.find((c) => c[0] === "context:budget_computed");
    expect(call).toBeDefined();
    const p = call?.[1] as Record<string, unknown>;
    expect(p.windowCapSource).toBe("served");
    expect(p.rawContextWindowTokens).toBe(131_072);
  });

  it("omitting capInfo keeps the throw message in the uncapped form (no knob mention)", () => {
    const deps = makeDeps({
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 25_584,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
      onThinkingDownshifted: vi.fn(),
      eventBus: { emit: vi.fn() } as unknown as ContextEngineDeps["eventBus"],
    });
    const freshTail = [{ role: "user", content: "x".repeat(21_000) }];
    let thrown: unknown;
    try {
      runPreflightFitCheck(deps, 32_000, [], 0, freshTail as never, "native");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContextExhaustionError);
    expect((thrown as Error).message).not.toContain("effectiveContextCapSmall");
  });
});

// ---------------------------------------------------------------------------
// WR-01: errorKind "resource" in WARN calls
// ---------------------------------------------------------------------------

describe("WR-01: errorKind is 'resource' in WARN calls (not the invalid 'capacity')", () => {
  it("governor WARN uses errorKind 'resource'", () => {
    // Create a scenario where the governor fires: native/high, window pressure.
    // effectiveWindow=5000, headroom for native/high=8960 → headroomBound=5000-8960 < 0
    // So assembledInputTokens(3000) > headroomBound → (a) skip (no security pins)
    // (c) governor fires for native; medium headroom=3840, low headroom=1792
    // With low: bound=5000-1792=3208 > assembled=3000 → governor fires at "low"
    const logger = makeLogger();
    const onThinkingDownshifted = vi.fn();
    const deps = makeDeps({
      logger: logger as unknown as ContextEngineDeps["logger"],
      getThinkingLevel: () => "high",
      onThinkingDownshifted,
      eventBus: { emit: vi.fn() } as unknown as ContextEngineDeps["eventBus"],
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
    });

    const evictable = makeBudgetItems(10, 300); // 3000 total tokens
    // effectiveWindow=5000: bound for "high" = 5000-8960 < 0 → assembledInputTokens > bound
    // governor fires for "native"; at "low": bound=5000-1792=3208 > 3000 → fits
    runPreflightFitCheck(deps, 5_000, evictable, 10, [], "native");

    // The governor WARN must have been called with errorKind "resource"
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnArgs = logger.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(warnArgs.errorKind).toBe("resource");
    expect(warnArgs.errorKind).not.toBe("capacity");
  });

  it("context-exhausted WARN uses errorKind 'resource'", () => {
    // All down-shifts exhausted: even at "low" the window is too tight → exhaustion WARN
    const logger = makeLogger();
    const deps = makeDeps({
      logger: logger as unknown as ContextEngineDeps["logger"],
      getThinkingLevel: () => "high",
      eventBus: { emit: vi.fn() } as unknown as ContextEngineDeps["eventBus"],
    });

    // effectiveWindow=2000, assembledInputTokens=4000 > headroomBound at any level
    // "low" headroom=1792, bound=2000-1792=208; 4000 > 208 → exhaustion
    const evictable = makeBudgetItems(4, 1_000); // 4000 tokens total
    expect(() => runPreflightFitCheck(deps, 2_000, evictable, 4, [], "native")).toThrow(ContextExhaustionError);

    // The exhaustion WARN must have been called with errorKind "resource"
    const warnCalls = logger.warn.mock.calls;
    const exhaustionWarn = warnCalls.find((c) => {
      const arg = c[0] as Record<string, unknown>;
      return (arg.hint as string)?.includes("context exhausted");
    });
    expect(exhaustionWarn).toBeDefined();
    const warnFields = exhaustionWarn![0] as Record<string, unknown>;
    expect(warnFields.errorKind).toBe("resource");
    expect(warnFields.errorKind).not.toBe("capacity");
  });
});

// ---------------------------------------------------------------------------
// CR-03: onAssembledInputTokens reports actual assembled count
// ---------------------------------------------------------------------------

describe("CR-03: onAssembledInputTokens reports actual assembled count (not simulated undercount)", () => {
  it("under no window pressure: reports budgetedTokens + freshTailTokens", () => {
    const captured: number[] = [];
    const deps = makeDeps({
      onAssembledInputTokens: (t) => captured.push(t),
      onEffectiveWindow: vi.fn(),
      getThinkingLevel: () => "medium",
    });

    // effectiveWindow=100000 (no pressure), 10 messages × 100 tokens = 1000,
    // freshTail: 1 message with content "hello" (5 chars → 0 tokens heuristic)
    const evictable = makeBudgetItems(10, 100); // 1000 tokens kept
    const freshTail = [{ role: "user" as const, content: "hello" }];
    runPreflightFitCheck(deps, 100_000, evictable, 10, freshTail as never, "none");

    expect(captured.length).toBe(1);
    // budgetedTokens=1000, freshTailTokens=ceil(5/3.5)=2 → reported=1002
    expect(captured[0]).toBe(1_002);
  });

  it("CR-03 REGRESSION: under security-pin window pressure, reports original assembled count (not simulation)", () => {
    // Scenario: assembledInputTokens > headroomBound AND securityPinMarkers present.
    // Pre-fix: deps.onAssembledInputTokens received the SIMULATED (lower) count.
    // Post-fix: deps.onAssembledInputTokens receives the ORIGINAL (actual) count.
    const captured: number[] = [];
    const markers = { canaryToken: "canary-xyz", contentDelimiter: "---delim---" };

    const deps = makeDeps({
      onAssembledInputTokens: (t) => captured.push(t),
      onEffectiveWindow: vi.fn(),
      getThinkingLevel: () => "medium",
      securityPinMarkers: markers,
      eventBus: { emit: vi.fn() } as unknown as ContextEngineDeps["eventBus"],
    });

    // 5 non-pinned messages × 500 tokens = 2500
    // 2 pinned messages (contain canary) × 500 tokens = 1000
    // effectiveWindow=4500, headroom for none/medium=768, headroomBound=4500-768=3732
    // assembledInputTokens=3500 (2500+1000) > 3732? No: 3500 < 3732.
    // So no pressure path fires → test with a tighter window:
    // effectiveWindow=3000 → headroomBound=3000-768=2232; 3500 > 2232 → pressure path

    // Build evictable: 5 non-pinned + 2 "pinned" (contain canary token)
    const nonPinned: BudgetItem[] = Array.from({ length: 5 }, (_, i) => ({
      msg: { role: "user" as const, content: `normal message ${i}` },
      tokens: 500,
    }));
    const pinned: BudgetItem[] = Array.from({ length: 2 }, () => ({
      msg: { role: "user" as const, content: `contains canary-xyz security context` },
      tokens: 500,
    }));
    const evictable = [...nonPinned, ...pinned]; // 7 items × 500 = 3500 total

    // Window pressure triggers step (a) with security pins:
    // keptCount=7 (all kept in normal budget pass since we pass keptCount=7)
    // assembledInputTokens = 3500 > headroomBound=2232 → step (a) fires
    // simulated: evict non-pinned to tighterBudget=2232-1000-0=1232
    //   → hardEvictedMsgs = evictHistoryUnderBudget(nonPinned, 1232)
    //   → kept ≤ 1232 tokens from 5×500 items → keeps 2 (1000) or maybe 2 (1000 ≤ 1232)
    //   → keptNonPinnedTokens ≈ 1000
    //   → simulatedCount = 1000 + 1000 + 0 = 2000 (< 3500 original)
    // With "none" style the governor doesn't fire, and 2000 ≤ 2232 so no exhaustion.

    runPreflightFitCheck(deps, 3_000, evictable, 7, [], "none");

    expect(captured.length).toBe(1);
    // Post-fix: must equal ORIGINAL assembled count = 3500 (not simulated ~2000)
    // The ORIGINAL count is budgetedTokens + freshTailTokens = 3500 + 0 = 3500
    expect(captured[0]).toBe(3_500);
  });

  it("CR-03: no security pins — onAssembledInputTokens always reports original count", () => {
    // Without security pins, step (a) is skipped entirely → no divergence.
    const captured: number[] = [];
    const deps = makeDeps({
      onAssembledInputTokens: (t) => captured.push(t),
      onEffectiveWindow: vi.fn(),
      getThinkingLevel: () => "medium",
      // No securityPinMarkers
    });

    const evictable = makeBudgetItems(8, 200); // 1600 tokens
    runPreflightFitCheck(deps, 100_000, evictable, 8, [], "none");
    expect(captured[0]).toBe(1_600);
  });
});

// ---------------------------------------------------------------------------
// IN-01: fresh-tail token estimation handles non-string content
// ---------------------------------------------------------------------------

describe("IN-01: fresh-tail token estimation includes multi-part / array content", () => {
  it("string content is counted (baseline)", () => {
    const captured: number[] = [];
    const deps = makeDeps({
      onAssembledInputTokens: (t) => captured.push(t),
      onEffectiveWindow: vi.fn(),
      getThinkingLevel: () => "off",
    });

    // freshTail: one message with 350 chars of string content
    const freshTail = [{ role: "user" as const, content: "a".repeat(350) }];
    // 350 chars / 3.5 = 100 tokens
    runPreflightFitCheck(deps, 100_000, [], 0, freshTail as never, "none");
    expect(captured[0]).toBe(100);
  });

  it("IN-01: array content blocks are counted (not silently zeroed)", () => {
    const captured: number[] = [];
    const deps = makeDeps({
      onAssembledInputTokens: (t) => captured.push(t),
      onEffectiveWindow: vi.fn(),
      getThinkingLevel: () => "off",
    });

    // freshTail: one message with array content (tool-result style)
    // block1: { text: "a".repeat(350) } → 350 chars → 100 tokens
    // block2: { content: "b".repeat(350) } → 350 chars → 100 tokens
    const freshTail = [
      {
        role: "tool" as const,
        content: [
          { type: "text", text: "a".repeat(350) },
          { type: "tool_result", content: "b".repeat(350) },
        ],
      },
    ];
    runPreflightFitCheck(deps, 100_000, [], 0, freshTail as never, "none");

    // Post-fix: array content should be counted → ceil(700/3.5)=200 tokens
    // Pre-fix: array content contributes 0 → reported=0
    expect(captured[0]).toBeGreaterThan(0);
    // The exact value: (350+350)/3.5 = 200 tokens
    expect(captured[0]).toBe(200);
  });

  it("IN-01: mixed messages (string + array) each contribute to total", () => {
    const captured: number[] = [];
    const deps = makeDeps({
      onAssembledInputTokens: (t) => captured.push(t),
      onEffectiveWindow: vi.fn(),
      getThinkingLevel: () => "off",
    });

    const freshTail = [
      { role: "user" as const, content: "a".repeat(350) },  // 100 tokens
      { role: "tool" as const, content: [{ type: "text", text: "b".repeat(350) }] }, // 100 tokens
    ];
    runPreflightFitCheck(deps, 100_000, [], 0, freshTail as never, "none");
    expect(captured[0]).toBe(200);  // 100 + 100
  });
});

// ---------------------------------------------------------------------------
// WR-02: minVisibleOutputTokens config value used as floor
// ---------------------------------------------------------------------------

describe("WR-02: minVisibleOutputTokens config value threads into headroom computation", () => {
  it("default (no config) uses 768 — frontier/mid byte-identical", () => {
    const captured: number[] = [];
    const deps = makeDeps({
      onAssembledInputTokens: (t) => captured.push(t),
      onEffectiveWindow: vi.fn(),
      getThinkingLevel: () => "medium",
    });
    // No window pressure → just verify the callback fires correctly
    const evictable = makeBudgetItems(5, 100);
    runPreflightFitCheck(deps, 100_000, evictable, 5, [], "none");
    expect(captured[0]).toBe(500);
  });

  it("custom minVisibleOutputTokens increases headroom floor (prevents undercount)", () => {
    // With minVisibleOutputTokens=1200 (custom config), headroom for none/medium
    // should be 1200 (not 768). Window pressure fires sooner.
    const capturedWin: number[] = [];
    const onThrowCapture = vi.fn();
    const deps = makeDeps({
      onAssembledInputTokens: (t) => capturedWin.push(t),
      onEffectiveWindow: vi.fn(),
      getThinkingLevel: () => "off",
      // Pass the custom minVisibleOutputTokens via the minVisibleOutputTokens dep key
      minVisibleOutputTokens: 1_200,
    } as Partial<ContextEngineDeps>);

    // With custom 1200 floor: headroomBound = 5000 - 1200 = 3800
    // assembledInputTokens = 4000 > 3800 → step (a) or governor or exhaustion fires
    // For reasoningStyle="none": no down-shift, no security pins → exhaustion thrown
    const evictable = makeBudgetItems(8, 500); // 4000 tokens
    try {
      runPreflightFitCheck(deps, 5_000, evictable, 8, [], "none");
    } catch (e) {
      onThrowCapture(e);
    }

    // With custom 1200 the pre-flight SHOULD throw (4000 > 3800 and no pins/governor for none)
    // But WITHOUT config threading: headroomBound = 5000-768=4232, 4000 < 4232 → no throw
    // This test VERIFIES the config value threads through (post-WR-02 fix).
    // For now, this test serves as a characterization: if minVisibleOutputTokens is NOT
    // threaded, the function completes without throwing.
    // After the fix, this should throw.
    // We document this as "requires human verification" since it tests a specific threading path.
    expect(onThrowCapture).toHaveBeenCalledTimes(1);
    expect(onThrowCapture.mock.calls[0][0]).toBeInstanceOf(ContextExhaustionError);
  });
});

// ---------------------------------------------------------------------------
// Escalation ladder: governor + exhaustion
// ---------------------------------------------------------------------------

describe("runPreflightFitCheck escalation ladder", () => {
  it("no pressure: no WARN, no throw, onAssembledInputTokens fires once", () => {
    const logger = makeLogger();
    const captured: number[] = [];
    const deps = makeDeps({
      logger: logger as unknown as ContextEngineDeps["logger"],
      onAssembledInputTokens: (t) => captured.push(t),
      onEffectiveWindow: vi.fn(),
      getThinkingLevel: () => "medium",
    });
    const evictable = makeBudgetItems(5, 100);
    expect(() => runPreflightFitCheck(deps, 100_000, evictable, 5, [], "none")).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
  });

  it("governor fires for native: onThinkingDownshifted called + WARN emitted", () => {
    const logger = makeLogger();
    const downshifted: string[] = [];
    const deps = makeDeps({
      logger: logger as unknown as ContextEngineDeps["logger"],
      getThinkingLevel: () => "high",
      onThinkingDownshifted: (level) => downshifted.push(level),
      eventBus: { emit: vi.fn() } as unknown as ContextEngineDeps["eventBus"],
      onAssembledInputTokens: vi.fn(),
      onEffectiveWindow: vi.fn(),
    });
    // 3000 tokens, effectiveWindow=5000, native/high headroom=8960 → pressure
    // governor fires downshifts until "low" (bound=3208 > 3000)
    const evictable = makeBudgetItems(10, 300);
    runPreflightFitCheck(deps, 5_000, evictable, 10, [], "native");
    expect(downshifted.length).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("exhaustion throw for none style with extreme pressure", () => {
    const deps = makeDeps({
      getThinkingLevel: () => "off",
      onAssembledInputTokens: vi.fn(),
      onEffectiveWindow: vi.fn(),
      logger: makeLogger() as unknown as ContextEngineDeps["logger"],
    });
    // 4000 tokens, effectiveWindow=2000: headroomBound = 2000-768=1232
    // no governor (style=none) → exhaustion
    const evictable = makeBudgetItems(4, 1_000);
    expect(() => runPreflightFitCheck(deps, 2_000, evictable, 4, [], "none")).toThrow(ContextExhaustionError);
  });
});

// ---------------------------------------------------------------------------
// W5 (obs-llm-troubleshooting): the fit check returns the ORIGINAL assembled
// count so the assembler's INFO line can log the full budget equation.
// ---------------------------------------------------------------------------
describe("runPreflightFitCheck return value (W5)", () => {
  it("returns the original assembled input token count for the INFO budget line", () => {
    const deps = makeDeps({
      getThinkingLevel: () => "high",
      getSystemTokensEstimate: () => 1_000,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
    });
    const evictable = makeBudgetItems(2, 100); // 200 history tokens
    const assembled = runPreflightFitCheck(deps, 32_000, evictable, 2, [], "native");
    expect(assembled).toBe(1_200);
  });
});

// ---------------------------------------------------------------------------
// Issue-6 (small-model e2e 2026-06-12 UC-3): the throw classifies WHY the fit
// failed, so the degraded reply can branch its advice. "narrow the ask" was
// misleading when the offender was a persisted oversized HISTORY message.
// ---------------------------------------------------------------------------
describe("Issue-6: exhaustion cause classification at the throw", () => {
  function throwFrom(
    evictable: BudgetItem[],
    keptCount: number,
    freshTail: unknown[],
  ): ContextExhaustionError {
    const deps = makeDeps({
      getThinkingLevel: () => "medium",
      getSystemTokensEstimate: () => 0,
      onEffectiveWindow: vi.fn(),
      onAssembledInputTokens: vi.fn(),
    });
    let caught: unknown;
    try {
      // reasoningStyle "none" → no downshift ladder; bound = 32000 − 768 = 31232.
      runPreflightFitCheck(deps, 32_000, evictable, keptCount, freshTail as never, "none");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ContextExhaustionError);
    return caught as ContextExhaustionError;
  }

  it("the CURRENT user input alone over the bound → cause oversized_input", () => {
    // 140K chars → 40000 tokens; it is the LAST user message in the fresh tail.
    const freshTail = [
      { role: "assistant", content: "working on it" },
      { role: "user", content: "X".repeat(140_000) },
    ];
    const err = throwFrom([], 0, freshTail);
    expect(err.exhaustionCause).toBe("oversized_input");
    expect(err.message).toContain("[cause: oversized_input]");
  });

  it("a single oversized EARLIER message (kept history item) → cause oversized_history_message", () => {
    // One kept history BudgetItem of 40000 tokens; the current input is tiny.
    const evictable: BudgetItem[] = [
      { msg: { role: "user" as const, content: "old oversized paste" }, tokens: 40_000 },
    ];
    const freshTail = [{ role: "user", content: "what is 2 + 2?" }];
    const err = throwFrom(evictable, 1, freshTail);
    expect(err.exhaustionCause).toBe("oversized_history_message");
    expect(err.message).toContain("[cause: oversized_history_message]");
  });

  it("many individually-fitting messages overflowing together → cause aggregate (unmarked message)", () => {
    // 5 × 28K chars = 8000 tokens each (each < 31232) — only the SUM overflows.
    const freshTail = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "X".repeat(28_000),
    }));
    const err = throwFrom([], 0, freshTail);
    expect(err.exhaustionCause).toBe("aggregate");
    expect(err.message).not.toContain("[cause:");
  });
});
