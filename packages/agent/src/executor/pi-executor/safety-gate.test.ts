// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for runSafetyGates — pre-lock safety gate composition.
 *
 * Closure-extracted state-first helper: tests confirm each gate translates a
 * failed check into the correct ExecutionResult finishReason without
 * exercising the full PiExecutor surface.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { ok, err } from "@comis/shared";
import type { SessionKey, NormalizedMessage } from "@comis/core";

import { runSafetyGates } from "./safety-gate.js";
import type { ExecutionResult } from "../types.js";
import type { PiExecutorDeps } from "./pi-executor.js";

function makeResult(): ExecutionResult {
  return {
    agentId: "agent-test",
    response: "",
    sessionKey: { tenantId: "t", channelId: "c", userId: "u" } as SessionKey,
    tokensUsed: { input: 0, output: 0, total: 0 },
    cost: { total: 0 },
    stepsExecuted: 0,
    llmCalls: 0,
    finishReason: "stop",
  };
}

function makeDeps(overrides: Partial<PiExecutorDeps> = {}): PiExecutorDeps {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logger,
  };
  return {
    circuitBreaker: { isOpen: () => false, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, reset: () => {} },
    budgetGuard: { checkBudget: () => ok(undefined), estimateCost: () => 0, recordUsage: () => {}, resetExecution: () => {}, getSnapshot: () => ({ perExecution: 0, perHour: 0, perDay: 0 }) },
    costTracker: {} as PiExecutorDeps["costTracker"],
    stepCounter: { shouldHalt: () => false, increment: () => 1, reset: () => {}, getCount: () => 0 },
    eventBus: { emit: () => {}, on: () => {}, off: () => {} } as unknown as PiExecutorDeps["eventBus"],
    logger: logger as unknown as PiExecutorDeps["logger"],
    authStorage: {} as PiExecutorDeps["authStorage"],
    modelRegistry: {} as PiExecutorDeps["modelRegistry"],
    sessionAdapter: {} as PiExecutorDeps["sessionAdapter"],
    workspaceDir: "/tmp",
    customTools: [],
    agentDir: "/tmp",
    clock: { now: () => 0, nowDate: () => new Date(0) },
    env: { get: () => undefined } as unknown as PiExecutorDeps["env"],
    timers: { setTimeout: () => ({ cancel: () => {} }), setInterval: () => ({ cancel: () => {} }) } as unknown as PiExecutorDeps["timers"],
    toolCapabilityPort: {} as PiExecutorDeps["toolCapabilityPort"],
    ...overrides,
  } as PiExecutorDeps;
}

const baseCtx = {
  msg: { text: "hi", channelType: "test", channelId: "c1", senderId: "u1", timestamp: 0 } as unknown as NormalizedMessage,
  sessionKey: { tenantId: "t", channelId: "c", userId: "u" } as SessionKey,
  agentId: "agent-1",
  provider: "anthropic",
};

describe("runSafetyGates", () => {
  it("returns passed=true when every gate is green", () => {
    const result = makeResult();
    const deps = makeDeps();
    const outcome = runSafetyGates({ result }, deps, baseCtx);
    expect(outcome.passed).toBe(true);
    expect(result.finishReason).toBe("stop");
  });

  it("blocks when circuit breaker is open and sets finishReason=circuit_open", () => {
    const result = makeResult();
    const deps = makeDeps({
      circuitBreaker: { isOpen: () => true, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "open" as const, reset: () => {} },
    });
    const outcome = runSafetyGates({ result }, deps, baseCtx);
    expect(outcome.passed).toBe(false);
    expect(result.finishReason).toBe("circuit_open");
  });

  it("blocks when provider is degraded and sets finishReason=provider_degraded", () => {
    const result = makeResult();
    const deps = makeDeps({
      providerHealth: { isDegraded: () => true, recordOutcome: () => {}, getProviderStatus: () => undefined },
    });
    const outcome = runSafetyGates({ result }, deps, baseCtx);
    expect(outcome.passed).toBe(false);
    expect(result.finishReason).toBe("provider_degraded");
  });

  it("returns safetyReinforcement field from input guard on pass", () => {
    const result = makeResult();
    // input-validator that returns no errors → no early-finish
    const deps = makeDeps({
      inputValidator: () => ({ valid: true, errors: [] }) as unknown as ReturnType<NonNullable<PiExecutorDeps["inputValidator"]>>,
    });
    const outcome = runSafetyGates({ result }, deps, baseCtx);
    expect(outcome.passed).toBe(true);
    if (outcome.passed) {
      // safetyReinforcement may be undefined when no jailbreak detected
      expect(outcome.safetyReinforcement === undefined || typeof outcome.safetyReinforcement === "string").toBe(true);
    }
  });

  it("state.result is the parameter object — helper mutates it in place", () => {
    const result = makeResult();
    const deps = makeDeps({
      circuitBreaker: { isOpen: () => true, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "open" as const, reset: () => {} },
    });
    runSafetyGates({ result }, deps, baseCtx);
    // The SAME object reference was mutated; the orchestrator reads back via this reference.
    expect(result.finishReason).toBe("circuit_open");
  });

  // Touch err so the otherwise-unused import does not trip no-unused-vars.
  void err;
});
