// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the SEP plan-stream.
 *
 * Behavior under test:
 *   - subscribes `sep:plan_extracted`, reads the live ExecutionPlan via a fake
 *     ExecutionPlanPort, and emits a plan-update whose entries map from
 *     ExecutionPlan.steps. NO new `plan_state` tool is created.
 *   - checkbox/completedBy correlation derives from `tool:executed`; a re-read
 *     after a tool completion re-emits with the updated step status.
 *   - `completedBy: undefined` is treated as "no completions yet".
 *   - the returned unsubscribe() detaches both bus handlers (no leak).
 */
import { describe, it, expect, vi } from "vitest";
import type { ReadonlyExecutionPlan, ExecutionPlanPort } from "@comis/core";
import { TypedEventBus } from "@comis/core";
import { createPlanStream, type PlanUpdate } from "./plan-stream.js";

function makePlanPort(plan: ReadonlyExecutionPlan | undefined): {
  port: ExecutionPlanPort;
  set: (p: ReadonlyExecutionPlan | undefined) => void;
} {
  let current = plan;
  return {
    port: { getCurrentPlan: () => current },
    set: (p) => {
      current = p;
    },
  };
}

describe("createPlanStream (SEP-sourced, no new tool)", () => {
  it("derives a plan-update from sep:plan_extracted + the live ExecutionPlan", () => {
    const bus = new TypedEventBus();
    const { port } = makePlanPort({
      active: true,
      request: "do the thing",
      completedCount: 0,
      steps: [
        { index: 1, description: "step one", status: "in_progress", completedBy: undefined },
        { index: 2, description: "step two", status: "pending" },
      ],
    });
    const updates: PlanUpdate[] = [];
    const stream = createPlanStream({ eventBus: bus, executionPlanPort: port });
    stream.subscribe((u) => updates.push(u));

    bus.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: "s1",
      stepCount: 2,
      timestamp: Date.now(),
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].entries).toHaveLength(2);
    expect(updates[0].entries[0]).toMatchObject({
      index: 1,
      description: "step one",
      status: "in_progress",
    });
    // completedBy undefined → treated as no completions.
    expect(updates[0].entries[0].completed).toBe(false);
    expect(updates[0].agentId).toBe("a1");
    expect(updates[0].sessionKey).toBe("s1");
  });

  it("re-emits a plan-update on tool:executed with the updated step status", () => {
    const bus = new TypedEventBus();
    const { port, set } = makePlanPort({
      active: true,
      request: "do",
      completedCount: 0,
      steps: [{ index: 1, description: "step one", status: "in_progress" }],
    });
    const updates: PlanUpdate[] = [];
    const stream = createPlanStream({ eventBus: bus, executionPlanPort: port });
    stream.subscribe((u) => updates.push(u));

    bus.emit("sep:plan_extracted", { agentId: "a1", sessionKey: "s1", stepCount: 1, timestamp: 1 });
    // SEP marks step done + correlates the toolCallId.
    set({
      active: true,
      request: "do",
      completedCount: 1,
      steps: [{ index: 1, description: "step one", status: "done", completedBy: ["call-1"] }],
    });
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 5,
      success: true,
      timestamp: 2,
      toolCallId: "call-1",
      agentId: "a1",
      sessionKey: "s1",
    });

    expect(updates).toHaveLength(2);
    expect(updates[1].entries[0].status).toBe("done");
    expect(updates[1].entries[0].completed).toBe(true);
  });

  it("emits nothing when SEP is inactive (getCurrentPlan returns undefined)", () => {
    const bus = new TypedEventBus();
    const { port } = makePlanPort(undefined);
    const updates: PlanUpdate[] = [];
    const stream = createPlanStream({ eventBus: bus, executionPlanPort: port });
    stream.subscribe((u) => updates.push(u));
    bus.emit("sep:plan_extracted", { agentId: "a1", sessionKey: "s1", stepCount: 0, timestamp: 1 });
    expect(updates).toHaveLength(0);
  });

  it("unsubscribe() detaches both bus handlers (no leak)", () => {
    const bus = new TypedEventBus();
    const offSpy = vi.spyOn(bus, "off");
    const { port } = makePlanPort({
      active: true,
      request: "do",
      completedCount: 0,
      steps: [{ index: 1, description: "s", status: "pending" }],
    });
    const updates: PlanUpdate[] = [];
    const stream = createPlanStream({ eventBus: bus, executionPlanPort: port });
    const unsubscribe = stream.subscribe((u) => updates.push(u));
    unsubscribe();
    // Both sep:plan_extracted and tool:executed handlers detached.
    expect(offSpy).toHaveBeenCalledTimes(2);
    // After unsubscribe, neither event reaches the listener.
    bus.emit("sep:plan_extracted", { agentId: "a1", sessionKey: "s1", stepCount: 1, timestamp: 1 });
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 1,
      success: true,
      timestamp: 2,
      toolCallId: "c",
      agentId: "a1",
      sessionKey: "s1",
    });
    expect(updates).toHaveLength(0);
  });
});
