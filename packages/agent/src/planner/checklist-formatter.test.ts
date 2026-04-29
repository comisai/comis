// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { formatChecklistForInjection } from "./checklist-formatter.js";
import type { ExecutionPlan } from "./types.js";

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    active: true,
    request: "Set up monitoring",
    steps: [
      { index: 1, description: "Create config", status: "done" },
      { index: 2, description: "Set up webhooks", status: "in_progress" },
      { index: 3, description: "Configure thresholds", status: "pending" },
    ],
    completedCount: 1,
    createdAtMs: Date.now(),
    ...overrides,
  };
}

describe("formatChecklistForInjection", () => {
  it("returns empty string for inactive plan", () => {
    const plan = makePlan({ active: false });
    expect(formatChecklistForInjection(plan)).toBe("");
  });

  it("returns empty string for plan with no steps", () => {
    const plan = makePlan({ steps: [] });
    expect(formatChecklistForInjection(plan)).toBe("");
  });

  it("renders correct status markers for mixed statuses", () => {
    const plan = makePlan({
      steps: [
        { index: 1, description: "Step A", status: "done" },
        { index: 2, description: "Step B", status: "in_progress" },
        { index: 3, description: "Step C", status: "skipped" },
        { index: 4, description: "Step D", status: "pending" },
      ],
      completedCount: 1,
    });
    const result = formatChecklistForInjection(plan);
    expect(result).toContain("[x] 1. Step A");
    expect(result).toContain("[>] 2. Step B");
    expect(result).toContain("[-] 3. Step C");
    expect(result).toContain("[ ] 4. Step D");
  });

  it("shows continue footer when incomplete", () => {
    const plan = makePlan({ completedCount: 1 });
    const result = formatChecklistForInjection(plan);
    expect(result).toContain("Continue with the next unchecked step");
    expect(result).toContain("Do not repeat completed steps");
    expect(result).toContain("[Execution checklist: 1/3 complete]");
  });

  it("shows verification questions when complete and verificationNudge is true", () => {
    const plan = makePlan({
      steps: [
        { index: 1, description: "Step A", status: "done" },
        { index: 2, description: "Step B", status: "done" },
      ],
      completedCount: 2,
    });
    const result = formatChecklistForInjection(plan, true);
    expect(result).toContain("All steps complete. Before responding to the user");
    expect(result).toContain("Did each step produce the expected outcome?");
    expect(result).toContain("Are there any error messages in tool results that were overlooked?");
    expect(result).toContain("Does the overall result satisfy the user's original request?");
  });

  it("shows simple completion message when complete and verificationNudge is false", () => {
    const plan = makePlan({
      steps: [
        { index: 1, description: "Step A", status: "done" },
        { index: 2, description: "Step B", status: "done" },
      ],
      completedCount: 2,
    });
    const result = formatChecklistForInjection(plan, false);
    expect(result).toContain("All steps complete. Verify the result works as expected");
    expect(result).not.toContain("Did each step produce the expected outcome?");
  });

  it("treats skipped steps as resolved for completion check", () => {
    const plan = makePlan({
      steps: [
        { index: 1, description: "Step A", status: "done" },
        { index: 2, description: "Step B", status: "skipped" },
      ],
      completedCount: 1,
    });
    const result = formatChecklistForInjection(plan, true);
    expect(result).toContain("All steps complete. Before responding to the user");
  });

  it("defaults verificationNudge to true when omitted", () => {
    const plan = makePlan({
      steps: [
        { index: 1, description: "Step A", status: "done" },
      ],
      completedCount: 1,
    });
    const result = formatChecklistForInjection(plan);
    expect(result).toContain("Did each step produce the expected outcome?");
  });

  it("includes correct count header", () => {
    const plan = makePlan({
      steps: [
        { index: 1, description: "A", status: "done" },
        { index: 2, description: "B", status: "done" },
        { index: 3, description: "C", status: "pending" },
        { index: 4, description: "D", status: "pending" },
        { index: 5, description: "E", status: "pending" },
      ],
      completedCount: 2,
    });
    const result = formatChecklistForInjection(plan);
    expect(result).toContain("[Execution checklist: 2/5 complete]");
  });
});
