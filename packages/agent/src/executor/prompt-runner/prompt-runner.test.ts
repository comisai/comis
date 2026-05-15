// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke tests for the thin runPrompt orchestrator.
 *
 * Phase 42 EXEC-SPLIT-07: the orchestrator is the composition root that
 * sequences the four phase modules (envelope-wrapper → budget-precheck →
 * retry-loop → output-escalation). Behavioral end-to-end coverage of
 * runPrompt's full pipeline lives in the integration suite
 * (test/integration/agent-routing-resolution.test.ts +
 * agent-routing-daemon.test.ts) because the dependency-construction cost
 * for a unit test exceeds the value of a unit-level assertion (RESEARCH
 * §"Pattern 1": invocation requires AgentSession + ModelRegistry +
 * BudgetGuard + CostTracker + AuthRotationAdapter + ProviderHealthMonitor +
 * full deps surface — too expensive for a unit test).
 *
 * This file pins the structural invariants of the orchestrator: it imports
 * each phase module, it calls them in sequence, and it propagates early-
 * return outcomes. The byte-identity parity gate
 * (executor-prompt-runner.parity.test.ts) is the public-API contract.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runPrompt } from "./prompt-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "prompt-runner.ts");
const source = readFileSync(sourcePath, "utf-8");

describe("prompt-runner.ts — orchestrator structure", () => {
  it("exports an async function `runPrompt`", () => {
    expect(typeof runPrompt).toBe("function");
    expect(runPrompt.name).toBe("runPrompt");
    expect(runPrompt.length).toBe(1); // destructured params object → arity 1
  });

  it("imports from each of the four phase modules", () => {
    expect(source).toMatch(/from\s+"\.\/envelope-wrapper\.js"/);
    expect(source).toMatch(/from\s+"\.\/budget-precheck\.js"/);
    expect(source).toMatch(/from\s+"\.\/retry-loop\.js"/);
    expect(source).toMatch(/from\s+"\.\/output-escalation\.js"/);
  });

  it("calls wrapEnvelope before precheckBudget before runRetryLoop before escalateOutput", () => {
    const idxEnvelope = source.indexOf("wrapEnvelope(");
    const idxPrecheck = source.indexOf("precheckBudget(");
    const idxRetry = source.indexOf("runRetryLoop(");
    const idxEscalate = source.indexOf("escalateOutput(");
    expect(idxEnvelope).toBeGreaterThanOrEqual(0);
    expect(idxPrecheck).toBeGreaterThan(idxEnvelope);
    expect(idxRetry).toBeGreaterThan(idxPrecheck);
    expect(idxEscalate).toBeGreaterThan(idxRetry);
  });

  it("propagates the budget-precheck rejection result without proceeding to retry-loop", () => {
    // Structural lock: the body must contain an `if (precheck.kind === "rejected") return ...`
    // shape between the precheckBudget call and the runRetryLoop call.
    const precheckIdx = source.indexOf("precheckBudget(");
    const retryIdx = source.indexOf("runRetryLoop(");
    const between = source.slice(precheckIdx, retryIdx);
    expect(between).toMatch(/precheck\.kind === "rejected"/);
    expect(between).toMatch(/return precheck\.result/);
  });

  it("propagates the stuck-session retry outcome without proceeding to escalateOutput", () => {
    // Mirror invariant: stuck-session branch returns stuckSessionResult() before escalateOutput.
    const retryIdx = source.indexOf("runRetryLoop(");
    const escalateIdx = source.indexOf("escalateOutput(");
    const between = source.slice(retryIdx, escalateIdx);
    expect(between).toMatch(/retry\.stuckSessionDetected/);
    expect(between).toMatch(/stuckSessionResult\(\)/);
  });

  it("stays at or below the 250L design cap (orchestrator size budget)", () => {
    const lineCount = source.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(250);
  });
});
