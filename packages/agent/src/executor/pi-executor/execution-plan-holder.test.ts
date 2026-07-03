// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the holder-backed ExecutionPlanPort implementation.
 *
 * Behavior under test:
 *   - a freshly-created holder's getCurrentPlan() returns undefined (no ref
 *     published / no turn active).
 *   - after publish(ref) with a live ExecutionPlan (active:true, 2 steps),
 *     getCurrentPlan() returns that plan with the same steps/statuses.
 *   - the holder reads the LIVE ref (no snapshot): mutating ref.current after
 *     publish is reflected by the NEXT getCurrentPlan() call.
 *   - clear() (turn end) makes getCurrentPlan() return undefined again.
 *   - when ref.current is undefined (SEP inactive), getCurrentPlan() returns
 *     undefined.
 */
import { describe, it, expect } from "vitest";
import type { ExecutionPlan } from "../../planner/types.js";
import { createExecutionPlanHolder } from "./execution-plan-holder.js";

function makePlan(): ExecutionPlan {
  return {
    active: true,
    request: "do the thing",
    completedCount: 0,
    createdAtMs: 1,
    steps: [
      { index: 1, description: "step one", status: "pending", completedBy: undefined },
      { index: 2, description: "step two", status: "pending" },
    ],
  };
}

describe("createExecutionPlanHolder (live-ref ExecutionPlanPort)", () => {
  it("returns undefined before any turn ref is published", () => {
    const holder = createExecutionPlanHolder();
    expect(holder.getCurrentPlan()).toBeUndefined();
  });

  it("returns the published plan with its steps and statuses", () => {
    const holder = createExecutionPlanHolder();
    const ref: { current: ExecutionPlan | undefined } = { current: makePlan() };
    holder.publish(ref);

    const plan = holder.getCurrentPlan();
    expect(plan).toBeDefined();
    expect(plan?.active).toBe(true);
    expect(plan?.steps).toHaveLength(2);
    expect(plan?.steps[0]).toMatchObject({ index: 1, description: "step one", status: "pending" });
    expect(plan?.steps[1]).toMatchObject({ index: 2, description: "step two", status: "pending" });
  });

  it("reflects live mutation of the published ref on the next getCurrentPlan call", () => {
    const holder = createExecutionPlanHolder();
    const ref: { current: ExecutionPlan | undefined } = { current: makePlan() };
    holder.publish(ref);
    expect(holder.getCurrentPlan()?.steps[0].status).toBe("pending");

    // SEP flips step[0] to done + bumps completedCount on the SAME ref object.
    const live = ref.current;
    if (live === undefined) throw new Error("test setup: ref.current must be defined");
    live.steps[0].status = "done";
    live.steps[0].completedBy = ["call-1"];
    live.completedCount = 1;

    const after = holder.getCurrentPlan();
    expect(after?.steps[0].status).toBe("done");
    expect(after?.steps[0].completedBy).toEqual(["call-1"]);
    expect(after?.completedCount).toBe(1);
  });

  it("returns undefined after clear() at turn end", () => {
    const holder = createExecutionPlanHolder();
    const ref: { current: ExecutionPlan | undefined } = { current: makePlan() };
    holder.publish(ref);
    expect(holder.getCurrentPlan()).toBeDefined();

    holder.clear();
    expect(holder.getCurrentPlan()).toBeUndefined();
  });

  it("returns undefined when the published ref current is undefined (SEP inactive)", () => {
    const holder = createExecutionPlanHolder();
    const ref: { current: ExecutionPlan | undefined } = { current: undefined };
    holder.publish(ref);
    expect(holder.getCurrentPlan()).toBeUndefined();
  });

  it("reflects a fresh ref published for a subsequent turn after clear", () => {
    const holder = createExecutionPlanHolder();
    const first: { current: ExecutionPlan | undefined } = { current: makePlan() };
    holder.publish(first);
    holder.clear();

    const second: { current: ExecutionPlan | undefined } = {
      current: { ...makePlan(), request: "second turn" },
    };
    holder.publish(second);
    expect(holder.getCurrentPlan()?.request).toBe("second turn");
  });
});
