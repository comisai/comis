// SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for sub-agent lifecycle.
 * Exercises createSubAgentRunner with real module instances and controlled
 * mock boundaries (session store, executeAgent, sendToChannel, EventBus).
 * Covers:
 * - Async spawn returns runId immediately (non-blocking)
 * - Run completion updates status with result
 * - Run failure sets status to "failed"
 * - Allowlist blocks unauthorized agent
 * - Empty allowlist allows any agent
 * - Auto-archive removes completed runs after retention period
 * - Announce includes stats line (Runtime, Tokens, Cost, Session)
 * - ANNOUNCE_SKIP suppresses announcement
 * - Sub-agent session created with correct metadata
 * - Events emitted for spawn and completion
 * - Graceful shutdown waits for in-flight runs
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSubAgentRunner,
  type SubAgentRunnerDeps,
} from "./sub-agent-runner.js";

// ---------------------------------------------------------------------------
// Test helper: builds deps with real-ish in-memory session store
// ---------------------------------------------------------------------------

function buildDeps(overrides?: Partial<SubAgentRunnerDeps>): SubAgentRunnerDeps {
  const sessionData = new Map<
    string,
    { messages: unknown[]; metadata: Record<string, unknown> }
  >();

  return {
    sessionStore: {
      save: vi.fn(
        (
          key: { tenantId: string; userId: string; channelId: string },
          messages: unknown[],
          metadata: Record<string, unknown>,
        ) => {
          const formatted = `${key.tenantId}:${key.userId}:${key.channelId}`;
          sessionData.set(formatted, { messages: [...messages], metadata: { ...metadata } });
        },
      ),
      delete: vi.fn(
        (key: { tenantId: string; userId: string; channelId: string }) => {
          const formatted = `${key.tenantId}:${key.userId}:${key.channelId}`;
          sessionData.delete(formatted);
        },
      ),
    },
    executeAgent: vi.fn().mockResolvedValue({
      response: "task completed successfully",
      tokensUsed: { total: 200 },
      cost: { total: 0.02 },
      finishReason: "stop",
    }),
    sendToChannel: vi.fn().mockResolvedValue(true),
    eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
    config: {
      enabled: true,
      maxPingPongTurns: 3,
      allowAgents: [],
      subAgentRetentionMs: 5_000,
      waitTimeoutMs: 60_000,
    },
    tenantId: "test-tenant",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("sub-agent lifecycle integration", () => {
  let deps: SubAgentRunnerDeps;

  beforeEach(() => {
    deps = buildDeps();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Async spawn returns runId immediately
  // -------------------------------------------------------------------------

  it("async spawn returns runId immediately (non-blocking)", () => {
    // Use a never-resolving promise to prove spawn is non-blocking
    let resolveExec!: (v: unknown) => void;
    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise((resolve) => {
        resolveExec = resolve;
      }),
    );

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "research topic",
      agentId: "researcher",
      callerSessionKey: "test-tenant:user1:ch1",
    });

    // runId returned immediately as a string
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);

    // executeAgent was called (fire-and-forget in background)
    expect(deps.executeAgent).toHaveBeenCalledTimes(1);

    // Status is "running"
    const status = runner.getRunStatus(runId);
    expect(status).toBeDefined();
    expect(status!.status).toBe("running");

    // Cleanup: resolve the pending promise to avoid hanging
    resolveExec({
      response: "done",
      tokensUsed: { total: 10 },
      cost: { total: 0.001 },
      finishReason: "stop",
    });
  });

  // -------------------------------------------------------------------------
  // 2. Run completes and status updates
  // -------------------------------------------------------------------------

  it("run completes and status updates to completed with result", async () => {
    vi.useFakeTimers();
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "summarize document",
      agentId: "default",
    });

    // Allow async execution to resolve
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
    expect(run!.completedAt).toBeGreaterThanOrEqual(run!.startedAt);
  });

  // -------------------------------------------------------------------------
  // 3. Run failure sets status to "failed"
  // -------------------------------------------------------------------------

  it("run failure sets status to failed with error message", async () => {
    vi.useFakeTimers();
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

  // -------------------------------------------------------------------------
  // 4. Allowlist blocks unauthorized agent
  // -------------------------------------------------------------------------

  it("allowlist blocks unauthorized agent with descriptive error", () => {
    deps.config.allowAgents = ["researcher", "coder"];

    const runner = createSubAgentRunner(deps);

    expect(() =>
      runner.spawn({
        task: "hack something",
        agentId: "hacker",
        callerAgentId: "orchestrator",
      }),
    ).toThrow(/not allowed/);

    // executeAgent should never have been called
    expect(deps.executeAgent).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Empty allowlist allows any agent
  // -------------------------------------------------------------------------

  it("empty allowlist allows any agent", () => {
    deps.config.allowAgents = [];

    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "anything goes",
      agentId: "any-agent",
    });

    expect(typeof runId).toBe("string");
    expect(deps.executeAgent).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 6. Auto-archive removes completed runs after retention period
  // -------------------------------------------------------------------------

  it("auto-archive removes completed runs after retention period", async () => {
    vi.useFakeTimers();
    deps.config.subAgentRetentionMs = 5_000; // 5s retention for test

    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "short task",
      agentId: "default",
    });

    // Complete the run
    await vi.advanceTimersByTimeAsync(0);

    // Run should exist before archive
    const runBefore = runner.getRunStatus(runId);
    expect(runBefore).toBeDefined();
    expect(runBefore!.status).toBe("completed");

    // Advance past retention (5s) + sweep interval (300s) to trigger archive sweep
    vi.advanceTimersByTime(5_000 + 300_001);

    // Run should be archived (removed from Map)
    const runAfter = runner.getRunStatus(runId);
    expect(runAfter).toBeUndefined();

    // sessionStore.delete should have been called
    expect(deps.sessionStore.delete).toHaveBeenCalledTimes(1);

    // session:sub_agent_archived event should have been emitted
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_archived",
      expect.objectContaining({ runId }),
    );
  });

  // -------------------------------------------------------------------------
  // 7. Announce includes stats line
  // -------------------------------------------------------------------------

  it("announce includes stats line with Runtime, Tokens, Cost, Session", async () => {
    vi.useFakeTimers();
    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "visible task",
      agentId: "default",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-1",
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const text = vi.mocked(deps.sendToChannel).mock.calls[0]![2]!;
    expect(text).toContain("Runtime:");
    expect(text).toContain("Tokens:");
    expect(text).toContain("Cost:");
    expect(text).toContain("Session:");
    expect(text).toContain("[System Message]");
    expect(text).toContain("Task: visible task");
    expect(text).toContain("task completed successfully");
    // Safety net: internal LLM instruction must be stripped from direct channel delivery
    expect(text).not.toContain("respond with NO_REPLY");
    expect(text).not.toContain("Inform the user about this completed background task");
  });

  // -------------------------------------------------------------------------
  // 8. ANNOUNCE_SKIP in response skips announcement
  // -------------------------------------------------------------------------

  it("ANNOUNCE_SKIP in response skips announcement", async () => {
    vi.useFakeTimers();
    vi.mocked(deps.executeAgent).mockResolvedValue({
      response: "result ANNOUNCE_SKIP",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
      finishReason: "stop",
    });

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "silent task",
      agentId: "default",
      announceChannelType: "telegram",
      announceChannelId: "chat-123",
    });

    await vi.advanceTimersByTimeAsync(0);

    // sendToChannel NOT called
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. Sub-agent session created in session store
  // -------------------------------------------------------------------------

  it("sub-agent session created with correct metadata in session store", () => {
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "metadata test",
      agentId: "researcher",
      callerSessionKey: "test-tenant:user1:ch1",
      callerAgentId: "orchestrator",
    });

    // sessionStore.save called with sub-agent session key
    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;

    // Session key contains sub-agent-{runId}
    const sessionKeyArg = saveCall[0] as { tenantId: string; userId: string; channelId: string };
    expect(sessionKeyArg.userId).toContain("sub-agent-");
    expect(sessionKeyArg.channelId).toContain("sub-agent:");
    expect(sessionKeyArg.tenantId).toBe("test-tenant");

    // Metadata contains expected fields
    const metadata = saveCall[2] as Record<string, unknown>;
    expect(metadata.parentSessionKey).toBe("test-tenant:user1:ch1");
    expect(metadata.spawnedByAgent).toBe("orchestrator");
    expect(metadata.taskDescription).toBe("metadata test");
    expect(metadata.runId).toBe(runId);
  });

  // -------------------------------------------------------------------------
  // 10. Events emitted for spawn and completion
  // -------------------------------------------------------------------------

  it("emits session:sub_agent_spawned and session:sub_agent_completed events", async () => {
    vi.useFakeTimers();
    const runner = createSubAgentRunner(deps);
    const runId = runner.spawn({
      task: "event test",
      agentId: "researcher",
      callerSessionKey: "test-tenant:user1:ch1",
    });

    // Spawn event emitted immediately
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:sub_agent_spawned",
      expect.objectContaining({
        runId,
        agentId: "researcher",
        task: "event test",
        parentSessionKey: "test-tenant:user1:ch1",
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

  // -------------------------------------------------------------------------
  // 11. Shutdown waits for in-flight runs
  // -------------------------------------------------------------------------

  it("shutdown waits for in-flight runs to complete", async () => {
    vi.useFakeTimers();

    let resolveExec!: (v: unknown) => void;
    vi.mocked(deps.executeAgent).mockReturnValue(
      new Promise((resolve) => {
        resolveExec = resolve;
      }),
    );

    const runner = createSubAgentRunner(deps);
    runner.spawn({
      task: "slow task",
      agentId: "default",
    });

    // Start shutdown (should not resolve while run is active)
    let shutdownResolved = false;
    const shutdownPromise = runner.shutdown().then(() => {
      shutdownResolved = true;
    });

    // Check that shutdown hasn't resolved yet
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdownResolved).toBe(false);

    // Resolve the active run
    resolveExec({
      response: "finally done",
      tokensUsed: { total: 50 },
      cost: { total: 0.005 },
      finishReason: "stop",
    });

    // Now shutdown should resolve
    await vi.advanceTimersByTimeAsync(0);
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Abort remediation integration
  // -------------------------------------------------------------------------

  describe("abort remediation integration", () => {
    it("spawn with max_steps finishReason delivers abort-enriched announcement", async () => {
      vi.useFakeTimers();
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const localDeps = buildDeps({ logger });
      vi.mocked(localDeps.executeAgent).mockResolvedValue({
        response: "partial work",
        tokensUsed: { total: 1000 },
        cost: { total: 0.10 },
        finishReason: "max_steps",
        stepsExecuted: 50,
      });

      const runner = createSubAgentRunner(localDeps);
      runner.spawn({
        task: "complex research",
        agentId: "researcher",
        announceChannelType: "discord",
        announceChannelId: "guild-ch-1",
        callerAgentId: "orchestrator",
        callerSessionKey: "test-tenant:user1:ch1",
      });

      await vi.advanceTimersByTimeAsync(0);

      // Announcement delivered with abort classification
      expect(localDeps.sendToChannel).toHaveBeenCalledTimes(1);
      const text = vi.mocked(localDeps.sendToChannel).mock.calls[0]![2]!;
      expect(text).toContain("Abort: step_limit");
      expect(text).toMatch(/Hint: .+/);
      expect(text).toContain("Steps: 50");
      expect(text).toContain("Halted (max steps reached)");

      // WARN log for abort
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ abortReason: "step_limit" }),
        expect.any(String),
      );

      // INFO log with stepCount
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ stepCount: 50 }),
        expect.stringContaining("completed"),
      );
    });

    it("spawn with error 'Request was aborted' delivers external_timeout announcement", async () => {
      vi.useFakeTimers();
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const localDeps = buildDeps({ logger });
      vi.mocked(localDeps.executeAgent).mockRejectedValue(
        new Error("Request was aborted"),
      );

      const runner = createSubAgentRunner(localDeps);
      runner.spawn({
        task: "api call task",
        agentId: "default",
        announceChannelType: "telegram",
        announceChannelId: "chat-456",
        callerAgentId: "orchestrator",
        callerSessionKey: "test-tenant:user1:ch1",
      });

      await vi.advanceTimersByTimeAsync(0);

      // failure path uses deliverFailureNotification (static, no LLM)
      expect(localDeps.sendToChannel).toHaveBeenCalledTimes(1);
      const text = vi.mocked(localDeps.sendToChannel).mock.calls[0]![2]!;
      expect(text).toContain("Task failed: api call task");
      expect(text).toContain("task encountered an error");

      // WARN log for abort in error path
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ abortReason: "external_timeout" }),
        expect.any(String),
      );
    });

    it("spawn with normal stop completion has no abort line", async () => {
      vi.useFakeTimers();
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const localDeps = buildDeps({ logger });
      vi.mocked(localDeps.executeAgent).mockResolvedValue({
        response: "task done successfully",
        tokensUsed: { total: 200 },
        cost: { total: 0.02 },
        finishReason: "stop",
        stepsExecuted: 5,
      });

      const runner = createSubAgentRunner(localDeps);
      runner.spawn({
        task: "normal task",
        agentId: "default",
        announceChannelType: "discord",
        announceChannelId: "guild-ch-2",
        callerAgentId: "orchestrator",
        callerSessionKey: "test-tenant:user1:ch1",
      });

      await vi.advanceTimersByTimeAsync(0);

      // Announcement delivered without abort line
      expect(localDeps.sendToChannel).toHaveBeenCalledTimes(1);
      const text = vi.mocked(localDeps.sendToChannel).mock.calls[0]![2]!;
      expect(text).not.toContain("Abort:");

      // No WARN log with abortReason
      const warnCalls = logger.warn.mock.calls;
      for (const [obj] of warnCalls) {
        expect(obj).not.toHaveProperty("abortReason");
      }
    });

    it("spawn with expected_outputs and budget_exceeded includes validation and abort", async () => {
      // Use real timers -- validateOutputs does real fs.stat with retry sleeps
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      const localDeps = buildDeps({ logger });
      vi.mocked(localDeps.executeAgent).mockResolvedValue({
        response: "ran out of budget before finishing",
        tokensUsed: { total: 5000 },
        cost: { total: 0.50 },
        finishReason: "budget_exceeded",
        stepsExecuted: 30,
      });

      const runner = createSubAgentRunner(localDeps);
      runner.spawn({
        task: "generate files",
        agentId: "coder",
        announceChannelType: "slack",
        announceChannelId: "C123",
        callerAgentId: "orchestrator",
        callerSessionKey: "test-tenant:user1:ch1",
        expected_outputs: ["/tmp/nonexistent-test-file-340.ts"],
      });

      // Wait for validation retries (3 attempts x 200ms) + async completion
      await vi.waitFor(() => {
        expect(localDeps.sendToChannel).toHaveBeenCalledTimes(1);
      }, { timeout: 3000 });

      const text = vi.mocked(localDeps.sendToChannel).mock.calls[0]![2]!;
      expect(text).toContain("Outputs:");
      expect(text).toContain("Abort: budget");

      // INFO log with filesCreated field
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ filesCreated: expect.any(Number) }),
        expect.stringContaining("completed"),
      );
    });
  });
});
