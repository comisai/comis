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

import { checkLoopLimit, emitLoopAbort, buildAbortRedirectMessage, checkSpendLimit, emitSpendAbort } from "./bridge-safety-controls.js";
import type { ExecutionPlan } from "../planner/types.js";
import type { SpendGateOutcome } from "../budget/budget-guard.js";
import { SpendError } from "../budget/spend-accumulator.js";

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

// ---------------------------------------------------------------------------
// Spend kill-switch routing (Phase 177-03 Task 2): checkSpendLimit + emitSpendAbort
// mirror the checkBudgetLimit/emitBudgetAbort mold. ONE abort reason
// "spend_exceeded"; the unpriceable nuance rides the distinct
// observability:spend_unpriceable event. warn-default never aborts.
// ---------------------------------------------------------------------------

/** A set of fake emit hooks for the three spend events. */
function makeSpendEmit() {
  return { spendWarning: vi.fn(), spendExceeded: vi.fn(), spendUnpriceable: vi.fn() };
}

const okOutcome = (warn: boolean): SpendGateOutcome => ({
  kind: "ok",
  reservation: { scopeKey: "t a", tenantKey: "t", reservedUsd: 0.5 },
  warn,
});
const exceededOutcome = (): SpendGateOutcome => ({
  kind: "exceeded",
  error: new SpendError("agent", 0.9, 1.0, 0.5),
});
const unpriceableOutcome = (): SpendGateOutcome => ({
  kind: "unpriceable",
  provider: "anthropic",
  model: "qwen-x",
});
const freeOutcome = (): SpendGateOutcome => ({ kind: "free" });

describe("checkSpendLimit", () => {
  it("free outcome never aborts and emits nothing", () => {
    const emit = makeSpendEmit();
    const res = checkSpendLimit(freeOutcome(), "abort", "abort", false, emit);
    expect(res.shouldAbort).toBe(false);
    expect(emit.spendWarning).not.toHaveBeenCalled();
    expect(emit.spendExceeded).not.toHaveBeenCalled();
    expect(emit.spendUnpriceable).not.toHaveBeenCalled();
  });

  it("ok+warn emits spend_warning and does NOT abort", () => {
    const emit = makeSpendEmit();
    const res = checkSpendLimit(okOutcome(true), "abort", "warn", false, emit);
    expect(res.shouldAbort).toBe(false);
    expect(emit.spendWarning).toHaveBeenCalledOnce();
    expect(emit.spendExceeded).not.toHaveBeenCalled();
  });

  it("ok without warn emits nothing and does NOT abort", () => {
    const emit = makeSpendEmit();
    const res = checkSpendLimit(okOutcome(false), "abort", "warn", false, emit);
    expect(res.shouldAbort).toBe(false);
    expect(emit.spendWarning).not.toHaveBeenCalled();
  });

  it("exceeded under action 'abort' emits spend_exceeded AND returns shouldAbort with spend_exceeded reasons", () => {
    const emit = makeSpendEmit();
    const res = checkSpendLimit(exceededOutcome(), "abort", "warn", false, emit);
    expect(emit.spendExceeded).toHaveBeenCalledOnce();
    expect(res.shouldAbort).toBe(true);
    expect(res.finishReason).toBe("spend_exceeded");
    expect(res.eventReason).toBe("spend_exceeded");
  });

  it("exceeded under action 'warn' (the shipped default) emits spend_exceeded but NEVER aborts", () => {
    const emit = makeSpendEmit();
    const res = checkSpendLimit(exceededOutcome(), "warn", "warn", false, emit);
    expect(emit.spendExceeded).toHaveBeenCalledOnce();
    expect(res.shouldAbort).toBe(false); // opt-in invariant: warn-default signals only
  });

  it("does not double-abort when already aborted (exceeded + abort + aborted=true)", () => {
    const emit = makeSpendEmit();
    const res = checkSpendLimit(exceededOutcome(), "abort", "warn", true, emit);
    // The event still fires (the breach is real), but no second abort is routed.
    expect(emit.spendExceeded).toHaveBeenCalledOnce();
    expect(res.shouldAbort).toBe(false);
  });

  it("unpriceable always emits spend_unpriceable; aborts ONLY when action='abort' AND onUnknownPricing='abort'", () => {
    // action warn → no abort (but still fail-loud)
    const e1 = makeSpendEmit();
    const r1 = checkSpendLimit(unpriceableOutcome(), "warn", "abort", false, e1);
    expect(e1.spendUnpriceable).toHaveBeenCalledOnce();
    expect(r1.shouldAbort).toBe(false);

    // action abort but onUnknownPricing warn → no abort (but still fail-loud)
    const e2 = makeSpendEmit();
    const r2 = checkSpendLimit(unpriceableOutcome(), "abort", "warn", false, e2);
    expect(e2.spendUnpriceable).toHaveBeenCalledOnce();
    expect(r2.shouldAbort).toBe(false);

    // both abort → abort (and fail-loud)
    const e3 = makeSpendEmit();
    const r3 = checkSpendLimit(unpriceableOutcome(), "abort", "abort", false, e3);
    expect(e3.spendUnpriceable).toHaveBeenCalledOnce();
    expect(r3.shouldAbort).toBe(true);
    expect(r3.finishReason).toBe("spend_exceeded");
  });

  it("spend_warning fires on a strictly-earlier turn than spend_exceeded (ordering)", () => {
    // Single emit object spanning two turns; record the global call order.
    const order: string[] = [];
    const emit = {
      spendWarning: vi.fn(() => order.push("warning")),
      spendExceeded: vi.fn(() => order.push("exceeded")),
      spendUnpriceable: vi.fn(),
    };
    // Turn 1: sub-ceiling but past warnAtFraction → warning.
    checkSpendLimit(okOutcome(true), "abort", "warn", false, emit);
    // Turn 2: now over the ceiling → exceeded.
    checkSpendLimit(exceededOutcome(), "abort", "warn", false, emit);
    expect(order).toEqual(["warning", "exceeded"]);
  });
});

describe("emitSpendAbort", () => {
  it("emits execution:aborted with reason spend_exceeded", () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    emitSpendAbort({ eventBus, sessionKey: testSessionKey, agentId: "agent-a", logger });
    expect(eventBus.emit).toHaveBeenCalledWith(
      "execution:aborted",
      expect.objectContaining({ reason: "spend_exceeded", agentId: "agent-a" }),
    );
  });

  it("logs a content-free WARN: errorKind resource + an actionable hint, NO $ amount in the message body", () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    emitSpendAbort({ eventBus, sessionKey: testSessionKey, agentId: "agent-a", logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "resource", hint: expect.any(String) }),
      expect.any(String),
    );
    // Content-free: the structured fields carry NO dollar amount, and the message
    // body string carries no "$".
    const [obj, msg] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.stringify(obj)).not.toContain("$");
    expect(obj).not.toHaveProperty("spentUsd");
    expect(obj).not.toHaveProperty("capUsd");
    expect(String(msg)).not.toContain("$");
  });

  it("invokes the optional onAbort hook before emitting", () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    const onAbort = vi.fn();
    emitSpendAbort({ eventBus, sessionKey: testSessionKey, agentId: "agent-a", logger, onAbort });
    expect(onAbort).toHaveBeenCalledOnce();
  });
});
