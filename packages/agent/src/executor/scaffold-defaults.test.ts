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

import { describe, it, expect } from "vitest";
import { resolveScaffoldDefaults } from "./scaffold-defaults.js";
import { resolveModelProfile } from "./model-profile.js";
import type { PerAgentConfig, OperationModels } from "@comis/core";

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
