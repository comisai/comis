/**
 * Integration tests for the full subagent pipeline.
 *
 * Exercises createSubAgentRunner wired with real ResultCondenser,
 * NarrativeCaster, and LifecycleHooks instances, using mock
 * executeAgent/sendToChannel boundaries. No daemon, no LLM, no network.
 *
 * Covers:
 * - TEST-06: Full pipeline (spawn -> condense -> cast -> announce -> lifecycle hooks)
 * - TEST-07: Concurrent spawn limit enforcement (children + depth + graph bypass)
 * - Lifecycle hook failure graceful degradation
 *
 * @module
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSubAgentRunner,
  type SubAgentRunnerDeps,
} from "@comis/daemon";

import {
  createResultCondenser,
  createNarrativeCaster,
  createLifecycleHooks,
} from "@comis/agent";

import { TypedEventBus } from "@comis/core";

// ---------------------------------------------------------------------------
// Shared temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subagent-pipeline-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helper: build full integration deps with real components
// ---------------------------------------------------------------------------

function buildIntegrationDeps(overrides?: Partial<SubAgentRunnerDeps>): SubAgentRunnerDeps & { eventBus: TypedEventBus } {
  const eventBus = new TypedEventBus();

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const condenser = createResultCondenser({
    maxResultTokens: 4000,
    condensationStrategy: "auto",
    dataDir: tmpDir,
    logger: mockLogger,
  });

  const narrativeCaster = createNarrativeCaster({
    enabled: true,
    tagPrefix: "Subagent Result",
  });

  const lifecycleHooks = createLifecycleHooks({
    dataDir: tmpDir,
    logger: mockLogger,
    eventBus,
  });

  return {
    sessionStore: {
      save: vi.fn(),
      delete: vi.fn(),
    },
    executeAgent: vi.fn().mockResolvedValue({
      response: "Research complete. Found 3 key findings about quantum computing.",
      tokensUsed: { total: 200 },
      cost: { total: 0.02 },
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
      },
    } as SubAgentRunnerDeps["config"],
    tenantId: "test-integration",
    dataDir: tmpDir,
    logger: mockLogger,
    resultCondenser: condenser,
    narrativeCaster,
    lifecycleHooks,
    ...overrides,
  } as SubAgentRunnerDeps & { eventBus: TypedEventBus };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("subagent pipeline integration", () => {

  // -------------------------------------------------------------------------
  // TEST-06: Full pipeline
  // -------------------------------------------------------------------------

  it("full pipeline: spawn -> condense -> cast -> announce -> lifecycle hooks", async () => {
    const deps = buildIntegrationDeps();

    // Subscribe to events BEFORE spawn
    const events: Array<{ name: string; data: unknown }> = [];
    const eventNames = [
      "session:sub_agent_spawned",
      "session:sub_agent_completed",
      "session:sub_agent_result_condensed",
      "session:sub_agent_spawn_prepared",
      "session:sub_agent_lifecycle_ended",
    ] as const;

    for (const name of eventNames) {
      deps.eventBus.on(name, (data: unknown) => events.push({ name, data }));
    }

    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "Research quantum computing applications",
      agentId: "researcher",
      callerSessionKey: "test-integration:user1:ch1",
      callerAgentId: "orchestrator",
      announceChannelType: "discord",
      announceChannelId: "guild-ch-test",
      depth: 0,
      maxDepth: 3,
    });

    expect(runId).toBeDefined();

    // Wait for async pipeline to complete (real timers, real IO)
    const deadline = Date.now() + 10_000;
    while (runner.getRunStatus(runId)?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Verify run completed
    const status = runner.getRunStatus(runId);
    expect(status).toBeDefined();
    expect(status!.status).toBe("completed");

    // Verify executeAgent was called once
    expect(deps.executeAgent).toHaveBeenCalledOnce();

    // Verify sendToChannel was called once (announcement delivery)
    expect(deps.sendToChannel).toHaveBeenCalledOnce();

    // Verify announcement text contains NarrativeCaster tag and metadata.
    // Note: deliverAnnouncement strips the trailing instruction when sending
    // directly to channel (no announceToParent or batcher), so the instruction
    // text is NOT present in the sendToChannel call. The NarrativeCaster DID
    // produce it, but the delivery layer strips it for direct channel sends.
    const sendCall = vi.mocked(deps.sendToChannel).mock.calls[0]!;
    const announcementText = sendCall[2] as string;
    expect(announcementText).toContain("[Subagent Result:");
    expect(announcementText).toContain("Condensation:");
    expect(announcementText).toContain("Full result:");
    expect(announcementText).toContain("Session:");

    // Verify disk file exists in tmpDir/subagent-results/
    const resultsDir = join(tmpDir, "subagent-results");
    expect(existsSync(resultsDir)).toBe(true);
    const sessionDirs = readdirSync(resultsDir);
    expect(sessionDirs.length).toBeGreaterThanOrEqual(1);
    // At least one session dir should contain a .json file
    let foundJsonFile = false;
    for (const dir of sessionDirs) {
      const dirPath = join(resultsDir, dir);
      try {
        const files = readdirSync(dirPath);
        if (files.some((f) => f.endsWith(".json"))) {
          foundJsonFile = true;
          break;
        }
      } catch {
        // ignore non-directory entries
      }
    }
    expect(foundJsonFile).toBe(true);

    // Verify event emissions
    const spawnedEvents = events.filter((e) => e.name === "session:sub_agent_spawned");
    expect(spawnedEvents.length).toBe(1);
    expect(spawnedEvents[0]!.data).toEqual(
      expect.objectContaining({ runId, agentId: "researcher" }),
    );

    const completedEvents = events.filter((e) => e.name === "session:sub_agent_completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0]!.data).toEqual(
      expect.objectContaining({ runId, success: true }),
    );

    const condensedEvents = events.filter((e) => e.name === "session:sub_agent_result_condensed");
    expect(condensedEvents.length).toBe(1);
    expect(condensedEvents[0]!.data).toEqual(
      expect.objectContaining({ runId, level: 1 }),
    );

    const preparedEvents = events.filter((e) => e.name === "session:sub_agent_spawn_prepared");
    expect(preparedEvents.length).toBe(1);

    const endedEvents = events.filter((e) => e.name === "session:sub_agent_lifecycle_ended");
    expect(endedEvents.length).toBe(1);
    expect(endedEvents[0]!.data).toEqual(
      expect.objectContaining({ runId, endReason: "completed" }),
    );
  });

  // -------------------------------------------------------------------------
  // TEST-07: Concurrent spawn children limit enforcement
  // -------------------------------------------------------------------------

  it("concurrent spawns: children limit enforcement", () => {
    vi.useFakeTimers();
    const deps = buildIntegrationDeps({
      // Never-resolving executeAgent so all spawns stay "running"
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
          maxChildrenPerAgent: 3,
          maxResultTokens: 4000,
          resultRetentionMs: 86_400_000,
          condensationStrategy: "auto",
          includeParentHistory: "none",
          objectiveReinforcement: true,
          artifactPassthrough: true,
          autoCompactThreshold: 0.95,
        },
      } as SubAgentRunnerDeps["config"],
    });

    // Subscribe to rejection events
    const rejectionEvents: unknown[] = [];
    deps.eventBus.on("session:sub_agent_spawn_rejected" as any, (data: unknown) => {
      rejectionEvents.push(data);
    });

    const runner = createSubAgentRunner(deps);

    const results: Array<{ runId?: string; error?: Error }> = [];

    for (let i = 0; i < 5; i++) {
      try {
        const runId = runner.spawn({
          task: `Task ${i + 1}`,
          agentId: `worker-${i}`,
          callerSessionKey: "test-integration:parent:session",
          callerAgentId: "orchestrator",
          depth: 0,
          maxDepth: 5,
        });
        results.push({ runId });
      } catch (err) {
        results.push({ error: err as Error });
      }
    }

    // Exactly 3 should succeed, 2 should be rejected
    const succeeded = results.filter((r) => r.runId);
    const rejected = results.filter((r) => r.error);

    expect(succeeded.length).toBe(3);
    expect(rejected.length).toBe(2);

    // Rejected errors should contain structured reason
    for (const r of rejected) {
      expect(r.error!.message).toContain("children limit exceeded");
    }

    // Rejection events should be emitted with reason
    expect(rejectionEvents.length).toBe(2);
    for (const evt of rejectionEvents) {
      expect(evt).toEqual(expect.objectContaining({ reason: "children_exceeded" }));
    }
  });

  // -------------------------------------------------------------------------
  // Depth limit enforcement
  // -------------------------------------------------------------------------

  it("depth limit enforcement", () => {
    const deps = buildIntegrationDeps({
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
          maxSpawnDepth: 2,
          maxChildrenPerAgent: 5,
          maxResultTokens: 4000,
          resultRetentionMs: 86_400_000,
          condensationStrategy: "auto",
          includeParentHistory: "none",
          objectiveReinforcement: true,
          artifactPassthrough: true,
          autoCompactThreshold: 0.95,
        },
      } as SubAgentRunnerDeps["config"],
    });

    // Subscribe to rejection events
    const rejectionEvents: unknown[] = [];
    deps.eventBus.on("session:sub_agent_spawn_rejected" as any, (data: unknown) => {
      rejectionEvents.push(data);
    });

    const runner = createSubAgentRunner(deps);

    // depth=2, maxDepth=2 should throw
    expect(() => runner.spawn({
      task: "deep task",
      agentId: "deep-agent",
      callerSessionKey: "test-integration:deep:ch",
      depth: 2,
      maxDepth: 2,
    })).toThrow("depth limit exceeded");

    // depth=1, maxDepth=2 should succeed
    const runId = runner.spawn({
      task: "shallow task",
      agentId: "shallow-agent",
      callerSessionKey: "test-integration:shallow:ch",
      depth: 1,
      maxDepth: 2,
    });
    expect(runId).toBeDefined();

    // Verify rejection event was emitted with depth_exceeded reason
    expect(rejectionEvents.length).toBe(1);
    expect(rejectionEvents[0]).toEqual(
      expect.objectContaining({ reason: "depth_exceeded" }),
    );
  });

  // -------------------------------------------------------------------------
  // Graph spawns bypass children limit (LIMIT-05)
  // -------------------------------------------------------------------------

  it("graph spawns bypass children limit", () => {
    vi.useFakeTimers();
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
          maxSpawnDepth: 5,
          maxChildrenPerAgent: 2,
          maxResultTokens: 4000,
          resultRetentionMs: 86_400_000,
          condensationStrategy: "auto",
          includeParentHistory: "none",
          objectiveReinforcement: true,
          artifactPassthrough: true,
          autoCompactThreshold: 0.95,
        },
      } as SubAgentRunnerDeps["config"],
    });

    const runner = createSubAgentRunner(deps);

    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      const runId = runner.spawn({
        task: `Graph task ${i + 1}`,
        agentId: `graph-worker-${i}`,
        callerSessionKey: "test-integration:graph-parent:ch",
        callerAgentId: "graph-coordinator",
        callerType: "graph",
        depth: 0,
        maxDepth: 5,
      });
      results.push(runId);
    }

    // All 4 should succeed (graph bypasses children limit of 2)
    expect(results.length).toBe(4);
    for (const runId of results) {
      expect(runId).toBeDefined();
      expect(typeof runId).toBe("string");
    }
  });

  // -------------------------------------------------------------------------
  // Lifecycle hook failure degrades gracefully
  // -------------------------------------------------------------------------

  it("lifecycle hook failure degrades gracefully", async () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const deps = buildIntegrationDeps({
      logger: mockLogger,
      lifecycleHooks: {
        prepareSpawn: vi.fn().mockRejectedValue(new Error("hook failure")),
        onEnded: vi.fn().mockResolvedValue(undefined),
      },
    });

    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "Task with broken hooks",
      agentId: "resilient-agent",
      callerSessionKey: "test-integration:hooks:ch",
      callerAgentId: "orchestrator",
      announceChannelType: "discord",
      announceChannelId: "guild-ch-test",
      depth: 0,
      maxDepth: 3,
    });

    // Wait for async pipeline to complete (real timers, real IO from condenser)
    const deadline = Date.now() + 10_000;
    while (runner.getRunStatus(runId)?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Run should still complete successfully despite hook failure
    const status = runner.getRunStatus(runId);
    expect(status).toBeDefined();
    expect(status!.status).toBe("completed");

    // Logger.warn should have been called about the hook failure
    const warnCalls = mockLogger.warn.mock.calls;
    const hookWarn = warnCalls.find(
      (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).toLowerCase().includes("hook"),
    );
    expect(hookWarn).toBeDefined();
  });
});
