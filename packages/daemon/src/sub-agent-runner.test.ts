import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtemp, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("@comis/agent", () => ({
  sanitizeAssistantResponse: (text: string) =>
    text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?final>/g, "").trim(),
}));

import {
  createSubAgentRunner,
  buildAnnouncementMessage,
  validateOutputs,
  classifyAbortReason,
  persistFailureRecord,
  deliverFailureNotification,
  ANNOUNCE_PARENT_TIMEOUT_MS,
  type SubAgentRunnerDeps,
  type ValidationResult,
  type AbortClassification,
} from "./sub-agent-runner.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDeps(): SubAgentRunnerDeps {
  return {
    sessionStore: {
      save: vi.fn(),
      delete: vi.fn(),
    },
    executeAgent: vi.fn().mockResolvedValue({
      response: "task completed successfully",
      tokensUsed: { total: 200 },
      cost: { total: 0.02 },
      finishReason: "stop",
      stepsExecuted: 3,
    }),
    sendToChannel: vi.fn().mockResolvedValue(true),
    eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
    config: {
      enabled: true,
      maxPingPongTurns: 3,
      allowAgents: [],
      subAgentRetentionMs: 3_600_000,
      waitTimeoutMs: 60_000,
      subAgentMaxSteps: 50,
      subAgentToolGroups: ["coding"],
    },
    tenantId: "default",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSubAgentRunner", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Test 1: Spawn returns runId immediately
  // -----------------------------------------------------------------------
  it("spawn returns runId immediately without awaiting executeAgent", () => {
    // Use a never-resolving promise to prove non-blocking
    let resolveExec!: (v: unknown) => void;
    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise((resolve) => { resolveExec = resolve; }),
    );

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "research topic",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
    });

    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);
    // executeAgent called but not yet resolved
    expect(deps.executeAgent).toHaveBeenCalledTimes(1);

    // Run is tracked as running
    const run = runner.getRunStatus(runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe("running");

    // Cleanup: resolve the pending promise
    resolveExec({
      response: "done",
      tokensUsed: { total: 10 },
      cost: { total: 0.001 },
      finishReason: "stop",
      stepsExecuted: 1,
    });
  });

  // -----------------------------------------------------------------------
  // Test 2: Run completes and updates status
  // -----------------------------------------------------------------------
  it("run completes and updates status with result", async () => {
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "summarize document",
      agentId: "default",
    });

    // Allow microtasks to complete
    await vi.advanceTimersByTimeAsync(0);

    const run = runner.getRunStatus(runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe("completed");
    expect(run!.result).toBeDefined();
    expect(run!.result!.response).toBe("task completed successfully");
    expect(run!.result!.tokensUsed.total).toBe(200);
    expect(run!.result!.cost.total).toBe(0.02);
    expect(run!.result!.finishReason).toBe("stop");
    expect(run!.completedAt).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 3: Run failure sets status to "failed"
  // -----------------------------------------------------------------------
  it("run failure sets status to failed with error message", async () => {
    vi.mocked(deps.executeAgent).mockRejectedValue(new Error("LLM quota exceeded"));

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "expensive task",
      agentId: "default",
    });

    await vi.advanceTimersByTimeAsync(0);

    const run = runner.getRunStatus(runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("LLM quota exceeded");
    expect(run!.completedAt).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 4: Allowlist blocks unauthorized agent
  // -----------------------------------------------------------------------
  it("allowlist blocks unauthorized agent", () => {
    deps.config.allowAgents = ["researcher"];

    const runner = createSubAgentRunner(deps);

    expect(() =>
      runner.spawn({
        task: "code something",
        agentId: "coder",
        callerAgentId: "orchestrator",
      }),
    ).toThrow(
      'Agent "orchestrator" is not allowed to spawn "coder". Allowed: researcher',
    );

    expect(deps.executeAgent).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 5: Empty allowlist allows any agent
  // -----------------------------------------------------------------------
  it("empty allowlist allows any agent", () => {
    deps.config.allowAgents = [];

    const runner = createSubAgentRunner(deps);

    // Should not throw
    const runId = runner.spawn({
      task: "anything",
      agentId: "any-agent-id",
    });

    expect(typeof runId).toBe("string");
    expect(deps.executeAgent).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 6: Auto-archive removes old completed runs
  // -----------------------------------------------------------------------
  it("auto-archive removes old completed runs after retention period", async () => {
    deps.config.subAgentRetentionMs = 60_000; // 1 minute for test

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "short task",
      agentId: "default",
    });

    // Complete the run
    await vi.advanceTimersByTimeAsync(0);

    const runBefore = runner.getRunStatus(runId);
    expect(runBefore).toBeDefined();
    expect(runBefore!.status).toBe("completed");

    // Advance past retention period + sweep interval
    vi.advanceTimersByTime(60_000 + 300_001);

    // Run should be archived (removed from Map)
    const runAfter = runner.getRunStatus(runId);
    expect(runAfter).toBeUndefined();

    // sessionStore.delete should have been called
    expect(deps.sessionStore.delete).toHaveBeenCalledTimes(1);

    // Archive event should have been emitted
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_archived",
      expect.objectContaining({
        runId,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 7: ANNOUNCE_SKIP suppresses announcement
  // -----------------------------------------------------------------------
  it("ANNOUNCE_SKIP suppresses announcement", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "result text ANNOUNCE_SKIP",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
      finishReason: "stop",
      stepsExecuted: 2,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "silent task",
      agentId: "default",
      announceChannelType: "telegram",
      announceChannelId: "chat123",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 8: Announce includes [System Message] format with stats
  // -----------------------------------------------------------------------
  it("announce includes [System Message] format with runtime, tokens, cost, session", async () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "visible task",
      agentId: "default",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-1",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deps.sendToChannel).mock.calls[0]![2];
    expect(text).toContain("[System Message]");
    expect(text).toContain("Task: visible task");
    expect(text).toContain("Status: Success");
    expect(text).toContain("Result: task completed successfully");
    expect(text).toContain("Runtime:");
    expect(text).toContain("Tokens: 200");
    expect(text).toContain("Cost: $0.0200");
    expect(text).toContain("Session:");
    // Safety net: internal LLM instruction must be stripped from direct channel delivery
    expect(text).not.toContain("respond with NO_REPLY");
    expect(text).not.toContain("Inform the user about this completed background task");
  });

  // -----------------------------------------------------------------------
  // Test 9: Events emitted on spawn and completion
  // -----------------------------------------------------------------------
  it("emits events on spawn and completion", async () => {
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "event test",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
    });

    // Spawn event emitted immediately
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_spawned",
      expect.objectContaining({
        runId,
        agentId: "researcher",
        task: "event test",
        parentSessionKey: "default:user1:channel1",
      }),
    );

    await vi.advanceTimersByTimeAsync(0);

    // Completion event emitted after execution
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_completed",
      expect.objectContaining({
        runId,
        agentId: "researcher",
        success: true,
        tokensUsed: 200,
        cost: 0.02,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 9b: Completion event has success:false for abnormal finishReason
  // -----------------------------------------------------------------------
  it("emits success:false when finishReason is abnormal", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "partial output",
      tokensUsed: { total: 5000 },
      cost: { total: 0.5 },
      finishReason: "budget_exceeded",
      stepsExecuted: 20,
    });

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "expensive task",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_completed",
      expect.objectContaining({
        runId,
        agentId: "researcher",
        success: false,
        tokensUsed: 5000,
        cost: 0.5,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 9c: Completion event has success:true for end_turn finishReason
  // -----------------------------------------------------------------------
  it("emits success:true when finishReason is end_turn", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "completed via end_turn",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
      finishReason: "end_turn",
      stepsExecuted: 2,
    });

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "end turn task",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_completed",
      expect.objectContaining({
        runId,
        agentId: "researcher",
        success: true,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 10: Shutdown waits for active runs
  // -----------------------------------------------------------------------
  it("shutdown waits for active runs to complete", async () => {
    let resolveExec!: (v: unknown) => void;
    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise((resolve) => { resolveExec = resolve; }),
    );

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "slow task",
      agentId: "default",
    });

    // Start shutdown (should not resolve immediately because run is active)
    let shutdownResolved = false;
    const shutdownPromise = runner.shutdown().then(() => { shutdownResolved = true; });

    // Allow microtask to check - shutdown should not resolve yet
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdownResolved).toBe(false);

    // Resolve the active run
    resolveExec({
      response: "finally done",
      tokensUsed: { total: 50 },
      cost: { total: 0.005 },
      finishReason: "stop",
      stepsExecuted: 1,
    });

    // Now shutdown should resolve
    await vi.advanceTimersByTimeAsync(0);
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 11: getRunStatus returns undefined for unknown runId
  // -----------------------------------------------------------------------
  it("getRunStatus returns undefined for unknown runId", () => {
    const runner = createSubAgentRunner(deps);
    expect(runner.getRunStatus("nonexistent-id")).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 12: Lifecycle logs emitted when logger provided
  // -----------------------------------------------------------------------
  it("emits lifecycle logs when logger is provided", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "logged task",
      agentId: "default",
      callerSessionKey: "default:user1:channel1",
    });

    // Spawn log emitted immediately
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId, agentId: "default" }),
      "Sub-agent spawn initiated",
    );

    // Allow execution to complete
    await vi.advanceTimersByTimeAsync(0);

    // Completion log emitted
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId, finishReason: "stop" }),
      "Sub-agent execution completed",
    );
  });

  // -----------------------------------------------------------------------
  // Test 13: Session store save called with correct metadata
  // -----------------------------------------------------------------------
  it("saves sub-agent session with correct metadata", () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "metadata test",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
      callerAgentId: "orchestrator",
      model: "claude-3-opus",
    });

    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;
    const metadata = saveCall[2] as Record<string, unknown>;
    expect(metadata.parentSessionKey).toBe("default:user1:channel1");
    expect(metadata.spawnedByAgent).toBe("orchestrator");
    expect(metadata.taskDescription).toBe("metadata test");
    expect(metadata.modelOverride).toBe("claude-3-opus");
    expect(metadata.runId).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 14: buildAnnouncementMessage formats success template
  // -----------------------------------------------------------------------
  it("buildAnnouncementMessage formats success template with [System Message] prefix", () => {
    const result = buildAnnouncementMessage({
      task: "Summarize doc",
      status: "completed",
      response: "Summary here",
      runtimeMs: 5000,
      tokensUsed: 100,
      cost: 0.001,
      finishReason: "stop",
      sessionKey: "t:u:c",
    });

    expect(result).toMatch(/^\[System Message\]/);
    expect(result).toContain("Task: Summarize doc");
    expect(result).toContain("Status: Success");
    expect(result).toContain("Result: Summary here");
    expect(result).toContain("Runtime: 5.0s");
    expect(result).toContain("Tokens: 100");
    expect(result).toContain("Cost: $0.0010");
    expect(result).toContain("respond with NO_REPLY");
  });

  // -----------------------------------------------------------------------
  // Test 15: buildAnnouncementMessage formats failure template
  // -----------------------------------------------------------------------
  it("buildAnnouncementMessage formats failure template", () => {
    const result = buildAnnouncementMessage({
      task: "Failing task",
      status: "failed",
      error: "API timeout",
      runtimeMs: 3000,
      tokensUsed: 0,
      cost: 0,
      sessionKey: "t:u:c",
    });

    expect(result).toMatch(/^\[System Message\]/);
    expect(result).toContain("Status: Failed");
    expect(result).toContain("Error: API timeout");
    expect(result).toContain("A background task has failed");
  });

  // -----------------------------------------------------------------------
  // Test 16: buildAnnouncementMessage formats halted (max_steps) template
  // -----------------------------------------------------------------------
  it("buildAnnouncementMessage formats halted (max_steps) template", () => {
    const result = buildAnnouncementMessage({
      task: "Long task",
      status: "completed",
      response: "Partial output",
      runtimeMs: 60000,
      tokensUsed: 5000,
      cost: 0.5,
      finishReason: "max_steps",
      sessionKey: "t:u:c",
    });

    expect(result).toContain("halted (max steps reached)");
    expect(result).toContain("Halted (max steps reached)");
  });

  // -----------------------------------------------------------------------
  // Test 17: Spawn uses announceToParent when available
  // -----------------------------------------------------------------------
  it("spawn uses announceToParent when available and callerSessionKey present", async () => {
    const announceToParent = vi.fn().mockResolvedValue(undefined);
    deps.announceToParent = announceToParent;

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "delegated work",
      agentId: "default",
      callerAgentId: "parent",
      callerSessionKey: "default:user1:channel1",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await vi.advanceTimersByTimeAsync(0);

    // announceToParent was called, not sendToChannel
    expect(announceToParent).toHaveBeenCalledTimes(1);
    expect(deps.sendToChannel).not.toHaveBeenCalled();

    // Text argument starts with [System Message]
    const text = announceToParent.mock.calls[0]![2];
    expect(text).toMatch(/^\[System Message\]/);

    // Session key was parsed correctly
    const callerSk = announceToParent.mock.calls[0]![1];
    expect(callerSk).toEqual(
      expect.objectContaining({
        tenantId: "default",
        userId: "user1",
        channelId: "channel1",
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 18: Spawn falls back to sendToChannel when announceToParent absent
  // -----------------------------------------------------------------------
  it("spawn falls back to sendToChannel when announceToParent is not provided", async () => {
    // No announceToParent in deps (default mock)
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "fallback task",
      agentId: "default",
      callerAgentId: "parent",
      callerSessionKey: "default:user1:channel1",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deps.sendToChannel).mock.calls[0]![2];
    expect(text).toContain("[System Message]");
  });

  // -----------------------------------------------------------------------
  // Test 19: Spawn falls back to sendToChannel when announceToParent throws
  // -----------------------------------------------------------------------
  it("spawn falls back to sendToChannel when announceToParent throws", async () => {
    const announceToParent = vi.fn().mockRejectedValue(new Error("Parent session unavailable"));
    deps.announceToParent = announceToParent;

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "error fallback",
      agentId: "default",
      callerAgentId: "parent",
      callerSessionKey: "default:user1:channel1",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await vi.advanceTimersByTimeAsync(0);

    // announceToParent was attempted
    expect(announceToParent).toHaveBeenCalledTimes(1);
    // Fell back to sendToChannel
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deps.sendToChannel).mock.calls[0]![2];
    expect(text).toContain("[System Message]");
  });

  // -----------------------------------------------------------------------
  // Test 20: buildAnnouncementMessage formats context_exhausted template
  // -----------------------------------------------------------------------
  it("buildAnnouncementMessage formats context_exhausted template", () => {
    const result = buildAnnouncementMessage({
      task: "Big task",
      status: "completed",
      response: "Partial output",
      runtimeMs: 30000,
      tokensUsed: 10000,
      cost: 1.0,
      finishReason: "context_exhausted",
      sessionKey: "t:u:c",
    });

    expect(result).toContain("halted (context exhausted)");
    expect(result).toContain("Halted (context exhausted)");
  });

  // -----------------------------------------------------------------------
  // Test 21: buildAnnouncementMessage formats budget_exceeded template
  // -----------------------------------------------------------------------
  it("buildAnnouncementMessage formats budget_exceeded template", () => {
    const result = buildAnnouncementMessage({
      task: "Expensive task",
      status: "completed",
      response: "Partial output",
      runtimeMs: 20000,
      tokensUsed: 8000,
      cost: 2.0,
      finishReason: "budget_exceeded",
      sessionKey: "t:u:c",
    });

    expect(result).toContain("halted (budget exceeded)");
    expect(result).toContain("Halted (budget exceeded)");
  });

  // -----------------------------------------------------------------------
  // Test 22: buildAnnouncementMessage formats context_loop template
  // -----------------------------------------------------------------------
  it("buildAnnouncementMessage formats context_loop template", () => {
    const result = buildAnnouncementMessage({
      task: "Looping task",
      status: "completed",
      response: "Repeated output",
      runtimeMs: 45000,
      tokensUsed: 6000,
      cost: 0.8,
      finishReason: "context_loop",
      sessionKey: "t:u:c",
    });

    expect(result).toContain("halted (context loop)");
    expect(result).toContain("Halted (context loop)");
  });

  // -----------------------------------------------------------------------
  // Test 23: Empty response logs warning
  // -----------------------------------------------------------------------
  it("empty response logs warning with actionable hint", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "",
      tokensUsed: { total: 50 },
      cost: { total: 0.01 },
      finishReason: "stop",
      stepsExecuted: 1,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "empty result task",
      agentId: "default",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("empty response"),
        errorKind: "internal",
      }),
      "Sub-agent produced empty output",
    );
  });

  // -----------------------------------------------------------------------
  // Test 24: Completion log includes responseLength
  // -----------------------------------------------------------------------
  it("completion log includes responseLength and agentId", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "hello world",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
      finishReason: "stop",
      stepsExecuted: 2,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "length test",
      agentId: "researcher",
    });

    await vi.advanceTimersByTimeAsync(0);

    // Find the completion log call
    const completionCall = logger.info.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent execution completed",
    );
    expect(completionCall).toBeDefined();
    expect(completionCall![0]).toEqual(
      expect.objectContaining({
        responseLength: 11, // "hello world".length
        agentId: "researcher",
      }),
    );
  });

  // -----------------------------------------------------------------------
  // cacheEffectiveness in completion log
  // -----------------------------------------------------------------------
  it("completion log includes cacheEffectiveness metric", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "done",
      tokensUsed: { total: 1000, cacheRead: 800, cacheWrite: 200 },
      cost: { total: 0.05 },
      finishReason: "stop",
      stepsExecuted: 5,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "cache effectiveness test",
      agentId: "test-agent",
    });

    await vi.advanceTimersByTimeAsync(0);

    const completionCall = logger.info.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent execution completed",
    );
    expect(completionCall).toBeDefined();
    expect(completionCall![0]).toEqual(
      expect.objectContaining({
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        cacheEffectiveness: 0.8, // 800 / (800 + 200) = 0.8
      }),
    );
  });

  it("cacheEffectiveness is 0 when no cache activity", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "done",
      tokensUsed: { total: 500 },
      cost: { total: 0.01 },
      finishReason: "stop",
      stepsExecuted: 2,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "no cache test",
      agentId: "test-agent",
    });

    await vi.advanceTimersByTimeAsync(0);

    const completionCall = logger.info.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent execution completed",
    );
    expect(completionCall).toBeDefined();
    expect(completionCall![0]).toEqual(
      expect.objectContaining({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheEffectiveness: 0,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 25: Kill log includes durationMs and task
  // -----------------------------------------------------------------------
  it("kill log includes durationMs and task excerpt", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    // Use a never-resolving promise so the run stays "running"
    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise(() => {}),
    );

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "long running task for kill test",
      agentId: "default",
    });

    // Advance some time so durationMs > 0
    vi.advanceTimersByTime(5000);

    runner.killRun(runId);

    // Find the kill log call
    const killCall = logger.info.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent run killed by parent",
    );
    expect(killCall).toBeDefined();
    expect(killCall![0]).toEqual(
      expect.objectContaining({
        runId,
        durationMs: expect.any(Number),
        task: expect.stringContaining("long running task"),
      }),
    );
    expect((killCall![0] as Record<string, unknown>).durationMs).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Test 25b: killRun calls activeRunRegistry.abort when registry provided
  // -----------------------------------------------------------------------
  it("killRun calls activeRunRegistry.abort when registry provided", () => {
    const abortMock = vi.fn().mockResolvedValue(undefined);
    const registryMock = {
      get: vi.fn().mockReturnValue({ abort: abortMock }),
    };
    deps.activeRunRegistry = registryMock;

    // Use a never-resolving promise so the run stays "running"
    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise(() => {}),
    );

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "task to abort",
      agentId: "default",
    });

    const run = runner.getRunStatus(runId)!;
    const sessionKey = run.sessionKey;

    const result = runner.killRun(runId);
    expect(result.killed).toBe(true);
    expect(registryMock.get).toHaveBeenCalledWith(sessionKey);
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 25c: killRun works normally when activeRunRegistry is not provided
  // -----------------------------------------------------------------------
  it("killRun works normally when activeRunRegistry is not provided", () => {
    // activeRunRegistry is not set (default from createMockDeps)
    // Use a never-resolving promise so the run stays "running"
    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise(() => {}),
    );

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "task without registry",
      agentId: "default",
    });

    const result = runner.killRun(runId);
    expect(result.killed).toBe(true);
    expect(runner.getRunStatus(runId)!.status).toBe("failed");
  });

  // -----------------------------------------------------------------------
  // Test 25d: killRun handles abort rejection gracefully (best-effort)
  // -----------------------------------------------------------------------
  it("killRun handles abort rejection gracefully", () => {
    const abortMock = vi.fn().mockRejectedValue(new Error("Already terminated"));
    const registryMock = {
      get: vi.fn().mockReturnValue({ abort: abortMock }),
    };
    deps.activeRunRegistry = registryMock;
    deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise(() => {}),
    );

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "task with abort error",
      agentId: "default",
    });

    // Should not throw
    const result = runner.killRun(runId);
    expect(result.killed).toBe(true);
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 25e: killRun skips abort when registry has no handle for session
  // -----------------------------------------------------------------------
  it("killRun skips abort when registry has no handle for session", () => {
    const registryMock = {
      get: vi.fn().mockReturnValue(undefined),
    };
    deps.activeRunRegistry = registryMock;

    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise(() => {}),
    );

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "task no handle",
      agentId: "default",
    });

    const result = runner.killRun(runId);
    expect(result.killed).toBe(true);
    expect(registryMock.get).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 28: Spawn INFO log includes maxSteps and toolProfile
  // -----------------------------------------------------------------------
  it("spawn INFO log includes maxSteps and toolProfile", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "log fields test",
      agentId: "default",
    });

    const spawnCall = logger.info.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent spawn initiated",
    );
    expect(spawnCall).toBeDefined();
    expect(spawnCall![0]).toEqual(
      expect.objectContaining({
        maxSteps: 50,
        toolProfile: ["coding"],
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 29: buildAnnouncementMessage includes step count
  // -----------------------------------------------------------------------
  it("buildAnnouncementMessage includes step count in stats line", () => {
    const result = buildAnnouncementMessage({
      task: "Step count task",
      status: "completed",
      response: "Done",
      runtimeMs: 5000,
      stepsExecuted: 12,
      tokensUsed: 100,
      cost: 0.001,
      finishReason: "stop",
      sessionKey: "t:u:c",
    });

    expect(result).toContain("Steps: 12");
  });

  // -----------------------------------------------------------------------
  // Test 30: buildAnnouncementMessage defaults step count to 0
  // -----------------------------------------------------------------------
  it("buildAnnouncementMessage defaults step count to 0 when not provided", () => {
    const result = buildAnnouncementMessage({
      task: "No steps task",
      status: "completed",
      response: "Done",
      runtimeMs: 5000,
      tokensUsed: 100,
      cost: 0.001,
      finishReason: "stop",
      sessionKey: "t:u:c",
    });

    expect(result).toContain("Steps: 0");
  });

  // -----------------------------------------------------------------------
  // Test 31: Completed run result includes stepsExecuted
  // -----------------------------------------------------------------------
  it("completed run result includes stepsExecuted", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "done with steps",
      tokensUsed: { total: 150 },
      cost: { total: 0.015 },
      finishReason: "stop",
      stepsExecuted: 5,
    });

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "steps tracking test",
      agentId: "default",
    });

    await vi.advanceTimersByTimeAsync(0);

    const run = runner.getRunStatus(runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe("completed");
    expect(run!.result!.stepsExecuted).toBe(5);
  });

  // -----------------------------------------------------------------------
  // Test 32: max_steps is passed to executeAgent
  // -----------------------------------------------------------------------
  it("max_steps is passed to executeAgent as 5th argument", async () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "limited steps task",
      agentId: "default",
      max_steps: 30,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.executeAgent).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ tenantId: "default" }),
      "limited steps task",
      30,
      undefined,
      undefined,  // graphOverrides (undefined for non-graph spawns)
    );
  });

  // -----------------------------------------------------------------------
  // Test 33: Spawn log shows per-spawn maxSteps when provided
  // -----------------------------------------------------------------------
  it("spawn INFO log shows per-spawn maxSteps when provided", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "per-spawn steps test",
      agentId: "default",
      max_steps: 20,
    });

    const spawnCall = logger.info.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent spawn initiated",
    );
    expect(spawnCall).toBeDefined();
    expect(spawnCall![0]).toEqual(
      expect.objectContaining({
        maxSteps: 20,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // callerAgentId passthrough
  // -----------------------------------------------------------------------
  it("passes callerAgentId to executeAgent", async () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "test task",
      agentId: "sub-agent",
      callerAgentId: "parent-agent",
      callerSessionKey: "default:user:chan",
    });
    await vi.waitFor(() => {
      expect(deps.executeAgent).toHaveBeenCalled();
    });
    const call = (deps.executeAgent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[4]).toBe("parent-agent");
  });

  it("passes undefined callerAgentId when not provided", async () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "test task",
      agentId: "sub-agent",
    });
    await vi.waitFor(() => {
      expect(deps.executeAgent).toHaveBeenCalled();
    });
    const call = (deps.executeAgent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[4]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Spawn limits
  // -----------------------------------------------------------------------
  describe("spawn limits", () => {
    function createLimitDeps(): SubAgentRunnerDeps {
      return {
        sessionStore: {
          save: vi.fn(),
          delete: vi.fn(),
        },
        executeAgent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves -- keeps children "running"
        sendToChannel: vi.fn().mockResolvedValue(true),
        eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
        config: {
          enabled: true,
          maxPingPongTurns: 3,
          allowAgents: [],
          subAgentRetentionMs: 3_600_000,
          waitTimeoutMs: 60_000,
          subAgentMaxSteps: 50,
          subAgentToolGroups: ["coding"],
          subagentContext: {
            maxSpawnDepth: 3,
            maxChildrenPerAgent: 5,
          },
        } as SubAgentRunnerDeps["config"],
        tenantId: "default",
      };
    }

    it("rejects spawn when depth limit exceeded", () => {
      const limitDeps = createLimitDeps();
      const runner = createSubAgentRunner(limitDeps);

      expect(() =>
        runner.spawn({
          task: "deep task",
          agentId: "agent-a",
          callerSessionKey: "default:user1:ch1",
          depth: 3,
          maxDepth: 3,
        }),
      ).toThrow(/depth limit exceeded/i);

      // Verify rejection event emitted
      expect(limitDeps.eventBus.emit).toHaveBeenCalledWith(
        "session:sub_agent_spawn_rejected",
        expect.objectContaining({
          reason: "depth_exceeded",
          currentDepth: 3,
          maxDepth: 3,
        }),
      );

      // Verify session was NOT created (limit check before session creation)
      expect(limitDeps.sessionStore.save).not.toHaveBeenCalled();
    });

    it("queues spawn when active children limit exceeded (default queuing)", () => {
      const limitDeps = createLimitDeps();
      const runner = createSubAgentRunner(limitDeps);

      // Spawn 5 children from same callerSessionKey (all stay "running")
      for (let i = 0; i < 5; i++) {
        runner.spawn({
          task: `child task ${i}`,
          agentId: "agent-a",
          callerSessionKey: "default:user1:ch1",
          depth: 0,
          maxDepth: 3,
        });
      }

      // 6th spawn should NOT throw -- it gets queued
      const queuedRunId = runner.spawn({
        task: "child task 5",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      });

      expect(typeof queuedRunId).toBe("string");
      const queuedRun = runner.getRunStatus(queuedRunId);
      expect(queuedRun).toBeDefined();
      expect(queuedRun!.status).toBe("queued");
      expect(queuedRun!.queuedAt).toBeDefined();

      // Verify queued event emitted
      expect(limitDeps.eventBus.emit).toHaveBeenCalledWith(
        "session:sub_agent_spawn_queued",
        expect.objectContaining({
          runId: queuedRunId,
          agentId: "agent-a",
          queuePosition: 1,
          activeChildren: 5,
          maxChildren: 5,
        }),
      );
    });

    it("graph-spawned nodes bypass children limit", () => {
      const limitDeps = createLimitDeps();
      const runner = createSubAgentRunner(limitDeps);

      // Spawn 5 regular children (saturates the limit)
      for (let i = 0; i < 5; i++) {
        runner.spawn({
          task: `child task ${i}`,
          agentId: "agent-a",
          callerSessionKey: "default:user1:ch1",
          depth: 0,
          maxDepth: 3,
        });
      }

      // 6th spawn with callerType: "graph" should succeed
      const runId = runner.spawn({
        task: "graph node task",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
        callerType: "graph",
      });

      expect(typeof runId).toBe("string");
      expect(runId.length).toBeGreaterThan(0);

      const run = runner.getRunStatus(runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe("running");
    });

    it("depth check still applies to graph spawns", () => {
      const limitDeps = createLimitDeps();
      const runner = createSubAgentRunner(limitDeps);

      expect(() =>
        runner.spawn({
          task: "deep graph task",
          agentId: "agent-a",
          callerSessionKey: "default:user1:ch1",
          depth: 3,
          maxDepth: 3,
          callerType: "graph",
        }),
      ).toThrow(/depth limit exceeded/i);
    });

    it("spawn at depth < maxDepth succeeds", () => {
      const limitDeps = createLimitDeps();
      const runner = createSubAgentRunner(limitDeps);

      const runId = runner.spawn({
        task: "valid depth task",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 2,
        maxDepth: 3,
      });

      expect(typeof runId).toBe("string");
      const run = runner.getRunStatus(runId);
      expect(run).toBeDefined();
      expect(run!.depth).toBe(2);
    });

    it("session metadata includes spawnDepth and maxSpawnDepth", () => {
      const limitDeps = createLimitDeps();
      const runner = createSubAgentRunner(limitDeps);

      runner.spawn({
        task: "metadata test task",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 1,
        maxDepth: 3,
      });

      expect(limitDeps.sessionStore.save).toHaveBeenCalledWith(
        expect.any(Object), // SessionKey
        expect.any(Array),  // messages
        expect.objectContaining({
          spawnDepth: 2,       // current (1) + 1
          maxSpawnDepth: 3,
        }),
      );
    });

    it("defaults to depth 0 when not provided", () => {
      const limitDeps = createLimitDeps();
      const runner = createSubAgentRunner(limitDeps);

      const runId = runner.spawn({
        task: "no depth params",
        agentId: "agent-a",
      });

      const run = runner.getRunStatus(runId);
      expect(run).toBeDefined();
      expect(run!.depth).toBe(0);

      // Session metadata should have spawnDepth: 1 (0 + 1)
      expect(limitDeps.sessionStore.save).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Array),
        expect.objectContaining({
          spawnDepth: 1,
        }),
      );
    });

    it("queued spawn promotes to running when sibling completes", async () => {
      // Use maxChildrenPerAgent: 1 for simplicity
      let resolveExec1!: (v: unknown) => void;
      const limitDeps: SubAgentRunnerDeps = {
        sessionStore: { save: vi.fn(), delete: vi.fn() },
        executeAgent: vi.fn().mockReturnValueOnce(
          new Promise((resolve) => { resolveExec1 = resolve; }),
        ).mockResolvedValue({
          response: "done", tokensUsed: { total: 10 }, cost: { total: 0.001 },
          finishReason: "stop", stepsExecuted: 1,
        }),
        sendToChannel: vi.fn().mockResolvedValue(true),
        eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
        config: {
          enabled: true, maxPingPongTurns: 3, allowAgents: [],
          subAgentRetentionMs: 3_600_000, waitTimeoutMs: 60_000,
          subAgentMaxSteps: 50, subAgentToolGroups: ["coding"],
          subagentContext: { maxSpawnDepth: 3, maxChildrenPerAgent: 1, maxQueuedPerAgent: 10 },
        } as SubAgentRunnerDeps["config"],
        tenantId: "default",
      };

      const runner = createSubAgentRunner(limitDeps);

      // Spawn child 1 (runs)
      const runId1 = runner.spawn({
        task: "child 1", agentId: "agent-a",
        callerSessionKey: "default:user1:ch1", depth: 0, maxDepth: 3,
      });
      expect(runner.getRunStatus(runId1)!.status).toBe("running");

      // Spawn child 2 (queued because maxChildrenPerAgent: 1)
      const runId2 = runner.spawn({
        task: "child 2", agentId: "agent-a",
        callerSessionKey: "default:user1:ch1", depth: 0, maxDepth: 3,
      });
      expect(runner.getRunStatus(runId2)!.status).toBe("queued");

      // Resolve child 1 execution
      resolveExec1({
        response: "done", tokensUsed: { total: 10 }, cost: { total: 0.001 },
        finishReason: "stop", stepsExecuted: 1,
      });

      // Allow microtasks to complete (execution + drain)
      await vi.advanceTimersByTimeAsync(0);

      // Child 2 should have been promoted to running
      const run2 = runner.getRunStatus(runId2);
      expect(run2).toBeDefined();
      expect(run2!.status === "running" || run2!.status === "completed").toBe(true);
    });

    it("throws when queue is full (maxQueuedPerAgent exceeded)", () => {
      const limitDeps: SubAgentRunnerDeps = {
        sessionStore: { save: vi.fn(), delete: vi.fn() },
        executeAgent: vi.fn().mockReturnValue(new Promise(() => {})),
        sendToChannel: vi.fn().mockResolvedValue(true),
        eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
        config: {
          enabled: true, maxPingPongTurns: 3, allowAgents: [],
          subAgentRetentionMs: 3_600_000, waitTimeoutMs: 60_000,
          subAgentMaxSteps: 50, subAgentToolGroups: ["coding"],
          subagentContext: { maxSpawnDepth: 3, maxChildrenPerAgent: 1, maxQueuedPerAgent: 2 },
        } as SubAgentRunnerDeps["config"],
        tenantId: "default",
      };

      const runner = createSubAgentRunner(limitDeps);
      const callerKey = "default:user1:ch1";

      // 1 running
      runner.spawn({ task: "running child", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 });

      // 2 queued
      runner.spawn({ task: "queued 1", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 });
      runner.spawn({ task: "queued 2", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 });

      // 4th spawn should throw with queue_full
      expect(() =>
        runner.spawn({ task: "overflow", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 }),
      ).toThrow(/queue full/i);

      expect(limitDeps.eventBus.emit).toHaveBeenCalledWith(
        "session:sub_agent_spawn_rejected",
        expect.objectContaining({ reason: "queue_full" }),
      );
    });

    it("maxQueuedPerAgent: 0 preserves old throw behavior", () => {
      const limitDeps: SubAgentRunnerDeps = {
        sessionStore: { save: vi.fn(), delete: vi.fn() },
        executeAgent: vi.fn().mockReturnValue(new Promise(() => {})),
        sendToChannel: vi.fn().mockResolvedValue(true),
        eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
        config: {
          enabled: true, maxPingPongTurns: 3, allowAgents: [],
          subAgentRetentionMs: 3_600_000, waitTimeoutMs: 60_000,
          subAgentMaxSteps: 50, subAgentToolGroups: ["coding"],
          subagentContext: { maxSpawnDepth: 3, maxChildrenPerAgent: 1, maxQueuedPerAgent: 0 },
        } as SubAgentRunnerDeps["config"],
        tenantId: "default",
      };

      const runner = createSubAgentRunner(limitDeps);
      const callerKey = "default:user1:ch1";

      // 1 running
      runner.spawn({ task: "running child", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 });

      // 2nd spawn should throw immediately (no queuing)
      expect(() =>
        runner.spawn({ task: "rejected child", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 }),
      ).toThrow(/children limit exceeded/i);

      expect(limitDeps.eventBus.emit).toHaveBeenCalledWith(
        "session:sub_agent_spawn_rejected",
        expect.objectContaining({ reason: "children_exceeded" }),
      );
    });

    it("queued spawns timeout after queueTimeoutMs", () => {
      vi.useFakeTimers();
      const limitDeps: SubAgentRunnerDeps = {
        sessionStore: { save: vi.fn(), delete: vi.fn() },
        executeAgent: vi.fn().mockReturnValue(new Promise(() => {})),
        sendToChannel: vi.fn().mockResolvedValue(true),
        eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
        config: {
          enabled: true, maxPingPongTurns: 3, allowAgents: [],
          subAgentRetentionMs: 3_600_000, waitTimeoutMs: 60_000,
          subAgentMaxSteps: 50, subAgentToolGroups: ["coding"],
          subagentContext: { maxSpawnDepth: 3, maxChildrenPerAgent: 1, maxQueuedPerAgent: 10, queueTimeoutMs: 5_000 },
        } as SubAgentRunnerDeps["config"],
        tenantId: "default",
      };

      const runner = createSubAgentRunner(limitDeps);
      const callerKey = "default:user1:ch1";

      // 1 running + 1 queued
      runner.spawn({ task: "running child", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 });
      const queuedRunId = runner.spawn({ task: "queued child", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 });

      expect(runner.getRunStatus(queuedRunId)!.status).toBe("queued");

      // Advance past queueTimeoutMs + sweep interval (300_000ms)
      vi.advanceTimersByTime(300_001);

      // Queued run should have timed out
      const run = runner.getRunStatus(queuedRunId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Queue timeout");

      expect(limitDeps.eventBus.emit).toHaveBeenCalledWith(
        "session:sub_agent_spawn_rejected",
        expect.objectContaining({ reason: "queue_timeout" }),
      );
    });

    it("10-node graph completes without rejection at maxChildrenPerAgent: 5", () => {
      const limitDeps = createLimitDeps();
      const runner = createSubAgentRunner(limitDeps);
      const callerSessionKey = "default:user1:ch1";
      const runIds: string[] = [];

      // Spawn 10 nodes with callerType: "graph" from the same callerSessionKey
      // All 10 should succeed, proving graph bypass handles >5 children
      for (let i = 0; i < 10; i++) {
        const runId = runner.spawn({
          task: `graph node ${i}`,
          agentId: "agent-a",
          callerSessionKey,
          depth: 0,
          maxDepth: 3,
          callerType: "graph",
        });
        runIds.push(runId);
      }

      // All 10 spawns succeeded
      expect(runIds).toHaveLength(10);

      // All 10 are running (unique run IDs)
      const uniqueIds = new Set(runIds);
      expect(uniqueIds.size).toBe(10);

      // Verify all runs are tracked and running
      for (const runId of runIds) {
        const run = runner.getRunStatus(runId);
        expect(run).toBeDefined();
        expect(run!.status).toBe("running");
      }

      // Verify NO rejection events were emitted
      const emitCalls = (limitDeps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const rejectionCalls = emitCalls.filter(
        ([event]: [string]) => event === "session:sub_agent_spawn_rejected",
      );
      expect(rejectionCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Graph-scoped abort group
  // -----------------------------------------------------------------------
  describe("graph-scoped abort group", () => {
    function createAbortGroupDeps(): SubAgentRunnerDeps {
      return {
        sessionStore: {
          save: vi.fn(),
          delete: vi.fn(),
        },
        executeAgent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves -- keeps children "running"
        sendToChannel: vi.fn().mockResolvedValue(true),
        eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
        config: {
          enabled: true,
          maxPingPongTurns: 3,
          allowAgents: [],
          subAgentRetentionMs: 3_600_000,
          waitTimeoutMs: 60_000,
          subAgentMaxSteps: 50,
          subAgentToolGroups: ["coding"],
          subagentContext: {
            maxSpawnDepth: 3,
            maxChildrenPerAgent: 5,
          },
        } as SubAgentRunnerDeps["config"],
        tenantId: "default",
      };
    }

    it("graph-spawned run has abortGroup set to graph:<graphId>", () => {
      const abortDeps = createAbortGroupDeps();
      const runner = createSubAgentRunner(abortDeps);

      const runId = runner.spawn({
        task: "graph task",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
        callerType: "graph",
        graphId: "g-test-123",
      });

      const run = runner.getRunStatus(runId);
      expect(run).toBeDefined();
      expect(run!.abortGroup).toBe("graph:g-test-123");
    });

    it("regular (non-graph) spawn has abortGroup set to callerSessionKey", () => {
      const abortDeps = createAbortGroupDeps();
      const runner = createSubAgentRunner(abortDeps);

      const runId = runner.spawn({
        task: "regular task",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      });

      const run = runner.getRunStatus(runId);
      expect(run).toBeDefined();
      expect(run!.abortGroup).toBe("default:user1:ch1");
    });

    it("graph-spawned run drains graph group (not callerSessionKey) on completion", async () => {
      const abortDeps = createAbortGroupDeps();
      (abortDeps.config as Record<string, unknown>).subagentContext = {
        maxSpawnDepth: 3,
        maxChildrenPerAgent: 5,
        maxQueuedPerAgent: 10,
      };

      // Create a resolve callback to control when the graph spawn completes
      let resolveGraphExec!: (v: unknown) => void;
      const graphExecPromise = new Promise((resolve) => { resolveGraphExec = resolve; });

      vi.mocked(abortDeps.executeAgent)
        .mockReturnValueOnce(graphExecPromise as Promise<ReturnType<SubAgentRunnerDeps["executeAgent"]>>)
        .mockReturnValue(new Promise(() => {}));

      const runner = createSubAgentRunner(abortDeps);

      // Spawn a graph node
      const graphRunId = runner.spawn({
        task: "graph node",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
        callerType: "graph",
        graphId: "g-drain-test",
      });

      const graphRun = runner.getRunStatus(graphRunId);
      expect(graphRun).toBeDefined();
      expect(graphRun!.abortGroup).toBe("graph:g-drain-test");

      // Complete the graph execution
      resolveGraphExec({
        response: "done",
        tokensUsed: { total: 10 },
        cost: { total: 0.001 },
        finishReason: "stop",
        stepsExecuted: 1,
      });

      await vi.advanceTimersByTimeAsync(0);

      // The graph run should be completed -- drainQueue was called with "graph:g-drain-test"
      // (not "default:user1:ch1"). Since there's nothing queued under that key, this is
      // a no-op, but the key point is it doesn't drain the parent session queue.
      const completedRun = runner.getRunStatus(graphRunId);
      expect(completedRun!.status).toBe("completed");
    });

    it("regular (non-graph) run still drains callerSessionKey on completion (no regression)", async () => {
      const abortDeps = createAbortGroupDeps();
      (abortDeps.config as Record<string, unknown>).subagentContext = {
        maxSpawnDepth: 3,
        maxChildrenPerAgent: 2,
        maxQueuedPerAgent: 10,
      };

      // First 2 calls: controllable promise + never resolve (fill limit), then resolve immediately (promoted)
      let resolveFirst!: (v: unknown) => void;
      const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });
      vi.mocked(abortDeps.executeAgent)
        .mockReturnValueOnce(firstPromise as Promise<ReturnType<SubAgentRunnerDeps["executeAgent"]>>)
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValue({
          response: "promoted done",
          tokensUsed: { total: 10 },
          cost: { total: 0.001 },
          finishReason: "stop",
          stepsExecuted: 1,
        });

      const runner = createSubAgentRunner(abortDeps);
      const callerKey = "default:user1:ch1";

      // Spawn 2 regular children (fills maxChildrenPerAgent: 2)
      runner.spawn({
        task: "child 1",
        agentId: "agent-a",
        callerSessionKey: callerKey,
        depth: 0,
        maxDepth: 3,
      });
      runner.spawn({
        task: "child 2",
        agentId: "agent-a",
        callerSessionKey: callerKey,
        depth: 0,
        maxDepth: 3,
      });

      // 3rd spawn should be queued
      const queuedRunId = runner.spawn({
        task: "queued child",
        agentId: "agent-a",
        callerSessionKey: callerKey,
        depth: 0,
        maxDepth: 3,
      });

      expect(runner.getRunStatus(queuedRunId)!.status).toBe("queued");

      // Complete the first child -- should drain queue and promote the queued spawn
      resolveFirst({
        response: "done",
        tokensUsed: { total: 10 },
        cost: { total: 0.001 },
        finishReason: "stop",
        stepsExecuted: 1,
      });

      await vi.advanceTimersByTimeAsync(0);

      // The queued spawn should have been promoted to running
      const promotedRun = runner.getRunStatus(queuedRunId);
      expect(promotedRun!.status === "running" || promotedRun!.status === "completed").toBe(true);
    });

    it("graph-spawned subagent survives parent session end", async () => {
      // This test proves that deregistering the parent session key from
      // activeRunRegistry does NOT kill or abort graph-spawned subagents.
      // Architecture invariants validated:
      // (a) activeRunRegistry.deregister(parentKey) only removes the parent's handle
      // (b) killRun uses run.sessionKey (subagent's own key), not callerSessionKey
      // (c) There is no session:expired -> killRun handler

      const mockAbort = vi.fn().mockResolvedValue(undefined);
      const mockParentAbort = vi.fn().mockResolvedValue(undefined);

      // Create a mock activeRunRegistry that tracks registrations
      const registryEntries = new Map<string, { abort: () => Promise<void> }>();

      const abortDeps = createAbortGroupDeps();
      abortDeps.activeRunRegistry = {
        get(sessionKey: string) {
          return registryEntries.get(sessionKey);
        },
      };

      const runner = createSubAgentRunner(abortDeps);

      // Register the parent session in the registry
      registryEntries.set("default:user1:ch1", { abort: mockParentAbort });

      // Spawn a graph subagent
      const graphRunId = runner.spawn({
        task: "graph research task",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
        callerType: "graph",
        graphId: "g-survive-test",
      });

      // Graph subagent is running
      const graphRun = runner.getRunStatus(graphRunId);
      expect(graphRun).toBeDefined();
      expect(graphRun!.status).toBe("running");

      // Register the subagent's own session key in the registry
      registryEntries.set(graphRun!.sessionKey, { abort: mockAbort });

      // Simulate parent session end: deregister the parent session key
      // (this is what executor-post-execution.ts line 412 does)
      registryEntries.delete("default:user1:ch1");

      // Verify: graph-spawned subagent is STILL running
      const afterDeregister = runner.getRunStatus(graphRunId);
      expect(afterDeregister!.status).toBe("running");

      // Verify: the subagent's own abort was NOT called
      expect(mockAbort).not.toHaveBeenCalled();

      // Verify: the subagent's own registry entry is still intact
      expect(registryEntries.has(afterDeregister!.sessionKey)).toBe(true);

      // Verify: the parent's registry entry is gone (as expected)
      expect(registryEntries.has("default:user1:ch1")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Watchdog timer
  // -----------------------------------------------------------------------
  describe("watchdog timer", () => {
    it("watchdog force-fails a stuck run after maxRunTimeoutMs", async () => {
      deps.config.subagentContext = { maxRunTimeoutMs: 5_000, perStepTimeoutMs: 2_000 } as typeof deps.config.subagentContext;
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
      deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "stuck task",
        agentId: "default",
        announceChannelType: "test",
        announceChannelId: "ch1",
      });

      const runBefore = runner.getRunStatus(runId);
      expect(runBefore).toBeDefined();
      expect(runBefore!.status).toBe("running");

      await vi.advanceTimersByTimeAsync(5_000);

      const runAfter = runner.getRunStatus(runId);
      expect(runAfter).toBeDefined();
      expect(runAfter!.status).toBe("failed");
      expect(runAfter!.error).toContain("Execution timeout");

      // Failure notification delivered
      expect(deps.sendToChannel).toHaveBeenCalled();

      // Completion event emitted with success: false
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "session:sub_agent_completed",
        expect.objectContaining({ success: false }),
      );
    });

    it("watchdog is not triggered when run completes before timeout", async () => {
      deps.config.subagentContext = { maxRunTimeoutMs: 5_000, perStepTimeoutMs: 2_000 } as typeof deps.config.subagentContext;

      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "fast task",
        agentId: "default",
      });

      // Let the immediate mock resolution complete
      await vi.advanceTimersByTimeAsync(100);

      // Advance past watchdog timeout
      await vi.advanceTimersByTimeAsync(5_000);

      const run = runner.getRunStatus(runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe("completed");
    });

    it("watchdog computes timeout from max_steps * perStepTimeoutMs when lower than maxRunTimeoutMs", async () => {
      deps.config.subagentContext = { maxRunTimeoutMs: 600_000, perStepTimeoutMs: 1_000 } as typeof deps.config.subagentContext;
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
      deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "stepped task",
        agentId: "default",
        max_steps: 3, // computed timeout = min(3 * 1000, 600000) = 3000ms
      });

      await vi.advanceTimersByTimeAsync(2_999);
      expect(runner.getRunStatus(runId)!.status).toBe("running");

      await vi.advanceTimersByTimeAsync(1); // hits 3000ms
      expect(runner.getRunStatus(runId)!.status).toBe("failed");
    });

    it("watchdog uses maxRunTimeoutMs as cap when max_steps * perStepTimeoutMs exceeds it", async () => {
      deps.config.subagentContext = { maxRunTimeoutMs: 5_000, perStepTimeoutMs: 2_000 } as typeof deps.config.subagentContext;
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
      deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "many-step task",
        agentId: "default",
        max_steps: 100, // computed = min(100 * 2000, 5000) = 5000ms
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(runner.getRunStatus(runId)!.status).toBe("running");

      await vi.advanceTimersByTimeAsync(1); // hits 5000ms
      expect(runner.getRunStatus(runId)!.status).toBe("failed");
    });

    it("watchdog aborts SDK session via activeRunRegistry", async () => {
      deps.config.subagentContext = { maxRunTimeoutMs: 2_000, perStepTimeoutMs: 1_000 } as typeof deps.config.subagentContext;
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
      const mockAbort = vi.fn().mockResolvedValue(undefined);
      deps.activeRunRegistry = { get: vi.fn().mockReturnValue({ abort: mockAbort }) };
      deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "abort test",
        agentId: "default",
      });

      const run = runner.getRunStatus(runId)!;

      await vi.advanceTimersByTimeAsync(2_000);

      // Registry was queried with the run's sessionKey (not runId)
      expect(deps.activeRunRegistry.get).toHaveBeenCalledWith(run.sessionKey);
      expect(mockAbort).toHaveBeenCalledOnce();
    });

    it("watchdog persists failure record when dataDir is set", async () => {
      deps.config.subagentContext = { maxRunTimeoutMs: 2_000, perStepTimeoutMs: 1_000 } as typeof deps.config.subagentContext;
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
      deps.dataDir = join(tmpdir(), `comis-watchdog-test-${Date.now()}`);
      deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "persist test",
        agentId: "default",
      });

      await vi.advanceTimersByTimeAsync(2_000);

      // Watchdog fired -- status changed to failed (proxy for persistence path being reached)
      expect(runner.getRunStatus(runId)!.status).toBe("failed");
    });
  });

  // -----------------------------------------------------------------------
  // Ghost run sweep
  // -----------------------------------------------------------------------
  describe("ghost run sweep", () => {
    it("ghost sweep force-fails a stuck run when watchdog was bypassed", async () => {
      // Use a very large maxRunTimeoutMs so watchdog does not fire during test window
      deps.config.subagentContext = { maxRunTimeoutMs: 10_000_000, perStepTimeoutMs: 5_000_000 } as typeof deps.config.subagentContext;
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
      deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "ghost stuck task",
        agentId: "default",
        announceChannelType: "ghost-test",
        announceChannelId: "ch2",
      });

      // Grace period = 10_000_000 + 120_000 = 10_120_000ms

      // First sweep fires at 300_000ms; run has been running for 300s, within grace
      await vi.advanceTimersByTimeAsync(300_000);
      expect(runner.getRunStatus(runId)!.status).toBe("running");

      // Backdate startedAt so the run appears ancient (past grace period)
      const run = runner.getRunStatus(runId)!;
      run.startedAt = Date.now() - 10_200_000; // 10_200s old > 10_120s grace

      // Next sweep fires at 600_000ms total; ghost sweep sees backdated run past grace
      await vi.advanceTimersByTimeAsync(300_000);

      expect(runner.getRunStatus(runId)!.status).toBe("failed");
      expect(runner.getRunStatus(runId)!.error).toContain("Ghost run");

      // Failure notification delivered via stored announce channel
      expect(deps.sendToChannel).toHaveBeenCalled();
    });

    it("ghost sweep skips runs that are already completed or failed", async () => {
      // Default mock resolves immediately (run completes)
      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "fast task",
        agentId: "default",
      });

      // Let the run complete
      await vi.advanceTimersByTimeAsync(100);
      expect(runner.getRunStatus(runId)!.status).toBe("completed");

      // Advance through a sweep interval
      await vi.advanceTimersByTimeAsync(300_000);

      // Status remains completed (ghost sweep did not change it)
      expect(runner.getRunStatus(runId)!.status).toBe("completed");
    });

    it("ghost sweep skips running runs within grace period", async () => {
      // Large maxRunTimeoutMs so watchdog won't fire
      deps.config.subagentContext = { maxRunTimeoutMs: 10_000_000, perStepTimeoutMs: 5_000_000 } as typeof deps.config.subagentContext;
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
      deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "within grace task",
        agentId: "default",
      });

      // First sweep: run has been running for 300s; grace is 10_120_000ms
      await vi.advanceTimersByTimeAsync(300_000);
      expect(runner.getRunStatus(runId)!.status).toBe("running");
    });

    it("announceChannelType and announceChannelId are stored on SubAgentRun", async () => {
      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "channel store test",
        agentId: "default",
        announceChannelType: "telegram",
        announceChannelId: "123",
      });

      const run = runner.getRunStatus(runId)!;
      expect(run.announceChannelType).toBe("telegram");
      expect(run.announceChannelId).toBe("123");
    });
  });
});

// ---------------------------------------------------------------------------
// validateOutputs
// ---------------------------------------------------------------------------

describe("validateOutputs", () => {
  it("returns exists: true for files that exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-test-"));
    const tmpFile = path.join(tmpDir, "output.txt");
    fs.writeFileSync(tmpFile, "hello");

    try {
      const results = await validateOutputs([tmpFile], 1, 10);
      expect(results).toHaveLength(1);
      expect(results[0]!.exists).toBe(true);
      expect(typeof results[0]!.size).toBe("number");
      expect(results[0]!.size).toBeGreaterThan(0);
    } finally {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    }
  });

  it("returns exists: false for missing files", async () => {
    const missingPath = `/tmp/nonexistent-comis-test-file-${Date.now()}`;
    const results = await validateOutputs([missingPath], 1, 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.exists).toBe(false);
    expect(results[0]!.size).toBeUndefined();
  });

  it("retries before giving up on missing files", async () => {
    const missingPath = `/tmp/nonexistent-comis-retry-${Date.now()}`;
    const start = Date.now();
    const results = await validateOutputs([missingPath], 3, 10);
    const elapsed = Date.now() - start;

    expect(results[0]!.exists).toBe(false);
    // Should have waited at least 2 * 10ms for 3 retries (2 delays between 3 attempts)
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it("handles mixed results (some exist, some missing)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-test-"));
    const tmpFile = path.join(tmpDir, "exists.txt");
    fs.writeFileSync(tmpFile, "content");
    const missingPath = `/tmp/nonexistent-comis-mixed-${Date.now()}`;

    try {
      const results = await validateOutputs([tmpFile, missingPath], 1, 10);
      expect(results).toHaveLength(2);
      expect(results[0]!.exists).toBe(true);
      expect(results[0]!.size).toBeGreaterThan(0);
      expect(results[1]!.exists).toBe(false);
      expect(results[1]!.size).toBeUndefined();
    } finally {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// buildAnnouncementMessage with validation
// ---------------------------------------------------------------------------

describe("buildAnnouncementMessage with validation", () => {
  const baseParams = {
    task: "Test task",
    status: "completed" as const,
    response: "Done",
    runtimeMs: 5000,
    stepsExecuted: 3,
    tokensUsed: 100,
    cost: 0.001,
    finishReason: "stop",
    sessionKey: "t:u:c",
  };

  it("includes validation results when all files verified", () => {
    const validation: ValidationResult[] = [
      { path: "/a.ts", exists: true, size: 100 },
      { path: "/b.ts", exists: true, size: 200 },
    ];

    const result = buildAnnouncementMessage({ ...baseParams, validation });
    expect(result).toContain("Outputs: 2/2 verified");
    expect(result).not.toContain("Missing:");
  });

  it("includes missing files in validation output", () => {
    const validation: ValidationResult[] = [
      { path: "/a.ts", exists: true, size: 100 },
      { path: "/b.ts", exists: false },
    ];

    const result = buildAnnouncementMessage({ ...baseParams, validation });
    expect(result).toContain("Outputs: 1/2 verified");
    expect(result).toContain("Missing: /b.ts");
  });

  it("omits validation section when no validation provided", () => {
    const result = buildAnnouncementMessage(baseParams);
    expect(result).not.toContain("Outputs:");
  });
});

// ---------------------------------------------------------------------------
// buildAnnouncementMessage with abort classification
// ---------------------------------------------------------------------------

describe("buildAnnouncementMessage with abort", () => {
  const baseParams = {
    task: "Test task",
    status: "completed" as const,
    response: "Done",
    runtimeMs: 5000,
    stepsExecuted: 3,
    tokensUsed: 100,
    cost: 0.001,
    finishReason: "max_steps",
    sessionKey: "t:u:c",
  };

  // includes Abort line when abort classification provided
  it("includes Abort line when abort classification provided", () => {
    const abort: AbortClassification = { category: "step_limit", hint: "Increase max_steps", severity: "actionable" };
    const result = buildAnnouncementMessage({ ...baseParams, abort });
    expect(result).toContain("Abort: step_limit | Hint: Increase max_steps");
  });

  // omits Abort line when no abort classification
  it("omits Abort line when no abort classification", () => {
    const result = buildAnnouncementMessage({ ...baseParams, finishReason: "stop" });
    expect(result).not.toContain("Abort:");
  });

  // includes both validation and abort lines
  it("includes both validation and abort lines with abort after validation", () => {
    const validation: ValidationResult[] = [
      { path: "/a.ts", exists: true, size: 100 },
    ];
    const abort: AbortClassification = { category: "step_limit", hint: "Increase max_steps", severity: "actionable" };
    const result = buildAnnouncementMessage({ ...baseParams, validation, abort });
    expect(result).toContain("Outputs:");
    expect(result).toContain("Abort:");
    // Abort line should come after validation line
    const validationIdx = result.indexOf("Outputs:");
    const abortIdx = result.indexOf("Abort:");
    expect(abortIdx).toBeGreaterThan(validationIdx);
  });

  // abort line for budget category
  it("abort line for budget category", () => {
    const abort: AbortClassification = { category: "budget", hint: "Increase token budget", severity: "actionable" };
    const result = buildAnnouncementMessage({ ...baseParams, finishReason: "budget_exceeded", abort });
    expect(result).toContain("Abort: budget");
  });

  // abort line for external_timeout category
  it("abort line for external_timeout category", () => {
    const abort: AbortClassification = { category: "external_timeout", hint: "Check provider status", severity: "investigate" };
    const result = buildAnnouncementMessage({ ...baseParams, finishReason: "circuit_open", abort });
    expect(result).toContain("Abort: external_timeout");
  });
});

// ---------------------------------------------------------------------------
// buildAnnouncementMessage with errorContext enrichment
// ---------------------------------------------------------------------------

describe("buildAnnouncementMessage with errorContext", () => {
  const baseParams = {
    task: "test task",
    status: "completed" as const,
    response: "An error occurred",
    runtimeMs: 5000,
    tokensUsed: 1000,
    cost: 0.05,
    finishReason: "error",
    sessionKey: "test:session",
  };

  it("enriches error label with errorContext when finishReason is error", () => {
    const msg = buildAnnouncementMessage({
      ...baseParams,
      errorContext: { errorType: "PromptTimeout", retryable: true },
    });
    expect(msg).toContain("Halted (PromptTimeout, retryable)");
  });

  it("shows generic Halted (error) without errorContext", () => {
    const msg = buildAnnouncementMessage(baseParams);
    expect(msg).toContain("Halted (error)");
    expect(msg).not.toContain("PromptTimeout");
  });

  it("omits retryable hint when errorContext.retryable is false", () => {
    const msg = buildAnnouncementMessage({
      ...baseParams,
      errorContext: { errorType: "UnexpectedError", retryable: false },
    });
    expect(msg).toContain("Halted (UnexpectedError)");
    expect(msg).not.toContain("retryable");
  });

  it("does not enrich non-error finishReasons even with errorContext", () => {
    const msg = buildAnnouncementMessage({
      ...baseParams,
      response: "result",
      finishReason: "max_steps",
      errorContext: { errorType: "PromptTimeout", retryable: true },
    });
    expect(msg).toContain("Halted (max steps reached)");
    expect(msg).not.toContain("PromptTimeout");
  });
});

// ---------------------------------------------------------------------------
// Spawn abort wiring integration tests
// ---------------------------------------------------------------------------

describe("abort wiring in spawn", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // completion with max_steps includes abort in announcement
  it("completion with max_steps includes abort in announcement", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "partial output",
      tokensUsed: { total: 3000 },
      cost: { total: 0.3 },
      finishReason: "max_steps",
      stepsExecuted: 50,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "big task",
      agentId: "default",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deps.sendToChannel).mock.calls[0]![2];
    expect(text).toContain("Abort: step_limit");
  });

  // completion with stop does not include abort in announcement
  it("completion with stop does not include abort in announcement", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "done",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
      finishReason: "stop",
      stepsExecuted: 3,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "normal task",
      agentId: "default",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deps.sendToChannel).mock.calls[0]![2];
    expect(text).not.toContain("Abort:");
  });

  // error catch path classifies abort (static failure notification)
  it("error catch path classifies abort from error message", async () => {
    vi.mocked(deps.executeAgent).mockRejectedValue(new Error("Request was aborted"));

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "timeout task",
      agentId: "default",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deps.sendToChannel).mock.calls[0]![2];
    // failure path now uses deliverFailureNotification (static, no LLM)
    expect(text).toContain("Task failed: timeout task");
    expect(text).toContain("task encountered an error");
  });

  // abnormal finishReason logs WARN with abortReason
  it("abnormal finishReason logs WARN with abortReason", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "partial",
      tokensUsed: { total: 5000 },
      cost: { total: 0.5 },
      finishReason: "budget_exceeded",
      stepsExecuted: 20,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "expensive task",
      agentId: "default",
    });

    await vi.advanceTimersByTimeAsync(0);

    const abortCall = logger.warn.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent aborted",
    );
    expect(abortCall).toBeDefined();
    expect(abortCall![0]).toEqual(
      expect.objectContaining({
        abortReason: "budget",
      }),
    );
  });

  // completion INFO log includes filesCreated
  it("completion INFO log includes filesCreated", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    deps.logger = logger;

    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "done",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
      finishReason: "stop",
      stepsExecuted: 3,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "files task",
      agentId: "default",
    });

    await vi.advanceTimersByTimeAsync(0);

    const completionCall = logger.info.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent execution completed",
    );
    expect(completionCall).toBeDefined();
    expect(completionCall![0]).toEqual(
      expect.objectContaining({
        filesCreated: 0,
        stepCount: 3,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Memory persistence tests
  // -----------------------------------------------------------------------

  it("persists completion summary to memory on success", async () => {
    const mockStore = vi.fn().mockResolvedValue({ ok: true });
    deps.memoryAdapter = { store: mockStore };

    const runner = createSubAgentRunner(deps);
    runner.spawn({ task: "build a snake game", agentId: "default" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mockStore).toHaveBeenCalledTimes(1);
    const entry = mockStore.mock.calls[0][0];
    expect(entry.content).toContain("Sub-agent task completed.");
    expect(entry.content).toContain("build a snake game");
    expect(entry.content).toContain("Status: Success");
    expect(entry.content).toContain("task completed successfully");
    expect(entry.trustLevel).toBe("system");
    expect(entry.sourceType).toBe("tool");
    expect(entry.tags).toContain("sub-agent-result");
    expect(entry.tags).toContain("task-completion");
    expect(entry.tags).not.toContain("aborted");
    expect(entry.agentId).toBe("default");
    expect(entry.tenantId).toBe("default");
  });

  it("persists completion summary with abort info on budget exceeded", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "partial work done",
      tokensUsed: { total: 100000 },
      cost: { total: 0.50 },
      finishReason: "budget_exceeded",
      stepsExecuted: 8,
    });
    const mockStore = vi.fn().mockResolvedValue({ ok: true });
    deps.memoryAdapter = { store: mockStore };

    const runner = createSubAgentRunner(deps);
    runner.spawn({ task: "complex task", agentId: "default" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mockStore).toHaveBeenCalledTimes(1);
    const entry = mockStore.mock.calls[0][0];
    expect(entry.content).toContain("Sub-agent task halted.");
    expect(entry.content).toContain("Status: Halted (budget)");
    expect(entry.tags).toContain("aborted");
  });

  it("does not crash when memoryAdapter is undefined", async () => {
    // memoryAdapter is not set (default from createMockDeps)
    const runner = createSubAgentRunner(deps);
    runner.spawn({ task: "simple task", agentId: "default" });
    await vi.advanceTimersByTimeAsync(0);

    const run = runner.getRunStatus(runner.listRuns()[0].runId);
    expect(run!.status).toBe("completed");
  });

  it("does not crash when memoryAdapter.store rejects", async () => {
    deps.memoryAdapter = { store: vi.fn().mockRejectedValue(new Error("DB write failed")) };
    deps.logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };

    const runner = createSubAgentRunner(deps);
    runner.spawn({ task: "task with failing memory", agentId: "default" });
    await vi.advanceTimersByTimeAsync(0);

    const run = runner.getRunStatus(runner.listRuns()[0].runId);
    expect(run!.status).toBe("completed");
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.stringContaining("Failed to persist") }),
      "Sub-agent memory persistence failed",
    );
  });

  // -----------------------------------------------------------------------
  // sanitization: strips think/final tags from memory persistence
  // -----------------------------------------------------------------------

  it("strips think/final tags from memory persistence result snippet", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "<think>secret reasoning</think>The actual result",
      tokensUsed: { total: 200 },
      cost: { total: 0.02 },
      finishReason: "stop",
      stepsExecuted: 3,
    });
    const mockStore = vi.fn().mockResolvedValue({ ok: true });
    deps.memoryAdapter = { store: mockStore };

    const runner = createSubAgentRunner(deps);
    runner.spawn({ task: "test task", agentId: "default" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mockStore).toHaveBeenCalledTimes(1);
    const entry = mockStore.mock.calls[0][0];
    expect(entry.content).not.toContain("<think>");
    expect(entry.content).not.toContain("secret reasoning");
    expect(entry.content).toContain("The actual result");
  });

  it("strips think/final tags from legacy announcement fallback", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "<think>hidden thought</think>visible announcement",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
      finishReason: "stop",
      stepsExecuted: 2,
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "announce task",
      agentId: "default",
      announceChannelType: "echo",
      announceChannelId: "ch1",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.sendToChannel).toHaveBeenCalled();
    const text = vi.mocked(deps.sendToChannel).mock.calls[0]![2] as string;
    expect(text).not.toContain("<think>");
    expect(text).not.toContain("hidden thought");
    expect(text).toContain("visible announcement");
  });
});

// ---------------------------------------------------------------------------
// classifyAbortReason
// ---------------------------------------------------------------------------

describe("classifyAbortReason", () => {
  // Test 1: max_steps -> step_limit
  it("maps max_steps to step_limit category", () => {
    const result = classifyAbortReason("max_steps");
    expect(result.category).toBe("step_limit");
    expect(result.severity).toBe("actionable");
    expect(result.hint).toContain("max_steps");
  });

  // Test 2: budget_exceeded -> budget
  it("maps budget_exceeded to budget category", () => {
    const result = classifyAbortReason("budget_exceeded");
    expect(result.category).toBe("budget");
    expect(result.severity).toBe("actionable");
  });

  // Test 3: context_loop -> context_full
  it("maps context_loop to context_full category", () => {
    const result = classifyAbortReason("context_loop");
    expect(result.category).toBe("context_full");
    expect(result.severity).toBe("actionable");
  });

  // Test 4: context_exhausted -> context_full
  it("maps context_exhausted to context_full category", () => {
    const result = classifyAbortReason("context_exhausted");
    expect(result.category).toBe("context_full");
    expect(result.severity).toBe("actionable");
  });

  // Test 5: circuit_open -> external_timeout
  it("maps circuit_open to external_timeout category", () => {
    const result = classifyAbortReason("circuit_open");
    expect(result.category).toBe("external_timeout");
    expect(result.severity).toBe("investigate");
  });

  // Test 6: error + "Request was aborted" -> external_timeout
  it("maps error with 'Request was aborted' to external_timeout", () => {
    const result = classifyAbortReason("error", "Request was aborted");
    expect(result.category).toBe("external_timeout");
    expect(result.severity).toBe("investigate");
  });

  // Test 7: error + timeout patterns -> external_timeout
  it("maps error with timeout patterns to external_timeout", () => {
    const result = classifyAbortReason("error", "connect ETIMEDOUT 1.2.3.4");
    expect(result.category).toBe("external_timeout");
  });

  // Test 8: generic error -> unknown
  it("maps generic error to unknown", () => {
    const result = classifyAbortReason("error", "something unexpected");
    expect(result.category).toBe("unknown");
    expect(result.severity).toBe("investigate");
  });

  // Test 9: unknown finishReason -> unknown
  it("maps unknown finishReason to unknown", () => {
    const result = classifyAbortReason("some_new_reason");
    expect(result.category).toBe("unknown");
  });

  // Test 10.5: provider_degraded -> provider_degraded
  it("maps provider_degraded to provider_degraded category", () => {
    const result = classifyAbortReason("provider_degraded");
    expect(result.category).toBe("provider_degraded");
    expect(result.severity).toBe("investigate");
    expect(result.hint).toContain("degraded");
  });

  // Test 10: every classification includes a non-empty hint
  it("every classification includes a non-empty hint string", () => {
    const cases: Array<[string, string | undefined]> = [
      ["max_steps", undefined],
      ["budget_exceeded", undefined],
      ["context_loop", undefined],
      ["circuit_open", undefined],
      ["provider_degraded", undefined],
      ["error", "something unexpected"],
    ];

    for (const [finishReason, errorMsg] of cases) {
      const result: AbortClassification = classifyAbortReason(finishReason, errorMsg);
      expect(result.hint.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// provider_degraded routing
// ---------------------------------------------------------------------------

describe("provider_degraded routing", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawn with provider_degraded finishReason calls deliverFailureNotification", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "",
      finishReason: "provider_degraded",
      stepsExecuted: 0,
      tokensUsed: { input: 0, output: 0, total: 0 },
      cost: { input: 0, output: 0, total: 0 },
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "degraded provider task",
      agentId: "default",
      announceChannelType: "echo",
      announceChannelId: "test-chan",
    });

    await vi.advanceTimersByTimeAsync(0);

    // deliverFailureNotification sends via sendToChannel
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const message = vi.mocked(deps.sendToChannel).mock.calls[0]![2] as string;
    expect(message).toContain("Task failed");
    expect(message).toContain("task encountered an error");
  });

  it("provider_degraded does NOT call announceToParent", async () => {
    const announceToParent = vi.fn().mockResolvedValue(undefined);
    deps.announceToParent = announceToParent;

    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "",
      finishReason: "provider_degraded",
      stepsExecuted: 0,
      tokensUsed: { input: 0, output: 0, total: 0 },
      cost: { input: 0, output: 0, total: 0 },
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "degraded task no parent announce",
      agentId: "default",
      announceChannelType: "echo",
      announceChannelId: "test-chan",
      callerAgentId: "parent-agent",
      callerSessionKey: "default:user1:ch1",
    });

    await vi.advanceTimersByTimeAsync(0);

    // announceToParent must NOT be called for provider_degraded
    expect(announceToParent).not.toHaveBeenCalled();
    // But sendToChannel IS called (via deliverFailureNotification)
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Spawn rejection WARN logs
// ---------------------------------------------------------------------------

describe("spawn rejection WARN logs", () => {
  function createLimitDepsWithLogger(): SubAgentRunnerDeps & { logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } } {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    return {
      sessionStore: {
        save: vi.fn(),
        delete: vi.fn(),
      },
      executeAgent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
      sendToChannel: vi.fn().mockResolvedValue(true),
      eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
      config: {
        enabled: true,
        maxPingPongTurns: 3,
        allowAgents: [],
        subAgentRetentionMs: 3_600_000,
        waitTimeoutMs: 60_000,
        subAgentMaxSteps: 50,
        subAgentToolGroups: ["coding"],
        subagentContext: {
          maxSpawnDepth: 3,
          maxChildrenPerAgent: 2,
        },
      } as SubAgentRunnerDeps["config"],
      tenantId: "default",
      logger,
    };
  }

  it("logs WARN on depth_exceeded rejection", () => {
    const deps = createLimitDepsWithLogger();
    const runner = createSubAgentRunner(deps);

    expect(() =>
      runner.spawn({
        task: "deep task",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 3,
        maxDepth: 3,
      }),
    ).toThrow(/depth limit exceeded/i);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "depth_exceeded",
        currentDepth: 3,
        maxDepth: 3,
        hint: expect.stringContaining("depth limit exceeded"),
        errorKind: "resource",
      }),
      "Subagent spawn rejected",
    );
  });

  it("logs WARN on queue_full rejection", () => {
    const deps = createLimitDepsWithLogger();
    // Override config: maxQueuedPerAgent: 1, maxChildrenPerAgent: 2
    (deps.config as Record<string, unknown>).subagentContext = {
      maxSpawnDepth: 3,
      maxChildrenPerAgent: 2,
      maxQueuedPerAgent: 1,
    };
    const runner = createSubAgentRunner(deps);

    // Spawn 2 running children (saturates limit)
    for (let i = 0; i < 2; i++) {
      runner.spawn({
        task: `child task ${i}`,
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      });
    }

    // 3rd spawn gets queued (maxQueuedPerAgent: 1)
    runner.spawn({
      task: "queued child",
      agentId: "agent-a",
      callerSessionKey: "default:user1:ch1",
      depth: 0,
      maxDepth: 3,
    });

    // 4th spawn should be rejected with queue_full
    expect(() =>
      runner.spawn({
        task: "overflow child",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      }),
    ).toThrow(/queue full/i);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "queue_full",
        hint: expect.stringContaining("queue full"),
        errorKind: "resource",
      }),
      "Subagent spawn rejected",
    );
  });
});

// ---------------------------------------------------------------------------
// persistFailureRecord integration (tests through createSubAgentRunner)
// ---------------------------------------------------------------------------

describe("persistFailureRecord integration", () => {
  it("failure path persists failure record before rollback", async () => {
    // Real timers required: persistFailureRecord uses real fs I/O (mkdir + writeFile)
    // which goes through libuv, not through JS timer queue.
    const failureDir = await mkdtemp(join(tmpdir(), "failure-path-test-"));
    const rollbackFn = vi.fn().mockResolvedValue(undefined);

    const localDeps = createMockDeps();
    localDeps.dataDir = failureDir;
    localDeps.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    localDeps.lifecycleHooks = {
      prepareSpawn: vi.fn().mockResolvedValue({ rollback: rollbackFn }),
      onEnded: vi.fn().mockResolvedValue(undefined),
    };

    // executeAgent rejects with an error
    vi.mocked(localDeps.executeAgent).mockRejectedValue(new Error("execution crashed"));

    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({
      task: "crashing task",
      agentId: "default",
    });

    // Wait for the async chain to complete (real I/O needs real event loop ticks)
    await new Promise((r) => setTimeout(r, 200));

    // Check the run is marked failed
    const run = runner.getRunStatus(runId);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("execution crashed");

    // Find the failure record on disk
    const resultsDir = join(failureDir, "subagent-results");
    const sessionDirs = await readdir(resultsDir);
    expect(sessionDirs.length).toBe(1);

    const files = await readdir(join(resultsDir, sessionDirs[0]));
    expect(files.length).toBe(1);

    const content = JSON.parse(
      await readFile(join(resultsDir, sessionDirs[0], files[0]), "utf-8"),
    );
    expect(content.status).toBe("failed");
    expect(content.endReason).toBe("failed");
    expect(content.error).toContain("execution crashed");

    // Rollback should still have been called (after persist)
    expect(rollbackFn).toHaveBeenCalledTimes(1);

    // Cleanup
    fs.rmSync(failureDir, { recursive: true, force: true });
  });

  it("kill path persists failure record via fire-and-forget", async () => {
    // Real timers required: persistFailureRecord uses real fs I/O (mkdir + writeFile)
    // which goes through libuv, not through JS timer queue.
    const killDir = await mkdtemp(join(tmpdir(), "kill-path-test-"));

    const localDeps = createMockDeps();
    localDeps.dataDir = killDir;
    localDeps.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    // executeAgent returns a never-resolving promise so the agent stays running
    vi.mocked(localDeps.executeAgent).mockReturnValue(
      new Promise(() => {}),
    );

    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({
      task: "long running task to be killed",
      agentId: "default",
    });

    // Small delay so spawn async setup completes
    await new Promise((r) => setTimeout(r, 50));

    // Kill the run (synchronous)
    const result = runner.killRun(runId);
    expect(result.killed).toBe(true);

    // Allow the fire-and-forget persist to complete (real I/O needs real event loop ticks)
    await new Promise((r) => setTimeout(r, 200));

    // Find the failure record on disk
    const resultsDir = join(killDir, "subagent-results");
    const sessionDirs = await readdir(resultsDir);
    expect(sessionDirs.length).toBe(1);

    const files = await readdir(join(resultsDir, sessionDirs[0]));
    expect(files.length).toBe(1);

    const content = JSON.parse(
      await readFile(join(resultsDir, sessionDirs[0], files[0]), "utf-8"),
    );
    expect(content.status).toBe("failed");
    expect(content.endReason).toBe("killed");
    expect(content.error).toBe("Killed by parent agent");

    // Cleanup
    fs.rmSync(killDir, { recursive: true, force: true });
  });

  it("success path passes cache fields to condenser via mock executeAgent", async () => {
    const condenserDir = await mkdtemp(join(tmpdir(), "condenser-cache-test-"));
    const condenseMock = vi.fn().mockResolvedValue({
      level: 1,
      result: { taskComplete: true, summary: "done", conclusions: ["ok"] },
      originalTokens: 50,
      condensedTokens: 50,
      compressionRatio: 1,
      diskPath: "/tmp/test.json",
    });

    const localDeps = createMockDeps();
    localDeps.dataDir = condenserDir;
    localDeps.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    localDeps.resultCondenser = { condense: condenseMock };

    // Mock executeAgent to return cache fields
    vi.mocked(localDeps.executeAgent).mockResolvedValue({
      response: "task completed with cache",
      tokensUsed: { total: 200, cacheRead: 50, cacheWrite: 30 },
      cost: { total: 0.02, cacheSaved: 0.005 },
      finishReason: "stop",
      stepsExecuted: 3,
    });

    const runner = createSubAgentRunner(localDeps);
    runner.spawn({
      task: "cache propagation test",
      agentId: "default",
    });

    // Wait for the async chain to complete (real I/O needs real event loop ticks)
    await new Promise((r) => setTimeout(r, 200));

    // Verify the condenser was called with cache fields in usage
    expect(condenseMock).toHaveBeenCalledTimes(1);
    const condenseArgs = condenseMock.mock.calls[0]![0];
    expect(condenseArgs.usage.cacheReadTokens).toBe(50);
    expect(condenseArgs.usage.cacheWriteTokens).toBe(30);
    expect(condenseArgs.usage.cacheSavedUsd).toBe(0.005);
    expect(condenseArgs.usage.totalTokens).toBe(200);
    expect(condenseArgs.usage.costUsd).toBe(0.02);

    // Cleanup
    fs.rmSync(condenserDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// ANNOUNCE_PARENT_TIMEOUT_MS constant
// ---------------------------------------------------------------------------

describe("ANNOUNCE_PARENT_TIMEOUT_MS", () => {
  it("equals 300000", () => {
    expect(ANNOUNCE_PARENT_TIMEOUT_MS).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// deliverAnnouncement timeout fallback
// ---------------------------------------------------------------------------

describe("deliverAnnouncement timeout fallback", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = createMockDeps();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to sendToChannel when announceToParent hangs past timeout", async () => {
    // announceToParent that never resolves (simulates hang)
    const hangingAnnounce = vi.fn().mockReturnValue(new Promise(() => {}));
    deps.announceToParent = hangingAnnounce;
    deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "task that completes but announce hangs",
      agentId: "default",
      callerSessionKey: "default:user1:channel1",
      callerAgentId: "caller-agent",
      announceChannelType: "discord",
      announceChannelId: "chan-timeout",
    });

    // Let executeAgent resolve (it returns from mock)
    await vi.advanceTimersByTimeAsync(100);

    // announceToParent was called
    expect(hangingAnnounce).toHaveBeenCalled();

    // Advance past the timeout (30 seconds)
    await vi.advanceTimersByTimeAsync(ANNOUNCE_PARENT_TIMEOUT_MS + 100);

    // sendToChannel should have been called as fallback
    expect(deps.sendToChannel).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// discoveredDeferredTools inheritance
// ---------------------------------------------------------------------------

describe("discoveredDeferredTools inheritance", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves discoveredDeferredTools to session metadata when present in params", () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "inherit discovery state",
      agentId: "default",
      callerSessionKey: "default:user1:channel1",
      callerAgentId: "parent-agent",
      discoveredDeferredTools: ["tool_a", "tool_b"],
    });

    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;
    const metadata = saveCall[2] as Record<string, unknown>;
    expect(metadata.discoveredDeferredTools).toEqual(["tool_a", "tool_b"]);
  });

  it("defaults discoveredDeferredTools to empty array when absent from params", () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "no discovery state",
      agentId: "default",
    });

    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;
    const metadata = saveCall[2] as Record<string, unknown>;
    expect(metadata.discoveredDeferredTools).toEqual([]);
  });

  it("SpawnPacket interface accepts discoveredDeferredTools field", () => {
    // Type-level test: verify the SpawnPacket interface allows the field
    const packet: import("@comis/core").SpawnPacket = {
      task: "test task",
      artifactRefs: [],
      domainKnowledge: [],
      toolGroups: [],
      objective: "",
      workspaceDir: "/tmp",
      depth: 0,
      maxDepth: 3,
      discoveredDeferredTools: ["tool_x", "tool_y"],
    };

    expect(packet.discoveredDeferredTools).toEqual(["tool_x", "tool_y"]);
  });
});

// ---------------------------------------------------------------------------
// Persistent session reuse tests
// ---------------------------------------------------------------------------

describe("persistent session reuse", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuseSessionKey skips sessionStore.save and uses provided session key", async () => {
    const reuseKey = "default:debate-node1:debategraph1node1";
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "round 2 debate",
      agentId: "bull",
      reuseSessionKey: reuseKey,
    });

    // sessionStore.save should NOT be called -- session already exists
    expect(deps.sessionStore.save).not.toHaveBeenCalled();

    // The run's sessionKey should match the reuse key
    const run = runner.getRunStatus(runId);
    expect(run).toBeDefined();
    expect(run!.sessionKey).toBe(reuseKey);

    // executeAgent should receive the parsed SessionKey
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.executeAgent).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(deps.executeAgent).mock.calls[0]!;
    // sessionKey arg (2nd param) should match parsed reuseKey
    expect(callArgs[1]).toEqual({
      tenantId: "default",
      userId: "debate-node1",
      channelId: "debategraph1node1",
    });
  });

  it("reuseSessionKey threads to executeAgent overrides with graphId/nodeId", async () => {
    const reuseKey = "default:debate-node1:debategraph1node1";
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "round 2 debate",
      agentId: "bull",
      reuseSessionKey: reuseKey,
      graphId: "g1",
      nodeId: "n1",
    });

    await vi.advanceTimersByTimeAsync(0);
    const callArgs = vi.mocked(deps.executeAgent).mock.calls[0]!;
    // 6th arg = overrides
    expect(callArgs[5]).toEqual({
      graphId: "g1",
      nodeId: "n1",
      reuseSessionKey: reuseKey,
    });
  });

  it("invalid reuseSessionKey falls back to normal session creation", async () => {
    deps.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "round 2 debate",
      agentId: "bull",
      reuseSessionKey: "invalid-key-format",
    });

    // sessionStore.save SHOULD be called (fallback to normal session)
    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);

    // logger.error should have been called with reuseSessionKey parse failure
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reuseSessionKey: "invalid-key-format" }),
      expect.stringContaining("Failed to parse reuseSessionKey"),
    );
  });

  it("normal spawn without reuseSessionKey still creates session (regression guard)", async () => {
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "research topic",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
    });

    // sessionStore.save SHOULD be called for normal spawns
    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;
    const sessionKey = saveCall[0] as { tenantId: string; userId: string; channelId: string };
    expect(sessionKey.tenantId).toBe("default");
    expect(sessionKey.userId).toContain("sub-agent-");
    expect(sessionKey.channelId).toContain("sub-agent:");

    // The run's sessionKey should match the standard format
    const run = runner.getRunStatus(runId);
    expect(run).toBeDefined();
    expect(run!.sessionKey).toContain("default:sub-agent-");
  });
});
