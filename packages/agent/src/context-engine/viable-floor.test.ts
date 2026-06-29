// SPDX-License-Identifier: Apache-2.0
/**
 * FLOOR-01 (Phase 176): boot viable-floor equation, WARN emission, boot-resolution
 * mirror, and the non-riggable I8 drift pins.
 *
 * minViable = bootstrapTotalTokens + toolSchemaTokens + outputHeadroomFloor
 *           + freshTailReserve + safetyMargin
 *
 * I8 contract: every term function/constant in viable-floor.ts IS the turn-time
 * import (tool-overhead.ts / output-headroom.ts / constants.ts / scaffold-defaults.ts /
 * effective-context-window.ts / model-profile.ts / executor-tool-assembly.ts) —
 * FLOOR-01-13 asserts FUNCTION-REFERENCE IDENTITY (`toBe`), never recomputation,
 * so a re-derived local copy cannot pass (Pitfall 8: the rigged-drift-test class).
 */
import { describe, it, expect } from "vitest";
import {
  computeMinViableEquation,
  evaluateViableFloorForAgent,
  collectAgentBootWindowInfo,
  VIABLE_FLOOR_SHARED_SOURCES,
  type AgentBootWindowInfo,
} from "./viable-floor.js";
import { toolDefOverheadChars } from "../executor/tool-overhead.js";
import { computeOutputHeadroom } from "./output-headroom.js";
import { resolveEffectiveContextWindow } from "../model/effective-context-window.js";
import { resolveScaffoldDefaults } from "../executor/scaffold-defaults.js";
import { resolveModelProfile, FAIL_CLOSED_PROFILE } from "../executor/model-profile.js";
import type { ModelProfile } from "../executor/model-profile.js";
import {
  CHARS_PER_TOKEN_RATIO,
  SAFETY_MARGIN_PERCENT,
  MIN_SAFETY_MARGIN_TOKENS,
} from "./constants.js";
import { PREAMBLE_WARN_THRESHOLD_BY_CLASS } from "../executor/executor-tool-assembly.js";
import type { PerAgentConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Small-class native-reasoning profile (budget-capacity-cap.test.ts style). */
const SMALL_NATIVE_PROFILE: ModelProfile = {
  contextWindow: 8_192,
  maxOutputTokens: 8_192,
  capabilityClass: "small",
  scaffoldLevel: "max",
  securityLevel: "locked",
  supportsVision: false,
  supportsTools: true,
  supportsPromptCache: false,
  supportsServerToolSearch: false,
  supportsStructuredOutput: false,
  reasoningStyle: "native",
};

/** Nano-class no-reasoning profile (for the safetyMargin-dominates fixture). */
const NANO_NONE_PROFILE: ModelProfile = {
  ...SMALL_NATIVE_PROFILE,
  capabilityClass: "nano",
  reasoningStyle: "none",
};

/**
 * Equation fixture toolset — char arithmetic computed by hand and inlined:
 *   tool A: name "alpha" (5) + 100-char description + JSON.stringify({type:"object"})
 *           = '{"type":"object"}' (17 chars) → 122
 *   tool B: name "beta" (4) + 50-char description + no parameters (0) → 54
 *   total = 176 chars → toolSchemaTokens = ceil(176 / 3.5) = 51
 */
const EQ_TOOLS = [
  { name: "alpha", description: "x".repeat(100), parameters: { type: "object" } },
  { name: "beta", description: "y".repeat(50) },
];
const EQ_TOOLS_TOKENS = 51;

/**
 * Dominance fixture — toolSchemaTokens is the max term:
 *   name "mega" (4) + 14_000-char description = 14_004 chars
 *   → toolSchemaTokens = ceil(14_004 / 3.5) = 4_002 (> small freshTailReserve 3_200)
 */
const BIG_TOOLS = [{ name: "mega", description: "z".repeat(14_000) }];
const BIG_TOOLS_TOKENS = 4_002;

/** Recording logger stub — captures every WARN for fixture assertion. */
function makeRecordingLogger(): {
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
  warnCalls: Array<{ obj: Record<string, unknown>; msg: string }>;
} {
  const warnCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    logger: {
      warn(obj, msg) {
        warnCalls.push({ obj, msg });
      },
    },
    warnCalls,
  };
}

/** AgentBootWindowInfo factory — the small-class served-bound default fixture. */
function makeInfo(overrides: Partial<AgentBootWindowInfo> = {}): AgentBootWindowInfo {
  return {
    agentId: "agent-1",
    providerId: "qwen-local",
    modelId: "qwen3.6:35b",
    configuredWindow: 131_072,
    served: 8_192,
    effectiveWindow: 8_192,
    windowSource: "served",
    modelProfile: SMALL_NATIVE_PROFILE,
    scaffoldBootstrapChars: 5_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeMinViableEquation — pure equation terms
// ---------------------------------------------------------------------------

describe("computeMinViableEquation — FLOOR-01 equation terms", () => {
  it("FLOOR-01-1: computes every term exactly for a small/native scaffold on an 8K window", () => {
    const eq = computeMinViableEquation({
      tools: EQ_TOOLS,
      scaffoldBootstrapChars: 5_000,
      reasoningStyle: "native",
      capabilityClass: "small",
      effectiveWindow: 8_192,
    });
    expect(eq.terms.bootstrapTotalTokens).toBe(1_429); // ceil(5000 / 3.5)
    expect(eq.terms.toolSchemaTokens).toBe(EQ_TOOLS_TOKENS); // ceil(176 / 3.5)
    expect(eq.terms.outputHeadroomFloor).toBe(1_792); // native@low 1024 + visible floor 768
    expect(eq.terms.freshTailReserve).toBe(3_200); // small-class preamble threshold
    expect(eq.terms.safetyMargin).toBe(2_048); // max(ceil(8192*5/100)=410, 2048)
    expect(eq.minViable).toBe(1_429 + 51 + 1_792 + 3_200 + 2_048);
    expect(eq.dominantTerm).toBe("freshTailReserve"); // 3200 is the max term
  });

  it("FLOOR-01-2: reasoningStyle none reserves only the visible output floor (768)", () => {
    const eq = computeMinViableEquation({
      tools: EQ_TOOLS,
      scaffoldBootstrapChars: 5_000,
      reasoningStyle: "none",
      capabilityClass: "small",
      effectiveWindow: 8_192,
    });
    expect(eq.terms.outputHeadroomFloor).toBe(768);
  });

  it("FLOOR-01-3: frontier class maps the Infinity preamble threshold to a 0 freshTailReserve keeping minViable finite", () => {
    // PREAMBLE_WARN_THRESHOLD_BY_CLASS.frontier === Infinity means "the preamble
    // WARN never fires at turn time", NOT "infinite preamble" — the floor maps it
    // to 0 so the equation stays finite and frontier's boot WARN is practically
    // unreachable (A1/A2 + R-4 healthy-boot-silent).
    const eq = computeMinViableEquation({
      tools: EQ_TOOLS,
      scaffoldBootstrapChars: 20_000,
      reasoningStyle: "none",
      capabilityClass: "frontier",
      effectiveWindow: 131_072,
    });
    expect(eq.terms.freshTailReserve).toBe(0);
    expect(Number.isFinite(eq.minViable)).toBe(true);
  });

  it("FLOOR-01-4: operator minVisibleOutputTokens replaces the default visible floor in the headroom term", () => {
    const eq = computeMinViableEquation({
      tools: EQ_TOOLS,
      scaffoldBootstrapChars: 5_000,
      reasoningStyle: "native",
      capabilityClass: "small",
      effectiveWindow: 8_192,
      minVisibleOutputTokens: 1_500,
    });
    expect(eq.terms.outputHeadroomFloor).toBe(1_024 + 1_500); // native@low + operator floor
  });

  // E1 (obs-sweep): deferral-aware toolSchemaTokens. At turn time applyToolDeferral ships only
  // `activeToolCeiling` active tools + a wire-stripped discover_tools stub; the boot floor must
  // mirror that or it counts the FULL pre-deferral corpus and false-WARNs on a small-class agent
  // that runs fine via discover_tools. Conservatively counts the `ceiling` LARGEST tools.
  const DEFERRAL_TOOLS = [
    { name: "a", description: "x".repeat(10), parameters: {} },   // 1 + 10 + 2 = 13
    { name: "b", description: "x".repeat(100), parameters: {} },  // 1 + 100 + 2 = 103
    { name: "c", description: "x".repeat(1000), parameters: {} }, // 1 + 1000 + 2 = 1003
    { name: "d", description: "x".repeat(5), parameters: {} },    // 1 + 5 + 2 = 8
  ];
  it("FLOOR-01-13 (E1): activeToolCeiling < tools.length counts ONLY the ceiling largest tools", () => {
    const base = { scaffoldBootstrapChars: 5_000, reasoningStyle: "none" as const, capabilityClass: "small", effectiveWindow: 8_192 };
    const full = computeMinViableEquation({ ...base, tools: DEFERRAL_TOOLS });
    const deferred = computeMinViableEquation({ ...base, tools: DEFERRAL_TOOLS, activeToolCeiling: 2 });
    expect(full.terms.toolSchemaTokens).toBe(Math.ceil((13 + 103 + 1003 + 8) / 3.5)); // 322 — all 4
    expect(deferred.terms.toolSchemaTokens).toBe(Math.ceil((1003 + 103) / 3.5)); // 316 — the 2 LARGEST only
    expect(deferred.terms.toolSchemaTokens).toBeLessThan(full.terms.toolSchemaTokens);
  });

  it("FLOOR-01-14 (E1): activeToolCeiling >= tools.length (or undefined) counts the full corpus (no deferral)", () => {
    const base = { scaffoldBootstrapChars: 5_000, reasoningStyle: "none" as const, capabilityClass: "small", effectiveWindow: 8_192, tools: DEFERRAL_TOOLS };
    const full = computeMinViableEquation(base);
    expect(computeMinViableEquation({ ...base, activeToolCeiling: 10 }).terms.toolSchemaTokens).toBe(full.terms.toolSchemaTokens);
    expect(computeMinViableEquation({ ...base, activeToolCeiling: undefined }).terms.toolSchemaTokens).toBe(full.terms.toolSchemaTokens);
  });
});

// ---------------------------------------------------------------------------
// evaluateViableFloorForAgent — WARN emission
// ---------------------------------------------------------------------------

describe("evaluateViableFloorForAgent — WARN emission", () => {
  it("FLOOR-01-5: emits exactly ONE WARN with the full named-term equation, binding source, knobs, and dominance lever", () => {
    const { logger, warnCalls } = makeRecordingLogger();
    const result = evaluateViableFloorForAgent({ info: makeInfo(), tools: BIG_TOOLS, logger });

    expect(warnCalls).toHaveLength(1);
    expect(result).toBeDefined();
    const { obj, msg } = warnCalls[0];
    expect(msg).toBe(
      "Boot viable-floor check: effective window below minViable — agent will degrade on real turns (WARN-only, boot continues)",
    );
    expect(obj.agentId).toBe("agent-1");
    expect(obj.effectiveWindow).toBe(8_192);
    expect(obj.windowSource).toBe("served");
    expect(obj.minViable).toBe(1_429 + BIG_TOOLS_TOKENS + 1_792 + 3_200 + 2_048);
    expect(obj.bootstrapTotalTokens).toBe(1_429);
    expect(obj.toolSchemaTokens).toBe(BIG_TOOLS_TOKENS);
    expect(obj.outputHeadroomFloor).toBe(1_792);
    expect(obj.freshTailReserve).toBe(3_200);
    expect(obj.safetyMargin).toBe(2_048);
    expect(obj.dominantTerm).toBe("toolSchemaTokens");
    expect(obj.errorKind).toBe("config");
    expect(obj.submodule).toBe("viable-floor");

    const hint = obj.hint as string;
    expect(hint).toMatch(
      /minViable = bootstrapTotalTokens\(\d+\) \+ toolSchemaTokens\(\d+\) \+ outputHeadroomFloor\(\d+\) \+ freshTailReserve\(\d+\) \+ safetyMargin\(\d+\) = \d+/,
    );
    expect(hint).toContain("[source: served]");
    expect(hint).toContain("OLLAMA_CONTEXT_LENGTH=131072");
    expect(hint).toContain("PARAMETER num_ctx 131072");
    // Dominance sentence: names the active-tool-ceiling levers.
    expect(hint).toContain("capabilityClass");
    expect(hint).toContain("discover_tools");
    expect(hint).toContain("MCP");
  });

  it("FLOOR-01-15 (E1): deferral-active — the floor measures the ceiling corpus + advises POST-deferral (not 'pin small')", () => {
    const { logger, warnCalls } = makeRecordingLogger();
    // 5 big tools, ceiling 2 → the floor counts only the 2 LARGEST (the turn defers the other 3 via
    // discover_tools). Each tool: name(2) + desc(14000) + params(0) = 14002 chars.
    const bigTools = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, description: "z".repeat(14_000) }));
    const result = evaluateViableFloorForAgent({ info: makeInfo({ activeToolCeiling: 2 }), tools: bigTools, logger });
    expect(warnCalls).toHaveLength(1);
    // toolSchemaTokens reflects the 2-tool DEFERRED corpus, NOT all 5 (deferral-aware floor).
    expect(result!.terms.toolSchemaTokens).toBe(Math.ceil((2 * (2 + 14_000)) / 3.5));
    const hint = warnCalls[0].obj.hint as string;
    // The advice no longer says "pin small" (already deferred) — it names the post-deferral levers.
    expect(hint).toContain("EVEN AFTER deferral");
    expect(hint).toContain("2-tool active ceiling");
    expect(hint).not.toContain("pin capabilityClass");
  });

  it("FLOOR-01-6: a healthy window (effectiveWindow >= minViable) returns undefined and emits ZERO warns", () => {
    const { logger, warnCalls } = makeRecordingLogger();
    const result = evaluateViableFloorForAgent({
      info: makeInfo({ effectiveWindow: 131_072, windowSource: "configured", served: undefined }),
      tools: BIG_TOOLS,
      logger,
    });
    expect(result).toBeUndefined();
    expect(warnCalls).toHaveLength(0);
  });

  it("FLOOR-01-7 (IN-06): capability-bound window leads with the capabilityClass pin lever, never the inert budget-knob remedy or the Ollama knobs", () => {
    // IN-06 (Phase 176 review, iteration 2): for a capability-bound window the
    // boot resolver (like the executor reconcile) reads only
    // DEFAULT_EFFECTIVE_CAP_BY_CLASS[pinned class] — the contextEngine.budget.*
    // caps can only clamp FURTHER, never raise this bind, so leading with
    // "Raise contextEngine.budget.effectiveContextCapSmall ... (0 = uncapped)"
    // is the WR-01 dead-knob misdirection on the boot WARN surface.
    const { logger, warnCalls } = makeRecordingLogger();
    evaluateViableFloorForAgent({
      info: makeInfo({ windowSource: "capability" }),
      tools: BIG_TOOLS,
      logger,
    });
    expect(warnCalls).toHaveLength(1);
    const hint = warnCalls[0].obj.hint as string;
    expect(hint).toContain(
      "Pin a higher class (or remove the pin) via providers.entries.qwen-local.capabilities.capabilityClass",
    );
    expect(hint).toContain("contextEngine.budget.* caps do not move this bind");
    expect(hint).not.toContain("(0 = uncapped)");
    expect(hint).not.toContain("OLLAMA_CONTEXT_LENGTH");
  });

  it("FLOOR-01-8: configured-bound window names the models[].contextWindow knob", () => {
    const { logger, warnCalls } = makeRecordingLogger();
    evaluateViableFloorForAgent({
      info: makeInfo({
        windowSource: "configured",
        configuredWindow: 8_192,
        served: undefined,
      }),
      tools: BIG_TOOLS,
      logger,
    });
    expect(warnCalls).toHaveLength(1);
    const hint = warnCalls[0].obj.hint as string;
    expect(hint).toContain("models[].contextWindow");
  });

  it("FLOOR-01-9: when safetyMargin dominates the hint omits the tool-surface dominance sentence", () => {
    // nano/"none" + tiny scaffold + tiny tools on a 4K window:
    //   bootstrap ceil(1000/3.5)=286, tools 51, headroom 768, freshTail nano 1600,
    //   safety max(ceil(4000*5/100)=200, 2048)=2048 → minViable 4753 > 4000.
    const { logger, warnCalls } = makeRecordingLogger();
    evaluateViableFloorForAgent({
      info: makeInfo({
        modelProfile: NANO_NONE_PROFILE,
        scaffoldBootstrapChars: 1_000,
        effectiveWindow: 4_000,
      }),
      tools: EQ_TOOLS,
      logger,
    });
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].obj.dominantTerm).toBe("safetyMargin");
    const hint = warnCalls[0].obj.hint as string;
    expect(hint).not.toContain("discover_tools");
  });
});

// ---------------------------------------------------------------------------
// WR-03 (Phase 176 review): the boot floor must measure the CONVERTED tool
// corpus — the SAME input the turn-time S estimate measures.
// ---------------------------------------------------------------------------
// The turn-time S term runs toolDefOverheadChars over the CONVERTED
// ToolDefinition[] (the executor's convertTools swaps each description for the
// pre-resolved LEAN one and appends promptGuidelines). Pre-fix the boot floor
// ran the SAME shared function over the RAW AgentTool[] — identical formula,
// different corpus — so the boot term systematically over-counted (raw
// descriptions ≫ lean) and false-positive WARNed on tool-heavy agents that
// genuinely fit at turn time, while under-counting guideline-carrying tools.

describe("WR-03: boot floor measures the converted (turn-time) tool corpus", () => {
  // BIG_TOOLS raw: "mega" (4) + 14_000 chars = 14_004 → raw term 4_002.
  // Lean conversion swaps to a 700-char description: 4 + 700 = 704 chars
  //   → converted term = ceil(704 / 3.5) = 202.
  const LEAN_DESCRIPTION = "L".repeat(700);
  const leanConvert = (
    tools: ReadonlyArray<{ name?: string; description?: string; parameters?: unknown }>,
  ) => tools.map((t) => ({ ...t, description: LEAN_DESCRIPTION }));

  it("WR-03-1: applies info.convertTools so toolSchemaTokens equals the converted corpus, not the raw one", () => {
    const { logger, warnCalls } = makeRecordingLogger();
    evaluateViableFloorForAgent({
      info: makeInfo({ convertTools: leanConvert }),
      tools: BIG_TOOLS,
      logger,
    });
    expect(warnCalls).toHaveLength(1);
    // ceil((4 + 700) / 3.5) = 202 — the turn-time corpus. Pre-fix: 4_002 (raw).
    expect(warnCalls[0].obj.toolSchemaTokens).toBe(202);
    expect(warnCalls[0].obj.minViable).toBe(1_429 + 202 + 1_792 + 3_200 + 2_048);
  });

  it("WR-03-2: a tool-heavy agent that genuinely FITS at turn time stays SILENT at boot (the false-positive kill)", () => {
    // Window 10_000: base terms 1_429 + 1_792 + 3_200 + 2_048 = 8_469.
    //   raw corpus:  8_469 + 4_002 = 12_471 > 10_000 → pre-fix WARNed.
    //   lean corpus: 8_469 +   202 =  8_671 < 10_000 → fits — silent (R-4).
    const { logger, warnCalls } = makeRecordingLogger();
    const result = evaluateViableFloorForAgent({
      info: makeInfo({ effectiveWindow: 10_000, convertTools: leanConvert }),
      tools: BIG_TOOLS,
      logger,
    });
    expect(result).toBeUndefined();
    expect(warnCalls).toHaveLength(0);
  });

  it("WR-03-3: a guideline-appending conversion GROWS the term (the under-count direction is fixed too)", () => {
    // Conversion mirrors tool-definition-adapter.ts guideline append:
    // EQ_TOOLS chars 176 + 2 × 24-char guideline block = 224 → ceil(224/3.5) = 64.
    const GUIDELINE_BLOCK = "\n\nGuidelines:\n- always x"; // 24 chars
    expect(GUIDELINE_BLOCK).toHaveLength(24);
    const guidelineConvert = (
      tools: ReadonlyArray<{ name?: string; description?: string; parameters?: unknown }>,
    ) => tools.map((t) => ({ ...t, description: (t.description ?? "") + GUIDELINE_BLOCK }));
    const { logger, warnCalls } = makeRecordingLogger();
    evaluateViableFloorForAgent({
      info: makeInfo({ convertTools: guidelineConvert }),
      tools: EQ_TOOLS,
      logger,
    });
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].obj.toolSchemaTokens).toBe(64); // raw EQ_TOOLS_TOKENS was 51
  });

  it("WR-03-4: absent convertTools keeps the raw measurement (conservative fallback; production wiring always binds it)", () => {
    const { logger, warnCalls } = makeRecordingLogger();
    evaluateViableFloorForAgent({ info: makeInfo(), tools: BIG_TOOLS, logger });
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].obj.toolSchemaTokens).toBe(BIG_TOOLS_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// collectAgentBootWindowInfo — executor-mirrored boot resolution
// ---------------------------------------------------------------------------

describe("collectAgentBootWindowInfo — executor-mirrored boot resolution", () => {
  it("FLOOR-01-10: served-bound resolution mirrors pi-executor — profile resolved on the RECONCILED window", () => {
    const calls: Array<[string, string]> = [];
    const info = collectAgentBootWindowInfo({
      agentId: "agent-1",
      providerId: "qwen-local",
      modelId: "qwen3.6:35b",
      findModel: (provider, modelId) => {
        calls.push([provider, modelId]);
        return { id: "qwen3.6:35b", provider: "qwen-local", contextWindow: 131_072 };
      },
      served: 8_192,
      explicitCapabilityClass: undefined,
      agentConfig: {} as PerAgentConfig,
    });
    // normalizeModelId passthrough for unknown provider → registry find mirror.
    expect(calls).toEqual([["qwen-local", "qwen3.6:35b"]]);
    expect(info.configuredWindow).toBe(131_072);
    expect(info.effectiveWindow).toBe(8_192);
    expect(info.windowSource).toBe("served");
    // Profile resolved on the RECONCILED window, exactly like pi-executor.ts:363-368.
    expect(info.modelProfile.contextWindow).toBe(8_192);
    // A2: small class → bootstrapTotalMaxChars (5_000) from resolveScaffoldDefaults.
    expect(info.scaffoldBootstrapChars).toBe(5_000);
  });

  it("FLOOR-01-11: explicit capabilityClass small with no served window caps via DEFAULT_EFFECTIVE_CAP_BY_CLASS", () => {
    const info = collectAgentBootWindowInfo({
      agentId: "agent-1",
      providerId: "qwen-local",
      modelId: "qwen3.6:35b",
      findModel: () => ({ id: "qwen3.6:35b", provider: "qwen-local", contextWindow: 131_072 }),
      served: undefined,
      explicitCapabilityClass: "small",
      agentConfig: {} as PerAgentConfig,
    });
    expect(info.effectiveWindow).toBe(32_000);
    expect(info.windowSource).toBe("capability");
  });

  it("FLOOR-01-12: registry miss falls back to the 8_192 configured default and the fail-closed nano profile", () => {
    const info = collectAgentBootWindowInfo({
      agentId: "agent-1",
      providerId: "qwen-local",
      modelId: "missing-model",
      findModel: () => undefined,
      served: undefined,
      explicitCapabilityClass: undefined,
      agentConfig: {} as PerAgentConfig,
    });
    expect(info.configuredWindow).toBe(8_192);
    expect(info.modelProfile).toBe(FAIL_CLOSED_PROFILE);
    expect(info.modelProfile.capabilityClass).toBe("nano");
  });
});

// ---------------------------------------------------------------------------
// I8 drift pins — shared-source identity (Pitfall 8: identity, not recomputation)
// ---------------------------------------------------------------------------

describe("I8 drift pins — shared-source reference identity", () => {
  it("FLOOR-01-13: every floor term function/constant IS the turn-time import — reference identity, not a recomputed copy", () => {
    expect(VIABLE_FLOOR_SHARED_SOURCES.toolDefOverheadChars).toBe(toolDefOverheadChars);
    expect(VIABLE_FLOOR_SHARED_SOURCES.computeOutputHeadroom).toBe(computeOutputHeadroom);
    expect(VIABLE_FLOOR_SHARED_SOURCES.resolveEffectiveContextWindow).toBe(
      resolveEffectiveContextWindow,
    );
    expect(VIABLE_FLOOR_SHARED_SOURCES.resolveScaffoldDefaults).toBe(resolveScaffoldDefaults);
    expect(VIABLE_FLOOR_SHARED_SOURCES.resolveModelProfile).toBe(resolveModelProfile);
    expect(VIABLE_FLOOR_SHARED_SOURCES.CHARS_PER_TOKEN_RATIO).toBe(CHARS_PER_TOKEN_RATIO);
    expect(VIABLE_FLOOR_SHARED_SOURCES.SAFETY_MARGIN_PERCENT).toBe(SAFETY_MARGIN_PERCENT);
    expect(VIABLE_FLOOR_SHARED_SOURCES.MIN_SAFETY_MARGIN_TOKENS).toBe(MIN_SAFETY_MARGIN_TOKENS);
    expect(VIABLE_FLOOR_SHARED_SOURCES.PREAMBLE_WARN_THRESHOLD_BY_CLASS).toBe(
      PREAMBLE_WARN_THRESHOLD_BY_CLASS,
    );
  });

  it("FLOOR-01-14: safetyMargin numerically matches the token-budget formula computed with the IMPORTED constants", () => {
    // The test imports SAFETY_MARGIN_PERCENT / MIN_SAFETY_MARGIN_TOKENS itself —
    // a local copy inside viable-floor.ts would still fail FLOOR-01-13's identity
    // check unless it re-exports the real constants.
    const eq = computeMinViableEquation({
      tools: EQ_TOOLS,
      scaffoldBootstrapChars: 5_000,
      reasoningStyle: "native",
      capabilityClass: "small",
      effectiveWindow: 8_192,
    });
    expect(eq.terms.safetyMargin).toBe(
      Math.max(Math.ceil((8_192 * SAFETY_MARGIN_PERCENT) / 100), MIN_SAFETY_MARGIN_TOKENS),
    );
  });
});
