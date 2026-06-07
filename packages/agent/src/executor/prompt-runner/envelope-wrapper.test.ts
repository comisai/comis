// SPDX-License-Identifier: Apache-2.0
/**
 * Source-grep regression tests for envelope-wrapper.ts.
 *
 * Pins the dynamic-preamble assembly shape (array-concat with filter(Boolean))
 * + the Pino debug-log canonical fields + the submodule binding label.
 * Behavioral verification of the rendered output lives in the renderer unit
 * test (capability-index-context.test.ts) and integration tests.
 *
 * R1 GoalAnchor tail-injection behavioral tests: verify that wrapEnvelope
 * appends the GoalAnchor block AFTER message text for scaffoldLevel=max,
 * and omits it for frontier/mid or when disabled.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { wrapEnvelope } from "./envelope-wrapper.js";
import type { RunPromptParams } from "./prompt-runner-types.js";
import type { ModelProfile } from "../../executor/model-profile.js";
import type { ExecutionPlan } from "../../planner/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "envelope-wrapper.ts");
const source = readFileSync(sourcePath, "utf-8");

describe("envelope-wrapper.ts — capability-index threading", () => {
  it("dynamic preamble uses array-concat [dynamicPreamble, capabilityIndexContext, deferredContext].filter(Boolean)", () => {
    // Source-grep: structural lock on the array-concat shape. Behavioral
    // verification of the rendered output lives in the renderer unit test
    // (capability-index-context.test.ts) and integration tests.
    expect(source).toMatch(
      /\[\s*dynamicPreamble\s*,\s*capabilityIndexContext\s*,\s*deferredContext\s*\]\s*\.\s*filter\s*\(\s*Boolean\s*\)/,
    );
  });

  it("Pino debug log emits the seven canonical fields with submodule label and message", () => {
    // Each canonical field appears literally in the log object.
    expect(source).toMatch(/capabilityIndexTokens/);
    expect(source).toMatch(/deferredContextTokens/);
    expect(source).toMatch(/fullPreambleTokens/);
    expect(source).toMatch(/clusterCount/);
    expect(source).toMatch(/activeToolCount/);
    expect(source).toMatch(/deferredToolCount/);
    expect(source).toMatch(/promptSkillCount/);
    // Message text matches expected placement verbatim.
    expect(source).toMatch(/"Dynamic preamble assembled"/);
  });

  it("submodule binding label is exactly 'executor.capability-index'", () => {
    // Submodule binding via deps.logger.child({ submodule: "..." }).
    expect(source).toMatch(/submodule\s*:\s*["']executor\.capability-index["']/);
  });
});

// ---------------------------------------------------------------------------
// R1 GoalAnchor tail-injection behavioral tests
// ---------------------------------------------------------------------------

/** Minimal stub logger */
function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

/** Build a minimal RunPromptParams for wrapEnvelope tests. */
function makeParams(overrides: {
  scaffoldLevel?: ModelProfile["scaffoldLevel"];
  goalAnchorEnabled?: boolean;
  planActive?: boolean;
  planRequest?: string;
  planSteps?: ExecutionPlan["steps"];
  msgText?: string;
}): RunPromptParams {
  const {
    scaffoldLevel = "max",
    goalAnchorEnabled = true,
    planActive = true,
    planRequest = "Test the feature end to end",
    planSteps = [{ index: 1, description: "Run the suite", status: "pending" as const }],
    msgText = "Please do the thing",
  } = overrides;

  const plan: ExecutionPlan | undefined = planActive !== undefined
    ? {
        active: planActive,
        request: planRequest,
        steps: planSteps,
        completedCount: 0,
        createdAtMs: 1000,
      }
    : undefined;

  const modelProfile: ModelProfile = {
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    capabilityClass: scaffoldLevel === "max" ? "small" : scaffoldLevel === "standard" ? "mid" : "frontier",
    scaffoldLevel,
    securityLevel: scaffoldLevel === "max" ? "locked" : "standard",
    supportsVision: false,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
    reasoningStyle: "none",
  };

  return {
    msg: {
      text: msgText,
      metadata: {},
    } as RunPromptParams["msg"],
    session: {} as RunPromptParams["session"],
    config: {
      goalAnchor: goalAnchorEnabled
        ? { enabled: true }
        : { enabled: false },
    } as RunPromptParams["config"],
    sessionKey: "agent:discord:chan" as unknown as RunPromptParams["sessionKey"],
    formattedKey: "agent:discord:chan",
    agentId: "agent",
    result: {} as RunPromptParams["result"],
    executionOverrides: undefined,
    executionStartMs: 0,
    effectiveTimeout: { promptTimeoutMs: 30000, retryPromptTimeoutMs: 30000 },
    executionId: "exec-1",
    bridge: { getResult: () => ({}) } as RunPromptParams["bridge"],
    dynamicPreamble: undefined,
    deferredContext: undefined,
    capabilityIndexResult: { text: "", capabilityIndexTokens: 0, clusterCount: 0, activeToolCount: 0, deferredToolCount: 0, promptSkillCount: 0 },
    inlineMemory: undefined,
    systemPrompt: undefined,
    mergedCustomTools: [],
    cmdResult: { hasCommandDirective: false },
    sepEnabled: true,
    executionPlanRef: { current: plan },
    _directives: undefined,
    _prevTimestamp: undefined,
    resolvedModel: undefined,
    modelProfile,
    deps: {
      eventBus: { emit: vi.fn() } as unknown as RunPromptParams["deps"]["eventBus"],
      logger: makeLogger() as unknown as RunPromptParams["deps"]["logger"],
      budgetGuard: { getSnapshot: () => ({ perExecution: 0 }), checkBudget: () => ({ ok: true }) } as unknown as RunPromptParams["deps"]["budgetGuard"],
      costTracker: {} as RunPromptParams["deps"]["costTracker"],
      modelRegistry: {} as RunPromptParams["deps"]["modelRegistry"],
      clock: { nowMs: () => 0, nowMonotonicMs: () => 0 } as unknown as RunPromptParams["deps"]["clock"],
      timers: {} as RunPromptParams["deps"]["timers"],
    },
    onResetTimer: vi.fn(),
  };
}

describe("R1: GoalAnchor tail injection via wrapEnvelope", () => {
  it("R1: scaffoldLevel=max with active plan → goalAnchor appears at END of message", () => {
    const params = makeParams({
      scaffoldLevel: "max",
      goalAnchorEnabled: true,
      planActive: true,
      planRequest: "Build the feature",
      planSteps: [{ index: 1, description: "Write tests", status: "pending" }],
      msgText: "Do the thing",
    });
    const result = wrapEnvelope(params);
    // The GoalAnchor block must appear at the END (tail position), not the beginning
    expect(result.messageText).toContain("[GoalAnchor: Build the feature]");
    expect(result.messageText).toContain("Write tests");
    // Tail position: message text ends with the anchor block (or contains it after user text)
    const anchorIdx = result.messageText.lastIndexOf("[GoalAnchor:");
    const msgIdx = result.messageText.indexOf("Do the thing");
    expect(anchorIdx).toBeGreaterThan(msgIdx);
  });

  it("R1: scaffoldLevel=light (frontier) → no goalAnchor in output", () => {
    const params = makeParams({
      scaffoldLevel: "light",
      goalAnchorEnabled: true,
      planActive: true,
      planRequest: "Build the feature",
      msgText: "Do the thing",
    });
    const result = wrapEnvelope(params);
    expect(result.messageText).not.toContain("[GoalAnchor:");
  });

  it("R1: goalAnchor.enabled=false → no goalAnchor even for small model", () => {
    const params = makeParams({
      scaffoldLevel: "max",
      goalAnchorEnabled: false,
      planActive: true,
      planRequest: "Build the feature",
      msgText: "Do the thing",
    });
    const result = wrapEnvelope(params);
    expect(result.messageText).not.toContain("[GoalAnchor:");
  });
});
