import { describe, it, expect } from "vitest";
import type { NodeDriverContext } from "@comis/core";
import { createVoteDriver } from "./vote-driver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides: Partial<NodeDriverContext> = {}): NodeDriverContext {
  let state: unknown;
  return {
    nodeId: "n1",
    task: "Evaluate the proposal",
    typeConfig: {},
    sharedDir: "/tmp/shared",
    graphLabel: "Test Graph",
    defaultAgentId: "default-agent",
    typeName: "vote",
    getState: <T>() => state as T | undefined,
    setState: <T>(s: T) => { state = s; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createVoteDriver
// ---------------------------------------------------------------------------

describe("createVoteDriver", () => {
  const driver = createVoteDriver();

  // -- Metadata ------------------------------------------------------------

  it("has typeId 'vote'", () => {
    expect(driver.typeId).toBe("vote");
  });

  it("has defaultTimeoutMs 300_000", () => {
    expect(driver.defaultTimeoutMs).toBe(300_000);
  });

  // -- initialize ----------------------------------------------------------

  it("initialize returns spawn_all with all voters", () => {
    const ctx = createMockContext({
      typeConfig: { voters: ["alice", "bob"] },
    });
    const action = driver.initialize(ctx);
    expect(action).toEqual({
      action: "spawn_all",
      spawns: [
        { agentId: "alice", task: "Evaluate the proposal" },
        { agentId: "bob", task: "Evaluate the proposal" },
      ],
    });
  });

  it("initialize with prompt_suffix appends suffix to each spawn task", () => {
    const ctx = createMockContext({
      typeConfig: { voters: ["alice", "bob"], prompt_suffix: "Be concise" },
    });
    const action = driver.initialize(ctx);
    expect(action.action).toBe("spawn_all");
    if (action.action === "spawn_all") {
      for (const spawn of action.spawns) {
        expect(spawn.task).toContain("\n\nBe concise");
      }
    }
  });

  it("initialize with verdict_format adds verdict hint to each spawn task", () => {
    const ctx = createMockContext({
      typeConfig: { voters: ["alice", "bob"], verdict_format: "YES or NO" },
    });
    const action = driver.initialize(ctx);
    expect(action.action).toBe("spawn_all");
    if (action.action === "spawn_all") {
      for (const spawn of action.spawns) {
        expect(spawn.task).toContain("Provide your verdict in this format: YES or NO");
      }
    }
  });

  it("initialize with both prompt_suffix and verdict_format appends both", () => {
    const ctx = createMockContext({
      typeConfig: {
        voters: ["alice", "bob"],
        prompt_suffix: "Be concise",
        verdict_format: "YES or NO",
      },
    });
    const action = driver.initialize(ctx);
    expect(action.action).toBe("spawn_all");
    if (action.action === "spawn_all") {
      for (const spawn of action.spawns) {
        expect(spawn.task).toContain("\n\nBe concise");
        expect(spawn.task).toContain("Provide your verdict in this format: YES or NO");
      }
    }
  });

  // -- onTurnComplete (defensive) ------------------------------------------

  it("onTurnComplete returns fail with defensive error", () => {
    const ctx = createMockContext();
    const action = driver.onTurnComplete(ctx, "some output");
    expect(action).toEqual({
      action: "fail",
      error: "Unexpected sequential turn in vote driver",
    });
  });

  // -- onParallelTurnComplete (tally) --------------------------------------

  it("onParallelTurnComplete formats tally with 2 voters", () => {
    const ctx = createMockContext();
    const action = driver.onParallelTurnComplete!(ctx, [
      { agentId: "alice", output: "Alice vote text" },
      { agentId: "bob", output: "Bob vote text" },
    ]);
    expect(action.action).toBe("complete");
    if (action.action === "complete") {
      expect(action.output).toContain("--- Vote Results (2 of 2 voters) ---");
      expect(action.output).toContain("[alice]: Alice vote text");
      expect(action.output).toContain("[bob]: Bob vote text");
      expect(action.output).toContain("--- End Vote Results ---");
    }
  });

  it("onParallelTurnComplete formats tally with 3 voters", () => {
    const ctx = createMockContext();
    const action = driver.onParallelTurnComplete!(ctx, [
      { agentId: "a", output: "A" },
      { agentId: "b", output: "B" },
      { agentId: "c", output: "C" },
    ]);
    expect(action.action).toBe("complete");
    if (action.action === "complete") {
      expect(action.output).toContain("--- Vote Results (3 of 3 voters) ---");
    }
  });

  // -- estimateDurationMs --------------------------------------------------

  it("estimateDurationMs scales with voter count", () => {
    expect(driver.estimateDurationMs({ voters: ["a", "b"] })).toBe(100_000);
    expect(driver.estimateDurationMs({ voters: ["a", "b", "c"] })).toBe(105_000);
    expect(driver.estimateDurationMs({ voters: ["a", "b", "c", "d"] })).toBe(110_000);
  });

  // -- configSchema --------------------------------------------------------

  it("configSchema accepts valid config with 2 voters", () => {
    const result = driver.configSchema.safeParse({ voters: ["a", "b"] });
    expect(result.success).toBe(true);
  });

  it("configSchema accepts optional fields", () => {
    const result = driver.configSchema.safeParse({
      voters: ["a", "b"],
      min_voters: 1,
      prompt_suffix: "Be brief",
      verdict_format: "YES/NO",
    });
    expect(result.success).toBe(true);
  });

  it("configSchema rejects fewer than 2 voters", () => {
    const result = driver.configSchema.safeParse({ voters: ["a"] });
    expect(result.success).toBe(false);
  });

  it("configSchema rejects missing voters", () => {
    const result = driver.configSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("configSchema rejects unknown keys", () => {
    const result = driver.configSchema.safeParse({ voters: ["a", "b"], extra: true });
    expect(result.success).toBe(false);
  });

  // -- onAbort -------------------------------------------------------------

  it("onAbort is callable and returns nothing", () => {
    const ctx = createMockContext();
    expect(driver.onAbort(ctx)).toBeUndefined();
  });
});
