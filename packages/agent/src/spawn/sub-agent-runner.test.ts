// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  conversationScopeToSessionKey,
  createConversationLocator,
  formatSessionKey,
  RequiredToolsUnreachableError,
  type ConversationLocator,
} from "@comis/core";
import { SandboxDowngradeError } from "./sandbox-posture.js";
import { mkdtemp, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@comis/shared";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("@comis/agent", () => ({
  sanitizeAssistantResponse: (text: string) =>
    text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?final>/g, "").trim(),
}));

import {
  createSubAgentRunner,
  ANNOUNCE_PARENT_TIMEOUT_MS,
  SubAgentSpawnPausedError,
  type SubAgentRunnerDeps,
} from "./sub-agent-runner.js";
import {
  buildAnnouncementMessage,
  validateOutputs,
  classifyAbortReason,
  persistFailureRecord,
  deliverFailureNotification,
  type ValidationResult,
  type AbortClassification,
} from "./sub-agent-result-processor.js";
import { createDeliveryDedup } from "./announce-key.js";
import type { ClockPort, TimerPort, TimerHandle } from "@comis/core";
import {
  attenuateCaps,
  AGENT_CAPABILITIES,
  resolveWorkspaceDir,
  type AgentCapability,
  type AgentConfig,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Lightweight port wrappers that delegate to globals so vi.useFakeTimers()
// continues to intercept Date.now / setTimeout / setInterval below.
// ---------------------------------------------------------------------------

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(t);
    },
    unref() {
      if (cancelled || unrefCalled) return;
      unrefCalled = true;
      t.unref();
    },
  };
}

const testClock: ClockPort = {
  now: () => Date.now(),
  nowDate: () => new Date(),
};

const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};

function createMockSessionStore(): SubAgentRunnerDeps["sessionStore"] {
  return {
    save: vi.fn().mockReturnValue(ok(undefined)),
    delete: vi.fn().mockReturnValue(ok(true)),
    loadByRef: vi.fn().mockReturnValue(ok(undefined)),
  };
}

function createTestConversation(overrides: {
  tenantId?: string;
  agentId?: string;
  principalId?: string;
  conversationId?: string;
} = {}): ConversationLocator {
  const locator = createConversationLocator({
    tenantId: overrides.tenantId ?? "default",
    agentId: overrides.agentId ?? "parent",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "test",
        channelInstanceId: "test-instance",
        conversationId: overrides.conversationId ?? "channel1",
        conversationKind: "direct",
      },
      principalId: overrides.principalId ?? "user1",
    },
  });
  if (!locator.ok) throw locator.error;
  return locator.value;
}

function formattedConversation(locator: ConversationLocator): string {
  const sessionKey = conversationScopeToSessionKey(locator.conversationScope);
  if (!sessionKey.ok) throw sessionKey.error;
  return formatSessionKey(sessionKey.value);
}

function persistedConversation(locator: ConversationLocator) {
  return {
    conversationRef: locator.conversationRef,
    conversationScope: locator.conversationScope,
    messages: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDeps(): SubAgentRunnerDeps {
  return {
    sessionStore: createMockSessionStore(),
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
    clock: testClock,
    timers: testTimers,
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
  // Spawn returns runId immediately
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
  // Run completes and updates status
  // -----------------------------------------------------------------------
  it("run completion retains one frozen bounded projection without raw output", async () => {
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
    if (run!.status !== "completed") throw new Error("expected completed run");
    expect(run.completion).toEqual({
      endReason: "completed",
      completedAtMs: expect.any(Number),
      summary: "task completed successfully",
    });
    expect(Object.isFrozen(run.completion)).toBe(true);
    expect(run.telemetry).toEqual({
      tokensUsedTotal: 200,
      costTotal: 0.02,
      finishReason: "stop",
      stepsExecuted: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(run).not.toHaveProperty("result");
    expect(run).not.toHaveProperty("error");
    expect(run).not.toHaveProperty("completedAt");
  });

  // -----------------------------------------------------------------------
  // Run failure sets status to "failed"
  // -----------------------------------------------------------------------
  it("run failure stores a frozen failure completion without raw error state", async () => {
    vi.mocked(deps.executeAgent).mockRejectedValue(new Error("LLM quota exceeded"));

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "expensive task",
      agentId: "default",
    });
    const failedWait = runner.waitForCompletion(runId);

    await vi.advanceTimersByTimeAsync(0);

    const run = runner.getRunStatus(runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe("failed");
    if (run!.status !== "failed") throw new Error("expected failed run");
    expect(run.completion).toEqual({
      endReason: "failed",
      completedAtMs: expect.any(Number),
      errorKind: "internal",
      summary: "LLM quota exceeded",
    });
    expect(Object.isFrozen(run.completion)).toBe(true);
    expect(run).not.toHaveProperty("result");
    expect(run).not.toHaveProperty("error");
    expect(run).not.toHaveProperty("completedAt");
    await expect(failedWait).resolves.toBe(run.completion);
  });

  it("uses the executor terminal kind even when failure prose suggests another classification", async () => {
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "",
      tokensUsed: { total: 7 },
      cost: { total: 0.01 },
      finishReason: "error",
      stepsExecuted: 1,
      terminalErrorKind: "dependency",
      errorContext: {
        errorType: "PromptTimeout",
        retryable: false,
        originalError: "authentication wording must not control the terminal kind",
      },
    } as Awaited<ReturnType<SubAgentRunnerDeps["executeAgent"]>> & {
      terminalErrorKind: "dependency";
    });
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({ task: "inspect dependency", agentId: "default" });

    await vi.advanceTimersByTimeAsync(0);

    const run = runner.getRunStatus(runId);
    expect(run?.status).toBe("failed");
    if (run?.status !== "failed") return;
    expect(run.completion.errorKind).toBe("dependency");
  });

  it("concurrent completion waiters share the runner-owned deferred", async () => {
    let resolveExecution!: (value: Awaited<ReturnType<SubAgentRunnerDeps["executeAgent"]>>) => void;
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise((resolve) => {
      resolveExecution = resolve;
    }));

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({ task: "shared wait", agentId: "default" });
    const first = runner.waitForCompletion(runId);
    const second = runner.waitForCompletion(runId);

    expect(first).toBeDefined();
    expect(second).toBe(first);

    resolveExecution({
      response: "shared result",
      tokensUsed: { total: 10 },
      cost: { total: 0.001 },
      finishReason: "stop",
      stepsExecuted: 1,
    });
    await vi.advanceTimersByTimeAsync(0);

    const [firstCompletion, secondCompletion] = await Promise.all([first!, second!]);
    expect(secondCompletion).toBe(firstCompletion);
    expect(firstCompletion).toEqual({
      endReason: "completed",
      completedAtMs: expect.any(Number),
      summary: "shared result",
    });
  });

  it("waiter cancellation returns promptly without cancelling the child", async () => {
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({ task: "keep running", agentId: "default" });
    const controller = new AbortController();

    const waiting = runner.waitForCompletions([runId], 60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toEqual([{ runId, status: "cancelled" }]);
    expect(runner.getRunStatus(runId)?.status).toBe("running");
  });

  it("mixed completion waits preserve completed results and time out only pending children", async () => {
    let resolveSecond!: (value: Awaited<ReturnType<SubAgentRunnerDeps["executeAgent"]>>) => void;
    vi.mocked(deps.executeAgent)
      .mockResolvedValueOnce({
        response: "first complete",
        tokensUsed: { total: 1 },
        cost: { total: 0 },
        finishReason: "stop",
        stepsExecuted: 1,
      })
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveSecond = resolve;
      }));
    const runner = createSubAgentRunner(deps);
    const completedRunId = runner.spawn({ task: "complete", agentId: "default" });
    const pendingRunId = runner.spawn({ task: "pending", agentId: "default" });
    await vi.advanceTimersByTimeAsync(0);

    const waiting = runner.waitForCompletions([completedRunId, pendingRunId], 250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toEqual([
      {
        runId: completedRunId,
        status: "completed",
        completion: expect.objectContaining({
          endReason: "completed",
          summary: "first complete",
        }),
      },
      { runId: pendingRunId, status: "timeout" },
    ]);
    expect(runner.getRunStatus(pendingRunId)?.status).toBe("running");

    resolveSecond({
      response: "second eventually completes",
      tokensUsed: { total: 1 },
      cost: { total: 0 },
      finishReason: "stop",
      stepsExecuted: 1,
    });
  });

  // -----------------------------------------------------------------------
  // Allowlist blocks unauthorized agent
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
  // Empty allowlist allows any agent
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
  // Auto-archive removes old completed runs
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
    await expect(runner.waitForCompletion(runId)).resolves.toMatchObject({
      endReason: "completed",
    });

    // Advance past retention period + sweep interval
    vi.advanceTimersByTime(60_000 + 300_001);

    // Run should be archived (removed from Map)
    const runAfter = runner.getRunStatus(runId);
    expect(runAfter).toBeUndefined();
    expect(runner.waitForCompletion(runId)).toBeUndefined();

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
  // ANNOUNCE_SKIP suppresses announcement
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
  // Announce includes [System Message] format with stats
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
  // Events emitted on spawn and completion
  // -----------------------------------------------------------------------
  it("emits events on spawn and completion", async () => {
    const runner = createSubAgentRunner(deps);
    const callerConversation = createTestConversation({ agentId: "parent-agent" });
    const runId = runner.spawn({
      task: "event test",
      agentId: "researcher",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
    });

    // Spawn event emitted immediately
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_spawned",
      expect.objectContaining({
        runId,
        agentId: "researcher",
        parentSessionKey: formattedConversation(callerConversation),
      }),
    );
    const spawnEvent = vi.mocked(deps.eventBus.emit).mock.calls.find(
      ([event]) => event === "session:sub_agent_spawned",
    );
    expect(spawnEvent?.[1]).not.toHaveProperty("task");

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
  // Completion event has success:false for abnormal finishReason
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
  // Completion event has success:true for end_turn finishReason
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
  // Shutdown waits for active runs
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

  it("shutdown drains announcements only after active completions enqueue", async () => {
    const lifecycle: string[] = [];
    let resolveExec!: (value: Awaited<ReturnType<SubAgentRunnerDeps["executeAgent"]>>) => void;
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise((resolve) => {
      resolveExec = resolve;
    }));
    deps.batcher = {
      enqueue: vi.fn(() => { lifecycle.push("enqueue"); }),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn(async () => { lifecycle.push("batcher.shutdown"); }),
      pending: 0,
      hasDelivered: vi.fn().mockReturnValue(false),
      markDelivered: vi.fn(),
    };

    const runner = createSubAgentRunner(deps);
    const callerConversation = createTestConversation({ agentId: "parent-agent" });
    runner.spawn({
      task: "complete during shutdown",
      agentId: "child-agent",
      callerAgentId: "parent-agent",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
      announceChannelType: "telegram",
      announceChannelId: "channel1",
    });

    const shutdownPromise = runner.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.batcher.shutdown).not.toHaveBeenCalled();

    resolveExec({
      response: "completed while shutdown was waiting",
      tokensUsed: { total: 10 },
      cost: { total: 0.001 },
      finishReason: "stop",
      stepsExecuted: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    await shutdownPromise;

    expect(lifecycle).toEqual(["enqueue", "batcher.shutdown"]);
  });

  it("enqueues verified expected outputs as generated file references", async () => {
    vi.useRealTimers();
    const outputDir = await mkdtemp(join(tmpdir(), "completion-output-test-"));
    const outputPath = join(outputDir, "monthly.csv");
    await writeFile(outputPath, "vehicle_id,status\n1,active\n", "utf8");
    const enqueue = vi.fn().mockResolvedValue(ok("queued"));
    deps.batcher = {
      enqueue,
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      pending: 0,
      hasDelivered: vi.fn().mockReturnValue(false),
      markDelivered: vi.fn(),
    };
    const callerConversation = createTestConversation({ agentId: "parent-agent" });
    const runner = createSubAgentRunner(deps);

    runner.spawn({
      task: "create the monthly report",
      agentId: "report-agent",
      expected_outputs: [outputPath],
      callerAgentId: "parent-agent",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
      announceChannelType: "telegram",
      announceChannelId: "channel1",
    });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{ sourceAgentId: "report-agent", path: outputPath }],
    }));
    await runner.shutdown();
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("shutdown closes spawn admission before waiting for active runs", async () => {
    const runner = createSubAgentRunner(deps);

    await runner.shutdown();

    expect(() => runner.spawn({
      task: "must not start after shutdown",
      agentId: "child-agent",
    })).toThrow("Sub-agent runner is shutting down");
    expect(deps.executeAgent).not.toHaveBeenCalled();
  });

  it("pauses spawn admission reversibly without reopening shutdown admission", async () => {
    deps.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const runner = createSubAgentRunner(deps);

    expect(runner.pauseSpawns()).toEqual({
      paused: true,
      acceptingSpawns: true,
      changed: true,
      resetsOnRestart: true,
    });
    expect(runner.pauseSpawns().changed).toBe(false);
    expect(() => runner.spawn({ task: "must wait", agentId: "child-agent" }))
      .toThrow(SubAgentSpawnPausedError);
    expect(deps.executeAgent).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_spawn_rejected",
      expect.objectContaining({ reason: "spawn_paused" }),
    );
    expect(deps.logger!.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "spawn_paused", errorKind: "precondition" }),
      "Sub-agent spawn rejected: admission paused",
    );

    expect(runner.resumeSpawns()).toEqual({
      paused: false,
      acceptingSpawns: true,
      changed: true,
      resetsOnRestart: true,
    });
    runner.spawn({ task: "may proceed", agentId: "child-agent" });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.executeAgent).toHaveBeenCalledOnce();

    runner.pauseSpawns();
    await runner.shutdown();
    runner.resumeSpawns();
    expect(() => runner.spawn({ task: "cannot reopen shutdown", agentId: "child-agent" }))
      .toThrow("Sub-agent runner is shutting down");
  });

  it("shutdown waits for a governed stop notice before the final batch drain", async () => {
    let resolveExec!: (value: Awaited<ReturnType<SubAgentRunnerDeps["executeAgent"]>>) => void;
    let resolveNotice!: (value: ReturnType<typeof ok>) => void;
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise((resolve) => {
      resolveExec = resolve;
    }));
    deps.sendGovernedAnnouncement = vi.fn().mockReturnValue(new Promise((resolve) => {
      resolveNotice = resolve;
    }));
    deps.batcher = {
      enqueue: vi.fn().mockResolvedValue(ok("queued")),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      pending: 0,
      hasDelivered: vi.fn().mockReturnValue(false),
      markDelivered: vi.fn(),
    };

    const runner = createSubAgentRunner(deps);
    const callerConversation = createTestConversation({ agentId: "parent-agent" });
    runner.spawn({
      task: "hang until bounded shutdown",
      agentId: "child-agent",
      callerAgentId: "parent-agent",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
      announceChannelType: "telegram",
      announceChannelId: "channel1",
    });

    const shutdown = runner.shutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(deps.batcher.shutdown).not.toHaveBeenCalled();

    resolveNotice(ok({
      delivered: true as const,
      identity: { agentId: "parent-agent", rootRunId: "root-1", stepIndex: 1 },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await shutdown;
    expect(deps.batcher.shutdown).toHaveBeenCalledOnce();

    resolveExec({
      response: "late success",
      tokensUsed: { total: 1 },
      cost: { total: 0 },
      finishReason: "stop",
      stepsExecuted: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.batcher.enqueue).not.toHaveBeenCalled();
  });

  it("shutdown remains bounded when a governed stop notice never settles", async () => {
    let resolveExec!: (value: Awaited<ReturnType<SubAgentRunnerDeps["executeAgent"]>>) => void;
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise((resolve) => {
      resolveExec = resolve;
    }));
    deps.sendGovernedAnnouncement = vi.fn().mockReturnValue(new Promise(() => {}));
    deps.batcher = {
      enqueue: vi.fn().mockResolvedValue(ok("queued")),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      pending: 0,
      hasDelivered: vi.fn().mockReturnValue(false),
      markDelivered: vi.fn(),
    };

    const runner = createSubAgentRunner(deps);
    const callerConversation = createTestConversation({ agentId: "parent-agent" });
    runner.spawn({
      task: "hang through shutdown notice grace",
      agentId: "child-agent",
      callerAgentId: "parent-agent",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
      announceChannelType: "telegram",
      announceChannelId: "channel1",
    });
    let resolved = false;
    const shutdown = runner.shutdown().then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(34_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(resolved).toBe(true);
    expect(deps.batcher.shutdown).toHaveBeenCalledOnce();

    resolveExec({
      response: "late success",
      tokensUsed: { total: 1 },
      cost: { total: 0 },
      finishReason: "stop",
      stepsExecuted: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.batcher.enqueue).not.toHaveBeenCalled();
  });

  it("shutdown suppresses a late success without reversing its completed event", async () => {
    let releaseMemory!: (value: { ok: boolean }) => void;
    deps.memoryAdapter = {
      store: vi.fn().mockReturnValue(new Promise((resolve) => {
        releaseMemory = resolve;
      })),
    };
    deps.sendGovernedAnnouncement = vi.fn().mockResolvedValue(ok({
      delivered: true as const,
      identity: { agentId: "parent-agent", rootRunId: "root-1", stepIndex: 2 },
    }));
    deps.batcher = {
      enqueue: vi.fn().mockResolvedValue(ok("queued")),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      pending: 0,
      hasDelivered: vi.fn().mockReturnValue(false),
      markDelivered: vi.fn(),
    };
    const runner = createSubAgentRunner(deps);
    const callerConversation = createTestConversation({ agentId: "parent-agent" });
    runner.spawn({
      task: "complete before post-processing stalls",
      agentId: "child-agent",
      callerAgentId: "parent-agent",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
      announceChannelType: "telegram",
      announceChannelId: "channel1",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.memoryAdapter.store).toHaveBeenCalledOnce();

    const shutdown = runner.shutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    await shutdown;

    const completionEvents = vi.mocked(deps.eventBus.emit).mock.calls.filter(
      (call) => call[0] === "session:sub_agent_completed",
    );
    expect(completionEvents).toHaveLength(1);
    expect(completionEvents[0]?.[1]).toEqual(expect.objectContaining({ success: true }));
    expect(deps.sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(deps.batcher.enqueue).not.toHaveBeenCalled();

    releaseMemory({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.batcher.enqueue).not.toHaveBeenCalled();
  });

  it("shutdown suppresses a halted result while its failure summary is still persisting", async () => {
    let releaseMemory!: (value: { ok: boolean }) => void;
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "partial result",
      tokensUsed: { total: 10 },
      cost: { total: 0.01 },
      finishReason: "max_steps",
      stepsExecuted: 50,
    });
    deps.memoryAdapter = {
      store: vi.fn().mockReturnValue(new Promise((resolve) => {
        releaseMemory = resolve;
      })),
    };
    deps.sendGovernedAnnouncement = vi.fn().mockResolvedValue(ok({
      delivered: true as const,
      identity: { agentId: "parent-agent", rootRunId: "root-1", stepIndex: 3 },
    }));
    deps.batcher = {
      enqueue: vi.fn().mockResolvedValue(ok("queued")),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      pending: 0,
      hasDelivered: vi.fn().mockReturnValue(false),
      markDelivered: vi.fn(),
    };
    const runner = createSubAgentRunner(deps);
    const callerConversation = createTestConversation({ agentId: "parent-agent" });
    runner.spawn({
      task: "halt before post-processing stalls",
      agentId: "child-agent",
      callerAgentId: "parent-agent",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
      announceChannelType: "telegram",
      announceChannelId: "channel1",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.memoryAdapter.store).toHaveBeenCalledOnce();

    const shutdown = runner.shutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    await shutdown;

    expect(deps.sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(deps.batcher.enqueue).not.toHaveBeenCalled();

    releaseMemory({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.batcher.enqueue).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // getRunStatus returns undefined for unknown runId
  // -----------------------------------------------------------------------
  it("getRunStatus returns undefined for unknown runId", () => {
    const runner = createSubAgentRunner(deps);
    expect(runner.getRunStatus("nonexistent-id")).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Lifecycle logs emitted when logger provided
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
    const spawnLog = logger.info.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent spawn initiated",
    );
    expect(spawnLog?.[0]).not.toHaveProperty("task");

    // Allow execution to complete
    await vi.advanceTimersByTimeAsync(0);

    // Completion log emitted
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId, finishReason: "stop" }),
      "Sub-agent execution completed",
    );
  });

  // -----------------------------------------------------------------------
  // Session store save called with correct metadata
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
    expect(metadata.agentId).toBe("researcher");
    expect(metadata.parentSessionKey).toBe("default:user1:channel1");
    expect(metadata.spawnedByAgent).toBe("orchestrator");
    expect(metadata.taskDescription).toBe("metadata test");
    expect(metadata.modelOverride).toBe("claude-3-opus");
    expect(metadata.runId).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // The worktree request flag survives the spawn round-trip onto the
  // child session metadata, so executeSubAgent (which only sees the persisted
  // metadata, never SpawnParams) can read it and run the child in an isolated
  // git worktree. Without this thread the `spawn --worktree` flag is a silent
  // no-op — the contract field and the lifecycle module exist, but nothing
  // carries the request to the runner that runs the child.
  // -----------------------------------------------------------------------
  it("persists the worktree request flag onto child session metadata", () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "worktree flag test",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
      callerAgentId: "orchestrator",
      worktree: true,
    });

    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;
    const metadata = saveCall[2] as Record<string, unknown>;
    expect(metadata.worktree).toBe(true);
  });

  it("defaults the worktree metadata flag to false when not requested", () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "no worktree test",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
      callerAgentId: "orchestrator",
    });

    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;
    const metadata = saveCall[2] as Record<string, unknown>;
    expect(metadata.worktree).toBe(false);
  });

  // -----------------------------------------------------------------------
  // buildAnnouncementMessage formats success template
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
  // buildAnnouncementMessage formats failure template
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
  // buildAnnouncementMessage formats halted (max_steps) template
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
  // Spawn uses announceToParent when available
  // -----------------------------------------------------------------------
  it("spawn uses announceToParent when available and callerSessionKey present", async () => {
    const announceToParent = vi.fn().mockResolvedValue(undefined);
    deps.announceToParent = announceToParent;
    const callerConversation = createTestConversation();

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "delegated work",
      agentId: "default",
      callerAgentId: "parent",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
      announceChannelType: "discord",
      announceChannelId: "ch1",
      resolvedLanguage: "und-Hebr",
    });

    await vi.advanceTimersByTimeAsync(0);

    // announceToParent was called, not sendToChannel
    expect(announceToParent).toHaveBeenCalledTimes(1);
    expect(deps.sendToChannel).not.toHaveBeenCalled();

    // Text argument starts with [System Message]
    const text = announceToParent.mock.calls[0]![3];
    expect(text).toMatch(/^\[System Message\]/);

    expect(announceToParent.mock.calls[0]![2]).toEqual(callerConversation);
    expect(announceToParent.mock.calls[0]![6]).toEqual({ resolvedLanguage: "und-Hebr" });

    // Session key was parsed correctly
    const callerSk = announceToParent.mock.calls[0]![1];
    expect(callerSk).toEqual(
      expect.objectContaining({
        tenantId: "default",
        userId: "user1",
        agentId: "parent",
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Spawn falls back to sendToChannel when announceToParent absent
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
  // Parent ambiguity never triggers a second delivery path
  // -----------------------------------------------------------------------
  it("spawn does not raw-fallback when announceToParent throws", async () => {
    const announceToParent = vi.fn().mockRejectedValue(new Error("Parent session unavailable"));
    deps.announceToParent = announceToParent;
    const callerConversation = createTestConversation();

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "error fallback",
      agentId: "default",
      callerAgentId: "parent",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await vi.advanceTimersByTimeAsync(0);

    // announceToParent was attempted
    expect(announceToParent).toHaveBeenCalledTimes(1);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // buildAnnouncementMessage formats context_exhausted template
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
  // buildAnnouncementMessage formats budget_exceeded template
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
  // buildAnnouncementMessage formats context_loop template
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
  // Empty response logs warning
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
  // Completion log includes responseLength
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
  // Kill log includes durationMs and task
  // -----------------------------------------------------------------------
  it("kill log includes duration without task content", async () => {
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

    // Find the kill log call — the message is attributed via the killedBy
    // field (a health-monitor kill must not read as a parent kill).
    const killCall = logger.info.mock.calls.find(
      (call: [Record<string, unknown>, string]) => call[1] === "Sub-agent run killed",
    );
    expect(killCall).toBeDefined();
    expect(killCall![0]).toEqual(expect.objectContaining({
      runId,
      killedBy: "parent",
      durationMs: expect.any(Number),
    }));
    expect(killCall![0]).not.toHaveProperty("task");
    expect((killCall![0] as Record<string, unknown>).durationMs).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // killRun calls sessionResolver.resolveActiveSession
  // -----------------------------------------------------------------------
  it("killRun calls sessionResolver.resolveActiveSession when resolver provided", () => {
    const abortMock = vi.fn().mockResolvedValue(undefined);
    const resolverMock = {
      resolveActiveSession: vi.fn().mockReturnValue({ abort: abortMock }),
    };
    deps.sessionResolver = resolverMock;

    // Use a never-resolving promise so the run stays "running"
    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise(() => {}),
    );

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "task to abort",
      agentId: "default",
    });

    const result = runner.killRun(runId);
    expect(result.killed).toBe(true);
    expect(resolverMock.resolveActiveSession).toHaveBeenCalledWith(
      runner.getRunStatus(runId)!.conversationRef,
    );
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // killRun works normally when sessionResolver is not provided
  // -----------------------------------------------------------------------
  it("killRun works normally when sessionResolver is not provided", () => {
    // sessionResolver is not set (default from createMockDeps).
    // Use a never-resolving promise so the run stays "running"
    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise(() => {}),
    );

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "task without resolver",
      agentId: "default",
    });

    const result = runner.killRun(runId);
    expect(result.killed).toBe(true);
    expect(runner.getRunStatus(runId)!.status).toBe("failed");
  });

  // -----------------------------------------------------------------------
  // killRun handles abort rejection gracefully (best-effort)
  // -----------------------------------------------------------------------
  it("killRun handles abort rejection gracefully", () => {
    const abortMock = vi.fn().mockRejectedValue(new Error("Already terminated"));
    const resolverMock = {
      resolveActiveSession: vi.fn().mockReturnValue({ abort: abortMock }),
    };
    deps.sessionResolver = resolverMock;
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
  // killRun skips abort when resolver has no handle for session
  // -----------------------------------------------------------------------
  it("killRun skips abort when resolver has no handle for session", () => {
    const resolverMock = {
      resolveActiveSession: vi.fn().mockReturnValue(undefined),
    };
    deps.sessionResolver = resolverMock;

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
    expect(resolverMock.resolveActiveSession).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Spawn INFO log includes maxSteps and toolProfile
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
  // buildAnnouncementMessage includes step count
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
  // buildAnnouncementMessage defaults step count to 0
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
  // Completed run result includes stepsExecuted
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
    if (run!.status !== "completed") throw new Error("expected completed run");
    expect(run.telemetry.stepsExecuted).toBe(5);
  });

  // -----------------------------------------------------------------------
  // max_steps is passed to executeAgent
  // -----------------------------------------------------------------------
  it("max_steps and spawn authority are passed to executeAgent", async () => {
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
      expect.objectContaining({
        conversationScope: expect.objectContaining({ tenantId: "default", agentId: "default" }),
        conversationRef: expect.any(String),
      }),
      "limited steps task",
      30,
      undefined,
      undefined,  // graphOverrides (undefined for non-graph spawns)
      undefined,  // tokenBudget (undefined when no per-spawn budget set)
      expect.objectContaining({
        rootRunId: expect.any(String),
        parentCaps: [],
        onAssemblyAuthority: expect.any(Function),
      }),
    );
  });

  it("expected output paths are included in the child execution contract", async () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "create the monthly report",
      agentId: "default",
      expected_outputs: ["/workspace/reports/monthly.csv"],
    });

    await vi.advanceTimersByTimeAsync(0);

    const childTask = vi.mocked(deps.executeAgent).mock.calls[0]?.[3];
    expect(childTask).toContain("create the monthly report");
    expect(childTask).toContain("Expected output contract");
    expect(childTask).toContain("/workspace/reports/monthly.csv");
    expect(childTask).toContain("exact path");
  });

  // A per-spawn tokenBudget is threaded to executeAgent, where the daemon wiring
  // lands it on executionOverrides → the child's BudgetGuard per-execution cap.
  it("tokenBudget and spawn authority are passed to executeAgent", async () => {
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "budgeted task",
      agentId: "default",
      tokenBudget: 5_000,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.executeAgent).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ tenantId: "default" }),
      expect.objectContaining({
        conversationScope: expect.objectContaining({ tenantId: "default", agentId: "default" }),
        conversationRef: expect.any(String),
      }),
      "budgeted task",
      undefined,
      undefined,
      undefined,
      5_000,
      expect.objectContaining({
        rootRunId: expect.any(String),
        parentCaps: [],
        onAssemblyAuthority: expect.any(Function),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Spawn log shows per-spawn maxSteps when provided
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
    expect(call[5]).toBe("parent-agent");
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
        sessionStore: createMockSessionStore(),
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
        clock: testClock,
        timers: testTimers,
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

    it("uses the graph coordinator reserved run identity for the launched attempt", () => {
      const limitDeps = createLimitDeps();
      const runner = createSubAgentRunner(limitDeps);
      const reservedRunId = "20000000-0000-4000-8000-000000000018";

      const runId = runner.spawn({
        task: "graph node with durable launch claim",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
        callerType: "graph",
        reservedRunId,
      });

      expect(runId).toBe(reservedRunId);
      expect(runner.getRunStatus(reservedRunId)?.status).toBe("running");
      expect(() => runner.spawn({
        task: "duplicate graph launch claim",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
        callerType: "graph",
        reservedRunId,
      })).toThrow(/already active/i);
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
        sessionStore: createMockSessionStore(),
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
        clock: testClock,
        timers: testTimers,
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
      const queuedWait = runner.waitForCompletion(runId2);

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
      await expect(queuedWait).resolves.toMatchObject({
        endReason: "completed",
        summary: "done",
      });
    });

    it("throws when queue is full (maxQueuedPerAgent exceeded)", () => {
      const limitDeps: SubAgentRunnerDeps = {
        sessionStore: createMockSessionStore(),
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
        clock: testClock,
        timers: testTimers,
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
        sessionStore: createMockSessionStore(),
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
        clock: testClock,
        timers: testTimers,
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

    it("queued spawns timeout after queueTimeoutMs", async () => {
      vi.useFakeTimers();
      const limitDeps: SubAgentRunnerDeps = {
        sessionStore: createMockSessionStore(),
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
        clock: testClock,
        timers: testTimers,
      };

      const runner = createSubAgentRunner(limitDeps);
      const callerKey = "default:user1:ch1";

      // 1 running + 1 queued
      runner.spawn({ task: "running child", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 });
      const queuedRunId = runner.spawn({ task: "queued child", agentId: "agent-a", callerSessionKey: callerKey, depth: 0, maxDepth: 3 });

      expect(runner.getRunStatus(queuedRunId)!.status).toBe("queued");
      const queuedWait = runner.waitForCompletion(queuedRunId);

      // Advance past queueTimeoutMs + sweep interval (300_000ms)
      vi.advanceTimersByTime(300_001);

      // Queued run should have timed out
      const run = runner.getRunStatus(queuedRunId);
      expect(run!.status).toBe("failed");
      if (run!.status !== "failed") throw new Error("expected failed run");
      expect(run.completion).toMatchObject({
        endReason: "failed",
        errorKind: "timeout",
        summary: expect.stringContaining("Queue timeout"),
      });
      await expect(queuedWait).resolves.toMatchObject({
        endReason: "failed",
        errorKind: "timeout",
      });

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

    // ---------------------------------------------------------------------
    // Tree-wide spawn ceiling consult. The injected
    // checkSpawnCeiling is the SINGLE seam both session.spawn AND graph.*
    // (and the in-process agent loop) hit — it bounds a for(;;) spawn() tree-
    // wide where the per-caller depth/fanout gates cannot.
    // ---------------------------------------------------------------------
    it("rejects spawn when the injected checkSpawnCeiling returns ok:false (tree-wide concurrency)", () => {
      const ceilingDeps = createLimitDeps();
      const checkSpawnCeiling = vi.fn().mockReturnValue({ ok: false, reason: "concurrency" });
      const runner = createSubAgentRunner({ ...ceilingDeps, checkSpawnCeiling });

      expect(() =>
        runner.spawn({
          task: "fork-bomb child",
          agentId: "agent-a",
          callerSessionKey: "default:user1:ch1",
          depth: 0,
          maxDepth: 3,
        }),
      ).toThrow(/spawn ceiling|concurrency/i);

      // The reject mirrors the depth/children reject: the rejection event fires
      // (the ceiling's "concurrency" reason maps to the closed-union tree-wide
      // member "ceiling_concurrency") and NO run/session is created (the ceiling
      // sits before run creation).
      expect(ceilingDeps.eventBus.emit).toHaveBeenCalledWith(
        "session:sub_agent_spawn_rejected",
        expect.objectContaining({ reason: "ceiling_concurrency" }),
      );
      expect(ceilingDeps.sessionStore.save).not.toHaveBeenCalled();
    });

    it("proceeds with the spawn when checkSpawnCeiling returns ok:true (or is absent)", () => {
      const ceilingDeps = createLimitDeps();
      // never-resolving executeAgent keeps the run "running"
      const checkSpawnCeiling = vi.fn().mockReturnValue({ ok: true });
      const runner = createSubAgentRunner({ ...ceilingDeps, checkSpawnCeiling });

      const runId = runner.spawn({
        task: "ordinary child",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      });

      expect(typeof runId).toBe("string");
      expect(runId.length).toBeGreaterThan(0);
      expect(checkSpawnCeiling).toHaveBeenCalled();
    });

    it("passes the run's rootRunId, depth, and active-children fanout to checkSpawnCeiling", () => {
      const ceilingDeps = createLimitDeps();
      const checkSpawnCeiling = vi.fn().mockReturnValue({ ok: true });
      const runner = createSubAgentRunner({ ...ceilingDeps, checkSpawnCeiling });

      runner.spawn({
        task: "child with a stable root",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 1,
        maxDepth: 3,
        rootRunId: "root-stable-xyz",
      });

      // (rootRunId, depth, fanout): the caller's rootRunId rides through (NOT a
      // fresh per-spawn id, which would silently under-count the tree), depth is
      // the current depth, and fanout is the active-children count (0 for the
      // first child).
      expect(checkSpawnCeiling).toHaveBeenCalledWith("root-stable-xyz", 1, 0);
    });

    // The allowlist check is hoisted ABOVE the ceiling
    // acquire, so a not-allowlisted spawn never reserves a slot it cannot
    // release (no run is created → no completion finally fires).
    it("does NOT acquire a ceiling slot when the spawn is rejected by the allowlist", () => {
      const ceilingDeps = createLimitDeps();
      ceilingDeps.config.allowAgents = ["only-this-agent"];
      const checkSpawnCeiling = vi.fn().mockReturnValue({ ok: true });
      const releaseSpawnCeiling = vi.fn();
      const runner = createSubAgentRunner({ ...ceilingDeps, checkSpawnCeiling, releaseSpawnCeiling });

      expect(() =>
        runner.spawn({
          task: "blocked",
          agentId: "not-allowed-agent",
          callerSessionKey: "default:user1:ch1",
          depth: 0,
          maxDepth: 3,
        }),
      ).toThrow(/not allowed to spawn/i);

      // The acquire must NOT have run (the allowlist refuses first), so there is
      // no orphaned reservation and nothing to release.
      expect(checkSpawnCeiling).not.toHaveBeenCalled();
      expect(releaseSpawnCeiling).not.toHaveBeenCalled();
    });

    // Every run that reserved a slot releases it 1:1 on its
    // terminal transition (the run-completion finally), so the per-root counter
    // does not monotonically leak.
    it("releases the ceiling slot once on run completion", async () => {
      const ceilingDeps = createLimitDeps();
      // executeAgent resolves so the run reaches its completion finally.
      vi.mocked(ceilingDeps.executeAgent).mockResolvedValue({
        response: "ok", tokensUsed: { total: 1 }, cost: { total: 0 },
        finishReason: "stop", stepsExecuted: 1,
      });
      const checkSpawnCeiling = vi.fn().mockReturnValue({ ok: true });
      const releaseSpawnCeiling = vi.fn();
      const runner = createSubAgentRunner({ ...ceilingDeps, checkSpawnCeiling, releaseSpawnCeiling });

      runner.spawn({
        task: "completes",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 1,
        maxDepth: 3,
        rootRunId: "root-rel",
      });

      await vi.advanceTimersByTimeAsync(0);

      // Released exactly once, against the run's tree root.
      expect(releaseSpawnCeiling).toHaveBeenCalledTimes(1);
      expect(releaseSpawnCeiling).toHaveBeenCalledWith("root-rel");
    });

    // A killed run also releases (kill marks failed, then the underlying
    // executeAgent promise settles and fires the finally) — and only ONCE.
    it("releases the ceiling slot exactly once even when the run is killed before settling", async () => {
      const ceilingDeps = createLimitDeps();
      let resolveExec!: (v: unknown) => void;
      vi.mocked(ceilingDeps.executeAgent).mockReturnValue(
        new Promise((resolve) => { resolveExec = resolve as (v: unknown) => void; }),
      );
      const checkSpawnCeiling = vi.fn().mockReturnValue({ ok: true });
      const releaseSpawnCeiling = vi.fn();
      const runner = createSubAgentRunner({ ...ceilingDeps, checkSpawnCeiling, releaseSpawnCeiling });

      const runId = runner.spawn({
        task: "killed",
        agentId: "agent-a",
        callerSessionKey: "default:user1:ch1",
        depth: 1,
        maxDepth: 3,
        rootRunId: "root-kill",
      });

      // Kill marks the run failed but the executeAgent promise is still pending.
      expect(runner.killRun(runId).killed).toBe(true);
      // Now let the underlying promise settle → the finally fires.
      resolveExec({ response: "late", tokensUsed: { total: 1 }, cost: { total: 0 }, finishReason: "stop", stepsExecuted: 1 });
      await vi.advanceTimersByTimeAsync(0);

      // Despite two terminal paths (kill + settle), release fires exactly once.
      expect(releaseSpawnCeiling).toHaveBeenCalledTimes(1);
      expect(releaseSpawnCeiling).toHaveBeenCalledWith("root-kill");
    });
  });

  // -----------------------------------------------------------------------
  // Graph-scoped abort group
  // -----------------------------------------------------------------------
  describe("graph-scoped abort group", () => {
    function createAbortGroupDeps(): SubAgentRunnerDeps {
      return {
        sessionStore: createMockSessionStore(),
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
        clock: testClock,
        timers: testTimers,
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
      const watchdogWait = runner.waitForCompletion(runId);

      await vi.advanceTimersByTimeAsync(5_000);

      const runAfter = runner.getRunStatus(runId);
      expect(runAfter).toBeDefined();
      expect(runAfter!.status).toBe("failed");
      if (runAfter!.status !== "failed") throw new Error("expected failed run");
      expect(runAfter.completion).toMatchObject({
        endReason: "watchdog_timeout",
        errorKind: "timeout",
        summary: expect.stringContaining("Execution timeout"),
      });
      await expect(watchdogWait).resolves.toMatchObject({
        endReason: "watchdog_timeout",
      });

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

    it("watchdog aborts SDK session via sessionResolver", async () => {
      deps.config.subagentContext = { maxRunTimeoutMs: 2_000, perStepTimeoutMs: 1_000 } as typeof deps.config.subagentContext;
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
      const mockAbort = vi.fn().mockResolvedValue(undefined);
      // Abort flows through the canonical conversation resolver.
      deps.sessionResolver = { resolveActiveSession: vi.fn().mockReturnValue({ abort: mockAbort }) };
      deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

      const runner = createSubAgentRunner(deps);
      const runId = runner.spawn({
        task: "abort test",
        agentId: "default",
      });

      // run is registered for sessionKey before the watchdog fires;
      // we rely on the resolver mock returning the abort handle.

      await vi.advanceTimersByTimeAsync(2_000);

      expect(deps.sessionResolver.resolveActiveSession).toHaveBeenCalledWith(
        runner.getRunStatus(runId)!.conversationRef,
      );
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
        requesterOrigin: {
          tenantId: "default",
          userId: "user-1",
          channelType: "ghost-test",
          channelId: "ch2",
          threadId: "topic-42",
        },
      });

      // Grace period = 10_000_000 + 120_000 = 10_120_000ms

      // First sweep fires at 300_000ms; run has been running for 300s, within grace
      await vi.advanceTimersByTimeAsync(300_000);
      expect(runner.getRunStatus(runId)!.status).toBe("running");

      // Backdate startedAt so the run appears ancient (past grace period)
      const run = runner.getRunStatus(runId)!;
      run.startedAt = Date.now() - 10_200_000; // 10_200s old > 10_120s grace
      const ghostWait = runner.waitForCompletion(runId);

      // Next sweep fires at 600_000ms total; ghost sweep sees backdated run past grace
      await vi.advanceTimersByTimeAsync(300_000);

      expect(runner.getRunStatus(runId)!.status).toBe("failed");
      const failedRun = runner.getRunStatus(runId)!;
      if (failedRun.status !== "failed") throw new Error("expected failed run");
      expect(failedRun.completion).toMatchObject({
        endReason: "ghost_sweep",
        errorKind: "timeout",
        summary: expect.stringContaining("Ghost run"),
      });
      await expect(ghostWait).resolves.toMatchObject({
        endReason: "ghost_sweep",
      });

      // Failure notification delivered via stored announce channel
      expect(deps.sendToChannel).toHaveBeenCalledWith(
        "ghost-test",
        "ch2",
        expect.any(String),
        { threadId: "topic-42" },
      );
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

  // -----------------------------------------------------------------------
  // Hash-dedup at spawn entry (duplicate spawn protection)
  // -----------------------------------------------------------------------
  describe("hash-dedup against in-flight runs", () => {
    it("dedups same caller and task while first run is still in flight", () => {
      // First spawn never resolves -> first run stays "running" indefinitely
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));

      const runner = createSubAgentRunner(deps);
      const runId1 = runner.spawn({
        task: "fetch AAPL price",
        agentId: "researcher",
        callerSessionKey: "tenant:user1:chan1",
      });

      expect(runner.getRunStatus(runId1)?.status).toBe("running");
      expect(deps.executeAgent).toHaveBeenCalledTimes(1);

      const runId2 = runner.spawn({
        task: "fetch AAPL price",
        agentId: "researcher",
        callerSessionKey: "tenant:user1:chan1",
      });

      expect(runId2).toBe(runId1);
      expect(deps.executeAgent).toHaveBeenCalledTimes(1);

      const dedupInfo = runner.lastSpawnDedupInfo();
      expect(dedupInfo).toBeDefined();
      expect(dedupInfo!.deduped).toBe(true);
      expect(dedupInfo!.existingRunId).toBe(runId1);
      expect(typeof dedupInfo!.ageMs).toBe("number");
      expect(dedupInfo!.ageMs).toBeGreaterThanOrEqual(0);

      expect(runner.getRunStatus(runId1)?.status).toBe("running");
      expect(runner.listRuns()).toHaveLength(1);
    });

    it("does not dedup spawns with different task strings from same caller", () => {
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));

      const runner = createSubAgentRunner(deps);
      const runId1 = runner.spawn({
        task: "task ONE",
        agentId: "researcher",
        callerSessionKey: "tenant:user1:chan1",
      });
      const runId2 = runner.spawn({
        task: "task TWO",
        agentId: "researcher",
        callerSessionKey: "tenant:user1:chan1",
      });

      expect(runId1).not.toBe(runId2);
      expect(deps.executeAgent).toHaveBeenCalledTimes(2);
      expect(runner.lastSpawnDedupInfo()).toBeUndefined();
      expect(runner.listRuns()).toHaveLength(2);
    });

    it("does not dedup spawns across different caller session keys", () => {
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));

      const runner = createSubAgentRunner(deps);
      const runId1 = runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "tenant:user1:chan1",
      });
      const runId2 = runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "tenant:user2:chan2",
      });

      expect(runId1).not.toBe(runId2);
      expect(deps.executeAgent).toHaveBeenCalledTimes(2);
      expect(runner.lastSpawnDedupInfo()).toBeUndefined();
    });

    it("does not dedup when callerSessionKey is undefined for top-level spawn", () => {
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));

      const runner = createSubAgentRunner(deps);
      const runId1 = runner.spawn({ task: "T", agentId: "A" });
      const runId2 = runner.spawn({ task: "T", agentId: "A" });

      expect(runId1).not.toBe(runId2);
      expect(deps.executeAgent).toHaveBeenCalledTimes(2);
      expect(runner.lastSpawnDedupInfo()).toBeUndefined();
    });

    it("re-spawning the same task after completion creates a new run not a dedup", async () => {
      // Default executeAgent mock resolves with a completed result -> first run reaches "completed".
      const runner = createSubAgentRunner(deps);
      const runId1 = runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "K",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.getRunStatus(runId1)?.status).toBe("completed");

      const runId2 = runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "K",
      });

      expect(runId2).not.toBe(runId1);
      expect(deps.executeAgent).toHaveBeenCalledTimes(2);
      expect(runner.lastSpawnDedupInfo()).toBeUndefined();
    });

    it("dedup index is cleaned up when first run fails leaving the slot fair game", async () => {
      vi.mocked(deps.executeAgent).mockRejectedValueOnce(new Error("simulated failure"));

      const runner = createSubAgentRunner(deps);
      const runId1 = runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "K",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.getRunStatus(runId1)?.status).toBe("failed");

      const runId2 = runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "K",
      });

      expect(runId2).not.toBe(runId1);
      expect(runner.lastSpawnDedupInfo()).toBeUndefined();
    });

    it("graph-marked spawns are not deduped against each other or against session spawns", () => {
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));

      const runner = createSubAgentRunner(deps);
      const runId1 = runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "K",
        callerType: "graph",
        graphId: "g-1",
        nodeId: "n-1",
      });
      const runId2 = runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "K",
        callerType: "graph",
        graphId: "g-1",
        nodeId: "n-2",
      });

      expect(runId1).not.toBe(runId2);
      expect(runner.lastSpawnDedupInfo()).toBeUndefined();
    });

    it("emits debug log line on dedup hit with required fields", () => {
      deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));

      const runner = createSubAgentRunner(deps);
      const runId1 = runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "K",
      });
      runner.spawn({
        task: "T",
        agentId: "A",
        callerSessionKey: "K",
      });

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: runId1,
          existingRunId: runId1,
          taskLength: 1,
          callerSessionKey: "K",
          ageMs: expect.any(Number),
          hint: "Duplicate spawn deduped against in-flight run",
        }),
        expect.stringContaining("Sub-agent spawn deduped"),
      );
      expect(deps.logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("dedup"),
      );
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
    const runId = runner.spawn({
      task: "big task",
      agentId: "default",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deps.sendToChannel).mock.calls[0]![2];
    expect(text).toContain("Abort: step_limit");
    expect(runner.getRunStatus(runId)).toMatchObject({
      status: "failed",
      completion: {
        endReason: "failed",
        errorKind: "internal",
        summary: "partial output",
      },
      telemetry: { finishReason: "max_steps" },
    });
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
    const authority = mockStore.mock.calls[0][1];
    expect(authority.turnScope.conversation.agentId).toBe("default");
    expect(authority.turnScope.conversation.tenantId).toBe("default");
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
  // max_steps -> step_limit
  it("maps max_steps to step_limit category", () => {
    const result = classifyAbortReason("max_steps");
    expect(result.category).toBe("step_limit");
    expect(result.severity).toBe("actionable");
    expect(result.hint).toContain("max_steps");
  });

  // budget_exceeded -> budget
  it("maps budget_exceeded to budget category", () => {
    const result = classifyAbortReason("budget_exceeded");
    expect(result.category).toBe("budget");
    expect(result.severity).toBe("actionable");
  });

  // spend_exceeded -> budget (NOT the "unknown" + "check daemon logs"
  // catch-all). A sub-agent killed by the dollars kill-switch must not be
  // classified category:"unknown" with a "check the daemon logs" hint (the
  // default branch) — that is a wrong-way, non-actionable pointer. It must
  // reuse the budget category with the actionable observability.spend.* hint
  // emitSpendAbort already uses.
  it("maps spend_exceeded to the budget category with an actionable observability.spend.* hint", () => {
    const result = classifyAbortReason("spend_exceeded");
    expect(result.category).toBe("budget");
    expect(result.severity).toBe("actionable");
    expect(result.hint).toContain("observability.spend.");
    // Never the catch-all "check the daemon logs" misdirection.
    expect(result.hint).not.toContain("daemon logs");
  });

  // context_loop -> context_full
  it("maps context_loop to context_full category", () => {
    const result = classifyAbortReason("context_loop");
    expect(result.category).toBe("context_full");
    expect(result.severity).toBe("actionable");
  });

  // context_exhausted -> context_full
  it("maps context_exhausted to context_full category", () => {
    const result = classifyAbortReason("context_exhausted");
    expect(result.category).toBe("context_full");
    expect(result.severity).toBe("actionable");
  });

  // circuit_open -> external_timeout
  it("maps circuit_open to external_timeout category", () => {
    const result = classifyAbortReason("circuit_open");
    expect(result.category).toBe("external_timeout");
    expect(result.severity).toBe("investigate");
  });

  // error + "Request was aborted" -> external_timeout
  it("maps error with 'Request was aborted' to external_timeout", () => {
    const result = classifyAbortReason("error", "Request was aborted");
    expect(result.category).toBe("external_timeout");
    expect(result.severity).toBe("investigate");
  });

  // error + timeout patterns -> external_timeout
  it("maps error with timeout patterns to external_timeout", () => {
    const result = classifyAbortReason("error", "connect ETIMEDOUT 1.2.3.4");
    expect(result.category).toBe("external_timeout");
  });

  // generic error -> unknown
  it("maps generic error to unknown", () => {
    const result = classifyAbortReason("error", "something unexpected");
    expect(result.category).toBe("unknown");
    expect(result.severity).toBe("investigate");
  });

  // unknown finishReason -> unknown
  it("maps unknown finishReason to unknown", () => {
    const result = classifyAbortReason("some_new_reason");
    expect(result.category).toBe("unknown");
  });

  // provider_degraded -> provider_degraded
  it("maps provider_degraded to provider_degraded category", () => {
    const result = classifyAbortReason("provider_degraded");
    expect(result.category).toBe("provider_degraded");
    expect(result.severity).toBe("investigate");
    expect(result.hint).toContain("degraded");
  });

  // every classification includes a non-empty hint
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
      sessionStore: createMockSessionStore(),
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
      clock: testClock,
      timers: testTimers,
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
    if (run!.status !== "failed") throw new Error("expected failed run");
    expect(run.completion).toMatchObject({
      endReason: "failed",
      errorKind: "internal",
      summary: "execution crashed",
    });

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
// materializeFullOutput — the child's full output becomes a
// structured ResultRef (summary + handle) in the announcement, never the
// full body. Real timers: the completion path awaits real fs/async ticks.
// ---------------------------------------------------------------------------

describe("materializeFullOutput child-output ResultRef in completion path", () => {
  // A response large enough that re-injecting it would defeat the longevity
  // invariant; the announcement must NEVER contain this verbatim.
  const LARGE_RESPONSE = "X".repeat(50_000);

  function makeMaterializeDeps(): SubAgentRunnerDeps {
    const localDeps = createMockDeps();
    localDeps.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    // The condenser produces the bounded summary; both it and the
    // materializer run.
    localDeps.resultCondenser = {
      condense: vi.fn().mockResolvedValue({
        level: 1,
        result: { taskComplete: true, summary: "bounded summary", conclusions: ["ok"] },
        originalTokens: 5000,
        condensedTokens: 50,
        compressionRatio: 100,
        diskPath: "/tmp/condensed-r1.json",
      }),
    };
    vi.mocked(localDeps.executeAgent).mockResolvedValue({
      response: LARGE_RESPONSE,
      tokensUsed: { total: 5000 },
      cost: { total: 0.1 },
      finishReason: "stop",
      stepsExecuted: 7,
    });
    return localDeps;
  }

  it("embeds the bounded summary plus the ResultRef handle but never the full body", async () => {
    const localDeps = makeMaterializeDeps();
    localDeps.materializeFullOutput = vi.fn().mockResolvedValue({
      ref: "results/r1.json",
      kind: "json",
      bytes: 1_048_576,
      preview: "{...}",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const runner = createSubAgentRunner(localDeps);
    runner.spawn({
      task: "produce a megabyte report",
      agentId: "default",
      callerAgentId: "parent",
      callerSessionKey: "default:user1:channel1",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(localDeps.sendToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(localDeps.sendToChannel).mock.calls[0]![2];
    // The condensed summary is present...
    expect(text).toContain("bounded summary");
    // ...AND the structured handle (ref + bytes + kind)...
    expect(text).toContain("results/r1.json");
    expect(text).toContain("1048576");
    expect(text).toContain("json");
    // ...but the full child body NEVER enters the lead's window.
    expect(text).not.toContain(LARGE_RESPONSE);
  });

  it("calls materializeFullOutput with the spawn runId and the full child response", async () => {
    const localDeps = makeMaterializeDeps();
    const materializeMock = vi.fn().mockResolvedValue({
      ref: "results/r2.json",
      kind: "json",
      bytes: 2048,
      preview: "{...}",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    localDeps.materializeFullOutput = materializeMock;

    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({
      task: "report",
      agentId: "default",
      callerSessionKey: "default:user1:channel1",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(materializeMock).toHaveBeenCalledTimes(1);
    const [content, ctx] = materializeMock.mock.calls[0]!;
    expect(content).toBe(LARGE_RESPONSE);
    expect(ctx.runId).toBe(runId);
    expect(typeof ctx.nowMs).toBe("number");
  });

  it("passes the child agentId in the ctx so the daemon targets the CHILD's jailed workspace", async () => {
    // Security: the materialize target MUST be the child's own jailed
    // workspace, never the lead's — the daemon resolves it from this agentId.
    const localDeps = makeMaterializeDeps();
    const materializeMock = vi.fn().mockResolvedValue({
      ref: "results/r3.json",
      kind: "json",
      bytes: 100,
      preview: "{...}",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    localDeps.materializeFullOutput = materializeMock;

    const runner = createSubAgentRunner(localDeps);
    runner.spawn({
      task: "report",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(materializeMock).toHaveBeenCalledTimes(1);
    const ctx = materializeMock.mock.calls[0]![1];
    expect(ctx.agentId).toBe("researcher");
  });

  it("falls back to summary plus diskPath when materializeFullOutput is absent", async () => {
    const localDeps = makeMaterializeDeps();
    // No materializeFullOutput dep — the worker/no-autonomy path.
    delete (localDeps as { materializeFullOutput?: unknown }).materializeFullOutput;

    const runner = createSubAgentRunner(localDeps);
    runner.spawn({
      task: "report",
      agentId: "default",
      callerSessionKey: "default:user1:channel1",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await new Promise((r) => setTimeout(r, 200));

    const text = vi.mocked(localDeps.sendToChannel).mock.calls[0]![2];
    expect(text).toContain("bounded summary");
    expect(text).toContain("/tmp/condensed-r1.json");
    expect(text).not.toContain(LARGE_RESPONSE);
  });

  it("degrades to summary plus diskPath and WARNs on a MaterializeError refusal", async () => {
    const localDeps = makeMaterializeDeps();
    localDeps.materializeFullOutput = vi
      .fn()
      .mockResolvedValue({ error: "result_ref_too_large: 9000000 > 8388608" });

    const runner = createSubAgentRunner(localDeps);
    runner.spawn({
      task: "report",
      agentId: "default",
      callerSessionKey: "default:user1:channel1",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await new Promise((r) => setTimeout(r, 200));

    // Completion path did not crash — announcement degraded to summary + diskPath.
    const text = vi.mocked(localDeps.sendToChannel).mock.calls[0]![2];
    expect(text).toContain("bounded summary");
    expect(text).toContain("/tmp/condensed-r1.json");
    // A WARN with errorKind:"resource" was emitted on the refusal branch.
    const warnCalls = vi.mocked(localDeps.logger!.warn).mock.calls;
    const resourceWarn = warnCalls.find(
      (c) => (c[0] as { errorKind?: string }).errorKind === "resource",
    );
    expect(resourceWarn).toBeDefined();
  });

  it("degrades silently without a resource WARN when materializeFullOutput returns undefined", async () => {
    const localDeps = makeMaterializeDeps();
    localDeps.materializeFullOutput = vi.fn().mockResolvedValue(undefined);

    const runner = createSubAgentRunner(localDeps);
    runner.spawn({
      task: "report",
      agentId: "default",
      callerSessionKey: "default:user1:channel1",
      announceChannelType: "discord",
      announceChannelId: "ch1",
    });

    await new Promise((r) => setTimeout(r, 200));

    const text = vi.mocked(localDeps.sendToChannel).mock.calls[0]![2];
    expect(text).toContain("bounded summary");
    expect(text).toContain("/tmp/condensed-r1.json");
    // No double-report: the store already logged the contained write failure,
    // so the runner emits NO errorKind:"resource" WARN on the undefined branch.
    const warnCalls = vi.mocked(localDeps.logger!.warn).mock.calls;
    const resourceWarn = warnCalls.find(
      (c) => (c[0] as { errorKind?: string }).errorKind === "resource",
    );
    expect(resourceWarn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ANNOUNCE_PARENT_TIMEOUT_MS constant
// ---------------------------------------------------------------------------

describe("ANNOUNCE_PARENT_TIMEOUT_MS", () => {
  it("equals 300000 milliseconds per sub-agent announce-parent timeout contract", () => {
    expect(ANNOUNCE_PARENT_TIMEOUT_MS).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// deliverAnnouncement timeout fallback
// ---------------------------------------------------------------------------

describe("deliverAnnouncement timeout quarantine", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = createMockDeps();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not raw-fallback when announceToParent hangs past timeout", async () => {
    // announceToParent that never resolves (simulates hang)
    const hangingAnnounce = vi.fn().mockReturnValue(new Promise(() => {}));
    deps.announceToParent = hangingAnnounce;
    deps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const callerConversation = createTestConversation({ agentId: "caller-agent" });

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "task that completes but announce hangs",
      agentId: "default",
      callerSessionKey: formattedConversation(callerConversation),
      callerConversation,
      callerAgentId: "caller-agent",
      announceChannelType: "discord",
      announceChannelId: "chan-timeout",
    });

    // Let executeAgent resolve (it returns from mock)
    await vi.advanceTimersByTimeAsync(100);

    // announceToParent was called
    expect(hangingAnnounce).toHaveBeenCalled();

    // Advance past the parent candidate timeout.
    await vi.advanceTimersByTimeAsync(ANNOUNCE_PARENT_TIMEOUT_MS + 100);

    expect(deps.sendToChannel).not.toHaveBeenCalled();
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

describe("persistent conversation reuse", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuseConversation skips session creation and preserves the provided authority", async () => {
    const reuseConversation = createTestConversation({
      agentId: "bull",
      principalId: "debate-node1",
      conversationId: "debate-round",
    });
    vi.mocked(deps.sessionStore.loadByRef).mockReturnValue(
      ok(persistedConversation(reuseConversation)),
    );
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "round 2 debate",
      agentId: "bull",
      reuseConversation,
    });

    expect(deps.sessionStore.save).not.toHaveBeenCalled();
    expect(deps.sessionStore.loadByRef).toHaveBeenCalledWith(
      { tenantId: "default", agentId: "bull" },
      reuseConversation.conversationRef,
    );

    const run = runner.getRunStatus(runId);
    expect(run?.conversationRef).toBe(reuseConversation.conversationRef);
    expect(run?.sessionKey).toBe(formattedConversation(reuseConversation));

    await vi.advanceTimersByTimeAsync(0);
    expect(deps.executeAgent).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(deps.executeAgent).mock.calls[0]!;
    expect(callArgs[2]).toEqual(reuseConversation);
  });

  it("reuseConversation threads to executeAgent graph overrides", async () => {
    const reuseConversation = createTestConversation({ agentId: "bull" });
    vi.mocked(deps.sessionStore.loadByRef).mockReturnValue(
      ok(persistedConversation(reuseConversation)),
    );
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "round 2 debate",
      agentId: "bull",
      reuseConversation,
      graphId: "g1",
      nodeId: "n1",
    });

    await vi.advanceTimersByTimeAsync(0);
    const callArgs = vi.mocked(deps.executeAgent).mock.calls[0]!;
    expect(callArgs[6]).toEqual({
      graphId: "g1",
      nodeId: "n1",
      reuseConversation,
      graphNodeDepth: undefined,
    });
  });

  it("rejects reuse when persisted session ownership differs from the requested agent", async () => {
    const requestedConversation = createTestConversation({ agentId: "bull" });
    const persistedOwner = createTestConversation({ agentId: "bear" });
    vi.mocked(deps.sessionStore.loadByRef).mockReturnValue(
      ok(persistedConversation(persistedOwner)),
    );
    const runner = createSubAgentRunner(deps);

    expect(() => runner.spawn({
      task: "round 2 debate",
      agentId: "bull",
      reuseConversation: requestedConversation,
    })).toThrow(/session ownership/i);

    expect(deps.executeAgent).not.toHaveBeenCalled();
    expect(deps.sessionStore.save).not.toHaveBeenCalled();
  });

  it("rejects reuse of a persisted session from another tenant", async () => {
    const reuseConversation = createTestConversation({
      tenantId: "other_tenant",
      agentId: "bull",
    });
    const runner = createSubAgentRunner(deps);

    expect(() => runner.spawn({
      task: "round 2 debate",
      agentId: "bull",
      reuseConversation,
    })).toThrow(/tenant/i);

    expect(deps.executeAgent).not.toHaveBeenCalled();
  });

  it("normal spawn without reuse authority still creates a scoped session", async () => {
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "research topic",
      agentId: "researcher",
      callerSessionKey: "default:user1:channel1",
    });

    // sessionStore.save SHOULD be called for normal spawns
    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;
    const conversationScope = saveCall[0];
    expect(conversationScope.tenantId).toBe("default");
    expect(conversationScope.agentId).toBe("researcher");
    expect(conversationScope.partition.kind).toBe("endpoint-conversation-principal");
    if (conversationScope.partition.kind !== "endpoint-conversation-principal") return;
    expect(conversationScope.partition.principalId).toContain("sub-agent:");
    expect(conversationScope.partition.endpoint.channelType).toBe("sub-agent");

    // The run's sessionKey should match the standard format
    const run = runner.getRunStatus(runId);
    expect(run).toBeDefined();
    expect(run!.conversationRef).toMatch(/^cv_/);
  });
});

// ---------------------------------------------------------------------------
// spawn required_tools gate
// ---------------------------------------------------------------------------

describe("spawn required_tools gate", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawn with requiredTools=['obs_query'] and toolGroups=['coding'] throws RequiredToolsUnreachableError before runId", () => {
    // 'obs_query' is in the 'supervisor' profile only — not in 'coding' — and is NOT
    // denylisted (mcp_manage was moved to SUB_AGENT_TOOL_DENYLIST by #254, so it now
    // classifies as 'denylist', not 'outside_profile' — see the gateway case below).
    // The daemon provides reachableToolNames (coding set); gate detects obs_query is absent.
    const runner = createSubAgentRunner(deps);
    const codingSet = new Set(["read", "edit", "write", "grep", "find", "ls", "apply_patch", "exec", "process"]);

    let caughtErr: unknown;
    try {
      runner.spawn({
        task: "test",
        agentId: "default",
        toolGroups: ["coding"],
        requiredTools: ["obs_query"],
        reachableToolNames: codingSet,
      });
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(RequiredToolsUnreachableError);
    const err = caughtErr as RequiredToolsUnreachableError;
    expect(err.unreachableTools).toHaveLength(1);
    expect(err.unreachableTools[0]!.toolName).toBe("obs_query");
    expect(err.unreachableTools[0]!.reason).toBe("outside_profile");
    expect(err.unreachableTools[0]!.hint).toContain("supervisor");

    // No run must have been created (gate fired BEFORE runId)
    expect(runner.listRuns(60)).toHaveLength(0);
  });

  it("spawn with requiredTools=['gateway'] throws RequiredToolsUnreachableError with denylist reason", () => {
    // 'gateway' is in SUB_AGENT_TOOL_DENYLIST — denied to ALL sub-agents.
    const runner = createSubAgentRunner(deps);

    let caughtErr: unknown;
    try {
      runner.spawn({ task: "test", agentId: "default", toolGroups: ["full"], requiredTools: ["gateway"] });
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(RequiredToolsUnreachableError);
    const err = caughtErr as RequiredToolsUnreachableError;
    expect(err.unreachableTools).toHaveLength(1);
    expect(err.unreachableTools[0]!.toolName).toBe("gateway");
    expect(err.unreachableTools[0]!.reason).toBe("denylist");
    expect(err.unreachableTools[0]!.hint).toMatch(/denied to ALL sub-agents/i);

    // No run must have been created
    expect(runner.listRuns(60)).toHaveLength(0);
  });

  it("spawn with requiredTools=['read'] and toolGroups=['coding'] succeeds and returns runId", () => {
    // 'read' is in the coding reachable set → gate passes.
    const runner = createSubAgentRunner(deps);
    const codingSet = new Set(["read", "edit", "write", "grep", "find", "ls", "apply_patch", "exec", "process"]);
    const runId = runner.spawn({
      task: "test",
      agentId: "default",
      toolGroups: ["coding"],
      requiredTools: ["read"],
      reachableToolNames: codingSet,
    });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runner.listRuns(60)).toHaveLength(1);
  });

  it("spawn with no requiredTools field ignores validation and starts normally (backward compatible)", () => {
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({ task: "test", agentId: "default" });
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Gate parity fixes:
//   - gate validates against daemon-provided reachableToolNames (default groups)
//   - gate validates against daemon-provided reachableToolNames (TOOL_GROUPS expansion)
//   - queued spawn path also runs the gate before runId
//   - supervisor hint wording
// ---------------------------------------------------------------------------

describe("spawn required_tools gate parity fixes", () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Spawn with required_tools containing a non-coding tool, no explicit tool_groups,
  // and reachableToolNames provided (coding set) must throw RequiredToolsUnreachableError.
  it("spawn with requiredTools=['mcp_manage'] and no toolGroups but reachableToolNames=coding-set throws RequiredToolsUnreachableError", () => {
    const runner = createSubAgentRunner(deps);
    // reachableToolNames mimics daemon computing effective coding ceiling
    const codingSet = new Set(["read", "edit", "write", "grep", "find", "ls", "apply_patch", "exec", "process"]);

    let caughtErr: unknown;
    try {
      runner.spawn({
        task: "test",
        agentId: "default",
        // no toolGroups — LLM omitted it (the common case)
        requiredTools: ["mcp_manage"],
        reachableToolNames: codingSet,
      });
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(RequiredToolsUnreachableError);
    const err = caughtErr as RequiredToolsUnreachableError;
    expect(err.unreachableTools[0]?.toolName).toBe("mcp_manage");
    // No run created — gate fires before runId
    expect(runner.listRuns(60)).toHaveLength(0);
  });

  // Spawn with tool_groups=["web"], required_tools=["web_fetch"], and
  // reachableToolNames containing "web_fetch" (TOOL_GROUPS expansion) must PASS.
  it("spawn with toolGroups=['web'] and requiredTools=['web_fetch'] with reachableToolNames containing web_fetch succeeds", () => {
    const runner = createSubAgentRunner(deps);
    // reachableToolNames mimics daemon expanding TOOL_GROUPS["group:web"]
    const webSet = new Set(["web_fetch", "web_search", "browser"]);

    const runId = runner.spawn({
      task: "test",
      agentId: "default",
      toolGroups: ["web"],
      requiredTools: ["web_fetch"],
      reachableToolNames: webSet,
    });

    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runner.listRuns(60)).toHaveLength(1);
  });

  // False-deny regression: without reachableToolNames, gate currently
  // false-denies web_fetch because SUB_AGENT_TOOL_PROFILES["web"] is undefined.
  // With reachableToolNames, this works.
  it("spawn without reachableToolNames but toolGroups=['web'] and requiredTools=['web_fetch'] — gate fails open (no crash) when reachableToolNames absent", () => {
    const runner = createSubAgentRunner(deps);
    // No reachableToolNames provided — gate must fail-open (not crash, not false-deny)
    let threw = false;
    try {
      runner.spawn({
        task: "test",
        agentId: "default",
        toolGroups: ["web"],
        requiredTools: ["web_fetch"],
        // no reachableToolNames
      });
    } catch (e) {
      threw = true;
    }
    // Without the daemon-computed set, gate fails-open: no throw
    // (runtime boundary still enforces; gate just can't validate without the set)
    expect(threw).toBe(false);
  });

  // Queued spawn with unreachable required_tools must throw BEFORE the queued runId is created.
  it("queued spawn with unreachable requiredTools throws RequiredToolsUnreachableError before runId (no run created)", () => {
    const runner = createSubAgentRunner(deps);
    // Fill children to force queue path
    const maxChildren = 5;
    for (let i = 0; i < maxChildren; i++) {
      runner.spawn({ task: `task-${i}`, agentId: "default", callerSessionKey: "caller:1" });
    }
    // Now at capacity — next spawn would be queued
    const codingSet = new Set(["read", "edit", "write", "grep", "find", "ls", "apply_patch", "exec", "process"]);
    let caughtErr: unknown;
    try {
      runner.spawn({
        task: "bad-queued",
        agentId: "default",
        callerSessionKey: "caller:1",
        requiredTools: ["mcp_manage"],
        reachableToolNames: codingSet,
      });
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(RequiredToolsUnreachableError);
    // The "bad-queued" run must NOT have been created
    const badRun = runner.listRuns(60).find((r) => r.task === "bad-queued");
    expect(badRun).toBeUndefined();
  });

  // The "no-match" fallback hint must suggest only 'full', not "supervisor' or 'full"
  it("classifyRequiredTool fallback hint for a tool in no profile suggests only 'full' (not supervisor)", () => {
    const runner = createSubAgentRunner(deps);
    const noProfileSet = new Set(["read", "write"]); // "web_fetch" is not in this set

    let caughtErr: unknown;
    try {
      runner.spawn({
        task: "test",
        agentId: "default",
        toolGroups: ["minimal"],
        requiredTools: ["web_fetch"], // web_fetch is NOT in any SUB_AGENT_TOOL_PROFILES entry
        reachableToolNames: noProfileSet,
      });
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(RequiredToolsUnreachableError);
    const err = caughtErr as RequiredToolsUnreachableError;
    const hint = err.unreachableTools[0]?.hint ?? "";
    // Must NOT suggest supervisor (web_fetch is not in supervisor profile)
    expect(hint).not.toContain("supervisor' or 'full");
    // Must suggest 'full'
    expect(hint).toContain("full");
  });
});

// ---------------------------------------------------------------------------
// Cross-check: sub-agent-runner uses BackgroundSessionResolver for
// parent-session lookup.
// ---------------------------------------------------------------------------
describe("sub-agent-runner uses BackgroundSessionResolver for parent-session lookup", () => {
  it("source-grep: no remaining activeRunRegistry.get( in non-test sub-agent-runner source", async () => {
    const fs2 = await import("node:fs");
    const path2 = await import("node:path");
    const url2 = await import("node:url");
    const here = path2.dirname(url2.fileURLToPath(import.meta.url));
    const src = fs2.readFileSync(path2.resolve(here, "sub-agent-runner.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // No literal activeRunRegistry.get( in the source.
    expect(stripped).not.toMatch(/activeRunRegistry\.get\(/);
  });

  // -------------------------------------------------------------------------
  // The runner must pass an onDelivered sink into deadLetterQueue.drain
  // so a DLQ-recovered announcement marks the shared deliveredKeys set —
  // otherwise a later failure sweep double-notifies the same run.
  // -------------------------------------------------------------------------

  it("marks the shared deliveryDedup when a DLQ drain recovers a keyed announcement", async () => {
    vi.useRealTimers(); // shutdown awaits a real microtask chain

    const deliveryDedup = createDeliveryDedup();
    // Stub DLQ whose drain re-delivers a keyed entry and invokes onDelivered.
    const drain = vi.fn(
      async (
        _send: unknown,
        onDelivered?: (idempotencyKey: string) => void,
      ): Promise<void> => {
        onDelivered?.("default:u1:c1::recovered-run");
      },
    );
    const deadLetterQueue = {
      enqueue: vi.fn(),
      drain,
      size: vi.fn().mockReturnValue(0),
    };

    const runner = createSubAgentRunner({
      ...createMockDeps(),
      // The DLQ recovery path registers a provider:recovered listener, so the
      // event bus needs `on` here (the default mock only stubs `emit`).
      eventBus: { emit: vi.fn(), on: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
      deadLetterQueue: deadLetterQueue as unknown as SubAgentRunnerDeps["deadLetterQueue"],
      deliveryDedup,
    });

    // shutdown() drains the DLQ (one of the three drain call sites).
    await runner.shutdown();

    expect(drain).toHaveBeenCalled();
    // The recovered key is now in the shared dedup → a later failure sweep
    // sees hasDelivered === true and suppresses the duplicate notification.
    expect(deliveryDedup.has("default:u1:c1::recovered-run")).toBe(true);
  });
});

// ===========================================================================
// Sandbox no-downgrade gate
//
// The fail-closed posture gate at the single spawn chokepoint: a spawned child
// may never be LESS confined than its spawner. The load-bearing security
// assertion is "refuse BEFORE any run/session/event" — proven on BOTH the
// immediate (normal) and the queued spawn branches. Posture is resolved via an
// INJECTED resolvePosture dep (NOT by reaching config.agents inside the runner).
// ===========================================================================

describe("sandbox no-downgrade gate", () => {
  // A posture map keyed by agentId, returned by the mock resolvePosture dep.
  // `parent` is confined (exec:always); `loose-child` is a downgrade
  // (exec:never); `equal-child` matches the parent; `confined-child` is an
  // upgrade (more confined than an unconfined parent).
  function makePostureResolver(
    byAgent: Record<string, { exec: "always" | "never" }>,
  ): (agentId: string, callerAgentId?: string) => { exec: "always" | "never" } {
    return (agentId: string, callerAgentId?: string) => {
      // Mirror the daemon's effectiveAgentId inherit-caller fallback: an agent
      // with no entry inherits the caller's posture.
      if (Object.prototype.hasOwnProperty.call(byAgent, agentId)) {
        return byAgent[agentId];
      }
      if (callerAgentId && Object.prototype.hasOwnProperty.call(byAgent, callerAgentId)) {
        return byAgent[callerAgentId];
      }
      // No entry for either ⇒ most-confined default (matches resolvePostureFromSkills(undefined)).
      return { exec: "always" };
    };
  }

  function createGateDeps(
    resolvePosture: (agentId: string, callerAgentId?: string) => { exec: "always" | "never" },
    overrides: Partial<SubAgentRunnerDeps> = {},
  ): SubAgentRunnerDeps {
    return {
      sessionStore: createMockSessionStore(),
      // never resolves -- keeps children "running" so the children-limit path is reachable
      executeAgent: vi.fn().mockReturnValue(new Promise(() => {})),
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
      clock: testClock,
      timers: testTimers,
      resolvePosture: resolvePosture as unknown as SubAgentRunnerDeps["resolvePosture"],
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // LOAD-BEARING: refuse before any run/session/event — immediate (normal) path
  // -------------------------------------------------------------------------
  it("refuses a downgrade spawn BEFORE any run/session/event on the immediate path", () => {
    const resolvePosture = makePostureResolver({
      parent: { exec: "always" },
      "loose-child": { exec: "never" },
    });
    const deps = createGateDeps(resolvePosture);
    const runner = createSubAgentRunner(deps);

    expect(() =>
      runner.spawn({
        task: "escalate task",
        agentId: "loose-child",
        callerAgentId: "parent",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      }),
    ).toThrow(/sandbox posture is less confined/i);

    // The fail-closed invariant: NO side effects of any kind.
    expect(deps.sessionStore.save).not.toHaveBeenCalled();
    expect(deps.executeAgent).not.toHaveBeenCalled();
    expect(runner.listRuns()).toHaveLength(0);
    // No spawn / queued / rejected lifecycle event for this refusal.
    expect(deps.eventBus.emit).not.toHaveBeenCalledWith(
      "session:sub_agent_spawned",
      expect.anything(),
    );
    expect(deps.eventBus.emit).not.toHaveBeenCalledWith(
      "session:sub_agent_spawn_queued",
      expect.anything(),
    );

    // The typed refusal event fires (before the throw, at the same
    // point a run/session would otherwise be created) carrying both postures as
    // enum tuples + the violated dimension(s) + the parent/child ids — NO secrets.
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "security:sandbox_downgrade_refused",
      expect.objectContaining({
        parentAgentId: "parent",
        childAgentId: "loose-child",
        violatedDimensions: ["exec"],
        parentPosture: { exec: "always" },
        childPosture: { exec: "never" },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // The refusal is a
  // TYPED SandboxDowngradeError, so the daemon's classifyRpcError classifies it
  // warn/precondition — a fail-closed SECURITY refusal must not read as an
  // internal/error handler fault in a system health sweep.
  // -------------------------------------------------------------------------
  it("throws a TYPED SandboxDowngradeError carrying the violated dimensions", () => {
    const resolvePosture = makePostureResolver({
      parent: { exec: "always" },
      "loose-child": { exec: "never" },
    });
    const runner = createSubAgentRunner(createGateDeps(resolvePosture));
    let thrown: unknown;
    try {
      runner.spawn({
        task: "escalate task",
        agentId: "loose-child",
        callerAgentId: "parent",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SandboxDowngradeError);
    expect((thrown as SandboxDowngradeError).violatedDimensions).toEqual(["exec"]);
  });

  // -------------------------------------------------------------------------
  // LOAD-BEARING: refuse before any run/session/event — queued path
  // -------------------------------------------------------------------------
  it("refuses a downgrade spawn BEFORE the queue enqueue on the queued path", () => {
    const resolvePosture = makePostureResolver({
      parent: { exec: "always" },
      "loose-child": { exec: "never" },
    });
    const deps = createGateDeps(resolvePosture);
    const runner = createSubAgentRunner(deps);

    // Saturate the children limit with 5 EQUAL-posture children (caller == child
    // agentId "parent" ⇒ equal ⇒ not refused). The 6th spawn would queue.
    for (let i = 0; i < 5; i++) {
      runner.spawn({
        task: `child task ${i}`,
        agentId: "parent",
        callerAgentId: "parent",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      });
    }
    expect(runner.listRuns()).toHaveLength(5);

    // The 6th spawn is a DOWNGRADE child — at the children limit it would
    // normally QUEUE. The gate sits before the children/queue branch, so it
    // must THROW before any queued run is created.
    expect(() =>
      runner.spawn({
        task: "escalate while saturated",
        agentId: "loose-child",
        callerAgentId: "parent",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      }),
    ).toThrow(/sandbox posture is less confined/i);

    // No queued run was created (still exactly the 5 running children).
    expect(runner.listRuns()).toHaveLength(5);
    expect(runner.listRuns().every((r) => r.status === "running")).toBe(true);
    expect(deps.eventBus.emit).not.toHaveBeenCalledWith(
      "session:sub_agent_spawn_queued",
      expect.objectContaining({ agentId: "loose-child" }),
    );
  });

  // -------------------------------------------------------------------------
  // Equal posture allowed
  // -------------------------------------------------------------------------
  it("allows a spawn when child posture equals the parent", () => {
    const resolvePosture = makePostureResolver({
      parent: { exec: "always" },
      "equal-child": { exec: "always" },
    });
    const deps = createGateDeps(resolvePosture);
    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "equal task",
      agentId: "equal-child",
      callerAgentId: "parent",
      callerSessionKey: "default:user1:ch1",
      depth: 0,
      maxDepth: 3,
    });

    expect(typeof runId).toBe("string");
    expect(runner.getRunStatus(runId)?.status).toBe("running");
    expect(deps.executeAgent).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Upgrade (more-confined child) allowed
  // -------------------------------------------------------------------------
  it("allows a spawn when the child is MORE confined than the parent (upgrade)", () => {
    const resolvePosture = makePostureResolver({
      "loose-parent": { exec: "never" },
      "confined-child": { exec: "always" },
    });
    const deps = createGateDeps(resolvePosture);
    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "upgrade task",
      agentId: "confined-child",
      callerAgentId: "loose-parent",
      callerSessionKey: "default:user1:ch1",
      depth: 0,
      maxDepth: 3,
    });

    expect(typeof runId).toBe("string");
    expect(runner.getRunStatus(runId)?.status).toBe("running");
  });

  // -------------------------------------------------------------------------
  // Missing-child-config-safe-default
  // -------------------------------------------------------------------------
  it("does NOT refuse a config-less child vs a config-less parent (both fold to most-confined)", () => {
    // Neither id is in the posture map ⇒ both resolve to most-confined default ⇒ equal.
    const resolvePosture = makePostureResolver({});
    const deps = createGateDeps(resolvePosture);
    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "unconfigured task",
      agentId: "no-config-child",
      callerAgentId: "no-config-parent",
      callerSessionKey: "default:user1:ch1",
      depth: 0,
      maxDepth: 3,
    });

    expect(typeof runId).toBe("string");
    expect(runner.getRunStatus(runId)?.status).toBe("running");
  });

  it("DOES refuse a config-less (unconfined) child vs a confined parent", () => {
    // Parent confined (exec:always); child has no entry but the resolver mock
    // returns an explicit unconfined posture for it ⇒ downgrade.
    const resolvePosture = makePostureResolver({
      "confined-parent": { exec: "always" },
      "loose-child": { exec: "never" },
    });
    const deps = createGateDeps(resolvePosture);
    const runner = createSubAgentRunner(deps);

    expect(() =>
      runner.spawn({
        task: "escalate task",
        agentId: "loose-child",
        callerAgentId: "confined-parent",
        callerSessionKey: "default:user1:ch1",
        depth: 0,
        maxDepth: 3,
      }),
    ).toThrow(/sandbox posture is less confined/i);
    expect(runner.listRuns()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Gate disabled via config
  // -------------------------------------------------------------------------
  it("does NOT refuse a downgrade when config.sandboxNoDowngrade is false", () => {
    const resolvePosture = makePostureResolver({
      parent: { exec: "always" },
      "loose-child": { exec: "never" },
    });
    const deps = createGateDeps(resolvePosture, {
      config: {
        enabled: true,
        maxPingPongTurns: 3,
        allowAgents: [],
        subAgentRetentionMs: 3_600_000,
        waitTimeoutMs: 60_000,
        subAgentMaxSteps: 50,
        subAgentToolGroups: ["coding"],
        sandboxNoDowngrade: false,
        subagentContext: { maxSpawnDepth: 3, maxChildrenPerAgent: 5 },
      } as SubAgentRunnerDeps["config"],
    });
    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "downgrade-but-allowed",
      agentId: "loose-child",
      callerAgentId: "parent",
      callerSessionKey: "default:user1:ch1",
      depth: 0,
      maxDepth: 3,
    });

    expect(typeof runId).toBe("string");
    expect(runner.getRunStatus(runId)?.status).toBe("running");
  });

  // -------------------------------------------------------------------------
  // Resolver absent (older wiring) — gate inert
  // -------------------------------------------------------------------------
  it("is inert (no refusal) when no resolvePosture dep is wired", () => {
    // createMockDeps() has no resolvePosture — the older-wiring inert path.
    const deps = createMockDeps();
    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "no-resolver task",
      agentId: "loose-child",
      callerAgentId: "parent",
      callerSessionKey: "default:user1:ch1",
      depth: 0,
      maxDepth: 3,
    });

    expect(typeof runId).toBe("string");
    expect(runner.getRunStatus(runId)?.status).toBe("running");
  });

  // -------------------------------------------------------------------------
  // Make the fail-OPEN observable. When the gate is enabled but no
  // resolver was injected, the gate is silently inert (a security control that
  // no-ops). Emit a one-time construction WARN so an operator sees the fail-open
  // in the logs — defense-in-depth alongside the daemon-wiring test.
  // -------------------------------------------------------------------------
  it("emits a one-time construction WARN when sandboxNoDowngrade is enabled but no resolver is injected", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const deps = {
      ...createMockDeps(),
      config: {
        enabled: true,
        maxPingPongTurns: 3,
        allowAgents: [],
        subAgentRetentionMs: 3_600_000,
        waitTimeoutMs: 60_000,
        subAgentMaxSteps: 50,
        subAgentToolGroups: ["coding"],
        sandboxNoDowngrade: true,
      } as SubAgentRunnerDeps["config"],
      logger: logger as unknown as SubAgentRunnerDeps["logger"],
      // resolvePosture intentionally absent ⇒ fail-open.
    };

    createSubAgentRunner(deps);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "config",
        hint: expect.stringContaining("no posture resolver"),
      }),
      expect.stringMatching(/no-downgrade gate is INERT/i),
    );
  });

  it("does NOT warn at construction when the resolver IS injected", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const resolvePosture = makePostureResolver({});
    const deps = createGateDeps(resolvePosture, {
      logger: logger as unknown as SubAgentRunnerDeps["logger"],
    });

    createSubAgentRunner(deps);

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/no-downgrade gate is INERT/i),
    );
  });

  it("does NOT warn at construction when sandboxNoDowngrade is explicitly false (gate intentionally off)", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const deps = {
      ...createMockDeps(),
      config: {
        enabled: true,
        maxPingPongTurns: 3,
        allowAgents: [],
        subAgentRetentionMs: 3_600_000,
        waitTimeoutMs: 60_000,
        subAgentMaxSteps: 50,
        subAgentToolGroups: ["coding"],
        sandboxNoDowngrade: false,
      } as SubAgentRunnerDeps["config"],
      logger: logger as unknown as SubAgentRunnerDeps["logger"],
    };

    createSubAgentRunner(deps);

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/no-downgrade gate is INERT/i),
    );
  });

  // -------------------------------------------------------------------------
  // Top-level spawn (no callerAgentId) — no parent to compare against
  // -------------------------------------------------------------------------
  it("allows a top-level spawn with no callerAgentId (no spawner posture to compare)", () => {
    // resolvePosture would mark "loose-child" a downgrade vs a confined parent,
    // but a top-level spawn has no parent ⇒ the gate does not fire.
    const resolvePosture = makePostureResolver({
      "loose-child": { exec: "never" },
    });
    const deps = createGateDeps(resolvePosture);
    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "top-level task",
      agentId: "loose-child",
      callerSessionKey: "default:user1:ch1",
      depth: 0,
      maxDepth: 3,
      // callerAgentId intentionally omitted
    });

    expect(typeof runId).toBe("string");
    expect(runner.getRunStatus(runId)?.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// rootRunId / parentLeaseId plumbing — the foundation for the tree-wide
// ceiling and kill-by-root. A tree-stable rootRunId is the key the unified
// semaphore and the kill-by-root primitive consult. A child that mints a
// fresh id escapes its parent's ceiling (a silent under-count),
// so the inheritance invariant below is load-bearing.
// ---------------------------------------------------------------------------
describe("createSubAgentRunner rootRunId/parentLeaseId tree plumbing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records the rootRunId passed in SpawnParams onto the SubAgentRun", () => {
    const deps = createMockDeps();
    // Never-resolving execute keeps the run in `running` so getRunStatus reads it.
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "research topic",
      agentId: "researcher",
      rootRunId: "root-X",
    });

    expect(runner.getRunStatus(runId)?.rootRunId).toBe("root-X");
  });

  it("mints a non-empty rootRunId for a depth-0 root spawn that omits one", () => {
    const deps = createMockDeps();
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "summarize document",
      agentId: "default",
      depth: 0,
      // rootRunId intentionally omitted — this IS the root, it must mint one.
    });

    const minted = runner.getRunStatus(runId)?.rootRunId;
    expect(typeof minted).toBe("string");
    expect((minted ?? "").length).toBeGreaterThan(0);
  });

  it("a child spawn inherits the parent rootRunId rather than minting a fresh one", () => {
    const deps = createMockDeps();
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const runner = createSubAgentRunner(deps);

    // The root mints its id...
    const parentRunId = runner.spawn({
      task: "parent task",
      agentId: "parent",
      depth: 0,
    });
    const parentRootId = runner.getRunStatus(parentRunId)?.rootRunId;
    expect(typeof parentRootId).toBe("string");

    // ...and a child passing that id down must carry the SAME id (one tree → one id).
    const childRunId = runner.spawn({
      task: "child task",
      agentId: "child",
      depth: 1,
      rootRunId: parentRootId,
    });

    expect(runner.getRunStatus(childRunId)?.rootRunId).toBe(parentRootId);
  });

  it("records parentLeaseId on the run when provided and leaves it undefined when omitted", () => {
    const deps = createMockDeps();
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const runner = createSubAgentRunner(deps);

    const withLease = runner.spawn({
      task: "child with lease",
      agentId: "child",
      depth: 1,
      rootRunId: "root-X",
      parentLeaseId: "lease-parent-1",
    });
    expect(runner.getRunStatus(withLease)?.parentLeaseId).toBe("lease-parent-1");

    const withoutLease = runner.spawn({
      task: "root no lease",
      agentId: "root",
      depth: 0,
    });
    expect(runner.getRunStatus(withoutLease)?.parentLeaseId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// killByRootRun fans killRun over every run of a tree.
// The per-run killRun aborts each SDK session; killByRootRun applies it to
// every running/queued run sharing a rootRunId, filtering strictly so a
// different tree is untouched.
// ---------------------------------------------------------------------------
describe("createSubAgentRunner killByRootRun tree fan-out", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills every running/queued run of a rootRunId and leaves other trees untouched", () => {
    const deps = createMockDeps();
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const runner = createSubAgentRunner(deps);

    const a = runner.spawn({ task: "a", agentId: "x", depth: 1, rootRunId: "root-K" });
    const b = runner.spawn({ task: "b", agentId: "y", depth: 1, rootRunId: "root-K" });
    const c = runner.spawn({ task: "c", agentId: "z", depth: 1, rootRunId: "root-K" });
    const other = runner.spawn({ task: "o", agentId: "w", depth: 1, rootRunId: "root-OTHER" });

    const result = runner.killByRootRun("root-K");

    expect(result.killed).toBe(3);
    expect(runner.getRunStatus(a)?.status).toBe("failed");
    expect(runner.getRunStatus(b)?.status).toBe("failed");
    expect(runner.getRunStatus(c)?.status).toBe("failed");
    // The other tree is verifiably untouched.
    expect(runner.getRunStatus(other)?.status).toBe("running");
  });

  it("skips runs already terminal and counts only the still-killable ones of the tree", () => {
    const deps = createMockDeps();
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const runner = createSubAgentRunner(deps);

    const stillRunning = runner.spawn({ task: "live", agentId: "x", depth: 1, rootRunId: "root-K" });
    const toComplete = runner.spawn({ task: "done", agentId: "y", depth: 1, rootRunId: "root-K" });

    // Drive `toComplete` to a terminal state via a per-run kill first.
    expect(runner.killRun(toComplete).killed).toBe(true);
    expect(runner.getRunStatus(toComplete)?.status).toBe("failed");

    // killByRootRun must skip the already-failed run and only count the live one.
    const result = runner.killByRootRun("root-K");
    expect(result.killed).toBe(1);
    expect(runner.getRunStatus(stillRunning)?.status).toBe("failed");
  });

  it("returns a zero count for an unknown rootRunId without throwing", () => {
    const deps = createMockDeps();
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const runner = createSubAgentRunner(deps);

    runner.spawn({ task: "live", agentId: "x", depth: 1, rootRunId: "root-K" });

    expect(runner.killByRootRun("no-such-root")).toEqual({ killed: 0 });
  });
});

// ---------------------------------------------------------------------------
// The ~30s read-only progress fork lifecycle in the spawn path
// ---------------------------------------------------------------------------
//
// The runner starts the read-only progress fork when a child run begins and
// stops it on the run's terminal settle (the completion finally) so it never
// outlives the child (no leaked timer). vi.useFakeTimers() drives the
// injected clock/timers (testClock/testTimers delegate to the faked globals).

describe("read-only progress fork lifecycle (sub-agent-runner)", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a content-free session:sub_agent_progress ~30s into a long-running child", async () => {
    // A never-resolving exec keeps the child in-flight so the fork can tick.
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const emit = vi.mocked((deps.eventBus as unknown as { emit: ReturnType<typeof vi.fn> }).emit);

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "long research",
      agentId: "child-long",
      callerSessionKey: "default:user1:channel1",
    });

    // No progress before the first tick.
    expect(emit.mock.calls.filter((c) => c[0] === "session:sub_agent_progress")).toHaveLength(0);

    // Advance ~30s → exactly one progress tick.
    await vi.advanceTimersByTimeAsync(30_000);

    const progress = emit.mock.calls.filter((c) => c[0] === "session:sub_agent_progress");
    expect(progress).toHaveLength(1);
    const payload = progress[0]![1] as {
      runId: string; agentId: string; progressLine: string;
      elapsedMs: number; stepsExecuted: number; timestamp: number;
    };
    expect(payload.agentId).toBe("child-long");
    expect(typeof payload.runId).toBe("string");
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(payload.progressLine.length).toBeGreaterThan(0);
    // Content-free: only the 6 bounded status keys, no child output/body.
    expect(Object.keys(payload).sort()).toEqual(
      ["agentId", "elapsedMs", "progressLine", "runId", "stepsExecuted", "timestamp"].sort(),
    );
    // No explicit shutdown: the fork interval is .unref()'d so it never blocks
    // exit; afterEach's vi.useRealTimers() reclaims the faked timer. (Awaiting
    // shutdown() here would hang on the never-resolving exec under fake timers.)
  });

  it("stops the fork on the completion finally — no progress after the child settles", async () => {
    // Default mock exec resolves immediately → the run completes, the fork stops.
    const emit = vi.mocked((deps.eventBus as unknown as { emit: ReturnType<typeof vi.fn> }).emit);

    const runner = createSubAgentRunner(deps);
    runner.spawn({ task: "quick task", agentId: "child-quick" });

    // Drive the completion path (the terminal finally stops the fork).
    await vi.advanceTimersByTimeAsync(0);

    const before = emit.mock.calls.filter((c) => c[0] === "session:sub_agent_progress").length;

    // Advance well past the interval AFTER completion → no further progress.
    await vi.advanceTimersByTimeAsync(120_000);

    const after = emit.mock.calls.filter((c) => c[0] === "session:sub_agent_progress").length;
    expect(after).toBe(before); // fork was stopped — no new ticks
  });

  it("ticks repeatedly while the child stays in-flight (~90s ⇒ 3 progress events)", async () => {
    vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
    const emit = vi.mocked((deps.eventBus as unknown as { emit: ReturnType<typeof vi.fn> }).emit);

    const runner = createSubAgentRunner(deps);
    runner.spawn({ task: "very long", agentId: "child-vlong" });

    await vi.advanceTimersByTimeAsync(90_000);

    const progress = emit.mock.calls.filter((c) => c[0] === "session:sub_agent_progress");
    expect(progress.length).toBe(3);
    // No shutdown await (never-resolving exec) — the .unref()'d interval is
    // reclaimed by afterEach's vi.useRealTimers().
  });
});

// ---------------------------------------------------------------------------
// Progress-fork security: window isolation is NOT escalation
// ---------------------------------------------------------------------------
//
// Each fresh-window coordinator child inherits an ATTENUATED lease (parent ∩
// requested — never broader) and writes to its OWN jailed workspace,
// distinct from the lead's. The lease mint lives in daemon wiring
// (setup-broker-activation.ts via attenuateCaps); the runner consumes the
// already-minted params.caps verbatim and NEVER broadens them. We assert the
// invariant directly against the security primitives (the single source of
// truth) plus a runner-level check that a spawn carries no cap outside the
// parent set.

describe("coordinator-child attenuated lease + own jailed workspace (no escalation)", () => {
  it("attenuateCaps yields a subset of the parent caps — never broader", () => {
    const parent: AgentCapability[] = ["orch:spawn", "orch:read", "orch:graph"];
    // A coordinator child requests a SUPERSET (incl. caps the parent lacks).
    const requested: AgentCapability[] = ["orch:read", "orch:write", "orch:spawn", "orch:cron"];

    const childLease = attenuateCaps(parent, requested);

    // Every minted cap is held by the parent (subset).
    for (const cap of childLease) {
      expect(parent).toContain(cap);
    }
    // The result is exactly parent ∩ requested — the cross-window broadening
    // (orch:write, orch:cron) is dropped; window isolation is not escalation.
    expect([...childLease].sort()).toEqual(["orch:read", "orch:spawn"].sort());
    // And it never holds a cap the parent does not.
    expect(childLease).not.toContain("orch:write");
    expect(childLease).not.toContain("orch:cron");
  });

  it("a coordinator child cannot mint a cap outside the full capability set", () => {
    // Even requesting EVERY known capability, a narrow parent stays narrow.
    const narrowParent: AgentCapability[] = ["orch:read"];
    const childLease = attenuateCaps(narrowParent, [...AGENT_CAPABILITIES]);
    expect(childLease).toEqual(["orch:read"]); // intersection with a singleton parent
  });

  it("each child resolves its OWN jailed workspace, distinct from the lead's", () => {
    const cfg: AgentConfig = {} as AgentConfig; // no explicit workspacePath → suffixed-by-agentId
    const dataDir = "/data/.comis";
    const leadWorkspace = resolveWorkspaceDir(cfg, "lead", dataDir);
    const childA = resolveWorkspaceDir(cfg, "coordinator-child-a", dataDir);
    const childB = resolveWorkspaceDir(cfg, "coordinator-child-b", dataDir);

    // Each agent's workspace is its own — a child never resolves the lead's dir.
    expect(childA).not.toBe(leadWorkspace);
    expect(childB).not.toBe(leadWorkspace);
    expect(childA).not.toBe(childB);
    expect(childA).toContain("coordinator-child-a");
    expect(leadWorkspace).toContain("lead");
  });

  it("the runner consumes params.caps verbatim — it never broadens the child lease", async () => {
    // The runner threads the ALREADY-minted (attenuated) caps it is given onto
    // the durable checkpoint — it does not add to them. Capture what it persists.
    const deps = createMockDeps();
    vi.useFakeTimers();
    try {
      vi.mocked(deps.executeAgent).mockReturnValue(new Promise(() => {}));
      const upsertCheckpoint = vi.fn().mockResolvedValue({ ok: true });
      deps.durableRuns = {
        upsertCheckpoint,
        touchHeartbeat: vi.fn().mockResolvedValue({ ok: true }),
        markCompleted: vi.fn().mockResolvedValue({ ok: true }),
      } as unknown as NonNullable<SubAgentRunnerDeps["durableRuns"]>;

      const parent: AgentCapability[] = ["orch:spawn", "orch:read", "orch:graph"];
      const mintedChildLease = attenuateCaps(parent, ["orch:read", "orch:write"]); // ["orch:read"]

      const runner = createSubAgentRunner(deps);
      runner.spawn({
        task: "isolated child",
        agentId: "coordinator-child",
        depth: 1,
        rootRunId: "root-COORD",
        caps: mintedChildLease,
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(upsertCheckpoint).toHaveBeenCalled();
      const persisted = upsertCheckpoint.mock.calls[0]![0] as { caps: AgentCapability[] };
      // The runner persisted EXACTLY the minted (attenuated) lease — no broadening.
      expect([...persisted.caps].sort()).toEqual([...mintedChildLease].sort());
      for (const cap of persisted.caps) {
        expect(parent).toContain(cap); // still a subset of the parent
      }
      expect(persisted.caps).not.toContain("orch:write"); // the dropped cross-window cap
      // No shutdown await (never-resolving exec) — fake timers reclaimed below.
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// killRun attribution, notification, and trajectory teardown.
// A daemon health-monitor kill must be attributed to the health monitor (not
// "Killed by parent agent"), must notify the announce channel (the parent
// only learns of a parent-initiated kill because it issued it), and every
// terminal path must release the session's trajectory recorder so a dead
// child stops ingesting other sessions' events.
// ---------------------------------------------------------------------------

describe("killRun attribution + notification + trajectory teardown", () => {
  function runningDeps(): SubAgentRunnerDeps {
    const localDeps = createMockDeps();
    localDeps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.mocked(localDeps.executeAgent).mockReturnValue(new Promise(() => {}));
    return localDeps;
  }

  it("health-monitor kill records killedBy + reason on the run and the failure record", async () => {
    const killDir = await mkdtemp(join(tmpdir(), "stuck-kill-attrib-"));
    const localDeps = runningDeps();
    localDeps.dataDir = killDir;
    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({ task: "long task", agentId: "default" });
    await new Promise((r) => setTimeout(r, 50));

    const reason = "no sub-agent activity for 200000ms (security.agentToAgent.subagentContext.stuckKillThresholdMs=180000)";
    const result = runner.killRun(runId, {
      killedBy: "health_monitor",
      reason,
      idleMs: 200_000,
      thresholdMs: 180_000,
    });
    expect(result.killed).toBe(true);
    const killedRun = runner.getRunStatus(runId)!;
    if (killedRun.status !== "failed") throw new Error("expected failed run");
    expect(killedRun.completion).toMatchObject({
      endReason: "killed",
      errorKind: "timeout",
      summary: reason,
    });

    await new Promise((r) => setTimeout(r, 200));
    const resultsDir = join(killDir, "subagent-results");
    const sessionDirs = await readdir(resultsDir);
    const files = await readdir(join(resultsDir, sessionDirs[0]!));
    const content = JSON.parse(
      await readFile(join(resultsDir, sessionDirs[0]!, files[0]!), "utf-8"),
    );
    expect(content.error).toBe(reason);
    expect(content.killedBy).toBe("health_monitor");
    expect(content.endReason).toBe("killed");

    fs.rmSync(killDir, { recursive: true, force: true });
  });

  it("default kill records parent attribution in the bounded completion", async () => {
    const localDeps = runningDeps();
    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({ task: "t", agentId: "default" });
    await new Promise((r) => setTimeout(r, 50));
    const killedWait = runner.waitForCompletion(runId);

    expect(runner.killRun(runId).killed).toBe(true);
    const killedRun = runner.getRunStatus(runId)!;
    if (killedRun.status !== "failed") throw new Error("expected failed run");
    expect(killedRun.completion).toMatchObject({
      endReason: "killed",
      errorKind: "precondition",
      summary: "Killed by parent agent",
    });
    await expect(killedWait).resolves.toBe(killedRun.completion);
  });

  it("kill emits subagent:killed with a content-free telemetry payload", async () => {
    const localDeps = runningDeps();
    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({ task: "t", agentId: "default" });
    await new Promise((r) => setTimeout(r, 50));

    runner.killRun(runId, {
      killedBy: "health_monitor",
      reason: "no sub-agent activity for 200000ms",
      idleMs: 200_000,
      thresholdMs: 180_000,
    });

    const emit = vi.mocked(localDeps.eventBus.emit);
    const killedCall = emit.mock.calls.find((c) => c[0] === "subagent:killed");
    expect(killedCall).toBeDefined();
    const payload = killedCall![1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      runId,
      agentId: "default",
      killedBy: "health_monitor",
      idleMs: 200_000,
      thresholdMs: 180_000,
    });
    expect(typeof payload.sessionKey).toBe("string");
    expect(typeof payload.runtimeMs).toBe("number");
    // Free-text reason stays on the run/failure-record/log — never the bus.
    expect("reason" in payload).toBe(false);
  });

  it("parent kill emits killedBy parent and delivers NO notification", async () => {
    const localDeps = runningDeps();
    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({
      task: "t",
      agentId: "default",
      announceChannelType: "telegram",
      announceChannelId: "42",
    });
    await new Promise((r) => setTimeout(r, 50));

    runner.killRun(runId);
    await new Promise((r) => setTimeout(r, 100));

    const emit = vi.mocked(localDeps.eventBus.emit);
    const killedCall = emit.mock.calls.find((c) => c[0] === "subagent:killed");
    expect((killedCall![1] as Record<string, unknown>).killedBy).toBe("parent");
    expect(localDeps.sendToChannel).not.toHaveBeenCalled();
  });

  it("health-monitor kill delivers an LLM-free failure notification to the announce channel", async () => {
    const localDeps = runningDeps();
    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({
      task: "rank all system drivers",
      agentId: "default",
      announceChannelType: "telegram",
      announceChannelId: "42",
    });
    await new Promise((r) => setTimeout(r, 50));

    runner.killRun(runId, {
      killedBy: "health_monitor",
      reason: "no sub-agent activity for 200000ms",
      idleMs: 200_000,
      thresholdMs: 180_000,
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(localDeps.sendToChannel).toHaveBeenCalledTimes(1);
    const [channelType, channelId, text] = vi.mocked(localDeps.sendToChannel).mock.calls[0]!;
    expect(channelType).toBe("telegram");
    expect(channelId).toBe("42");
    expect(text).toContain("health monitor");
    expect(text).toContain("rank all system drivers");
  });

  it("closeTrajectory fires once when a killed execution settles (not at kill time)", async () => {
    const localDeps = createMockDeps();
    localDeps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let resolveExec: ((v: unknown) => void) | undefined;
    vi.mocked(localDeps.executeAgent).mockReturnValue(
      new Promise((r) => { resolveExec = r; }) as never,
    );
    const closeTrajectory = vi.fn().mockResolvedValue(undefined);
    localDeps.closeTrajectory = closeTrajectory;

    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({ task: "t", agentId: "default" });
    await new Promise((r) => setTimeout(r, 50));

    runner.killRun(runId, { killedBy: "health_monitor", reason: "stuck" });
    // The recorder must survive until the in-flight execution settles so its
    // final records (session.summary) still land.
    expect(closeTrajectory).not.toHaveBeenCalled();

    resolveExec!({
      response: "late result",
      tokensUsed: { total: 1 },
      cost: { total: 0 },
      finishReason: "stop",
      stepsExecuted: 1,
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(closeTrajectory).toHaveBeenCalledTimes(1);
    expect(closeTrajectory).toHaveBeenCalledWith(runner.getRunStatus(runId)!.sessionKey);
  });

  it("closeTrajectory fires once after a successful completion", async () => {
    const localDeps = createMockDeps();
    localDeps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const closeTrajectory = vi.fn().mockResolvedValue(undefined);
    localDeps.closeTrajectory = closeTrajectory;

    const runner = createSubAgentRunner(localDeps);
    const runId = runner.spawn({ task: "t", agentId: "default" });
    await new Promise((r) => setTimeout(r, 200));

    expect(closeTrajectory).toHaveBeenCalledTimes(1);
    expect(closeTrajectory).toHaveBeenCalledWith(runner.getRunStatus(runId)!.sessionKey);
  });

  it("closeTrajectory fires once after a natural failure", async () => {
    const localDeps = createMockDeps();
    localDeps.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.mocked(localDeps.executeAgent).mockRejectedValue(new Error("execution crashed"));
    const closeTrajectory = vi.fn().mockResolvedValue(undefined);
    localDeps.closeTrajectory = closeTrajectory;

    const runner = createSubAgentRunner(localDeps);
    runner.spawn({ task: "t", agentId: "default" });
    await new Promise((r) => setTimeout(r, 200));

    expect(closeTrajectory).toHaveBeenCalledTimes(1);
  });
});
