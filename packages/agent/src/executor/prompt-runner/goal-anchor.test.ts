// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the GoalAnchor builder.
 *
 * Behavior under test:
 *   - buildGoalAnchorBlock returns the header + pending/in_progress steps
 *   - Completed (done/skipped) steps are OMITTED from the block
 *   - Output is bounded by maxChars; excess truncated with ellipsis (…)
 *   - plan.active === false OR empty steps → header-only string
 *   - plan undefined → returns "" (safe no-op)
 */
import { describe, it, expect } from "vitest";
import type { ExecutionPlan, PlanStep } from "../../planner/types.js";
import { buildGoalAnchorBlock } from "./goal-anchor.js";

function makePlan(
  request: string,
  steps: PlanStep[],
  active = true,
): ExecutionPlan {
  return {
    active,
    request,
    steps,
    completedCount: steps.filter((s) => s.status === "done").length,
    createdAtMs: 1_000_000,
  };
}

function makeStep(
  index: number,
  description: string,
  status: PlanStep["status"] = "pending",
): PlanStep {
  return { index, description, status };
}

describe("buildGoalAnchorBlock", () => {
  it("returns empty string when plan is undefined (safe no-op)", () => {
    expect(buildGoalAnchorBlock(undefined)).toBe("");
  });

  it("returns header-only when plan.active is false", () => {
    const plan = makePlan("do the thing", [makeStep(1, "step one")], false);
    const result = buildGoalAnchorBlock(plan);
    expect(result).toBe("[GoalAnchor: do the thing]");
  });

  it("returns header-only when steps array is empty", () => {
    const plan = makePlan("do the thing", []);
    const result = buildGoalAnchorBlock(plan);
    expect(result).toBe("[GoalAnchor: do the thing]");
  });

  it("includes pending steps with checkbox prefix", () => {
    const plan = makePlan("build feature X", [
      makeStep(1, "analyze requirements", "pending"),
      makeStep(2, "write tests", "pending"),
    ]);
    const result = buildGoalAnchorBlock(plan);
    expect(result).toContain("[GoalAnchor: build feature X]");
    expect(result).toContain("☐ 1. analyze requirements");
    expect(result).toContain("☐ 2. write tests");
  });

  it("includes in_progress steps with checkbox prefix", () => {
    const plan = makePlan("deploy service", [
      makeStep(1, "run migration", "in_progress"),
    ]);
    const result = buildGoalAnchorBlock(plan);
    expect(result).toContain("☐ 1. run migration");
  });

  it("omits done steps from the block", () => {
    const plan = makePlan("multi-step task", [
      makeStep(1, "completed step", "done"),
      makeStep(2, "pending step", "pending"),
    ]);
    const result = buildGoalAnchorBlock(plan);
    expect(result).not.toContain("completed step");
    expect(result).toContain("☐ 2. pending step");
  });

  it("omits skipped steps from the block", () => {
    const plan = makePlan("multi-step task", [
      makeStep(1, "skipped step", "skipped"),
      makeStep(2, "active step", "pending"),
    ]);
    const result = buildGoalAnchorBlock(plan);
    expect(result).not.toContain("skipped step");
    expect(result).toContain("☐ 2. active step");
  });

  it("returns header-only when all steps are done or skipped", () => {
    const plan = makePlan("all done task", [
      makeStep(1, "step one", "done"),
      makeStep(2, "step two", "skipped"),
    ]);
    const result = buildGoalAnchorBlock(plan);
    expect(result).toBe("[GoalAnchor: all done task]");
  });

  it("uses the default maxChars of 500", () => {
    const longDescription = "a".repeat(400);
    const plan = makePlan("request", [
      makeStep(1, longDescription, "pending"),
      makeStep(2, "another step", "pending"),
    ]);
    const result = buildGoalAnchorBlock(plan);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("truncates output at maxChars with ellipsis when block exceeds limit", () => {
    const veryLongDesc = "x".repeat(600);
    const plan = makePlan("req", [makeStep(1, veryLongDesc, "pending")]);
    const result = buildGoalAnchorBlock(plan, 50);
    expect(result.length).toBeLessThanOrEqual(51); // 50 chars + "…" = 51 UTF-8 code points
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not truncate when block fits within maxChars", () => {
    const plan = makePlan("short req", [makeStep(1, "short step", "pending")]);
    const result = buildGoalAnchorBlock(plan, 500);
    expect(result.endsWith("…")).toBe(false);
    expect(result).toContain("☐ 1. short step");
  });

  it("formats header on its own line followed by steps on separate lines", () => {
    const plan = makePlan("build X", [
      makeStep(1, "step A", "pending"),
      makeStep(2, "step B", "pending"),
    ]);
    const result = buildGoalAnchorBlock(plan);
    const lines = result.split("\n");
    expect(lines[0]).toBe("[GoalAnchor: build X]");
    expect(lines[1]).toBe("☐ 1. step A");
    expect(lines[2]).toBe("☐ 2. step B");
  });

  it("handles a plan with a mix of all statuses — includes only pending and in_progress", () => {
    const plan = makePlan("complex task", [
      makeStep(1, "already done", "done"),
      makeStep(2, "in progress now", "in_progress"),
      makeStep(3, "was skipped", "skipped"),
      makeStep(4, "not started", "pending"),
    ]);
    const result = buildGoalAnchorBlock(plan);
    expect(result).not.toContain("already done");
    expect(result).toContain("☐ 2. in progress now");
    expect(result).not.toContain("was skipped");
    expect(result).toContain("☐ 4. not started");
  });

  it("accepts a custom maxChars and respects it", () => {
    const plan = makePlan("custom cap", [
      makeStep(1, "step one", "pending"),
      makeStep(2, "step two", "pending"),
    ]);
    const small = buildGoalAnchorBlock(plan, 30);
    const large = buildGoalAnchorBlock(plan, 500);
    expect(small.length).toBeLessThanOrEqual(31); // 30 chars + optional "…"
    expect(large.length).toBeGreaterThan(small.length);
  });
});
