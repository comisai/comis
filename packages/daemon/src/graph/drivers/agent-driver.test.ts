import { describe, it, expect } from "vitest";
import { createAgentDriver } from "./agent-driver.js";
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
    typeName: "agent",
    getState: <T>() => state as T | undefined,
    setState: <T>(s: T) => { state = s; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentDriver", () => {
  const driver = createAgentDriver();

  describe("metadata", () => {
    it("has typeId 'agent'", () => {
      expect(driver.typeId).toBe("agent");
    });

    it("has name and description defined", () => {
      expect(driver.name).toBeDefined();
      expect(driver.name.length).toBeGreaterThan(0);
      expect(driver.description).toBeDefined();
      expect(driver.description.length).toBeGreaterThan(0);
    });

    it("has defaultTimeoutMs of 300_000", () => {
      expect(driver.defaultTimeoutMs).toBe(300_000);
    });
  });

  describe("initialize", () => {
    it("returns spawn with correct agentId, task, model, maxSteps from typeConfig", () => {
      const ctx = createMockContext({
        typeConfig: { agent: "my-agent", model: "gpt-4", max_steps: 5 },
      });
      const action = driver.initialize(ctx);
      expect(action).toEqual({
        action: "spawn",
        agentId: "my-agent",
        task: "Test task",
        model: "gpt-4",
        maxSteps: 5,
      });
    });

    it("returns spawn with model/maxSteps undefined when not in typeConfig", () => {
      const ctx = createMockContext({
        typeConfig: { agent: "a" },
      });
      const action = driver.initialize(ctx);
      expect(action).toEqual({
        action: "spawn",
        agentId: "a",
        task: "Test task",
        model: undefined,
        maxSteps: undefined,
      });
    });

    it("uses agentId from typeConfig.agent, not ctx.defaultAgentId", () => {
      const ctx = createMockContext({
        typeConfig: { agent: "specific-agent" },
        defaultAgentId: "should-not-use-this",
      });
      const action = driver.initialize(ctx);
      expect(action).toHaveProperty("action", "spawn");
      expect(action).toHaveProperty("agentId", "specific-agent");
    });
  });

  describe("onTurnComplete", () => {
    it("returns complete with agent output passed through verbatim", () => {
      const ctx = createMockContext();
      const action = driver.onTurnComplete(ctx, "Agent produced this output.");
      expect(action).toEqual({
        action: "complete",
        output: "Agent produced this output.",
      });
    });
  });

  describe("onAbort", () => {
    it("is callable and returns void", () => {
      const ctx = createMockContext();
      expect(() => driver.onAbort(ctx)).not.toThrow();
    });
  });

  describe("estimateDurationMs", () => {
    it("returns 90_000", () => {
      expect(driver.estimateDurationMs({})).toBe(90_000);
    });
  });

  describe("configSchema", () => {
    it("accepts valid config with agent string", () => {
      const result = driver.configSchema.safeParse({ agent: "test" });
      expect(result.success).toBe(true);
    });

    it("rejects empty object (missing agent)", () => {
      const result = driver.configSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys (strictObject)", () => {
      const result = driver.configSchema.safeParse({ agent: "a", unknown_key: "bad" });
      expect(result.success).toBe(false);
    });

    it("rejects empty string agent (min(1) constraint)", () => {
      const result = driver.configSchema.safeParse({ agent: "" });
      expect(result.success).toBe(false);
    });
  });
});
