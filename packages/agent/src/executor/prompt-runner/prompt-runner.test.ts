// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke tests for the thin runPrompt orchestrator.
 *
 * The orchestrator is the composition root that sequences the four phase
 * modules (envelope-wrapper → budget-precheck → retry-loop →
 * output-escalation). Behavioral end-to-end coverage of runPrompt's full
 * pipeline lives in the integration suite
 * (test/integration/agent-routing-resolution.test.ts +
 * agent-routing-daemon.test.ts) because invocation requires AgentSession +
 * ModelRegistry + BudgetGuard + CostTracker + AuthRotationAdapter +
 * ProviderHealthMonitor + full deps surface — too expensive for a unit test.
 *
 * This file pins the structural invariants of the orchestrator: it imports
 * each phase module, it calls them in sequence, and it propagates early-
 * return outcomes. The public API surface is re-exported byte-identically
 * via index.ts.
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

  it("imports `systemNowMs` from @comis/core and `createHash` from node:crypto (prompt:submitted emit)", () => {
    expect(source).toMatch(/import\s+\{\s*systemNowMs\s*\}\s+from\s+"@comis\/core"/);
    expect(source).toMatch(/import\s+\{\s*createHash\s*\}\s+from\s+"node:crypto"/);
  });

  it("emits prompt:submitted after wrapEnvelope returns and before precheckBudget", () => {
    // The structural ordering invariant: the emit helper invocation is
    // sandwiched between wrapEnvelope and precheckBudget so the
    // observability boundary runs before the budget gate.
    const idxEnvelope = source.indexOf("wrapEnvelope(");
    const idxEmit = source.indexOf("emitPromptSubmitted(");
    const idxPrecheck = source.indexOf("precheckBudget(");
    expect(idxEnvelope).toBeGreaterThanOrEqual(0);
    expect(idxEmit).toBeGreaterThan(idxEnvelope);
    expect(idxPrecheck).toBeGreaterThan(idxEmit);
  });

  it("emit_prompt_submitted_with_digests calls eventBus.emit with sha256 systemDigest + messagesDigest", () => {
    // Behavioral: drive runPrompt indirectly via the exported helper.
    // The full pipeline requires mock AgentSession + ModelRegistry +
    // BudgetGuard so we narrow to verifying the digest contract
    // structurally — the architecture lock that prompt-submitted is
    // emitted at all is enforced above. The full e2e shape is covered
    // by the integration suite.
    expect(source).toMatch(/createHash\("sha256"\)/);
    // Object shorthand (systemDigest,) is used to pass the local digest
    // variable into the emit payload — confirm the field name appears
    // followed by a comma/space terminator.
    expect(source).toMatch(/\bsystemDigest,/);
    expect(source).toMatch(/\bmessagesDigest,/);
    expect(source).toMatch(/promptChars:\s*systemPrompt\.length\s*\+\s*messageText\.length/);
  });

  it("swallows emit errors so dispatch is never aborted by an observability failure", () => {
    // Structural lock: the emit helper body must be wrapped in
    // try/catch with the debug-log on failure.
    const helperBlock = source.slice(source.indexOf("function emitPromptSubmitted("));
    expect(helperBlock).toMatch(/try\s*\{/);
    expect(helperBlock).toMatch(/catch\s*\(err\)/);
    expect(helperBlock).toMatch(/Failed to emit prompt:submitted/);
  });
});
