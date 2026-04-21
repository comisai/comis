// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createDebateDriver } from "./debate-driver.js";
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
    typeName: "debate",
    getState: <T>() => state as T | undefined,
    setState: <T>(s: T) => { state = s; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDebateDriver", () => {
  const driver = createDebateDriver();

  describe("metadata", () => {
    it("has typeId 'debate'", () => {
      expect(driver.typeId).toBe("debate");
    });

    it("has defaultTimeoutMs of 600_000", () => {
      expect(driver.defaultTimeoutMs).toBe(600_000);
    });
  });

  describe("full 2-agent 2-round sequence (4 turns)", () => {
    it("executes bull/bear debate through all rounds to completion", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 2 },
      });

      // initialize -> spawn bull for round 1 (opening argument)
      const a1 = driver.initialize(ctx);
      expect(a1).toHaveProperty("action", "spawn");
      expect(a1).toHaveProperty("agentId", "bull");
      const t1 = (a1 as { task: string }).task;
      expect(t1).toContain("round 1 of 2");
      expect(t1).toContain("You are bull");
      expect(t1).toContain("opening argument");
      expect(t1).toContain("shared pipeline folder");
      expect(t1).toContain("/tmp/test-shared");
      expect(t1).toContain("Read the detailed upstream reports");

      // Turn 1: bull completes -> spawn bear for round 1 (must counter, session reuse)
      const a2 = driver.onTurnComplete(ctx, "Bull R1");
      expect(a2).toHaveProperty("action", "spawn");
      expect(a2).toHaveProperty("agentId", "bear");
      const t2 = (a2 as { task: string }).task;
      // After first turn, session reuse task -- references conversation history
      expect(t2).toContain("round 1 of 2");
      expect(t2).toContain("You are bear");
      expect(t2).toContain("different position");
      expect(t2).toContain("conversation history above");
      expect(t2).not.toContain("--- Debate Transcript ---");

      // Turn 2: bear completes -> spawn bull for round 2 (refine/rebut, session reuse)
      const a3 = driver.onTurnComplete(ctx, "Bear R1");
      expect(a3).toHaveProperty("action", "spawn");
      expect(a3).toHaveProperty("agentId", "bull");
      const t3 = (a3 as { task: string }).task;
      expect(t3).toContain("round 2 of 2");
      expect(t3).toContain("strengthen your position");
      // No embedded transcript -- references conversation history
      expect(t3).toContain("conversation history above");
      expect(t3).not.toContain("--- Debate Transcript ---");

      // Turn 3: bull completes -> spawn bear for round 2
      const a4 = driver.onTurnComplete(ctx, "Bull R2");
      expect(a4).toHaveProperty("action", "spawn");
      expect(a4).toHaveProperty("agentId", "bear");

      // Turn 4: bear completes -> complete with transcript
      const a5 = driver.onTurnComplete(ctx, "Bear R2");
      expect(a5).toHaveProperty("action", "complete");
      const output = (a5 as { output: string }).output;
      expect(output).toContain("Debate Transcript");
      expect(output).toContain("[Round 1] bull: Bull R1");
      expect(output).toContain("[Round 1] bear: Bear R1");
      expect(output).toContain("[Round 2] bull: Bull R2");
      expect(output).toContain("[Round 2] bear: Bear R2");
    });
  });

  describe("2-agent 1-round with synthesizer", () => {
    it("completes debate then spawns synthesizer, returns synthesizer output", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 1, synthesizer: "judge" },
      });

      // initialize -> spawn bull
      const a1 = driver.initialize(ctx);
      expect(a1).toHaveProperty("agentId", "bull");

      // bull completes -> spawn bear
      const a2 = driver.onTurnComplete(ctx, "Bull argument");
      expect(a2).toHaveProperty("agentId", "bear");

      // bear completes -> spawn synthesizer (debate rounds done, session reuse)
      const a3 = driver.onTurnComplete(ctx, "Bear argument");
      expect(a3).toHaveProperty("action", "spawn");
      expect(a3).toHaveProperty("agentId", "judge");
      const synthTask = (a3 as { task: string }).task;
      // Session reuse -- references conversation history, no embedded transcript
      expect(synthTask).toContain("You are the synthesizer");
      expect(synthTask).toContain("conversation history above");
      expect(synthTask).toContain("balanced verdict");
      expect(synthTask).toContain("shared pipeline folder");
      expect(synthTask).toContain("/tmp/test-shared");
      expect(synthTask).toContain("Read the detailed upstream reports");
      expect(synthTask).not.toContain("--- Full Debate Transcript ---");

      // synthesizer completes -> complete with synthesizer output (not transcript)
      const a4 = driver.onTurnComplete(ctx, "Synthesized verdict");
      expect(a4).toEqual({ action: "complete", output: "Synthesized verdict" });
    });
  });

  describe("3-agent 1-round (no synthesizer)", () => {
    it("cycles through 3 agents and completes with transcript", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["a", "b", "c"], rounds: 1 },
      });

      const a1 = driver.initialize(ctx);
      expect(a1).toHaveProperty("agentId", "a");

      const a2 = driver.onTurnComplete(ctx, "A says");
      expect(a2).toHaveProperty("agentId", "b");

      const a3 = driver.onTurnComplete(ctx, "B says");
      expect(a3).toHaveProperty("agentId", "c");

      const a4 = driver.onTurnComplete(ctx, "C says");
      expect(a4).toHaveProperty("action", "complete");
      const output = (a4 as { output: string }).output;
      expect(output).toContain("[Round 1] a: A says");
      expect(output).toContain("[Round 1] b: B says");
      expect(output).toContain("[Round 1] c: C says");
    });
  });

  describe("1-round 2-agent minimal", () => {
    it("completes after 2 onTurnComplete calls", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["x", "y"], rounds: 1 },
      });

      driver.initialize(ctx);
      const a2 = driver.onTurnComplete(ctx, "X output");
      expect(a2).toHaveProperty("action", "spawn");

      const a3 = driver.onTurnComplete(ctx, "Y output");
      expect(a3).toHaveProperty("action", "complete");
    });
  });

  describe("state tracking", () => {
    it("correctly advances currentRound and currentAgentIndex", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["a", "b"], rounds: 2 },
      });

      // initialize: state = {currentRound:1, currentAgentIndex:0}
      driver.initialize(ctx);

      // After a completes: index++ -> 1, still round 1 (1 < 2 agents)
      driver.onTurnComplete(ctx, "A R1");
      const s1 = ctx.getState<{ currentRound: number; currentAgentIndex: number }>();
      expect(s1?.currentAgentIndex).toBe(1);
      expect(s1?.currentRound).toBe(1);

      // After b completes: index++ -> 2 >= 2 agents, wrap to 0 and round++ -> 2
      driver.onTurnComplete(ctx, "B R1");
      const s2 = ctx.getState<{ currentRound: number; currentAgentIndex: number }>();
      expect(s2?.currentAgentIndex).toBe(0);
      expect(s2?.currentRound).toBe(2);
    });
  });

  describe("transcript format", () => {
    it("entries are [Round N] agentId: output separated by double newlines", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["alpha", "beta"], rounds: 1 },
      });

      driver.initialize(ctx);
      driver.onTurnComplete(ctx, "Alpha output");
      const result = driver.onTurnComplete(ctx, "Beta output");
      const output = (result as { output: string }).output;
      expect(output).toContain("[Round 1] alpha: Alpha output");
      expect(output).toContain("[Round 1] beta: Beta output");
      // Double newline separation between entries
      expect(output).toContain("[Round 1] alpha: Alpha output\n\n[Round 1] beta: Beta output");
    });
  });

  describe("estimateDurationMs", () => {
    it("returns agents * rounds * 90_000 for debate without synthesizer", () => {
      expect(driver.estimateDurationMs({ agents: ["a", "b"], rounds: 2 })).toBe(4 * 90_000);
    });

    it("adds 90_000 for synthesizer", () => {
      expect(
        driver.estimateDurationMs({ agents: ["a", "b"], rounds: 2, synthesizer: "s" }),
      ).toBe(5 * 90_000);
    });
  });

  describe("configSchema", () => {
    it("accepts valid config with 2+ agents and rounds", () => {
      const result = driver.configSchema.safeParse({
        agents: ["a", "b"],
        rounds: 2,
        synthesizer: "s",
      });
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

    it("rejects rounds: 6 (max 5)", () => {
      const result = driver.configSchema.safeParse({ agents: ["a", "b"], rounds: 6 });
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys (strictObject)", () => {
      const result = driver.configSchema.safeParse({ agents: ["a", "b"], extra: true });
      expect(result.success).toBe(false);
    });

    it("defaults rounds to 2 when not specified", () => {
      const result = driver.configSchema.safeParse({ agents: ["a", "b"] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as { rounds: number }).rounds).toBe(2);
      }
    });
  });

  describe("sharedDir instruction in all rounds", () => {
    it("includes shared pipeline folder instruction in every debate round", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 2 },
      });

      // Round 1, bull (initialize)
      const a1 = driver.initialize(ctx);
      const t1 = (a1 as { task: string }).task;
      expect(t1).toContain("shared pipeline folder");
      expect(t1).toContain("/tmp/test-shared");

      // Round 1, bear (bull completes)
      const a2 = driver.onTurnComplete(ctx, "Bull R1");
      const t2 = (a2 as { task: string }).task;
      expect(t2).toContain("shared pipeline folder");
      expect(t2).toContain("/tmp/test-shared");

      // Round 2, bull (bear completes, advances round)
      const a3 = driver.onTurnComplete(ctx, "Bear R1");
      const t3 = (a3 as { task: string }).task;
      expect(t3).toContain("round 2 of 2");
      expect(t3).toContain("shared pipeline folder");
      expect(t3).toContain("/tmp/test-shared");

      // Round 2, bear (bull completes)
      const a4 = driver.onTurnComplete(ctx, "Bull R2");
      const t4 = (a4 as { task: string }).task;
      expect(t4).toContain("shared pipeline folder");
      expect(t4).toContain("/tmp/test-shared");
    });
  });

  describe("onAbort", () => {
    it("is callable and returns void", () => {
      const ctx = createMockContext();
      expect(() => driver.onAbort(ctx)).not.toThrow();
    });
  });

  describe("persistent session reuse", () => {
    it("initialize() returns spawn WITHOUT reuseSessionKey (first round is always new)", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 2 },
      });

      const action = driver.initialize(ctx);
      expect(action).toHaveProperty("action", "spawn");
      // First round must NOT have reuseSessionKey -- always a fresh session
      expect(action).not.toHaveProperty("reuseSessionKey");
      // And task text uses the original format with the original task included
      const task = (action as { task: string }).task;
      expect(task).toContain("Test task");
      expect(task).toContain("opening argument");
    });

    it("onTurnComplete after round 1 produces session-reuse task WITHOUT transcript embedding", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 2 },
      });

      // Initialize: round 1, bull
      driver.initialize(ctx);
      // Bull completes round 1 -> bear spawns (still round 1, transcript now has 1 entry)
      const a2 = driver.onTurnComplete(ctx, "Bull R1");
      expect(a2).toHaveProperty("action", "spawn");
      expect(a2).toHaveProperty("agentId", "bear");
      const t2 = (a2 as { task: string }).task;
      // Session reuse: task should NOT contain embedded transcript marker
      expect(t2).not.toContain("--- Debate Transcript ---");
      // Should reference "conversation history above" instead
      expect(t2).toContain("conversation history above");
      expect(t2).toContain("different position");
      expect(t2).toContain("shared pipeline folder");
    });

    it("round 2+ task text references conversation history, not embedded transcript", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 2 },
      });

      driver.initialize(ctx);
      driver.onTurnComplete(ctx, "Bull R1");   // -> bear round 1
      driver.onTurnComplete(ctx, "Bear R1");   // -> bull round 2
      const a3 = driver.onTurnComplete(ctx, "Bull R2"); // -> bear round 2

      expect(a3).toHaveProperty("action", "spawn");
      const task = (a3 as { task: string }).task;
      // Should NOT embed transcript in task text
      expect(task).not.toContain("--- Debate Transcript ---");
      // Should reference conversation history
      expect(task).toContain("conversation history above");
      expect(task).toContain("shared pipeline folder");
    });

    it("synthesizer spawn uses session-reuse task referencing conversation history", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 1, synthesizer: "judge" },
      });

      driver.initialize(ctx);
      driver.onTurnComplete(ctx, "Bull argument");
      const synthAction = driver.onTurnComplete(ctx, "Bear argument");

      expect(synthAction).toHaveProperty("action", "spawn");
      expect(synthAction).toHaveProperty("agentId", "judge");
      const synthTask = (synthAction as { task: string }).task;
      // Session reuse: synthesizer should reference conversation history, not embed transcript
      expect(synthTask).not.toContain("--- Full Debate Transcript ---");
      expect(synthTask).toContain("conversation history above");
      expect(synthTask).toContain("balanced verdict");
      expect(synthTask).toContain("shared pipeline folder");
    });

    it("first round initialize task uses full original format with embedded transcript (no reuse)", () => {
      const ctx = createMockContext({
        task: "Analyze the impact of AI on jobs",
        typeConfig: { agents: ["optimist", "pessimist"], rounds: 2 },
      });

      const action = driver.initialize(ctx);
      const task = (action as { task: string }).task;
      // Original task must be included
      expect(task).toContain("Analyze the impact of AI on jobs");
      // No transcript to embed (empty array)
      expect(task).not.toContain("--- Debate Transcript ---");
      // Opening argument format
      expect(task).toContain("opening argument");
    });
  });

  describe("getPartialOutput", () => {
    it("returns undefined when state is not yet initialized (no state set)", () => {
      const ctx = createMockContext();
      // No initialize() call -- getState returns undefined
      expect(driver.getPartialOutput!(ctx)).toBeUndefined();
    });

    it("returns undefined after initialize but before any onTurnComplete (empty transcript)", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 2 },
      });
      driver.initialize(ctx);
      // Transcript is empty -- no rounds completed
      expect(driver.getPartialOutput!(ctx)).toBeUndefined();
    });

    it("returns formatted transcript with partial header after 1 round of a 2-round debate", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 2 },
      });

      driver.initialize(ctx);
      // Complete round 1: bull then bear
      driver.onTurnComplete(ctx, "Bull argues first");
      driver.onTurnComplete(ctx, "Bear counters");
      // Now we're in round 2 but haven't completed it

      const partial = driver.getPartialOutput!(ctx);
      expect(partial).toBeDefined();
      expect(partial).toContain("[Partial");
      expect(partial).toContain("1 of 2 rounds completed");
      expect(partial).toContain("[Round 1] bull: Bull argues first");
      expect(partial).toContain("[Round 1] bear: Bear counters");
      expect(partial).toContain("Debate Transcript");
    });

    it("returns formatted transcript mid-round with partial header", () => {
      const ctx = createMockContext({
        typeConfig: { agents: ["bull", "bear"], rounds: 2 },
      });

      driver.initialize(ctx);
      // Only bull has spoken in round 1
      driver.onTurnComplete(ctx, "Bull argues first");

      const partial = driver.getPartialOutput!(ctx);
      expect(partial).toBeDefined();
      expect(partial).toContain("[Partial");
      expect(partial).toContain("1 of 2 rounds completed");
      expect(partial).toContain("[Round 1] bull: Bull argues first");
    });
  });
});
