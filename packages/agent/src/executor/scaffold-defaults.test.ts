// SPDX-License-Identifier: Apache-2.0
/**
 * SD1/SD2/SD3/SD5 truth table for resolveScaffoldDefaults().
 *
 * RED state: scaffold-defaults.ts does not exist yet — all tests fail with
 * "Cannot find module './scaffold-defaults.js'" until Task 2 creates the
 * implementation. This failing state is committed intentionally per
 * CLAUDE.md Tests-First.
 *
 * Invariants tested:
 *  - SD1: GoalAnchor capability default ON for small/nano; explicit config wins both ways
 *  - SD2: rag.baseFloor capability default 0.15 for small/nano; explicit non-zero wins;
 *         0.15>0.12 poison evidence (Phase-153 fixture)
 *  - SD3: Verification cost-gate OFF unless distinct cheap critic explicitly configured + keyless
 *  - SD5: frontier/mid always return all-OFF regardless of capability class (byte-identical
 *         non-regression — pre-Phase-158 behavior preserved for frontier/mid)
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
// provider heuristics (per SD5 test structure from model-profile.test.ts L163-191).
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

// criticContext for SD3 tests: ollama keyless, distinct cheap critic model
const criticContextWithDistinctCheapModel = {
  provider: "ollama",
  agentModel: "qwen3.6:27b",
  operationModels: {
    verification: { model: "ollama:qwen3.6:1.5b" },
  } as OperationModels,
};

// ---------------------------------------------------------------------------
// SD1: GoalAnchor capability-gated default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — SD1: GoalAnchor capability default", () => {
  it("Test 1: small model with no goalAnchor config returns goalAnchorEnabled=true (capability default ON)", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(true);
  });

  it("Test 2: nano model with no goalAnchor config returns goalAnchorEnabled=true (capability default ON)", () => {
    const result = resolveScaffoldDefaults(nanoProfile, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(true);
  });

  it("Test 3: small model with explicit goalAnchor.enabled=false returns goalAnchorEnabled=false (explicit false wins)", () => {
    const config = { goalAnchor: { enabled: false } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.goalAnchorEnabled).toBe(false);
  });

  it("Test 4: frontier model with explicit goalAnchor.enabled=true returns goalAnchorEnabled=true (explicit true on frontier wins)", () => {
    const config = { goalAnchor: { enabled: true } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(frontierProfile, config);
    expect(result.goalAnchorEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SD2: rag.baseFloor capability-gated default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — SD2: rag.baseFloor capability default", () => {
  it("Test 5: small model with baseFloor=0 (schema default) returns baseFloor=0.15 (SMALL_NANO_DEFAULT_BASE_FLOOR)", () => {
    const config = { rag: { baseFloor: 0 } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.baseFloor).toBe(0.15);
  });

  it("Test 6: small model with explicit non-zero baseFloor=0.5 returns baseFloor=0.5 (explicit non-zero wins)", () => {
    const config = { rag: { baseFloor: 0.5 } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.baseFloor).toBe(0.5);
  });

  it("Test 7: SMALL_NANO_DEFAULT_BASE_FLOOR=0.15 drops Phase-153 poison fixture base=0.12 (0.15 > 0.12)", () => {
    // Documentary proof: the resolved floor for a small model with no config is 0.15.
    // The Phase-153 R3 poison fixture had base=0.12 (see memory-recall-floor.test.ts CASE A).
    // resolvedFloor=0.15 > 0.12 (Phase-153 poison fixture base score)
    // → passesBaseFloor gate in memory-recall.ts drops it.
    // We prove the constant relationship here — the downstream gate is tested in memory-recall-floor.test.ts.
    const config = { rag: { baseFloor: 0 } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    // resolvedFloor=0.15 > 0.12 (Phase-153 poison fixture base) → passesBaseFloor gate drops it
    expect(result.baseFloor).toBeGreaterThan(0.12);
  });
});

// ---------------------------------------------------------------------------
// SD3: Verification cost-gate
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — SD3: verification cost-gate", () => {
  it("Test 8: small model with no criticContext returns verificationEnabled=false (no cost-gate check)", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig, undefined);
    expect(result.verificationEnabled).toBe(false);
  });

  it("Test 9: small + keyless + distinct cheap critic model explicitly configured → verificationEnabled=true", () => {
    // agentModel=qwen3.6:27b (primary), criticModel=qwen3.6:1.5b (cheap distinct)
    // provider=ollama (keyless) → resolveOperationModel returns source="explicit_config",
    // modelId="qwen3.6:1.5b" !== agentModel "qwen3.6:27b" → cost-gate ON
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig, criticContextWithDistinctCheapModel);
    expect(result.verificationEnabled).toBe(true);
  });

  it("Test 10: small model with explicit verification.enabled=false + cheap critic → verificationEnabled=false (explicit false wins)", () => {
    const config = { verification: { enabled: false } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config, criticContextWithDistinctCheapModel);
    expect(result.verificationEnabled).toBe(false);
  });

  it("Test 11: frontier model with cheap critic configured → verificationEnabled=false (frontier → cost-gate branch unreachable)", () => {
    // Frontier: isSmallNano=false → SD3 defaults to false regardless of criticContext
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig, criticContextWithDistinctCheapModel);
    expect(result.verificationEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SD3 / WR-01: the cost-gate must expose the DISTINCT CHEAP critic model the
// critic actually runs on — NOT the agent's primary. The cost-gate's defining
// guarantee ("never silently doubles local-CPU latency") is false if the critic
// auto-enables on a cheap model's existence but then runs the primary. This is
// the regression the SD3 gate-decision tests above could not catch (code review
// WR-03): they only asserted the on/off decision, never the model identity.
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — SD3/WR-01: resolved critic model", () => {
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
// SD5: Non-regression — frontier/mid byte-identical to pre-Phase-158
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — SD5: frontier/mid byte-identical non-regression", () => {
  it("Test 12: frontier model with no config returns all-OFF (goalAnchorEnabled=false, baseFloor=0, verificationEnabled=false)", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(false);
    expect(result.baseFloor).toBe(0);
    expect(result.verificationEnabled).toBe(false);
  });

  it("Test 13: mid model with no config returns all-OFF (goalAnchorEnabled=false, baseFloor=0, verificationEnabled=false)", () => {
    const result = resolveScaffoldDefaults(midProfile, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(false);
    expect(result.baseFloor).toBe(0);
    expect(result.verificationEnabled).toBe(false);
  });

  it("Test 14: capabilityClassOverride=frontier on ollama model → goalAnchorEnabled=false (same as Test 12 via override)", () => {
    // Proves that the override path (not just provider heuristic) also yields all-OFF for frontier.
    const frontierViaOverride = resolveModelProfile(BASE_OLLAMA_INPUT, "frontier");
    const result = resolveScaffoldDefaults(frontierViaOverride, emptyConfig);
    expect(result.goalAnchorEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SD6: bootstrapMaxChars capability default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — SD6: bootstrapMaxChars capability default", () => {
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
    // 20_000 is the schema .default() value — treated as "unset" sentinel.
    // An operator who genuinely wants 20_000 on a small model must use capabilityClassOverride:"frontier".
    const config = { bootstrap: { maxChars: 20_000, promptMode: "full", groupChatFiltering: true } } as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.bootstrapMaxChars).toBe(3_500);
  });
});

// ---------------------------------------------------------------------------
// SD7: activeToolCeiling capability default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — SD7: activeToolCeiling capability default", () => {
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
// SD8: frontier/mid capacity byte-identical non-regression
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — SD8: frontier/mid capacity byte-identical non-regression", () => {
  it("frontier: bootstrapMaxChars=20_000 with no bootstrap config", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(20_000);
  });
  it("mid: bootstrapMaxChars=20_000 with no bootstrap config", () => {
    const result = resolveScaffoldDefaults(midProfile, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(20_000);
  });
  it("frontier: activeToolCeiling=undefined (no ceiling — byte-identical to v2.14)", () => {
    const result = resolveScaffoldDefaults(frontierProfile, emptyConfig);
    expect(result.activeToolCeiling).toBeUndefined();
  });
  it("mid: activeToolCeiling=undefined (no ceiling — byte-identical to v2.14)", () => {
    const result = resolveScaffoldDefaults(midProfile, emptyConfig);
    expect(result.activeToolCeiling).toBeUndefined();
  });
  it("capabilityClassOverride=frontier on ollama model → bootstrapMaxChars=20_000 AND activeToolCeiling=undefined", () => {
    // Mirrors SD5 Test 14 (capabilityClassOverride pattern)
    const frontierViaOverride = resolveModelProfile(BASE_OLLAMA_INPUT, "frontier");
    const result = resolveScaffoldDefaults(frontierViaOverride, emptyConfig);
    expect(result.bootstrapMaxChars).toBe(20_000);
    expect(result.activeToolCeiling).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SD9: bootstrapTotalMaxChars capability default
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — SD9: bootstrapTotalMaxChars capability default", () => {
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
// F5: frontier/mid byte-identical after F1+F2 retune (non-regression)
// ---------------------------------------------------------------------------

describe("resolveScaffoldDefaults — F5: frontier/mid byte-identical after F1+F2 retune", () => {
  it("frontier: activeToolCeiling=undefined (no ceiling — unchanged by F1 retune)", () => {
    expect(resolveScaffoldDefaults(frontierProfile, emptyConfig).activeToolCeiling).toBeUndefined();
  });
  it("mid: activeToolCeiling=undefined", () => {
    expect(resolveScaffoldDefaults(midProfile, emptyConfig).activeToolCeiling).toBeUndefined();
  });
  it("frontier: bootstrapMaxChars=20_000 with no total cap (F2 total cap is small/nano only)", () => {
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
// RETR-04 / WR-02 (Phase 173): relevanceFirst resolution + arbiter-scoped baseFloor.
//
// The unified arbiter (Plan 03) ranks LTM T3/T4 against history; when it is active
// (relevance-first), an unconfigured baseFloor must be ENFORCED, not silently 0 (the
// WR-02 fail-open). `relevanceFirst` is the arbiter-active signal threaded to the recall
// gate. It is resolved with the SD1 capability-gate shape — NEVER re-parsed through a
// schema (Pitfall 1: .default() collapses undefined→false and kills the ?? gate). The
// gate axes are ModelProfile.scaffoldLevel==="max" (small/nano) AND !supportsPromptCache
// (design §14.1, line 144 — a non-caching local model reorders for free; a caching model
// pays a cache-break so it stays recency-first below the fence). Frontier/mid stay
// recency-first → byte-identical baseFloor=0 (LOCKED #2).
// ---------------------------------------------------------------------------
describe("resolveScaffoldDefaults — RETR-04: relevanceFirst (arbiter-active signal)", () => {
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
    // The optional-chain read of the (Plan-03) schema block: explicit true overrides the
    // capability gate's false for a frontier profile. Cast because the schema block does not
    // exist on PerAgentConfig yet (Plan 03 adds it); the resolver reads it defensively.
    const config = { contextEngine: { relevance: { firstByDefault: true } } } as unknown as PerAgentConfig;
    const result = resolveScaffoldDefaults(frontierProfile, config);
    expect(result.relevanceFirst).toBe(true);
  });

  it("explicit config.contextEngine.relevance.firstByDefault=false wins for small (operator force-off)", () => {
    // Explicit false must be preserved (NOT collapsed by ??) — the load-bearing force-off path.
    const config = { contextEngine: { relevance: { firstByDefault: false } } } as unknown as PerAgentConfig;
    const result = resolveScaffoldDefaults(smallProfile, config);
    expect(result.relevanceFirst).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RETR-04 / WR-02: baseFloor stays arbiter-scoped (the resolver is the contract pin;
// the behavioral fail-open proof lives on the recall path in memory-recall-floor.test.ts).
//
// small/nano relevance-first: an UNCONFIGURED baseFloor (schema-default 0) resolves to the
// class default 0.15 — the floor the arbiter enforces. frontier/mid: unconfigured stays 0
// (byte-identical). Explicit config always wins for every class.
// ---------------------------------------------------------------------------
describe("resolveScaffoldDefaults — RETR-04: baseFloor fail-closed under the arbiter (contract pin)", () => {
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
// equal the exported Set from verification-gate.ts (Plan 02 assertion, deferred
// from Plan 01).
//
// scaffold-defaults.ts keeps its own private copy to avoid a circular import;
// verification-gate.ts now exports the canonical Set (Phase 158, Plan 02).
// This test fails loudly if either copy drifts.
// ---------------------------------------------------------------------------
describe("KEYLESS_CRITIC_PROVIDERS cross-file parity (Plan 02)", () => {
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
// CWF-04: resolveScaffoldDefaults → ceiling → applyToolDeferral E2E chain
//
// Phase-0 static determination (2026-06-09): WIRING-OK — the ceiling and compact-prompt
// ARE correctly wired in current source (post-Phase 165). The live incident's
// activeToolCount: 83 was stale-dist, not a code gate. Phase 168 scope = regression
// test (this file) + orchestration-reachability change (tool-deferral.ts).
// No tool-path threading fix needed.
//
// CWF-04-E (compact-prompt binding): small profile → resolvePromptModeForProfile
// returns 'compact-secure'. This is locked by the existing WR-03 suite at
// prompt-assembly.test.ts:2159. Confirm it stays GREEN after the GREEN commit.
// ---------------------------------------------------------------------------

describe("CWF-04: resolveScaffoldDefaults→ceiling→applyToolDeferral E2E chain (small + 83 tools)", () => {
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

  it("CWF-04-A: small profile → resolveScaffoldDefaults returns activeToolCeiling=24 (chain entry lock)", () => {
    const result = resolveScaffoldDefaults(smallProfile, emptyConfig);
    expect(result.activeToolCeiling).toBe(24);
  });

  it("CWF-04: small + 83 tools → active ≤ 24 AND pipeline in active set (E2E chain — RED: pipeline deferred today)", () => {
    // RED test: fails today because pipeline is currently deferred by the ceiling.
    // GREEN: SMALL_CLASS_ORCHESTRATION_TOOLS exempts pipeline inside the ceiling block.
    //
    // This integrates resolveScaffoldDefaults → applyToolDeferral end-to-end.
    // No existing test covers this full chain — this is the regression lock.
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
    // KEY ASSERTION (RED → GREEN): pipeline must be in the active set for small
    expect(result.activeTools.map(t => t.name)).toContain("pipeline");
  });
});

// ---------------------------------------------------------------------------
// SD (v2.19): maxToolResultChars capability-gated default
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
    // 50_000 is BOTH the schema default and an explicit value — like the SD6 20_000
    // sentinel, a small model still receives the capability cap. Operators force the
    // full value via capabilityClassOverride:"frontier".
    const config = { maxToolResultChars: 50_000 } as PerAgentConfig;
    expect(resolveScaffoldDefaults(smallProfile, config).maxToolResultChars).toBe(12_000);
  });
});
