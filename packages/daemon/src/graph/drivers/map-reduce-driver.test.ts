// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { NodeDriverContext } from "@comis/core";
import { createMapReduceDriver } from "./map-reduce-driver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides: Partial<NodeDriverContext> = {}): NodeDriverContext {
  let state: unknown;
  return {
    nodeId: "n1",
    task: "Analyze the data",
    typeConfig: {},
    sharedDir: "/tmp/shared",
    graphLabel: "Test Graph",
    defaultAgentId: "default-agent",
    typeName: "map-reduce",
    getState: <T>() => state as T | undefined,
    setState: <T>(s: T) => { state = s; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMapReduceDriver
// ---------------------------------------------------------------------------

describe("createMapReduceDriver", () => {
  const driver = createMapReduceDriver();

  // -- Metadata ------------------------------------------------------------

  it("has typeId 'map-reduce'", () => {
    expect(driver.typeId).toBe("map-reduce");
  });

  it("has defaultTimeoutMs 600_000", () => {
    expect(driver.defaultTimeoutMs).toBe(600_000);
  });

  // -- Full two-phase flow -------------------------------------------------

  it("runs full mapper -> reducer -> complete flow", () => {
    const ctx = createMockContext({
      typeConfig: {
        mappers: [{ agent: "m1" }, { agent: "m2" }],
        reducer: "red",
      },
    });

    // Phase 1: initialize spawns all mappers
    const init = driver.initialize(ctx);
    expect(init).toEqual({
      action: "spawn_all",
      spawns: [
        { agentId: "m1", task: "Analyze the data" },
        { agentId: "m2", task: "Analyze the data" },
      ],
    });

    // State after initialize is "mapping"
    const stateAfterInit = ctx.getState<{ phase: string; reducer: string; reducerPrompt: unknown }>();
    expect(stateAfterInit).toEqual({
      phase: "mapping",
      reducer: "red",
      reducerPrompt: undefined,
    });

    // Phase 2: onParallelTurnComplete spawns reducer
    const parallel = driver.onParallelTurnComplete!(ctx, [
      { agentId: "m1", output: "O1" },
      { agentId: "m2", output: "O2" },
    ]);
    expect(parallel.action).toBe("spawn");
    if (parallel.action === "spawn") {
      expect(parallel.agentId).toBe("red");
      expect(parallel.task).toContain("Analyze the data");
      expect(parallel.task).toContain("--- Mapper Results ---");
      expect(parallel.task).toContain("[m1]:\nO1");
      expect(parallel.task).toContain("[m2]:\nO2");
      expect(parallel.task).toContain("--- End Mapper Results ---");
      expect(parallel.task).toContain("You are the reducer. Synthesize all mapper results");
    }

    // State after onParallelTurnComplete is "reducing"
    const stateAfterReduce = ctx.getState<{ phase: string }>();
    expect(stateAfterReduce!.phase).toBe("reducing");

    // Phase 3: onTurnComplete completes with reducer output
    const complete = driver.onTurnComplete(ctx, "Reduced output");
    expect(complete).toEqual({ action: "complete", output: "Reduced output" });
  });

  // -- task_suffix for mappers ---------------------------------------------

  it("mappers with task_suffix append suffix to task", () => {
    const ctx = createMockContext({
      typeConfig: {
        mappers: [
          { agent: "m1", task_suffix: "Focus on revenue" },
          { agent: "m2", task_suffix: "Focus on costs" },
        ],
        reducer: "red",
      },
    });

    const init = driver.initialize(ctx);
    expect(init.action).toBe("spawn_all");
    if (init.action === "spawn_all") {
      expect(init.spawns[0].task).toBe("Analyze the data\n\nFocus on revenue");
      expect(init.spawns[1].task).toBe("Analyze the data\n\nFocus on costs");
    }
  });

  // -- Custom reducer_prompt -----------------------------------------------

  it("custom reducer_prompt replaces default reducer instructions", () => {
    const ctx = createMockContext({
      typeConfig: {
        mappers: [{ agent: "m1" }, { agent: "m2" }],
        reducer: "red",
        reducer_prompt: "Merge all findings into a bullet list.",
      },
    });

    driver.initialize(ctx);
    const parallel = driver.onParallelTurnComplete!(ctx, [
      { agentId: "m1", output: "O1" },
      { agentId: "m2", output: "O2" },
    ]);
    expect(parallel.action).toBe("spawn");
    if (parallel.action === "spawn") {
      expect(parallel.task).toContain("Merge all findings into a bullet list.");
      expect(parallel.task).not.toContain("You are the reducer");
    }
  });

  // -- estimateDurationMs --------------------------------------------------

  it("estimateDurationMs returns 180_000", () => {
    expect(driver.estimateDurationMs({})).toBe(180_000);
  });

  // -- configSchema --------------------------------------------------------

  it("configSchema accepts valid config with 2 mappers and reducer", () => {
    const result = driver.configSchema.safeParse({
      mappers: [{ agent: "a" }, { agent: "b" }],
      reducer: "r",
    });
    expect(result.success).toBe(true);
  });

  it("configSchema rejects fewer than 2 mappers", () => {
    const result = driver.configSchema.safeParse({
      mappers: [{ agent: "a" }],
      reducer: "r",
    });
    expect(result.success).toBe(false);
  });

  it("configSchema rejects missing reducer", () => {
    const result = driver.configSchema.safeParse({
      mappers: [{ agent: "a" }, { agent: "b" }],
    });
    expect(result.success).toBe(false);
  });

  it("configSchema rejects mapper with empty agent string", () => {
    const result = driver.configSchema.safeParse({
      mappers: [{ agent: "" }, { agent: "b" }],
      reducer: "r",
    });
    expect(result.success).toBe(false);
  });

  it("configSchema rejects unknown keys", () => {
    const result = driver.configSchema.safeParse({
      mappers: [{ agent: "a" }, { agent: "b" }],
      reducer: "r",
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  // -- onAbort -------------------------------------------------------------

  it("onAbort is callable and returns nothing", () => {
    const ctx = createMockContext();
    expect(driver.onAbort(ctx)).toBeUndefined();
  });
});
