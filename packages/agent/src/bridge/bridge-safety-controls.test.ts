// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the loop-detected safety control (FIX #2a) and
 * R2 abort-redirect response assertions (Plan 153-02).
 *
 * R2 tests verify that buildAbortRedirectMessage produces the correct
 * response text at all 7 abort sites (5 in-bridge + 2 pre-lock):
 *   - max_steps, loop_detected, budget_exceeded, context_exhausted, circuit_open (in-bridge)
 *   - provider_degraded, circuit_open pre-lock (safety-gate fallback with msg.text)
 */
import { describe, it, expect, vi } from "vitest";
import type { SessionKey, TypedEventBus, ComisLogger } from "@comis/core";

import { checkLoopLimit, emitLoopAbort, buildAbortRedirectMessage } from "./bridge-safety-controls.js";
import type { ExecutionPlan } from "../planner/types.js";

const testSessionKey = "agent-a:discord:chan-1" as unknown as SessionKey;

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
}

function makeEventBus(): TypedEventBus {
  return { emit: vi.fn() } as unknown as TypedEventBus;
}

describe("checkLoopLimit", () => {
  it("returns a loop_detected abort when the detector reports a loop and not already aborted", () => {
    const result = checkLoopLimit({ shouldBreakLoop: () => true }, false);
    expect(result.shouldAbort).toBe(true);
    expect(result.finishReason).toBe("loop_detected");
    expect(result.eventReason).toBe("loop_detected");
  });

  it("does not abort when the detector reports no loop", () => {
    const result = checkLoopLimit({ shouldBreakLoop: () => false }, false);
    expect(result.shouldAbort).toBe(false);
  });

  it("does not double-abort when the run is already aborted", () => {
    const result = checkLoopLimit({ shouldBreakLoop: () => true }, true);
    expect(result.shouldAbort).toBe(false);
  });
});

describe("emitLoopAbort", () => {
  it("emits execution:aborted with reason loop_detected", () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    emitLoopAbort({ eventBus, sessionKey: testSessionKey, agentId: "agent-a", logger });
    expect(eventBus.emit).toHaveBeenCalledWith(
      "execution:aborted",
      expect.objectContaining({ reason: "loop_detected", agentId: "agent-a" }),
    );
  });

  it("logs a WARN with errorKind resource and an actionable hint", () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    emitLoopAbort({ eventBus, sessionKey: testSessionKey, agentId: "agent-a", logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "resource", hint: expect.any(String) }),
      expect.any(String),
    );
  });

  it("invokes the optional onAbort hook before emitting", () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    const onAbort = vi.fn();
    emitLoopAbort({ eventBus, sessionKey: testSessionKey, agentId: "agent-a", logger, onAbort });
    expect(onAbort).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// R2: buildAbortRedirectMessage — all 7 abort-site paths
// ---------------------------------------------------------------------------

/** Build a minimal ExecutionPlan for testing */
function makeActivePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    active: true,
    request: "Implement the login flow with OAuth",
    steps: [
      { index: 1, description: "Create OAuth endpoint", status: "done" },
      { index: 2, description: "Wire callback handler", status: "pending" },
      { index: 3, description: "Add session persistence", status: "in_progress" },
    ],
    completedCount: 1,
    createdAtMs: 1000,
    ...overrides,
  };
}

describe("R2: buildAbortRedirectMessage — in-bridge abort sites (plan available)", () => {
  it("R2: max_steps abort → response contains plan.request text", () => {
    const plan = makeActivePlan();
    const response = buildAbortRedirectMessage(plan, "max_steps");
    expect(response).toContain("max_steps");
    expect(response).toContain(plan.request);
  });

  it("R2: loop_detected abort → response lists unmet steps", () => {
    const plan = makeActivePlan();
    const response = buildAbortRedirectMessage(plan, "loop_detected");
    expect(response).toContain(plan.request);
    // Unmet steps (pending + in_progress): step 2 and step 3
    expect(response).toContain("Wire callback handler");
    expect(response).toContain("Add session persistence");
    // Done step should NOT appear in unmet list
    expect(response).not.toContain("Create OAuth endpoint");
  });

  it("R2: budget_exceeded abort → response contains plan.request text + unmet items", () => {
    const plan = makeActivePlan();
    const response = buildAbortRedirectMessage(plan, "budget_exceeded");
    expect(response).toContain("budget_exceeded");
    expect(response).toContain(plan.request);
    expect(response).toContain("Wire callback handler");
  });

  it("R2: context_exhausted abort → response contains plan.request text + unmet items", () => {
    const plan = makeActivePlan();
    const response = buildAbortRedirectMessage(plan, "context_exhausted");
    expect(response).toContain("context_exhausted");
    expect(response).toContain(plan.request);
    expect(response).toContain("Add session persistence");
  });

  it("R2: circuit_open mid-loop abort → response contains plan.request text + unmet items", () => {
    const plan = makeActivePlan();
    const response = buildAbortRedirectMessage(plan, "circuit_open");
    expect(response).toContain("circuit_open");
    expect(response).toContain(plan.request);
    expect(response).toContain("Wire callback handler");
  });
});

describe("R2: buildAbortRedirectMessage — pre-lock abort sites (no plan, msg.text fallback)", () => {
  it("R2: pre-lock provider_degraded (no plan) → response contains msg.text fragment", () => {
    const msgText = "Please run the security scan on the codebase".slice(0, 200);
    const response = buildAbortRedirectMessage(undefined, "provider_degraded", msgText);
    expect(response).toContain("provider_degraded");
    expect(response).toContain(msgText);
  });

  it("R2: pre-lock circuit_open (no plan) → response contains msg.text fragment", () => {
    const msgText = "Deploy the new service to production".slice(0, 200);
    const response = buildAbortRedirectMessage(undefined, "circuit_open", msgText);
    expect(response).toContain("circuit_open");
    expect(response).toContain(msgText);
  });
});
