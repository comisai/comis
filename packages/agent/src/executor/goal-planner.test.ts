// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createGoalPlanner } from "./goal-planner.js";

describe("createGoalPlanner (deferred planner stub)", () => {
  it("returns a planner function", () => {
    const planner = createGoalPlanner({});
    expect(typeof planner).toBe("function");
  });

  it("planner resolves to an empty GoalChecklist without calling any LLM", async () => {
    const planner = createGoalPlanner({});
    const result = await planner("Build a snake game with collision detection and scoring.");
    expect(result).toEqual({ items: [] });
    expect(Array.isArray(result.items)).toBe(true);
  });
});
