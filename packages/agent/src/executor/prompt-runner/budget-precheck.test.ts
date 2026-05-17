// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the budget pre-check helper.
 *
 * The budget pre-check has a clean pure-function interface (params +
 * messageText + skipPrompt → outcome) so it is testable in isolation
 * without the full deps surface a runPrompt invocation would require.
 */
import { describe, it, expect, vi } from "vitest";

import { precheckBudget } from "./budget-precheck.js";
import type { RunPromptParams } from "./prompt-runner-types.js";

// Minimal fake-builder. The pre-check only consumes a tiny slice of
// RunPromptParams (deps.budgetGuard, deps.logger, config.maxTokens, result).
// We construct that slice and cast to RunPromptParams — every other field is
// inaccessible by the pre-check code path.
type PrecheckSlice = Pick<RunPromptParams, "deps" | "config" | "result">;

interface BudgetCheckResultOk { ok: true; }
interface BudgetCheckResultErr {
  ok: false;
  error: {
    message: string;
    scope: "perExecution" | "perDay" | "perMonth";
    cap: number;
    currentUsage: number;
  };
}

function makeParams(overrides: {
  budgetCheckResult: BudgetCheckResultOk | BudgetCheckResultErr;
  maxTokens?: number;
  estimatedTokens?: number;
}): PrecheckSlice {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  const budgetGuard = {
    estimateCost: vi.fn(() => overrides.estimatedTokens ?? 100),
    checkBudget: vi.fn(() => overrides.budgetCheckResult),
    getSnapshot: vi.fn(() => ({ perExecution: 0 })),
  };
  const deps = {
    logger,
    budgetGuard,
  } as unknown as RunPromptParams["deps"];
  const config = {
    maxTokens: overrides.maxTokens,
  } as unknown as RunPromptParams["config"];
  const result = {
    finishReason: "stop",
    response: "",
    stepsExecuted: 0,
  } as unknown as RunPromptParams["result"];
  return { deps, config, result };
}

describe("precheckBudget", () => {
  it("returns { kind: 'ok' } when skipPrompt is true (bypasses the check entirely)", () => {
    const params = makeParams({ budgetCheckResult: { ok: true } });
    const outcome = precheckBudget(params as RunPromptParams, "user text", true);
    expect(outcome).toEqual({ kind: "ok" });
    // The estimator and checker must not be invoked when skipPrompt is true.
    expect((params.deps.budgetGuard.estimateCost as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((params.deps.budgetGuard.checkBudget as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("returns { kind: 'ok' } when the budget check passes", () => {
    const params = makeParams({ budgetCheckResult: { ok: true } });
    const outcome = precheckBudget(params as RunPromptParams, "user text", false);
    expect(outcome).toEqual({ kind: "ok" });
    expect((params.deps.budgetGuard.estimateCost as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((params.deps.budgetGuard.checkBudget as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it("returns a rejection result + mutates result.finishReason + result.response when the check fails", () => {
    const params = makeParams({
      budgetCheckResult: {
        ok: false,
        error: {
          message: "Budget exceeded",
          scope: "perExecution",
          cap: 1000,
          currentUsage: 1500,
        },
      },
    });
    const outcome = precheckBudget(params as RunPromptParams, "user text", false);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.result).toEqual({
        promptSucceeded: false,
        promptError: undefined,
        escalationAttempted: false,
      });
    }
    // Verify the result was mutated with the rejection state.
    expect(params.result.finishReason).toBe("budget_exceeded");
    expect(params.result.response).toBe("Budget exceeded");
    // Verify a structured WARN was logged (Pino object-first shape).
    expect(params.deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetType: "perExecution",
        budgetLimit: 1000,
        errorKind: "validation",
        hint: expect.stringContaining("Increase budgets.perExecution"),
      }),
      "Budget pre-check rejected prompt",
    );
  });

  it("uses config.maxTokens when provided; defaults to 4096 otherwise", () => {
    const params1 = makeParams({ budgetCheckResult: { ok: true }, maxTokens: 8192 });
    precheckBudget(params1 as RunPromptParams, "x".repeat(10), false);
    expect(params1.deps.budgetGuard.estimateCost).toHaveBeenCalledWith(10, 8192);

    const params2 = makeParams({ budgetCheckResult: { ok: true }, maxTokens: undefined });
    precheckBudget(params2 as RunPromptParams, "x".repeat(10), false);
    expect(params2.deps.budgetGuard.estimateCost).toHaveBeenCalledWith(10, 4096);
  });
});
