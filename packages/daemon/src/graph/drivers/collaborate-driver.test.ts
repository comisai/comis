import { describe, it, expect } from "vitest";
import { createCollaborateDriver } from "./collaborate-driver.js";
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
    typeName: "collaborate",
    getState: <T>() => state as T | undefined,
    setState: <T>(s: T) => { state = s; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCollaborateDriver", () => {
  const driver = createCollaborateDriver();

  describe("metadata", () => {
    it("has typeId 'collaborate'", () => {
      expect(driver.typeId).toBe("collaborate");
    });

    it("has defaultTimeoutMs of 300_000", () => {
      expect(driver.defaultTimeoutMs).toBe(300_000);
    });
  });

  describe("full 2-agent 1-round", () => {
    it("spawns agents sequentially, completes after both contribute", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["agentA", "agentB"], rounds: 1 },
      });

      // initialize -> spawn first agent with original task (no prior contributions)
      const a1 = driver.initialize(ctx);
      expect(a1).toEqual({
        action: "spawn",
        agentId: "agentA",
        task: "Test task",
      });

      // agentA completes -> spawn agentB with prior contributions
      const a2 = driver.onTurnComplete(ctx, "A output");
      expect(a2).toHaveProperty("action", "spawn");
      expect(a2).toHaveProperty("agentId", "agentB");
      const t2 = (a2 as { task: string }).task;
      expect(t2).toContain("Prior Contributions");
      expect(t2).toContain("[agentA] A output");

      // agentB completes -> complete with formatted contributions
      const a3 = driver.onTurnComplete(ctx, "B output");
      expect(a3).toHaveProperty("action", "complete");
      const output = (a3 as { output: string }).output;
      expect(output).toContain("Collaborative Output");
      expect(output).toContain("[agentA] A output");
      expect(output).toContain("[agentB] B output");
    });
  });

  describe("full 2-agent 2-round (4 turns)", () => {
    it("cycles agents across rounds with cumulative contributions", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["a", "b"], rounds: 2 },
      });

      // Round 1
      const a1 = driver.initialize(ctx);
      expect(a1).toHaveProperty("agentId", "a");

      const a2 = driver.onTurnComplete(ctx, "A R1");
      expect(a2).toHaveProperty("agentId", "b");
      expect((a2 as { task: string }).task).toContain("[a] A R1");

      const a3 = driver.onTurnComplete(ctx, "B R1");
      expect(a3).toHaveProperty("action", "spawn");
      expect(a3).toHaveProperty("agentId", "a");
      // Round 2 starts, a sees both R1 contributions
      const t3 = (a3 as { task: string }).task;
      expect(t3).toContain("[a] A R1");
      expect(t3).toContain("[b] B R1");

      const a4 = driver.onTurnComplete(ctx, "A R2");
      expect(a4).toHaveProperty("agentId", "b");
      // b sees all 3 prior contributions
      const t4 = (a4 as { task: string }).task;
      expect(t4).toContain("[a] A R1");
      expect(t4).toContain("[b] B R1");
      expect(t4).toContain("[a] A R2");

      // Final turn -> complete
      const a5 = driver.onTurnComplete(ctx, "B R2");
      expect(a5).toHaveProperty("action", "complete");
      const output = (a5 as { output: string }).output;
      expect(output).toContain("[a] A R1");
      expect(output).toContain("[b] B R1");
      expect(output).toContain("[a] A R2");
      expect(output).toContain("[b] B R2");
    });
  });

  describe("3-agent 1-round", () => {
    it("3 turns, each sees growing contributions history", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["x", "y", "z"], rounds: 1 },
      });

      const a1 = driver.initialize(ctx);
      expect(a1).toHaveProperty("agentId", "x");
      // First agent gets plain task, no prior contributions
      expect((a1 as { task: string }).task).toBe("Test task");

      const a2 = driver.onTurnComplete(ctx, "X says");
      expect(a2).toHaveProperty("agentId", "y");
      const t2 = (a2 as { task: string }).task;
      expect(t2).toContain("[x] X says");

      const a3 = driver.onTurnComplete(ctx, "Y says");
      expect(a3).toHaveProperty("agentId", "z");
      const t3 = (a3 as { task: string }).task;
      expect(t3).toContain("[x] X says");
      expect(t3).toContain("[y] Y says");

      const a4 = driver.onTurnComplete(ctx, "Z says");
      expect(a4).toHaveProperty("action", "complete");
      const output = (a4 as { output: string }).output;
      expect(output).toContain("[x] X says");
      expect(output).toContain("[y] Y says");
      expect(output).toContain("[z] Z says");
    });
  });

  describe("contribution format", () => {
    it("uses [agentId] output format in Prior Contributions", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["alice", "bob"], rounds: 1 },
      });
      driver.initialize(ctx);
      const a2 = driver.onTurnComplete(ctx, "Alice perspective");
      const task = (a2 as { task: string }).task;
      expect(task).toContain("[alice] Alice perspective");
      expect(task).toContain("Prior Contributions");
    });
  });

  describe("final output format", () => {
    it("wraps all contributions with Collaborative Output header", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["a", "b"], rounds: 1 },
      });
      driver.initialize(ctx);
      driver.onTurnComplete(ctx, "A work");
      const result = driver.onTurnComplete(ctx, "B work");
      const output = (result as { output: string }).output;
      expect(output).toContain("Collaborative Output");
      expect(output).toContain("[a] A work");
      expect(output).toContain("[b] B work");
    });
  });

  describe("estimateDurationMs", () => {
    it("returns agents.length * rounds * 90_000", () => {
      expect(driver.estimateDurationMs({ agents: ["a", "b"], rounds: 1 })).toBe(2 * 90_000);
      expect(driver.estimateDurationMs({ agents: ["a", "b", "c"], rounds: 2 })).toBe(6 * 90_000);
    });
  });

  describe("configSchema", () => {
    it("accepts valid config with 2+ agents (default rounds=1)", () => {
      const result = driver.configSchema.safeParse({ agents: ["a", "b"] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as { rounds: number }).rounds).toBe(1);
      }
    });

    it("accepts config with explicit rounds", () => {
      const result = driver.configSchema.safeParse({ agents: ["a", "b"], rounds: 2 });
      expect(result.success).toBe(true);
    });

    it("rejects agents with fewer than 2 (min 2)", () => {
      const result = driver.configSchema.safeParse({ agents: ["a"] });
      expect(result.success).toBe(false);
    });

    it("rejects rounds: 0 (min 1)", () => {
      const result = driver.configSchema.safeParse({ agents: ["a", "b"], rounds: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects rounds: 4 (max 3)", () => {
      const result = driver.configSchema.safeParse({ agents: ["a", "b"], rounds: 4 });
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys (strictObject)", () => {
      const result = driver.configSchema.safeParse({ agents: ["a", "b"], extra: true });
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
