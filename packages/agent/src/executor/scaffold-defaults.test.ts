// SPDX-License-Identifier: Apache-2.0
/**
 * Capability-default truth table for resolveScaffoldDefaults().
 *
 * Invariants tested:
 *  - GoalAnchor capability default ON for small/nano; explicit config wins both ways
 *  - rag.baseFloor capability default 0.15 for small/nano; explicit non-zero wins;
 *    0.15>0.12 drops the known poison fixture
 *  - Verification cost-gate OFF unless a distinct cheap critic is explicitly configured + keyless
 *  - frontier/mid always return all-OFF regardless of capability class (byte-identical
 *    non-regression — the scaffold defaults never touch large tiers)
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { resolveScaffoldDefaults } from "./scaffold-defaults.js";
// Parity assertion: both copies of KEYLESS_CRITIC_PROVIDERS must be identical.
// scaffold-defaults.ts keeps its own Set to avoid circular imports; verification-gate.ts
// exports it so we can assert equality here. If either copy drifts, this test fails loudly.
import { KEYLESS_CRITIC_PROVIDERS as gateProviders } from "./verification-gate.js";
import { resolveModelProfile } from "./model-profile.js";
import type { PerAgentConfig, OperationModels } from "@comis/core";
import { applyToolDeferral } from "./tool-deferral.js";
import type { DeferralContext } from "./tool-deferral.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDiscoveryTracker } from "./discovery-tracker.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Profile fixtures — use capabilityClassOverride so tests do not depend on
// provider heuristics (mirrors the model-profile.test.ts override fixtures).
// ---------------------------------------------------------------------------
const BASE_OLLAMA_INPUT = {
  id: "test-model",
  provider: "ollama",
  contextWindow: 8_192,
  reasoning: false,
  input: ["text"] as ["text"],
};

const smallProfile = resolveModelProfile(BASE_OLLAMA_INPUT, "small");
const nanoProfile = resolveModelProfile(BASE_OLLAMA_INPUT, "nano");
const frontierProfile = resolveModelProfile(BASE_OLLAMA_INPUT, "frontier");
const midProfile = resolveModelProfile(BASE_OLLAMA_INPUT, "mid");

// Minimal config shapes (raw PerAgentConfig, NOT re-parsed through sub-schemas).
// CRITICAL: do NOT call GoalAnchorConfigSchema.parse() or VerificationConfigSchema.parse()
// on these — that would collapse undefined to false and break the ?? gate tests.
const emptyConfig = {} as PerAgentConfig;

// criticContext for the cost-gate tests: ollama keyless, distinct cheap critic model
const criticContextWithDistinctCheapModel = {
  provider: "ollama",
  agentModel: "qwen3.6:27b",
  operationModels: {
    verification: { model: "ollama:qwen3.6:1.5b" },
  } as OperationModels,
};

// ---------------------------------------------------------------------------
// GoalAnchor capability-gated default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — GoalAnchor capability default", () => {
  it("small model with no goalAnchor config returns goalAnchorEnabled=true (capability default ON)", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(true);
  });

  it("nano model with no goalAnchor config returns goalAnchorEnabled=true (capability default ON)", () => {
    const result = resolveScaffoldDefaults(nanoProfile, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(true);
  });

  it("small model with explicit goalAnchor.enabled=false returns goalAnchorEnabled=false (explicit false wins)", () => {
    const config = { goalAnchor: { enabled: false } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.goalAnchorEnabled).toBe(false);
  });

  it("frontier model with explicit goalAnchor.enabled=true returns goalAnchorEnabled=true (explicit true on frontier wins)", () => {
    const config = { goalAnchor: { enabled: true } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(frontierProfile, config);
    expect(result.goalAnchorEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rag.baseFloor capability-gated default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — rag.baseFloor capability default", () => {
  it("small model with baseFloor=0 (schema default) returns baseFloor=0.15 (SMALL_NANO_DEFAULT_BASE_FLOOR)", () => {
    const config = { rag: { baseFloor: 0 } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.baseFloor).toBe(0.15);
  });

  it("small model with explicit non-zero baseFloor=0.5 returns baseFloor=0.5 (explicit non-zero wins)", () => {
    const config = { rag: { baseFloor: 0.5 } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.baseFloor).toBe(0.5);
  });

  it("SMALL_NANO_DEFAULT_BASE_FLOOR=0.15 drops the poison fixture base=0.12 (0.15 > 0.12)", () => {
    // Documentary proof: the resolved floor for a small model with no config is 0.15.
    // The poison fixture has base=0.12 (see memory-recall-floor.test.ts CASE A).
    // resolvedFloor=0.15 > 0.12 (poison fixture base score)
    // → passesBaseFloor gate in memory-recall.ts drops it.
    // We prove the constant relationship here — the downstream gate is tested in memory-recall-floor.test.ts.
    const config = { rag: { baseFloor: 0 } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    // resolvedFloor=0.15 > 0.12 (poison fixture base) → passesBaseFloor gate drops it
    expect(result.baseFloor).toBeGreaterThan(0.12);
  });
});

// ---------------------------------------------------------------------------
// Verification cost-gate
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — verification cost-gate", () => {
  it("small model with no criticContext returns verificationEnabled=false (no cost-gate check)", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig, undefined);
    expect(result.verificationEnabled).toBe(false);
  });

  it("small + keyless + distinct cheap critic model explicitly configured → verificationEnabled=true", () => {
    // agentModel=qwen3.6:27b (primary), criticModel=qwen3.6:1.5b (cheap distinct)
    // provider=ollama (keyless) → resolveOperationModel returns source="explicit_config",
    // modelId="qwen3.6:1.5b" !== agentModel "qwen3.6:27b" → cost-gate ON
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig, criticContextWithDistinctCheapModel);
    expect(result.verificationEnabled).toBe(true);
  });

  it("small model with explicit verification.enabled=false + cheap critic → verificationEnabled=false (explicit false wins)", () => {
    const config = { verification: { enabled: false } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config, criticContextWithDistinctCheapModel);
    expect(result.verificationEnabled).toBe(false);
  });

  it("frontier model with cheap critic configured → verificationEnabled=false (frontier → cost-gate branch unreachable)", () => {
    // Frontier: isSmallNano=false → the cost-gate defaults to false regardless of criticContext
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig, criticContextWithDistinctCheapModel);
    expect(result.verificationEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The cost-gate must expose the DISTINCT CHEAP critic model the
// critic actually runs on — NOT the agent's primary. The cost-gate's defining
// guarantee ("never silently doubles local-CPU latency") is false if the critic
// auto-enables on a cheap model's existence but then runs the primary. This is
// the regression the gate-decision tests above cannot catch:
// they only assert the on/off decision, never the model identity.
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — resolved critic model", () => {
  it("exposes the distinct cheap critic model the critic runs on (qwen3.6:1.5b), not the primary (qwen3.6:27b)", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig, criticContextWithDistinctCheapModel);
    expect(result.verificationEnabled).toBe(true);
    // The critic MUST run on the resolved distinct cheap model — not config.model (the primary).
    expect(result.criticModel).toEqual({ provider: "ollama", modelId: "qwen3.6:1.5b" });
    expect(result.criticModel?.modelId).not.toBe(criticContextWithDistinctCheapModel.agentModel);
  });

  it("criticModel is undefined when verification is off (no criticContext)", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig, undefined);
    expect(result.verificationEnabled).toBe(false);
    expect(result.criticModel).toBeUndefined();
  });

  it("criticModel is undefined when explicit verification.enabled=false force-off (even with a cheap critic configured)", () => {
    const config = { verification: { enabled: false } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config, criticContextWithDistinctCheapModel);
    expect(result.verificationEnabled).toBe(false);
    expect(result.criticModel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-regression — frontier/mid all-OFF (scaffold defaults never touch large tiers)
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — frontier/mid all-OFF non-regression", () => {
  it("frontier model with no config returns all-OFF (goalAnchorEnabled=false, baseFloor=0, verificationEnabled=false)", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(false);
    expect(result.baseFloor).toBe(0);
    expect(result.verificationEnabled).toBe(false);
  });

  it("mid model with no config returns all-OFF (goalAnchorEnabled=false, baseFloor=0, verificationEnabled=false)", () => {
    const result = resolveScaffoldDefaults(midProfile, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(false);
    expect(result.baseFloor).toBe(0);
    expect(result.verificationEnabled).toBe(false);
  });

  it("capabilityClassOverride=frontier on ollama model → goalAnchorEnabled=false (same all-OFF result via the override path)", () => {
    // Proves that the override path (not just provider heuristic) also yields all-OFF for frontier.
    const frontierViaOverride = resolveModelProfile(BASE_OLLAMA_INPUT, "frontier");
    const result = resolveScaffoldDefaults(frontierViaOverride, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bootstrapMaxChars capability default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — bootstrapMaxChars capability default", () => {
  it("small model with default bootstrap config (20_000 sentinel) returns bootstrapMaxChars=3_500", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(3_500);
  });
  it("nano model with default bootstrap config returns bootstrapMaxChars=3_500", () => {
    const result = resolveScaffoldDefaults(nanoProfile, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(3_500);
  });
  it("small model with explicit maxChars=5000 overrides capability default", () => {
    const config = { bootstrap: { maxChars: 5_000, promptMode: "full", groupChatFiltering: true } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.bootstrapMaxChars).toBe(5_000);
  });
  it("small model with explicit maxChars=20000 (sentinel value) — capability default applies, not the explicit 20_000", () => {
    // 20_000 is the schema .default() value — treated as an "unset" sentinel.
    // An operator who genuinely wants 20_000 on a small model must use capabilityClassOverride:"frontier".
    const config = { bootstrap: { maxChars: 20_000, promptMode: "full", groupChatFiltering: true } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.bootstrapMaxChars).toBe(3_500);
  });
});

// ---------------------------------------------------------------------------
// activeToolCeiling capability default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — activeToolCeiling capability default", () => {
  it("small model returns activeToolCeiling=24", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(result.activeToolCeiling).toBe(24);
  });
  it("nano model returns activeToolCeiling=undefined (nano has its own aggressive path — ceiling on top is no-op)", () => {
    const result = resolveScaffoldDefaults(nanoProfile, emptyConfig);
    expect(result.activeToolCeiling).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// frontier/mid capacity byte-identical non-regression
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — frontier/mid capacity byte-identical non-regression", () => {
  it("frontier: bootstrapMaxChars=20_000 with no bootstrap config", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(20_000);
  });
  it("mid: bootstrapMaxChars=20_000 with no bootstrap config", () => {
    const result = resolveScaffoldDefaults(midProfile, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(20_000);
  });
  it("frontier: activeToolCeiling=undefined (no ceiling — large tiers stay uncapped)", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.activeToolCeiling).toBeUndefined();
  });
  it("mid: activeToolCeiling=undefined (no ceiling — large tiers stay uncapped)", () => {
    const result = resolveScaffoldDefaults(midProfile, emptyConfig);
    expect(result.activeToolCeiling).toBeUndefined();
  });
  it("capabilityClassOverride=frontier on ollama model → bootstrapMaxChars=20_000 AND activeToolCeiling=undefined", () => {
    // Mirrors the frontier-via-override case above (capabilityClassOverride pattern)
    const frontierViaOverride = resolveModelProfile(BASE_OLLAMA_INPUT, "frontier");
    const result = resolveScaffoldDefaults(frontierViaOverride, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(20_000);
    expect(result.activeToolCeiling).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// bootstrapTotalMaxChars capability default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — bootstrapTotalMaxChars capability default", () => {
  it("small model returns bootstrapTotalMaxChars=5_000", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(result.bootstrapTotalMaxChars).toBe(5_000);
  });
  it("nano model returns bootstrapTotalMaxChars=5_000", () => {
    const result = resolveScaffoldDefaults(nanoProfile, emptyConfig);
    expect(result.bootstrapTotalMaxChars).toBe(5_000);
  });
  it("frontier model returns bootstrapTotalMaxChars=undefined (no total cap)", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.bootstrapTotalMaxChars).toBeUndefined();
  });
  it("mid model returns bootstrapTotalMaxChars=undefined", () => {
    const result = resolveScaffoldDefaults(midProfile, emptyConfig);
    expect(result.bootstrapTotalMaxChars).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// frontier/mid byte-identical after the small/nano capacity retune (non-regression)
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — frontier/mid byte-identical after the small/nano capacity retune", () => {
  it("frontier: activeToolCeiling=undefined (no ceiling — unchanged by the retune)", () => {
    expect(resolveScaffoldDefaults(frontierProfile, emptyConfig).activeToolCeiling).toBeUndefined();
  });
  it("mid: activeToolCeiling=undefined", () => {
    expect(resolveScaffoldDefaults(midProfile, emptyConfig).activeToolCeiling).toBeUndefined();
  });
  it("frontier: bootstrapMaxChars=20_000 with no total cap (the total cap is small/nano only)", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(20_000);
    expect(result.bootstrapTotalMaxChars).toBeUndefined();
  });
  it("mid: bootstrapMaxChars=20_000 with no total cap", () => {
    const result = resolveScaffoldDefaults(midProfile, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(20_000);
    expect(result.bootstrapTotalMaxChars).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// relevanceFirst resolution + arbiter-scoped baseFloor.
//
// The unified arbiter ranks LTM T3/T4 against history; when it is active
// (relevance-first), an unconfigured baseFloor must be ENFORCED, not silently 0 (a
// fail-open). `relevanceFirst` is the arbiter-active signal threaded to the recall
// gate. It is resolved with the same explicit-??-capability gate shape — NEVER
// re-parsed through a schema (.default() collapses undefined→false and kills the
// ?? gate). The gate axes are ModelProfile.scaffoldLevel==="max" (small/nano) AND
// !supportsPromptCache (a non-caching local model reorders for free; a caching
// model pays a cache-break so it stays recency-first below the fence).
// Frontier/mid stay recency-first → byte-identical baseFloor=0.
// ---------------------------------------------------------------------------
describe("resolveScaffoldDefaults — relevanceFirst (arbiter-active signal)", () => {
  it("small ollama (no prompt-cache) with no relevance config → relevanceFirst=true (capability gate)", () => {
    // BASE_OLLAMA_INPUT has no prompt-cache capability → supportsPromptCache=false →
    // the small/nano capability gate fires.
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(result.relevanceFirst).toBe(true);
  });

  it("nano ollama (no prompt-cache) with no relevance config → relevanceFirst=true", () => {
    const result = resolveScaffoldDefaults(nanoProfile, emptyConfig);
    expect(result.relevanceFirst).toBe(true);
  });

  it("frontier with no relevance config → relevanceFirst=false (recency-first, arbiter off — byte-identical)", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.relevanceFirst).toBe(false);
  });

  it("mid with no relevance config → relevanceFirst=false (recency-first, arbiter off — byte-identical)", () => {
    const result = resolveScaffoldDefaults(midProfile, emptyConfig);
    expect(result.relevanceFirst).toBe(false);
  });

  it("explicit config.contextEngine.relevance.firstByDefault=true wins for frontier (operator opt-in)", () => {
    // The TYPED read of the relevance schema block: explicit true overrides the
    // capability gate's false for a frontier profile. `as PerAgentConfig` (a partial-config
    // cast — the field is a REAL typed member of ContextEngineConfig, so NO `as unknown`
    // bypass is needed; the resolver reads config.contextEngine?.relevance?.firstByDefault directly).
    const config = { contextEngine: { relevance: { firstByDefault: true } } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(frontierProfile, config);
    expect(result.relevanceFirst).toBe(true);
  });

  it("explicit config.contextEngine.relevance.firstByDefault=false wins for small (operator force-off)", () => {
    // Explicit false must be preserved (NOT collapsed by ??) — the load-bearing force-off path.
    const config = { contextEngine: { relevance: { firstByDefault: false } } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.relevanceFirst).toBe(false);
  });

  it("OMITTED firstByDefault on a non-caching small profile still resolves relevanceFirst=true (undefined falls through the ?? gate — no schema re-parse)", () => {
    // The keystone proof: an explicit `relevance: {}` block with firstByDefault
    // OMITTED must leave the field `undefined` so the resolver's `?? (isSmallNano &&
    // !supportsPromptCache)` capability gate FIRES. If the resolver re-parsed the sub-block
    // through its schema, a `.default()` would collapse undefined→false and this would
    // wrongly resolve to false. The schema keeps firstByDefault OPTIONAL with NO
    // .default(), and the resolver reads it via the optional chain — so undefined survives.
    const config = { contextEngine: { relevance: {} } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config); // small + ollama (no cache)
    expect(result.relevanceFirst).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// baseFloor stays arbiter-scoped (the resolver is the contract pin;
// the behavioral fail-open proof lives on the recall path in memory-recall-floor.test.ts).
//
// small/nano relevance-first: an UNCONFIGURED baseFloor (schema-default 0) resolves to the
// class default 0.15 — the floor the arbiter enforces. frontier/mid: unconfigured stays 0
// (byte-identical). Explicit config always wins for every class.
// ---------------------------------------------------------------------------
describe("resolveScaffoldDefaults — baseFloor fail-closed under the arbiter (contract pin)", () => {
  it("small relevance-first + unconfigured baseFloor → 0.15 AND relevanceFirst=true (the load-bearing floor)", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(result.baseFloor).toBe(0.15);
    expect(result.relevanceFirst).toBe(true);
  });

  it("frontier + unconfigured baseFloor → 0 AND relevanceFirst=false (byte-identical, arbiter off)", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.baseFloor).toBe(0);
    expect(result.relevanceFirst).toBe(false);
  });

  it("explicit config.rag.baseFloor=0.3 always wins for every class (regression — explicit > capability > off)", () => {
    const config = { rag: { baseFloor: 0.3 } } as PerAgentConfig;
    expect(resolveScaffoldDefaults(smallProfile, config).baseFloor).toBe(0.3);
    expect(resolveScaffoldDefaults(nanoProfile, config).baseFloor).toBe(0.3);
    expect(resolveScaffoldDefaults(frontierProfile, config).baseFloor).toBe(0.3);
    expect(resolveScaffoldDefaults(midProfile, config).baseFloor).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Cross-file parity: KEYLESS_CRITIC_PROVIDERS in scaffold-defaults.ts must
// equal the exported Set from verification-gate.ts.
//
// scaffold-defaults.ts keeps its own private copy to avoid a circular import;
// verification-gate.ts exports the canonical Set.
// This test fails loudly if either copy drifts.
// ---------------------------------------------------------------------------
describe("KEYLESS_CRITIC_PROVIDERS cross-file parity", () => {
  it("scaffold-defaults.ts KEYLESS_CRITIC_PROVIDERS content matches verification-gate.ts export", () => {
    // The scaffold-defaults copy is private; we test by exercising resolveScaffoldDefaults
    // with known-keyless and known-keyed providers and comparing the gate outcomes
    // against the imported gateProviders Set from verification-gate.ts.
    //
    // For each provider in gateProviders (keyless): cost-gate with distinct cheap critic
    // must yield verificationEnabled=true (cost-gate branch reached + keyless check passes).
    // For a cloud provider NOT in gateProviders: verificationEnabled=false (keyless check fails).
    const keylessProviders = Array.from(gateProviders);
    // Sort for deterministic comparison
    expect(keylessProviders.sort()).toEqual(["lm-studio", "ollama"].sort());

    // Also verify via resolveScaffoldDefaults behavior: each provider in gateProviders
    // must pass the keyless check inside scaffold-defaults (verificationEnabled=true
    // when a distinct cheap critic is configured).
    for (const provider of keylessProviders) {
      const ctx = {
        provider,
        agentModel: "qwen3.6:27b",
        operationModels: {
          verification: { model: `${provider}:qwen3.6:1.5b` },
        } as OperationModels,
      };
      const result = resolveScaffoldDefaults(smallProfile, emptyConfig, ctx);
      expect(result.verificationEnabled).toBe(true);
    }

    // Cloud provider (not in gateProviders): verificationEnabled=false
    const cloudCtx = {
      provider: "anthropic",
      agentModel: "claude-haiku",
      operationModels: {
        verification: { model: "anthropic:claude-haiku-small" },
      } as OperationModels,
    };
    const cloudResult = resolveScaffoldDefaults(smallProfile, emptyConfig, cloudCtx);
    expect(cloudResult.verificationEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveScaffoldDefaults → ceiling → applyToolDeferral E2E chain.
//
// Regression lock for the full chain: the small-class ceiling and compact-prompt
// ARE correctly wired in source — a live incident that showed
// activeToolCount: 83 on a small model traced to a stale dist/, not a code gate.
// This suite pins the chain end-to-end so a real wiring regression cannot hide
// behind that ambiguity again.
//
// (The compact-prompt half — small profile → resolvePromptModeForProfile
// returns 'compact-secure' — is locked by the resolvePromptModeForProfile
// suite in prompt-assembly.test.ts.)
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults→ceiling→applyToolDeferral E2E chain (small + 83 tools)", () => {
  function makeTool(name: string): ToolDefinition {
    return {
      name,
      description: "x".repeat(50),
      parameters: {
        type: "object" as const,
        properties: {
          input: { type: "string" as const, description: "y".repeat(10) },
        },
      },
      execute: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    } as unknown as ToolDefinition;
  }

  it("small profile → resolveScaffoldDefaults returns activeToolCeiling=24 (chain entry lock)", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(result.activeToolCeiling).toBe(24);
  });

  it("small + 83 tools → active ≤ 24 AND pipeline in active set (E2E chain)", () => {
    // Fails if the ceiling defers pipeline: SMALL_CLASS_ORCHESTRATION_TOOLS
    // must exempt pipeline inside the ceiling block.
    //
    // This integrates resolveScaffoldDefaults → applyToolDeferral end-to-end.
    // No other test covers this full chain — this is the regression lock.
    const logger = createMockLogger();
    const defaults = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(defaults.activeToolCeiling).toBe(24); // confirm chain entry

    const coreToolNames = [
      "read", "edit", "write", "grep", "find", "ls", "apply_patch",
      "exec", "process",
      "message",
      "memory_search", "memory_store", "memory_get",
      "web_search", "web_fetch",
    ];
    const tools: ToolDefinition[] = [
      ...coreToolNames.map(n => makeTool(n)),
      makeTool("pipeline"),
      ...Array.from({ length: 67 }, (_, i) => makeTool(`cold_tool_${i}`)),
    ];
    expect(tools.length).toBe(83);

    const ctx: DeferralContext = {
      trustLevel: "admin",
      channelType: undefined,
      capabilityClass: "small",
      recentlyUsedToolNames: new Set(),
      toolNames: tools.map(t => t.name),
      discoveryTracker: createDiscoveryTracker(),
      providerFamily: "anthropic",
      activeToolCeiling: defaults.activeToolCeiling, // = 24 from resolveScaffoldDefaults
    };

    const result = applyToolDeferral(tools, 128_000, ctx, logger);

    // Ceiling holds — exact pin: 15 CORE + 1 pipeline + 8 cold = 24
    // (83 total − 59 deferred cold tools = 24 active; deterministic — same fixture every run)
    expect(result.activeTools.length).toBe(24);
    // KEY ASSERTION: pipeline must be in the active set for small
    expect(result.activeTools.map(t => t.name)).toContain("pipeline");
  });
});

// ---------------------------------------------------------------------------
// maxToolResultChars capability-gated default
//
// A single tool result defaults to up to 50_000 chars (~12.5K tokens). On a
// small model (32K window) two such results exhaust the context — the live NVDA
// analysts hit context_exhausted at assembled ~33-35K because web_search/read
// results were 20-35K chars each. Cap them for small/nano; frontier/mid unchanged.
// ---------------------------------------------------------------------------
describe("resolveScaffoldDefaults — maxToolResultChars capability default", () => {
  it("small + unset → 12_000 char cap", () => {
    expect(resolveScaffoldDefaults(smallProfile, emptyConfig).maxToolResultChars).toBe(12_000);
  });

  it("nano + unset → 8_000 char cap (tighter for the 16K window)", () => {
    expect(resolveScaffoldDefaults(nanoProfile, emptyConfig).maxToolResultChars).toBe(8_000);
  });

  it("frontier + unset → undefined (consumer uses config 50_000, byte-identical)", () => {
    expect(resolveScaffoldDefaults(frontierProfile, emptyConfig).maxToolResultChars).toBeUndefined();
  });

  it("mid + unset → undefined", () => {
    expect(resolveScaffoldDefaults(midProfile, emptyConfig).maxToolResultChars).toBeUndefined();
  });

  it("small + explicit operator override → undefined (operator value wins via config fallback)", () => {
    const config = { maxToolResultChars: 30_000 } as PerAgentConfig;
    expect(resolveScaffoldDefaults(smallProfile, config).maxToolResultChars).toBeUndefined();
  });

  it("small + explicit 50_000 (the schema-default sentinel) → still capped (12_000)", () => {
    // 50_000 is BOTH the schema default and an explicit value — like the bootstrap
    // 20_000 sentinel, a small model still receives the capability cap. Operators force
    // the full value via capabilityClassOverride:"frontier".
    const config = { maxToolResultChars: 50_000 } as PerAgentConfig;
    expect(resolveScaffoldDefaults(smallProfile, config).maxToolResultChars).toBe(12_000);
  });
});
