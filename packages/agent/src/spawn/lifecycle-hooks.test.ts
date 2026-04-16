/**
 * Unit tests for lifecycle hooks and deriveSubagentContextEngineConfig.
 *
 * Tests cover:
 * - prepareSpawn: event emission, belt defense (no directory pre-creation)
 * - onEnded: all three endReasons, belt defense
 * - deriveSubagentContextEngineConfig: inheritance, override, no mutation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createLifecycleHooks, deriveSubagentContextEngineConfig } from "./lifecycle-hooks.js";
import type { ContextEngineConfig, SubagentContextConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps() {
  return {
    logger: {
      info: vi.fn() as Mock,
      warn: vi.fn() as Mock,
      debug: vi.fn() as Mock,
    },
    eventBus: {
      emit: vi.fn() as Mock,
    },
  };
}

const baseParams = {
  runId: "run-123",
  parentSessionKey: "parent:session:key",
  childSessionKey: "child:session:key",
  agentId: "agent-1",
  task: "Analyze data",
  depth: 1,
  maxDepth: 3,
};

// ---------------------------------------------------------------------------
// prepareSpawn tests
// ---------------------------------------------------------------------------

describe("prepareSpawn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined (no rollback needed -- no directory pre-creation)", async () => {
    const deps = createMockDeps();
    const hooks = createLifecycleHooks(deps);

    const result = await hooks.prepareSpawn(baseParams);

    expect(result).toBeUndefined();
  });

  it("emits session:sub_agent_spawn_prepared event", async () => {
    const deps = createMockDeps();
    const hooks = createLifecycleHooks(deps);

    await hooks.prepareSpawn(baseParams);

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_spawn_prepared",
      expect.objectContaining({
        runId: "run-123",
        parentSessionKey: "parent:session:key",
        agentId: "agent-1",
        task: "Analyze data",
        depth: 1,
        maxDepth: 3,
        artifactCount: 0,
        timestamp: expect.any(Number),
      }),
    );
  });

  it("returns undefined when internal error occurs (belt defense)", async () => {
    const deps = createMockDeps();
    deps.eventBus.emit.mockImplementation(() => {
      throw new Error("EventBus crashed");
    });
    const hooks = createLifecycleHooks(deps);

    const result = await hooks.prepareSpawn(baseParams);

    expect(result).toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-123",
        hint: "prepareSubagentSpawn hook internal error",
        errorKind: "internal",
      }),
      expect.stringContaining("prepareSpawn internal error"),
    );
  });
});

// ---------------------------------------------------------------------------
// onEnded tests
// ---------------------------------------------------------------------------

describe("onEnded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits session:sub_agent_lifecycle_ended event for completed endReason", async () => {
    const deps = createMockDeps();
    const hooks = createLifecycleHooks(deps);

    await hooks.onEnded({
      runId: "run-123",
      agentId: "agent-1",
      parentSessionKey: "parent:session:key",
      childSessionKey: "child:session:key",
      endReason: "completed",
      condensedResult: { level: 2 },
      runtimeMs: 5000,
      tokensUsed: 1200,
      cost: 0.05,
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_lifecycle_ended",
      expect.objectContaining({
        runId: "run-123",
        agentId: "agent-1",
        parentSessionKey: "parent:session:key",
        endReason: "completed",
        durationMs: 5000,
        tokensUsed: 1200,
        cost: 0.05,
        condensationLevel: 2,
        timestamp: expect.any(Number),
      }),
    );
  });

  it("handles failed endReason with no condensedResult", async () => {
    const deps = createMockDeps();
    const hooks = createLifecycleHooks(deps);

    await hooks.onEnded({
      runId: "run-456",
      agentId: "agent-2",
      parentSessionKey: "parent:key",
      childSessionKey: "child:key",
      endReason: "failed",
      runtimeMs: 3000,
      tokensUsed: 800,
      cost: 0.02,
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_lifecycle_ended",
      expect.objectContaining({
        endReason: "failed",
        condensationLevel: undefined,
      }),
    );
  });

  it("handles killed endReason", async () => {
    const deps = createMockDeps();
    const hooks = createLifecycleHooks(deps);

    await hooks.onEnded({
      runId: "run-789",
      agentId: "agent-3",
      parentSessionKey: "parent:key",
      childSessionKey: "child:key",
      endReason: "killed",
      runtimeMs: 10000,
      tokensUsed: 0,
      cost: 0,
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_lifecycle_ended",
      expect.objectContaining({
        endReason: "killed",
      }),
    );
  });

  it("does not throw when internal error occurs (belt defense)", async () => {
    const deps = createMockDeps();
    deps.eventBus.emit.mockImplementation(() => {
      throw new Error("EventBus crashed");
    });
    const hooks = createLifecycleHooks(deps);

    // Must NOT throw
    await hooks.onEnded({
      runId: "run-err",
      agentId: "agent-err",
      parentSessionKey: "parent:key",
      childSessionKey: "child:key",
      endReason: "completed",
      runtimeMs: 1000,
      tokensUsed: 100,
      cost: 0.01,
    });

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-err",
        hint: "onSubagentEnded hook internal error",
        errorKind: "internal",
      }),
      expect.stringContaining("onEnded internal error"),
    );
  });
});

// ---------------------------------------------------------------------------
// deriveSubagentContextEngineConfig tests
// ---------------------------------------------------------------------------

describe("deriveSubagentContextEngineConfig", () => {
  it("inherits parent config via spread", () => {
    const parentConfig: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 8,
      historyTurns: 15,
      observationKeepWindow: 15,
      observationTriggerChars: 200_000,
      compactionCooldownTurns: 5,
      compactionModel: "groq:llama",
    };

    const result = deriveSubagentContextEngineConfig(parentConfig, {} as SubagentContextConfig);

    expect(result.compactionModel).toBe("groq:llama");
    expect(result.thinkingKeepTurns).toBe(8);
    expect(result.enabled).toBe(true);
  });

  it("inherits parent compactionModel", () => {
    const parentConfig: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 10,
      historyTurns: 15,
      observationKeepWindow: 15,
      observationTriggerChars: 200_000,
      compactionCooldownTurns: 5,
      compactionModel: "groq:llama",
    };

    const result = deriveSubagentContextEngineConfig(parentConfig, {} as SubagentContextConfig);

    expect(result.compactionModel).toBe("groq:llama");
  });

  it("does not mutate parent config", () => {
    const parentConfig: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 10,
      historyTurns: 15,
      observationKeepWindow: 15,
      observationTriggerChars: 200_000,
      compactionCooldownTurns: 5,
      compactionModel: "groq:llama",
    };

    const originalModel = parentConfig.compactionModel;
    const originalTurns = parentConfig.thinkingKeepTurns;

    deriveSubagentContextEngineConfig(parentConfig, {} as SubagentContextConfig);

    expect(parentConfig.compactionModel).toBe(originalModel);
    expect(parentConfig.thinkingKeepTurns).toBe(originalTurns);
  });
});
