import { describe, it, expect } from "vitest";
import { createRefineDriver } from "./refine-driver.js";
import type { NodeDriverContext } from "@comis/core";

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

function createMockContext(overrides?: Partial<NodeDriverContext>): NodeDriverContext {
  let state: unknown = undefined;
  return {
    nodeId: "test-node",
    task: "Test task",
    typeConfig: {},
    sharedDir: "/tmp/test-shared",
    graphLabel: "Test Graph",
    defaultAgentId: "default-agent",
    typeName: "refine",
    getState: <T>() => state as T | undefined,
    setState: <T>(s: T) => { state = s; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRefineDriver", () => {
  const driver = createRefineDriver();

  describe("metadata", () => {
    it("has typeId 'refine'", () => {
      expect(driver.typeId).toBe("refine");
    });

    it("has defaultTimeoutMs of 300_000", () => {
      expect(driver.defaultTimeoutMs).toBe(300_000);
    });
  });

  describe("full 2-reviewer chain", () => {
    it("spawns first reviewer, then second, then completes", () => {
      const ctx = createMockContext({
        typeConfig: { reviewers: ["alice", "bob"] },
      });

      // initialize -> spawn first reviewer with original task
      const a1 = driver.initialize(ctx);
      expect(a1).toEqual({
        action: "spawn",
        agentId: "alice",
        task: "Test task",
      });

      // onTurnComplete for alice -> spawn bob with refined task
      const a2 = driver.onTurnComplete(ctx, "Alice draft v1");
      expect(a2).toHaveProperty("action", "spawn");
      expect(a2).toHaveProperty("agentId", "bob");

      // Task text contains step numbering and previous output
      const spawnAction = a2 as { action: "spawn"; task: string };
      expect(spawnAction.task).toContain("step 1 of 2");
      expect(spawnAction.task).toContain("Alice draft v1");
      expect(spawnAction.task).toContain("Test task");

      // onTurnComplete for bob -> complete with final output
      const a3 = driver.onTurnComplete(ctx, "Bob refined v2");
      expect(a3).toEqual({
        action: "complete",
        output: "Bob refined v2",
      });
    });
  });

  describe("full 3-reviewer chain", () => {
    it("chains 3 reviewers sequentially, last returns complete", () => {
      const ctx = createMockContext({
        typeConfig: { reviewers: ["r1", "r2", "r3"] },
      });

      const a1 = driver.initialize(ctx);
      expect(a1).toHaveProperty("agentId", "r1");

      const a2 = driver.onTurnComplete(ctx, "R1 output");
      expect(a2).toHaveProperty("action", "spawn");
      expect(a2).toHaveProperty("agentId", "r2");
      expect((a2 as { task: string }).task).toContain("step 1 of 3");

      const a3 = driver.onTurnComplete(ctx, "R2 output");
      expect(a3).toHaveProperty("action", "spawn");
      expect(a3).toHaveProperty("agentId", "r3");
      expect((a3 as { task: string }).task).toContain("step 2 of 3");

      const a4 = driver.onTurnComplete(ctx, "R3 final");
      expect(a4).toEqual({ action: "complete", output: "R3 final" });
    });
  });

  describe("task text formatting", () => {
    it("includes step N of M numbering", () => {
      const ctx = createMockContext({
        typeConfig: { reviewers: ["a", "b"] },
      });
      driver.initialize(ctx);
      const a2 = driver.onTurnComplete(ctx, "draft");
      const task = (a2 as { task: string }).task;
      expect(task).toMatch(/step \d+ of \d+/);
    });

    it("includes original task and previous output", () => {
      const ctx = createMockContext({
        task: "Write a poem",
        typeConfig: { reviewers: ["a", "b"] },
      });
      driver.initialize(ctx);
      const a2 = driver.onTurnComplete(ctx, "First attempt at poem");
      const task = (a2 as { task: string }).task;
      expect(task).toContain("Write a poem");
      expect(task).toContain("First attempt at poem");
    });

    it("includes 'Review and improve' instruction", () => {
      const ctx = createMockContext({
        typeConfig: { reviewers: ["a", "b"] },
      });
      driver.initialize(ctx);
      const a2 = driver.onTurnComplete(ctx, "draft");
      const task = (a2 as { task: string }).task;
      expect(task).toContain("Review and improve");
    });
  });

  describe("estimateDurationMs", () => {
    it("returns reviewers.length * 90_000", () => {
      expect(driver.estimateDurationMs({ reviewers: ["a", "b"] })).toBe(180_000);
      expect(driver.estimateDurationMs({ reviewers: ["a", "b", "c"] })).toBe(270_000);
    });
  });

  describe("configSchema", () => {
    it("accepts valid config with 2+ reviewers", () => {
      const result = driver.configSchema.safeParse({ reviewers: ["a", "b"] });
      expect(result.success).toBe(true);
    });

    it("rejects config with only 1 reviewer (min 2)", () => {
      const result = driver.configSchema.safeParse({ reviewers: ["a"] });
      expect(result.success).toBe(false);
    });

    it("rejects empty object", () => {
      const result = driver.configSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys (strictObject)", () => {
      const result = driver.configSchema.safeParse({ reviewers: ["a", "b"], extra: true });
      expect(result.success).toBe(false);
    });
  });

  describe("onAbort", () => {
    it("is callable and returns void", () => {
      const ctx = createMockContext();
      expect(() => driver.onAbort(ctx)).not.toThrow();
    });
  });
});
