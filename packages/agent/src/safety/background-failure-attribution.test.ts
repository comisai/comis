// SPDX-License-Identifier: Apache-2.0
/**
 * The breaker must count a background failure against the tool that FAILED.
 *
 * Live incident: a report tool was auto-backgrounded on every launch, so it
 * returned "moved to the background" — a SUCCESS — and its consecutive-failure
 * counter reset each time. The real failures surfaced on the `background_tasks`
 * poller, which tripped at 2. The breaker therefore blinded the agent's ability
 * to observe outcomes while leaving the failing tool unthrottled: 20+ launches,
 * each burning the full MCP deadline, until the turn's wall-clock budget expired
 * and the user got a canned error ten minutes later.
 */
import { describe, it, expect, vi } from "vitest";
import {
  attributeBackgroundFailuresToOriginatingTool,
  createBackgroundTaskSettlementReconciler,
  isRelayedBackgroundFailure,
  BACKGROUND_POLLER_TOOL,
} from "./background-failure-attribution.js";
import { createToolRetryBreaker } from "./tool-retry-breaker.js";

function fakeBus() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  return {
    on(name: string, fn: (p: unknown) => void) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
    },
    off(name: string, fn: (p: unknown) => void) {
      handlers.get(name)?.delete(fn);
    },
    emit(name: string, p: unknown) {
      for (const fn of handlers.get(name) ?? []) fn(p);
    },
    count(name: string) {
      return handlers.get(name)?.size ?? 0;
    },
  };
}

describe("isRelayedBackgroundFailure", () => {
  it("returns true when the poller relays someone else's failure", () => {
    expect(isRelayedBackgroundFailure(
      BACKGROUND_POLLER_TOOL,
      "[conflict] Background task failed: tool timed out",
    )).toBe(true);
  });

  it("still blames the poller for its OWN failures", () => {
    // A bad taskId or a storage error is genuinely the poller's problem and must
    // keep counting — otherwise the exemption becomes a blanket amnesty.
    expect(isRelayedBackgroundFailure(BACKGROUND_POLLER_TOOL, "unknown taskId")).toBe(false);
    expect(isRelayedBackgroundFailure(BACKGROUND_POLLER_TOOL, undefined)).toBe(false);
  });

  it("never exempts any other tool", () => {
    expect(isRelayedBackgroundFailure("some_tool", "Background task failed: x")).toBe(false);
  });
});

describe("attributeBackgroundFailuresToOriginatingTool", () => {
  it("counts the failure against the tool that launched the task", () => {
    const bus = fakeBus();
    const breaker = { recordResult: vi.fn() };
    attributeBackgroundFailuresToOriginatingTool({ eventBus: bus as never, breaker });

    bus.emit("background_task:failed", {
      toolName: "mcp__vendor--heavy_report",
      error: "timed out",
      taskId: "t1",
    });

    expect(breaker.recordResult).toHaveBeenCalledTimes(1);
    const [tool, , success] = breaker.recordResult.mock.calls[0]!;
    expect(tool).toBe("mcp__vendor--heavy_report");
    expect(success).toBe(false);
  });

  it("repeated failures accumulate on that tool — the storm can now be stopped", () => {
    const bus = fakeBus();
    const breaker = { recordResult: vi.fn() };
    attributeBackgroundFailuresToOriginatingTool({ eventBus: bus as never, breaker });

    for (let i = 0; i < 3; i++) {
      bus.emit("background_task:failed", { toolName: "mcp__vendor--heavy_report", error: "timed out" });
    }
    expect(breaker.recordResult).toHaveBeenCalledTimes(3);
    for (const call of breaker.recordResult.mock.calls) {
      expect(call[0]).toBe("mcp__vendor--heavy_report");
    }
  });

  it("never counts the poller itself", () => {
    const bus = fakeBus();
    const breaker = { recordResult: vi.fn() };
    attributeBackgroundFailuresToOriginatingTool({ eventBus: bus as never, breaker });
    bus.emit("background_task:failed", { toolName: BACKGROUND_POLLER_TOOL, error: "x" });
    expect(breaker.recordResult).not.toHaveBeenCalled();
  });

  it("ignores another agent's failures when scoped", () => {
    const bus = fakeBus();
    const breaker = { recordResult: vi.fn() };
    attributeBackgroundFailuresToOriginatingTool({ eventBus: bus as never, breaker, agentId: "a" });
    bus.emit("background_task:failed", { toolName: "t", error: "x", agentId: "b" });
    expect(breaker.recordResult).not.toHaveBeenCalled();
    bus.emit("background_task:failed", { toolName: "t", error: "x", agentId: "a" });
    expect(breaker.recordResult).toHaveBeenCalledTimes(1);
  });

  it("ignores failures from another session and dispatch redeliveries", () => {
    const bus = fakeBus();
    const breaker = { recordResult: vi.fn() };
    attributeBackgroundFailuresToOriginatingTool({
      eventBus: bus as never,
      breaker,
      agentId: "a",
      sessionKey: "session-a",
    });
    bus.emit("background_task:failed", { toolName: "t", error: "x", agentId: "a", sessionKey: "session-b" });
    bus.emit("background_task:failed", { toolName: "t", error: "x", agentId: "a", sessionKey: "session-a", dispatchRedelivery: true });
    expect(breaker.recordResult).not.toHaveBeenCalled();
    bus.emit("background_task:failed", { toolName: "t", error: "x", agentId: "a", sessionKey: "session-a" });
    expect(breaker.recordResult).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes — the listener must not outlive the execution that owns the breaker", () => {
    const bus = fakeBus();
    const breaker = { recordResult: vi.fn() };
    const off = attributeBackgroundFailuresToOriginatingTool({ eventBus: bus as never, breaker });
    expect(bus.count("background_task:failed")).toBe(1);
    off();
    expect(bus.count("background_task:failed")).toBe(0);
    bus.emit("background_task:failed", { toolName: "t", error: "x" });
    expect(breaker.recordResult).not.toHaveBeenCalled();
  });

  it("shares task-id deduplication with the later durable settlement scan", () => {
    const bus = fakeBus();
    const breaker = { recordResult: vi.fn() };
    const reconciler = createBackgroundTaskSettlementReconciler(breaker);
    attributeBackgroundFailuresToOriginatingTool({
      eventBus: bus as never,
      breaker,
      reconciler,
      agentId: "a",
      sessionKey: "session-a",
    });

    bus.emit("background_task:failed", {
      taskId: "task-1",
      toolName: "mcp__reports--slow_lookup",
      error: "source unavailable",
      agentId: "a",
      sessionKey: "session-a",
      timestamp: 10,
    });
    reconciler.reconcile([
      {
        id: "task-1",
        toolName: "mcp__reports--slow_lookup",
        status: "failed",
        completedAt: 10,
        error: "source unavailable",
      },
    ]);

    expect(breaker.recordResult).toHaveBeenCalledTimes(1);
  });
});

describe("createBackgroundTaskSettlementReconciler", () => {
  it("carries delayed failures across turns and does not replay a settled task", () => {
    const breaker = createToolRetryBreaker({
      maxConsecutiveFailures: 3,
      maxToolFailures: 2,
      maxConsecutiveErrorPatterns: 10,
      suggestAlternatives: false,
    });
    const reconciler = createBackgroundTaskSettlementReconciler(breaker);
    const failed = (id: string) => ({
      id,
      toolName: "mcp__reports--slow_lookup",
      status: "failed" as const,
      completedAt: 10,
      error: "source unavailable",
    });

    expect(reconciler.reconcile([failed("task-1")])).toHaveLength(0);
    expect(breaker.beforeToolCall("mcp__reports--slow_lookup", { subject: "a" }).block).toBe(false);

    // A later execution scans the same durable task plus one new failure. The
    // first task must not count twice, while the second must trip the persistent
    // error-pattern breaker.
    const transitions = reconciler.reconcile([failed("task-1"), failed("task-2")]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      transition: "opened",
      toolName: "mcp__reports--slow_lookup",
    });
    expect(breaker.beforeToolCall("mcp__reports--slow_lookup", { subject: "b" }).block).toBe(true);
  });

  it("replays terminal chronology so a later completion resets prior failures", () => {
    const breaker = createToolRetryBreaker({
      maxConsecutiveFailures: 3,
      maxToolFailures: 5,
      maxConsecutiveErrorPatterns: 2,
      suggestAlternatives: false,
    });
    const reconciler = createBackgroundTaskSettlementReconciler(breaker);

    const transitions = reconciler.reconcile([
      {
        id: "task-failed-1",
        toolName: "mcp__reports--slow_lookup",
        status: "failed",
        completedAt: 10,
        error: "source unavailable",
      },
      {
        id: "task-failed-2",
        toolName: "mcp__reports--slow_lookup",
        status: "failed",
        completedAt: 20,
        error: "source unavailable",
      },
      {
        id: "task-completed",
        toolName: "mcp__reports--slow_lookup",
        status: "completed",
        completedAt: 30,
      },
    ]);

    expect(transitions.map((transition) => transition.transition)).toEqual(["opened", "reset"]);
    expect(breaker.beforeToolCall("mcp__reports--slow_lookup", { subject: "c" }).block).toBe(false);
  });
});
