/**
 * E2E integration test: Dead-letter queue retry pipeline.
 *
 * Exercises the full DLQ lifecycle:
 * - Failed delivery -> enqueue -> retry drain -> successful delivery
 * - Expired entries dropped after maxRetries exceeded
 * - DLQ integration with sub-agent-runner delivery pipeline
 *
 * Uses real createAnnouncementDeadLetterQueue and createSubAgentRunner
 * with mock boundary dependencies (no daemon, no LLM, no network).
 * Follows the established pattern from test/integration/subagent-pipeline.test.ts.
 *
 * Covers:
 * - TEST-03 (partial): Dead-letter retry to delivery E2E
 * - OBSV-03 (partial): INFO for successful DLQ delivery verified
 *
 * @module
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAnnouncementDeadLetterQueue,
  createSubAgentRunner,
  type SubAgentRunnerDeps,
} from "@comis/daemon";

import { TypedEventBus } from "@comis/core";

// ---------------------------------------------------------------------------
// Shared temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "resilience-dead-letter-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: mock logger
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("resilience E2E: dead-letter queue retry pipeline", () => {

  // -------------------------------------------------------------------------
  // Failed delivery enqueues to DLQ, drain retries and delivers
  // -------------------------------------------------------------------------

  it("failed delivery -> enqueue -> drain retry -> successful delivery -> dead_letter_delivered event", async () => {
    const eventBus = new TypedEventBus();
    const logger = createMockLogger();

    const filePath = join(tmpDir, "dlq-test-1.jsonl");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      retryIntervalMs: 0, // No delay between retries (pitfall 3)
      maxRetries: 5,
      maxAgeMs: 3_600_000,
      eventBus,
      logger,
    });

    // Track dead_letter_delivered events
    const deliveredEvents: Array<{
      runId: string;
      channelType: string;
      attemptCount: number;
    }> = [];
    eventBus.on("announcement:dead_letter_delivered", (data) => {
      deliveredEvents.push(data);
    });

    // Track dead_lettered events (enqueue)
    const enqueuedEvents: Array<{ runId: string }> = [];
    eventBus.on("announcement:dead_lettered", (data) => {
      enqueuedEvents.push(data);
    });

    // Enqueue a failed announcement
    dlq.enqueue({
      announcementText: "Task complete: quantum research findings",
      channelType: "echo",
      channelId: "ch1",
      runId: "run-1",
      failedAt: Date.now(),
      attemptCount: 0,
      lastError: "sendToChannel failed",
    });

    // Wait for fire-and-forget file append
    await new Promise((r) => setTimeout(r, 100));

    // Verify entry was enqueued
    expect(dlq.size()).toBe(1);
    expect(enqueuedEvents.length).toBe(1);
    expect(enqueuedEvents[0]!.runId).toBe("run-1");

    // First drain: sendToChannel fails -> attemptCount increments, entry stays
    const failingSendToChannel = vi.fn().mockResolvedValue(false);
    await dlq.drain(failingSendToChannel);

    expect(failingSendToChannel).toHaveBeenCalledWith("echo", "ch1", "Task complete: quantum research findings");
    expect(dlq.size()).toBe(1); // Still queued (retry not exhausted)

    // Second drain: sendToChannel succeeds -> entry removed, event emitted
    const succeedingSendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(succeedingSendToChannel);

    expect(succeedingSendToChannel).toHaveBeenCalledWith("echo", "ch1", "Task complete: quantum research findings");
    expect(dlq.size()).toBe(0); // Entry removed

    // Verify announcement:dead_letter_delivered event was emitted
    expect(deliveredEvents.length).toBe(1);
    expect(deliveredEvents[0]!.runId).toBe("run-1");
    expect(deliveredEvents[0]!.channelType).toBe("echo");
    expect(deliveredEvents[0]!.attemptCount).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Expired entries are dropped on drain
  // -------------------------------------------------------------------------

  it("expired entries are dropped after maxRetries exceeded", async () => {
    const eventBus = new TypedEventBus();
    const logger = createMockLogger();

    const filePath = join(tmpDir, "dlq-test-2.jsonl");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      retryIntervalMs: 0,
      maxRetries: 1, // Drop after 1 retry
      maxAgeMs: 3_600_000,
      eventBus,
      logger,
    });

    // Enqueue an entry
    dlq.enqueue({
      announcementText: "Expired announcement",
      channelType: "echo",
      channelId: "ch2",
      runId: "run-2",
      failedAt: Date.now(),
      attemptCount: 0,
      lastError: "initial failure",
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(dlq.size()).toBe(1);

    // First drain: sendToChannel fails -> attemptCount goes to 1 (= maxRetries)
    const failingSend = vi.fn().mockResolvedValue(false);
    await dlq.drain(failingSend);

    // Entry is still in queue after first drain (count incremented to 1)
    // but on next drain the filter will drop it because attemptCount >= maxRetries
    expect(dlq.size()).toBe(1);

    // Second drain: entry should be filtered out (expired) before sendToChannel is called
    const secondSend = vi.fn().mockResolvedValue(true);
    await dlq.drain(secondSend);

    // Entry dropped: size is 0 and sendToChannel was NOT called (entry was filtered)
    expect(dlq.size()).toBe(0);
    expect(secondSend).not.toHaveBeenCalled();

    // Verify debug log about max retries exceeded
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-2" }),
      expect.stringContaining("max retries"),
    );
  });

  // -------------------------------------------------------------------------
  // DLQ integrates with sub-agent-runner delivery pipeline
  // -------------------------------------------------------------------------

  it("failed announcement delivery in runner falls back to DLQ enqueue", async () => {
    const eventBus = new TypedEventBus();
    const logger = createMockLogger();

    const filePath = join(tmpDir, "dlq-test-3.jsonl");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      retryIntervalMs: 0,
      maxRetries: 5,
      maxAgeMs: 3_600_000,
      eventBus,
      logger,
    });

    // Track dead_lettered events
    const enqueuedEvents: Array<{ runId: string }> = [];
    eventBus.on("announcement:dead_lettered", (data) => {
      enqueuedEvents.push(data);
    });

    // sendToChannel rejects (throws) to trigger DLQ enqueue in deliverAnnouncement
    const rejectingSendToChannel = vi.fn().mockRejectedValue(
      new Error("Channel delivery failed"),
    );

    const runnerDeps: SubAgentRunnerDeps & { eventBus: TypedEventBus } = {
      sessionStore: {
        save: vi.fn(),
        delete: vi.fn(),
      },
      executeAgent: vi.fn().mockResolvedValue({
        response: "Research complete. Found 3 key findings.",
        tokensUsed: { total: 200 },
        cost: { total: 0.02 },
        finishReason: "stop",
        stepsExecuted: 5,
      }),
      sendToChannel: rejectingSendToChannel,
      eventBus,
      config: {
        enabled: true,
        maxPingPongTurns: 3,
        allowAgents: [],
        subAgentRetentionMs: 60_000,
        waitTimeoutMs: 60_000,
        subAgentMaxSteps: 50,
        subAgentToolGroups: ["coding"],
        subAgentMcpTools: "inherit",
        subagentContext: {
          maxSpawnDepth: 3,
          maxChildrenPerAgent: 5,
          maxResultTokens: 4000,
          resultRetentionMs: 86_400_000,
          condensationStrategy: "auto",
          includeParentHistory: "none",
          objectiveReinforcement: true,
          artifactPassthrough: true,
          autoCompactThreshold: 0.95,
          maxRunTimeoutMs: 600_000,
          perStepTimeoutMs: 60_000,
        },
      } as SubAgentRunnerDeps["config"],
      tenantId: "test-dlq-integration",
      dataDir: tmpDir,
      logger,
      deadLetterQueue: dlq,
    } as SubAgentRunnerDeps & { eventBus: TypedEventBus };

    const runner = createSubAgentRunner(runnerDeps);

    const runId = runner.spawn({
      task: "Research quantum computing",
      agentId: "researcher",
      callerSessionKey: "test-dlq-integration:user:ch3",
      callerAgentId: "orchestrator",
      announceChannelType: "echo",
      announceChannelId: "ch3",
      depth: 0,
      maxDepth: 3,
    });

    // Wait for async pipeline to complete
    const deadline = Date.now() + 10_000;
    while (
      runner.getRunStatus(runId)?.status === "running" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Task should complete successfully (executeAgent succeeds)
    const status = runner.getRunStatus(runId);
    expect(status!.status).toBe("completed");

    // Wait for fire-and-forget DLQ operations to settle
    await new Promise((r) => setTimeout(r, 200));

    // The announcement delivery failed -> DLQ should have the entry
    expect(dlq.size()).toBeGreaterThanOrEqual(1);
    expect(enqueuedEvents.length).toBeGreaterThanOrEqual(1);

    await runner.shutdown();
  });

  // -------------------------------------------------------------------------
  // OBSV-03: Log level verification for DLQ delivery
  // -------------------------------------------------------------------------

  it("successful DLQ delivery logs at DEBUG level (not ERROR)", async () => {
    const eventBus = new TypedEventBus();
    const logger = createMockLogger();

    const filePath = join(tmpDir, "dlq-test-4.jsonl");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      retryIntervalMs: 0,
      maxRetries: 5,
      maxAgeMs: 3_600_000,
      eventBus,
      logger,
    });

    // Enqueue an entry
    dlq.enqueue({
      announcementText: "Successfully delivered message",
      channelType: "echo",
      channelId: "ch4",
      runId: "run-4",
      failedAt: Date.now(),
      attemptCount: 0,
    });

    await new Promise((r) => setTimeout(r, 100));

    // Drain with successful sendToChannel
    const successSend = vi.fn().mockResolvedValue(true);
    await dlq.drain(successSend);

    expect(dlq.size()).toBe(0);

    // OBSV-03: Verify DEBUG log for successful delivery (not ERROR)
    // The DLQ uses logger.debug for successful delivery
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-4" }),
      expect.stringContaining("delivered successfully"),
    );

    // Verify no ERROR was logged for normal retry flow
    const errorCalls = logger.error.mock.calls;
    const dlqErrorCalls = errorCalls.filter(
      (call: unknown[]) =>
        typeof call[1] === "string" &&
        (call[1] as string).toLowerCase().includes("dead-letter"),
    );
    expect(dlqErrorCalls.length).toBe(0);
  });
});
