/**
 * E2E integration test: Prompt timeout to error delivery pipeline.
 *
 * Exercises: PromptTimeoutError rejection -> sub-agent-runner catch block ->
 * failure notification delivered to channel -> session:sub_agent_completed
 * event with success: false.
 *
 * Uses real createSubAgentRunner with mock boundary dependencies (no daemon,
 * no LLM, no network). Follows the established pattern from
 * test/integration/subagent-pipeline.test.ts.
 *
 * Covers:
 * - TEST-03 (partial): Prompt timeout to error delivery E2E
 * - OBSV-03 (partial): ERROR with errorKind:'internal' verified via mock logger
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

import { PromptTimeoutError } from "@comis/agent";
import { TypedEventBus } from "@comis/core";

// ---------------------------------------------------------------------------
// Shared temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "resilience-prompt-timeout-"));
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
        // Large watchdog timeout so it never fires during prompt timeout tests
        maxRunTimeoutMs: 600_000,
        perStepTimeoutMs: 60_000,
      },
    } as SubAgentRunnerDeps["config"],
    tenantId: "test-prompt-timeout",
    dataDir: tmpDir,
    logger: mockLogger,
    ...overrides,
  } as SubAgentRunnerDeps & { eventBus: TypedEventBus };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("resilience E2E: prompt timeout pipeline", () => {
  let runner: ReturnType<typeof createSubAgentRunner>;

  afterEach(async () => {
    if (runner) {
      await runner.shutdown();
    }
  });

  // -------------------------------------------------------------------------
  // Prompt timeout triggers failure notification
  // -------------------------------------------------------------------------

  it("PromptTimeoutError rejection triggers failure notification and completion event", async () => {
    const deps = buildIntegrationDeps({
      executeAgent: vi.fn().mockRejectedValue(
        new PromptTimeoutError(5000),
      ),
    });

    // Subscribe to events BEFORE spawn
    const completedEvents: Array<{
      runId: string;
      agentId: string;
      success: boolean;
      runtimeMs: number;
    }> = [];
    deps.eventBus.on("session:sub_agent_completed", (data) => {
      completedEvents.push(data);
    });

    runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "Research topic that will timeout",
      agentId: "timeout-agent",
      callerSessionKey: "test-prompt-timeout:user:ch1",
      callerAgentId: "orchestrator",
      announceChannelType: "echo",
      announceChannelId: "ch1",
      depth: 0,
      maxDepth: 3,
    });

    expect(runId).toBeDefined();

    // Wait for async pipeline to complete (prompt timeout rejection is synchronous)
    const deadline = Date.now() + 10_000;
    while (
      runner.getRunStatus(runId)?.status === "running" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Verify run is failed
    const status = runner.getRunStatus(runId);
    expect(status).toBeDefined();
    expect(status!.status).toBe("failed");
    expect(status!.error).toBeDefined();

    // Verify sendToChannel was called with canned failure text
    expect(deps.sendToChannel).toHaveBeenCalled();
    const sendCall = vi.mocked(deps.sendToChannel).mock.calls[0]!;
    expect(sendCall[0]).toBe("echo"); // channelType
    expect(sendCall[1]).toBe("ch1"); // channelId
    expect(sendCall[2]).toEqual(expect.stringContaining("Task failed"));

    // Verify session:sub_agent_completed event with success: false
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0]!.runId).toBe(runId);
    expect(completedEvents[0]!.success).toBe(false);

    // OBSV-03: Verify ERROR log with errorKind:'internal' (runner catch-all)
    expect(deps.logger!.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "internal",
        hint: expect.any(String),
      }),
      expect.any(String),
    );
  });

  // -------------------------------------------------------------------------
  // PromptTimeoutError is handled the same as any other executeAgent rejection
  // -------------------------------------------------------------------------

  it("runner catch block treats PromptTimeoutError as generic failure (no special handling)", async () => {
    const timeoutMs = 3000;
    const deps = buildIntegrationDeps({
      executeAgent: vi.fn().mockRejectedValue(
        new PromptTimeoutError(timeoutMs),
      ),
    });

    runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "Another timeout scenario",
      agentId: "timeout-agent-2",
      callerSessionKey: "test-prompt-timeout:user2:ch2",
      callerAgentId: "orchestrator",
      announceChannelType: "echo",
      announceChannelId: "ch2",
      depth: 0,
      maxDepth: 3,
    });

    // Wait for completion
    const deadline = Date.now() + 10_000;
    while (
      runner.getRunStatus(runId)?.status === "running" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const status = runner.getRunStatus(runId);
    expect(status!.status).toBe("failed");

    // The error message comes from PromptTimeoutError which extends TimeoutError:
    // "Prompt execution timed out after {timeoutMs}ms"
    expect(status!.error).toContain("timed out");

    // Verify the runner's catch block logged at ERROR (not WARN -- it's a catch-all)
    const errorCalls = vi.mocked(deps.logger!.error).mock.calls;
    const failedLog = errorCalls.find(
      (call) => typeof call[1] === "string" && call[1].includes("failed"),
    );
    expect(failedLog).toBeDefined();
    expect(failedLog![0]).toEqual(
      expect.objectContaining({
        errorKind: "internal",
        hint: expect.stringContaining("Sub-agent execution failed"),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Failure notification text is LLM-free (static text only)
  // -------------------------------------------------------------------------

  it("failure notification uses static text without LLM call", async () => {
    const deps = buildIntegrationDeps({
      executeAgent: vi.fn().mockRejectedValue(
        new PromptTimeoutError(5000),
      ),
    });

    runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "Check that no LLM is involved in failure notification",
      agentId: "static-text-agent",
      callerSessionKey: "test-prompt-timeout:user3:ch3",
      callerAgentId: "orchestrator",
      announceChannelType: "echo",
      announceChannelId: "ch3",
      depth: 0,
      maxDepth: 3,
    });

    // Wait for completion
    const deadline = Date.now() + 10_000;
    while (
      runner.getRunStatus(runId)?.status === "running" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Verify sendToChannel message contains structured failure info
    const sendCalls = vi.mocked(deps.sendToChannel).mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const messageText = sendCalls[0]![2] as string;
    expect(messageText).toContain("Task failed");
    expect(messageText).toContain("could not complete");
    expect(messageText).toContain("Runtime:");

    // Verify no LLM-style content in the message (no rewriting, no persona)
    expect(messageText).not.toContain("[System Message]");
    expect(messageText).not.toContain("Inform the user");
  });
});
