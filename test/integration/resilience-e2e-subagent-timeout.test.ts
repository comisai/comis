// SPDX-License-Identifier: Apache-2.0
/**
 * E2E integration test: Subagent watchdog timeout and ghost sweep pipelines.
 *
 * Exercises:
 * - Watchdog timer fires -> run marked failed -> failure notification delivered
 * - Ghost sweep detects stale runs -> force-failed -> notification delivered
 *
 * Uses vi.useFakeTimers({ shouldAdvanceTime: true }) for timer-dependent
 * scenarios. Follows the established pattern from
 * test/integration/subagent-pipeline.test.ts.
 *
 * Covers:
 * - TEST-03 (partial): Subagent timeout to user notification E2E
 * - OBSV-03 (partial): ERROR with errorKind:'timeout' for watchdog and ghost sweep
 *
 * @module
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSubAgentRunner,
  type SubAgentRunnerDeps,
} from "@comis/daemon";

import { TypedEventBus } from "@comis/core";

// ---------------------------------------------------------------------------
// Shared temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "resilience-subagent-timeout-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: build integration deps with mock boundaries
// ---------------------------------------------------------------------------

function buildIntegrationDeps(
  overrides?: Partial<SubAgentRunnerDeps>,
): SubAgentRunnerDeps & { eventBus: TypedEventBus } {
  const eventBus = new TypedEventBus();

  const mockLogger = {
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
    executeAgent: vi.fn().mockResolvedValue({
      response: "Done",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
      finishReason: "stop",
      stepsExecuted: 5,
    }),
    sendToChannel: vi.fn().mockResolvedValue(true),
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
        maxRunTimeoutMs: 5_000,
        perStepTimeoutMs: 2_000,
      },
    } as SubAgentRunnerDeps["config"],
    tenantId: "test-subagent-timeout",
    dataDir: tmpDir,
    logger: mockLogger,
    ...overrides,
  } as SubAgentRunnerDeps & { eventBus: TypedEventBus };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("resilience E2E: subagent watchdog timeout and ghost sweep", () => {
  let runner: ReturnType<typeof createSubAgentRunner>;

  afterEach(async () => {
    if (runner) {
      await runner.shutdown();
    }
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Watchdog timeout fires and delivers notification
  // -------------------------------------------------------------------------

  it("watchdog timeout fires and delivers failure notification", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const deps = buildIntegrationDeps({
      // Never-resolving executeAgent to trigger watchdog
      executeAgent: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    // Subscribe to events BEFORE spawn
    const completedEvents: Array<{
      runId: string;
      agentId: string;
      success: boolean;
    }> = [];
    deps.eventBus.on("session:sub_agent_completed", (data) => {
      completedEvents.push(data);
    });

    runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "Task that will be killed by watchdog",
      agentId: "watchdog-agent",
      callerSessionKey: "test-subagent-timeout:user:ch1",
      callerAgentId: "orchestrator",
      announceChannelType: "echo",
      announceChannelId: "ch1",
      depth: 0,
      maxDepth: 3,
    });

    expect(runId).toBeDefined();

    // Advance past the watchdog timeout (5000ms config + margin)
    await vi.advanceTimersByTimeAsync(6_000);

    // Verify run is failed
    const status = runner.getRunStatus(runId);
    expect(status).toBeDefined();
    expect(status!.status).toBe("failed");
    expect(status!.error).toContain("timeout");

    // Verify sendToChannel was called with canned failure text
    expect(deps.sendToChannel).toHaveBeenCalled();
    const sendCall = vi.mocked(deps.sendToChannel).mock.calls[0]!;
    expect(sendCall[0]).toBe("echo");
    expect(sendCall[1]).toBe("ch1");
    expect(sendCall[2]).toEqual(expect.stringContaining("Task failed"));

    // Verify session:sub_agent_completed event with success: false
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0]!.runId).toBe(runId);
    expect(completedEvents[0]!.success).toBe(false);

    // OBSV-03: Verify ERROR log with errorKind:'timeout' for watchdog
    expect(deps.logger!.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "timeout",
        hint: expect.any(String),
      }),
      expect.stringContaining("watchdog"),
    );
  });

  // -------------------------------------------------------------------------
  // Ghost sweep detects stale runs
  // -------------------------------------------------------------------------

  it("ghost sweep detects and force-fails stale runs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Use very large maxRunTimeoutMs so watchdog never fires within test window.
    // Then backdate startedAt so the ghost sweep sees the run as ancient.
    // This is the established technique from sub-agent-runner.test.ts (472-02).
    const LARGE_TIMEOUT_MS = 10_000_000;

    const deps = buildIntegrationDeps({
      executeAgent: vi.fn().mockReturnValue(new Promise(() => {})),
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
          maxRunTimeoutMs: LARGE_TIMEOUT_MS,
          perStepTimeoutMs: 5_000_000,
        },
      } as SubAgentRunnerDeps["config"],
    });

    const completedEvents: Array<{
      runId: string;
      success: boolean;
    }> = [];
    deps.eventBus.on("session:sub_agent_completed", (data) => {
      completedEvents.push(data);
    });

    runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "Task that becomes a ghost run",
      agentId: "ghost-agent",
      callerSessionKey: "test-subagent-timeout:user:ch2",
      callerAgentId: "orchestrator",
      announceChannelType: "echo",
      announceChannelId: "ch2",
      depth: 0,
      maxDepth: 3,
    });

    expect(runId).toBeDefined();

    // First sweep fires at 300_000ms; run is within grace -- verify still running
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runner.getRunStatus(runId)!.status).toBe("running");

    // Backdate startedAt so the run appears past ghost grace period.
    // Ghost grace = maxRunTimeoutMs + 120_000 = 10_120_000ms
    // getRunStatus returns a reference to the internal run object.
    const run = runner.getRunStatus(runId)!;
    run.startedAt = Date.now() - (LARGE_TIMEOUT_MS + 200_000);

    // Next sweep fires at 600_000ms total; ghost sweep sees backdated run
    await vi.advanceTimersByTimeAsync(300_000);

    // Verify run is failed via ghost sweep
    const status = runner.getRunStatus(runId);
    expect(status).toBeDefined();
    expect(status!.status).toBe("failed");
    expect(status!.error).toContain("Ghost run");

    // Verify sendToChannel was called (ghost sweep delivers failure notification)
    expect(deps.sendToChannel).toHaveBeenCalled();

    // Verify session:sub_agent_completed event
    const ghostCompletedEvents = completedEvents.filter(
      (e) => e.runId === runId,
    );
    expect(ghostCompletedEvents.length).toBeGreaterThanOrEqual(1);
    expect(ghostCompletedEvents[0]!.success).toBe(false);

    // OBSV-03: Verify ERROR log with errorKind:'timeout' for ghost sweep
    expect(deps.logger!.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "timeout",
        hint: expect.any(String),
      }),
      expect.stringContaining("Ghost"),
    );
  });
});
