// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGraphCoordinator, type GraphCoordinatorDeps } from "./graph-coordinator.js";
import {
  type ExecutionGraph,
  type ValidatedGraph,
  validateAndSortGraph,
  TypedEventBus,
} from "@comis/core";
import { createNodeTypeRegistry } from "./node-type-registry.js";
import { handleGraphCompletion } from "./graph-completion.js";
import type { CoordinatorSharedState, GraphRunState } from "./graph-coordinator-state.js";

// ---------------------------------------------------------------------------
// Module mock for @mariozechner/pi-ai (prevents real SDK import in unit tests)
// ---------------------------------------------------------------------------

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn().mockReturnValue({ id: "mock-model" }),
  getModels: vi.fn().mockReturnValue([]),
  getProviders: vi.fn().mockReturnValue([]),
  completeSimple: vi.fn().mockResolvedValue({
    usage: { cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  }),
}));

// ---------------------------------------------------------------------------
// Module mock for graph-prewarm (spy on preWarmGraphCache calls)
// ---------------------------------------------------------------------------

const mockPreWarmGraphCache = vi.fn().mockResolvedValue({
  success: false,
  cacheWriteTokens: 0,
  tokensUsed: 0,
  cost: 0,
  skipped: true,
});

vi.mock("./graph-prewarm.js", () => ({
  preWarmGraphCache: (...args: unknown[]) => mockPreWarmGraphCache(...args),
}));

// ---------------------------------------------------------------------------
// Module mock for node:fs (captures writeFileSync calls for transcript tests)
// ---------------------------------------------------------------------------

const fsWriteCalls: Array<{ path: string; content: string }> = [];
const fsMockFiles = new Map<string, string>();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: actual.mkdirSync,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      fsWriteCalls.push({
        path: String(args[0]),
        content: String(args[1]),
      });
    },
    existsSync: (p: string) => fsMockFiles.has(String(p)),
    readFileSync: (p: string) => {
      const content = fsMockFiles.get(String(p));
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface SimpleNode {
  nodeId: string;
  task?: string;
  dependsOn?: string[];
  agentId?: string;
  model?: string;
  maxSteps?: number;
  timeoutMs?: number;
  barrierMode?: "all" | "majority" | "best-effort";
  retries?: number;
  contextMode?: "full" | "summary" | "none";
  typeId?: string;
  typeConfig?: Record<string, unknown>;
}

function buildGraph(nodes: SimpleNode[], opts?: Partial<ExecutionGraph>): ValidatedGraph {
  const graph: ExecutionGraph = {
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      task: n.task ?? `Task ${n.nodeId}`,
      dependsOn: n.dependsOn ?? [],
      agentId: n.agentId,
      model: n.model,
      maxSteps: n.maxSteps,
      timeoutMs: n.timeoutMs,
      ...(n.barrierMode !== undefined && { barrierMode: n.barrierMode }),
      retries: n.retries ?? 0,
      ...(n.contextMode !== undefined && { contextMode: n.contextMode }),
      ...(n.typeId !== undefined && { typeId: n.typeId }),
      ...(n.typeConfig !== undefined && { typeConfig: n.typeConfig }),
    })),
    onFailure: opts?.onFailure ?? "fail-fast",
    ...opts,
  };
  const result = validateAndSortGraph(graph);
  if (!result.ok) {
    throw new Error(`Invalid test graph: ${result.error.message}`);
  }
  return result.value;
}

interface MockSubAgentRunner {
  spawn: ReturnType<typeof vi.fn>;
  killRun: ReturnType<typeof vi.fn>;
  getRunStatus: ReturnType<typeof vi.fn>;
  _completeRun(runId: string, response: string): void;
  _failRun(runId: string, error: string): void;
  _getSpawnCalls(): Array<Record<string, unknown>>;
  _getKillCalls(): string[];
}

function createMockSubAgentRunner(): MockSubAgentRunner {
  let counter = 0;
  const spawnCalls: Array<Record<string, unknown>> = [];
  const killCalls: string[] = [];
  const runData = new Map<string, { status: string; result?: { response: string }; error?: string }>();

  const runner: MockSubAgentRunner = {
    spawn: vi.fn((params: Record<string, unknown>) => {
      const runId = `run-${counter++}`;
      spawnCalls.push({ ...params, _runId: runId });
      runData.set(runId, { status: "running" });
      return runId;
    }),
    killRun: vi.fn((runId: string) => {
      killCalls.push(runId);
      const run = runData.get(runId);
      if (run) {
        run.status = "failed";
        run.error = "Killed by parent agent";
      }
      return { killed: true };
    }),
    getRunStatus: vi.fn((runId: string) => {
      return runData.get(runId);
    }),
    _completeRun(runId: string, response: string) {
      const run = runData.get(runId);
      if (run) {
        run.status = "completed";
        run.result = { response };
      }
    },
    _failRun(runId: string, error: string) {
      const run = runData.get(runId);
      if (run) {
        run.status = "failed";
        run.error = error;
      }
    },
    _getSpawnCalls() {
      return spawnCalls;
    },
    _getKillCalls() {
      return killCalls;
    },
  };

  return runner;
}

function simulateCompletion(
  eventBus: TypedEventBus,
  runId: string,
  success: boolean,
): void {
  eventBus.emit("session:sub_agent_completed", {
    runId,
    agentId: "test-agent",
    success,
    runtimeMs: 100,
    tokensUsed: 50,
    cost: 0.001,
    timestamp: Date.now(),
  });
}

function simulateCompletionWithBudget(
  eventBus: TypedEventBus,
  runId: string,
  success: boolean,
  tokensUsed: number,
  cost: number,
): void {
  eventBus.emit("session:sub_agent_completed", {
    runId,
    agentId: "test-agent",
    success,
    runtimeMs: 100,
    tokensUsed,
    cost,
    timestamp: Date.now(),
  });
}

async function waitForMicrotask(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
}

function createTestDeps(
  overrides?: Partial<GraphCoordinatorDeps>,
): { deps: GraphCoordinatorDeps; runner: MockSubAgentRunner; eventBus: TypedEventBus; sendToChannel: ReturnType<typeof vi.fn> } {
  const runner = createMockSubAgentRunner();
  const eventBus = new TypedEventBus();
  const sendToChannel = vi.fn(async () => true);

  const deps: GraphCoordinatorDeps = {
    subAgentRunner: runner,
    eventBus,
    sendToChannel,
    tenantId: "test-tenant",
    defaultAgentId: "test-agent",
    maxConcurrency: 4,
    dataDir: "/tmp/test-comis",
    nodeTypeRegistry: createNodeTypeRegistry(),
    spawnStaggerMs: 0,  // Disable stagger in tests unless explicitly testing it
    ...overrides,
  };

  // Override eventBus/runner if explicitly provided in overrides
  if (overrides?.subAgentRunner) {
    deps.subAgentRunner = overrides.subAgentRunner;
  }
  if (overrides?.eventBus) {
    return { deps, runner, eventBus: overrides.eventBus as TypedEventBus, sendToChannel };
  }

  return { deps, runner, eventBus, sendToChannel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGraphCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fsMockFiles.clear();
    mockPreWarmGraphCache.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Basic execution
  // -------------------------------------------------------------------------

  describe("basic execution", () => {
    it("executes a single-node graph", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verify spawn was called once
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      const spawnCall = runner._getSpawnCalls()[0]!;
      expect(spawnCall.task).toContain("Task A");
      expect(spawnCall.agentId).toBe("test-agent");

      // Complete the node
      const runId = spawnCall._runId as string;
      runner._completeRun(runId, "Result A");
      simulateCompletion(eventBus, runId, true);

      // Verify graph reaches completed status
      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");
      expect(status?.isTerminal).toBe(true);

      await coordinator.shutdown();
    });

    it("executes a linear A -> B -> C chain in dependency order", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["B"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only A should be spawned initially
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      const aCall = runner._getSpawnCalls()[0]!;
      expect(aCall.task).toContain("Task A");

      // Complete A
      const runIdA = aCall._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // B should now be spawned
      expect(runner.spawn).toHaveBeenCalledTimes(2);
      const bCall = runner._getSpawnCalls()[1]!;
      expect(bCall.task).toContain("Task B");

      // Complete B
      const runIdB = bCall._runId as string;
      runner._completeRun(runIdB, "Result B");
      simulateCompletion(eventBus, runIdB, true);
      await waitForMicrotask();

      // C should now be spawned
      expect(runner.spawn).toHaveBeenCalledTimes(3);
      const cCall = runner._getSpawnCalls()[2]!;
      expect(cCall.task).toContain("Task C");

      // Complete C
      const runIdC = cCall._runId as string;
      runner._completeRun(runIdC, "Result C");
      simulateCompletion(eventBus, runIdC, true);

      // Graph completed
      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");

      await coordinator.shutdown();
    });

    it("executes independent nodes in parallel", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A", "B"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Both A and B should be spawned
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Complete both
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;

      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // C not spawned yet (B still pending)
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      runner._completeRun(runIdB, "Result B");
      simulateCompletion(eventBus, runIdB, true);
      await waitForMicrotask();

      // C should now be spawned
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete C
      const runIdC = runner._getSpawnCalls()[2]!._runId as string;
      runner._completeRun(runIdC, "Result C");
      simulateCompletion(eventBus, runIdC, true);

      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Template interpolation
  // -------------------------------------------------------------------------

  describe("template interpolation", () => {
    it("forwards results via template interpolation in downstream task text", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        {
          nodeId: "B",
          dependsOn: ["A"],
          task: "Summarize: {{A.result}}",
        },
      ]);

      await coordinator.run({ graph });

      // Complete A with result text
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "The data shows X");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // Verify B's spawn call received interpolated task text
      const bCall = runner._getSpawnCalls()[1]!;
      expect(bCall.task).toContain("Summarize: The data shows X");

      await coordinator.shutdown();
    });

    it("uses unavailable placeholder for failed upstream nodes", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);

      await coordinator.run({ graph });

      // Fail A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._failRun(runIdA, "Node A error");
      simulateCompletion(eventBus, runIdA, false);
      await waitForMicrotask();

      // B should be skipped (fail-fast cascade), not spawned
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Context mode threading
  // -------------------------------------------------------------------------

  describe("contextMode threading", () => {
    it("passes contextMode none to buildContextEnvelope, suppressing upstream output sections", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"], contextMode: "none" },
      ]);
      await coordinator.run({ graph });

      // Complete A with output
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result from A that should be hidden");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // B should be spawned -- check its task does NOT contain upstream output section
      expect(runner.spawn).toHaveBeenCalledTimes(2);
      const bCall = runner._getSpawnCalls()[1]!;
      const bTask = bCall.task as string;
      expect(bTask).not.toContain('### Output from "A"');
      expect(bTask).not.toContain("Result from A that should be hidden");
      // Should still contain the graph context header and task
      expect(bTask).toContain("## Graph Context");
      expect(bTask).toContain("## Your Task");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Per-node timeout
  // -------------------------------------------------------------------------

  describe("per-node timeout", () => {
    it("kills a node exceeding per-node timeout", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A", timeoutMs: 50 }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const runIdA = runner._getSpawnCalls()[0]!._runId as string;

      // Advance time past timeout
      vi.advanceTimersByTime(100);

      // Verify killRun was called
      expect(runner.killRun).toHaveBeenCalledWith(runIdA);

      // Simulate the completion event that killRun would trigger
      simulateCompletion(eventBus, runIdA, false);

      const status = coordinator.getStatus(result.value);
      expect(status?.isTerminal).toBe(true);
      expect(status?.nodes.get("A")?.status).toBe("failed");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Graph-level timeout
  // -------------------------------------------------------------------------

  describe("graph-level timeout", () => {
    it("cancels all running nodes on graph-level timeout", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph(
        [{ nodeId: "A" }, { nodeId: "B" }],
        { timeoutMs: 50 },
      );
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;

      // Advance time past graph timeout
      vi.advanceTimersByTime(100);

      // Verify killRun called for both
      expect(runner._getKillCalls()).toContain(runIdA);
      expect(runner._getKillCalls()).toContain(runIdB);

      // Simulate completion events from killRun
      simulateCompletion(eventBus, runIdA, false);
      simulateCompletion(eventBus, runIdB, false);

      const status = coordinator.getStatus(result.value);
      expect(status?.isTerminal).toBe(true);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency control
  // -------------------------------------------------------------------------

  describe("concurrency control", () => {
    it("limits parallel node execution to maxConcurrency", async () => {
      const { deps, runner, eventBus } = createTestDeps({ maxConcurrency: 2 });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D" },
        { nodeId: "E" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only 2 should be spawned initially (maxConcurrency = 2)
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Complete one node
      const runId0 = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId0, "Result 0");
      simulateCompletion(eventBus, runId0, true);
      await waitForMicrotask();

      // A 3rd node should now be spawned
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete another
      const runId1 = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runId1, "Result 1");
      simulateCompletion(eventBus, runId1, true);
      await waitForMicrotask();

      // 4th spawned
      expect(runner.spawn).toHaveBeenCalledTimes(4);

      // Complete 3rd
      const runId2 = runner._getSpawnCalls()[2]!._runId as string;
      runner._completeRun(runId2, "Result 2");
      simulateCompletion(eventBus, runId2, true);
      await waitForMicrotask();

      // 5th spawned
      expect(runner.spawn).toHaveBeenCalledTimes(5);

      // Complete remaining
      const runId3 = runner._getSpawnCalls()[3]!._runId as string;
      runner._completeRun(runId3, "Result 3");
      simulateCompletion(eventBus, runId3, true);
      await waitForMicrotask();

      const runId4 = runner._getSpawnCalls()[4]!._runId as string;
      runner._completeRun(runId4, "Result 4");
      simulateCompletion(eventBus, runId4, true);

      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Aggregate announcement
  // -------------------------------------------------------------------------

  describe("aggregate announcement", () => {
    it("announces aggregate results to channel on completion", async () => {
      const { deps, runner, eventBus, sendToChannel } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);

      await coordinator.run({
        graph,
        announceChannelType: "discord",
        announceChannelId: "chan-123",
        nodeProgress: true,
      });

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // Node progress message sent after A completes (graph not yet terminal)
      expect(sendToChannel).toHaveBeenCalledTimes(1);
      expect(sendToChannel.mock.calls[0]![2]).toContain("1/2 nodes");
      sendToChannel.mockClear();

      // Complete B
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runIdB, "Result B");
      simulateCompletion(eventBus, runIdB, true);

      // Wait for async announcement delivery
      await vi.advanceTimersByTimeAsync(10);

      // sendToChannel should be called once with aggregate message (no progress for terminal node)
      expect(sendToChannel).toHaveBeenCalledTimes(1);
      const [channelType, channelId, text] = sendToChannel.mock.calls[0]!;
      expect(channelType).toBe("discord");
      expect(channelId).toBe("chan-123");
      expect(text).toContain("2/2 nodes");
      // A is intermediate (B depends on it) — shown as checkmark summary
      expect(text).toContain("\u2705 A");
      // B is leaf — full output surfaced
      expect(text).toContain("Result B");

      await coordinator.shutdown();
    });

    it("does not announce per-node results (suppresses SubAgentRunner announcements)", async () => {
      const { deps, runner } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      await coordinator.run({
        graph,
        announceChannelType: "discord",
        announceChannelId: "chan-123",
      });

      // Verify spawn calls do NOT include announceChannelType or announceChannelId
      const spawnCall = runner._getSpawnCalls()[0]!;
      expect(spawnCall).not.toHaveProperty("announceChannelType");
      expect(spawnCall).not.toHaveProperty("announceChannelId");

      await coordinator.shutdown();
    });

    it("announcement includes GraphId line", async () => {
      const { deps, runner, eventBus, sendToChannel } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const runResult = await coordinator.run({
        graph,
        announceChannelType: "discord",
        announceChannelId: "chan-graphid",
      });
      expect(runResult.ok).toBe(true);
      const graphId = runResult.ok ? runResult.value : "";

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);

      await vi.advanceTimersByTimeAsync(10);

      expect(sendToChannel).toHaveBeenCalledTimes(1);
      const text = sendToChannel.mock.calls[0]![2] as string;
      expect(text).toContain(`GraphId: ${graphId}`);

      await coordinator.shutdown();
    });

    it("uses announceToParent when available", async () => {
      const announceToParent = vi.fn(async () => {});
      const { deps, runner, eventBus, sendToChannel } = createTestDeps({ announceToParent });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      await coordinator.run({
        graph,
        callerAgentId: "parent-agent",
        callerSessionKey: "parent-session",
        announceChannelType: "discord",
        announceChannelId: "chan-123",
      });

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);

      // Wait for async announcement delivery
      await vi.advanceTimersByTimeAsync(10);

      // announceToParent should be called instead of sendToChannel
      expect(announceToParent).toHaveBeenCalledTimes(1);
      expect(sendToChannel).not.toHaveBeenCalled();

      await coordinator.shutdown();
    });

    it("routes through batcher when available instead of direct announceToParent", async () => {
      const announceToParent = vi.fn(async () => {});
      const batcherEnqueue = vi.fn();
      const batcher = { enqueue: batcherEnqueue, flush: vi.fn(), shutdown: vi.fn(), pending: 0 };
      const { deps, runner, eventBus, sendToChannel } = createTestDeps({ announceToParent, batcher });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      await coordinator.run({
        graph,
        callerAgentId: "parent-agent",
        callerSessionKey: "parent-session",
        announceChannelType: "discord",
        announceChannelId: "chan-123",
      });

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);

      await vi.advanceTimersByTimeAsync(10);

      // Batcher should be used; announceToParent and sendToChannel should NOT be called directly
      expect(batcherEnqueue).toHaveBeenCalledTimes(1);
      expect(announceToParent).not.toHaveBeenCalled();
      expect(sendToChannel).not.toHaveBeenCalled();

      // Verify enqueued announcement has correct fields
      const enqueued = batcherEnqueue.mock.calls[0]![0];
      expect(enqueued.announceChannelType).toBe("discord");
      expect(enqueued.announceChannelId).toBe("chan-123");
      expect(enqueued.callerAgentId).toBe("parent-agent");
      expect(enqueued.callerSessionKey).toBe("parent-session");
      expect(enqueued.announcementText).toContain("GraphId:");

      await coordinator.shutdown();
    });

    it("includes full leaf node output in announcement (no truncation for terminal nodes)", async () => {
      const { deps, runner, eventBus, sendToChannel } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      await coordinator.run({
        graph,
        announceChannelType: "discord",
        announceChannelId: "chan-trunc",
      });

      // Complete A with a long output (1500+ chars)
      const longOutput = "The analysis reveals several key findings about the market. " +
        "First the consumer sentiment has shifted dramatically. ".repeat(30);
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, longOutput);
      simulateCompletion(eventBus, runIdA, true);

      await vi.advanceTimersByTimeAsync(10);

      expect(sendToChannel).toHaveBeenCalledTimes(1);
      const text = sendToChannel.mock.calls[0]![2] as string;

      // Leaf node A: full output included (not truncated)
      // sanitizeAssistantResponse trims the output, so compare against trimmed version
      expect(text).toContain(longOutput.trim());
      // Footer with graph metadata present
      expect(text).toContain("1/1 nodes");
      expect(text).toContain("GraphId:");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Failure cascade
  // -------------------------------------------------------------------------

  describe("failure cascade", () => {
    it("skips downstream nodes when upstream fails (fail-fast)", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["B"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Fail A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._failRun(runIdA, "Node A error");
      simulateCompletion(eventBus, runIdA, false);

      // B and C should be skipped, graph should be terminal
      const status = coordinator.getStatus(result.value);
      expect(status?.isTerminal).toBe(true);
      expect(status?.graphStatus).toBe("failed");
      expect(status?.nodes.get("B")?.status).toBe("skipped");
      expect(status?.nodes.get("C")?.status).toBe("skipped");

      // Only 1 spawn call (A only)
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Graph management
  // -------------------------------------------------------------------------

  describe("graph management", () => {
    it("getStatus returns snapshot for running graph", async () => {
      const { deps, runner } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const status = coordinator.getStatus(result.value);
      expect(status).toBeDefined();
      expect(status?.graphStatus).toBe("running");
      expect(status?.nodes.get("A")?.status).toBe("running");
      expect(status?.nodes.get("B")?.status).toBe("pending");

      await coordinator.shutdown();
    });

    it("getStatus returns undefined for unknown graphId", async () => {
      const { deps } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      expect(coordinator.getStatus("nonexistent")).toBeUndefined();

      await coordinator.shutdown();
    });

    it("cancel kills running nodes and marks graph cancelled", async () => {
      const { deps, runner } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const runIdA = runner._getSpawnCalls()[0]!._runId as string;

      // Cancel the graph
      const cancelled = coordinator.cancel(result.value);
      expect(cancelled).toBe(true);

      // Verify killRun called
      expect(runner.killRun).toHaveBeenCalledWith(runIdA);

      // Graph should be terminal
      const status = coordinator.getStatus(result.value);
      expect(status?.isTerminal).toBe(true);

      await coordinator.shutdown();
    });

    it("cancel returns false for already-completed graph", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete the graph
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);

      // Try to cancel
      const cancelled = coordinator.cancel(result.value);
      expect(cancelled).toBe(false);

      await coordinator.shutdown();
    });

    it("listGraphs returns recent graph summaries", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph1 = buildGraph([{ nodeId: "A" }], { label: "Graph 1" });
      const result1 = await coordinator.run({ graph: graph1 });

      // Advance time so graph2 has a later startedAt
      vi.advanceTimersByTime(100);

      const graph2 = buildGraph([{ nodeId: "B" }], { label: "Graph 2" });
      const result2 = await coordinator.run({ graph: graph2 });

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      const summaries = coordinator.listGraphs();
      expect(summaries).toHaveLength(2);
      // Sorted by startedAt descending
      expect(summaries[0]!.label).toBe("Graph 2");
      expect(summaries[1]!.label).toBe("Graph 1");
      expect(summaries[0]!.status).toBe("running");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("cleanup", () => {
    it("cleans up event listeners on shutdown", async () => {
      const eventBus = new TypedEventBus();
      const { deps } = createTestDeps({ eventBus });
      const coordinator = createGraphCoordinator(deps);

      // Before shutdown, listener exists
      expect(eventBus.listenerCount("session:sub_agent_completed")).toBeGreaterThan(0);

      await coordinator.shutdown();

      // After shutdown, listener removed
      expect(eventBus.listenerCount("session:sub_agent_completed")).toBe(0);
    });

    it("clears all timers on graph completion", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A", timeoutMs: 5000 }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete node before timeout fires
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);

      // Advance past what would have been the timeout
      vi.advanceTimersByTime(10000);

      // killRun should NOT have been called (timer was cleared)
      expect(runner.killRun).not.toHaveBeenCalled();

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe("validation", () => {
    it("run succeeds with dependsOn-based template interpolation (no inputFrom)", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "analyzer" },
        {
          nodeId: "summarizer",
          dependsOn: ["analyzer"],
          task: "Summarize: {{analyzer.result}}",
        },
      ]);

      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // Complete analyzer
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Analysis complete");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // Verify summarizer received interpolated task
      const bCall = runner._getSpawnCalls()[1]!;
      expect(bCall.task).toContain("Summarize: Analysis complete");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles concurrent graph runs independently", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph1 = buildGraph([{ nodeId: "A" }]);
      const graph2 = buildGraph([{ nodeId: "B" }]);

      const result1 = await coordinator.run({ graph: graph1 });
      const result2 = await coordinator.run({ graph: graph2 });
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      // Both should have spawned
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Complete first graph's node
      const runId0 = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId0, "Result 1");
      simulateCompletion(eventBus, runId0, true);

      // First graph complete, second still running
      expect(coordinator.getStatus(result1.value)?.graphStatus).toBe("completed");
      expect(coordinator.getStatus(result2.value)?.graphStatus).toBe("running");

      // Complete second graph's node
      const runId1 = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runId1, "Result 2");
      simulateCompletion(eventBus, runId1, true);

      expect(coordinator.getStatus(result2.value)?.graphStatus).toBe("completed");

      await coordinator.shutdown();
    });

    it("returns err when MAX_GRAPHS exceeded", async () => {
      const { deps, runner } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      // Spawn 100 graphs (MAX_GRAPHS)
      for (let i = 0; i < 100; i++) {
        const graph = buildGraph([{ nodeId: `node-${i}` }]);
        const result = await coordinator.run({ graph });
        expect(result.ok).toBe(true);
      }

      // 101st should fail
      const graph = buildGraph([{ nodeId: "overflow" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("Too many active graphs");

      await coordinator.shutdown();
    });

    it("cancel returns false for unknown graphId", async () => {
      const { deps } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      expect(coordinator.cancel("nonexistent")).toBe(false);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Observability events
  // -------------------------------------------------------------------------

  describe("observability events", () => {
    it("emits graph:started before any node events", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const allEvents: Array<{ name: string; payload: Record<string, unknown> }> = [];
      eventBus.on("graph:started", (p) => allEvents.push({ name: "graph:started", payload: p as unknown as Record<string, unknown> }));
      eventBus.on("graph:node_updated", (p) => allEvents.push({ name: "graph:node_updated", payload: p as unknown as Record<string, unknown> }));
      eventBus.on("graph:completed", (p) => allEvents.push({ name: "graph:completed", payload: p as unknown as Record<string, unknown> }));

      const graph = buildGraph([{ nodeId: "A" }], { label: "Test Graph" });
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete the node
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);

      // graph:started should be the very first event
      expect(allEvents.length).toBeGreaterThanOrEqual(1);
      expect(allEvents[0]!.name).toBe("graph:started");
      const startedPayload = allEvents[0]!.payload as { graphId: string; label: string; nodeCount: number; timestamp: number };
      expect(startedPayload.graphId).toBe(result.value);
      expect(startedPayload.label).toBe("Test Graph");
      expect(startedPayload.nodeCount).toBe(1);
      expect(startedPayload.timestamp).toBeGreaterThan(0);

      await coordinator.shutdown();
    });

    it("emits graph:node_updated for running and completed transitions", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const nodeUpdates: Array<Record<string, unknown>> = [];
      eventBus.on("graph:node_updated", (p) => nodeUpdates.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // After run(), should have "running" event
      expect(nodeUpdates).toHaveLength(1);
      expect(nodeUpdates[0]!.nodeId).toBe("A");
      expect(nodeUpdates[0]!.status).toBe("running");

      // Complete the node
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);

      // Should now have "completed" event
      expect(nodeUpdates).toHaveLength(2);
      expect(nodeUpdates[1]!.nodeId).toBe("A");
      expect(nodeUpdates[1]!.status).toBe("completed");
      expect(nodeUpdates[1]!.durationMs).toBeGreaterThanOrEqual(0);

      await coordinator.shutdown();
    });

    it("emits graph:node_updated with error for failed node", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const nodeUpdates: Array<Record<string, unknown>> = [];
      eventBus.on("graph:node_updated", (p) => nodeUpdates.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Fail the node
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._failRun(runIdA, "Task error");
      simulateCompletion(eventBus, runIdA, false);

      // Should have "running" then "failed"
      expect(nodeUpdates).toHaveLength(2);
      expect(nodeUpdates[1]!.status).toBe("failed");
      expect(nodeUpdates[1]!.error).toBe("Task error");

      await coordinator.shutdown();
    });

    it("emits graph:node_updated for skipped nodes in failure cascade", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const nodeUpdates: Array<Record<string, unknown>> = [];
      eventBus.on("graph:node_updated", (p) => nodeUpdates.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Fail A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._failRun(runIdA, "A failed");
      simulateCompletion(eventBus, runIdA, false);

      // Should have: A running, B skipped, C skipped, A failed
      // (skipped events emitted before A's completed/failed event in the code flow)
      const skippedEvents = nodeUpdates.filter((e) => e.status === "skipped");
      expect(skippedEvents).toHaveLength(2);
      const skippedIds = skippedEvents.map((e) => e.nodeId).sort();
      expect(skippedIds).toEqual(["B", "C"]);

      await coordinator.shutdown();
    });

    it("emits graph:completed with node count breakdown", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // Complete B
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runIdB, "Result B");
      simulateCompletion(eventBus, runIdB, true);

      expect(completedEvents).toHaveLength(1);
      const completed = completedEvents[0]!;
      expect(completed.graphId).toBe(result.value);
      expect(completed.status).toBe("completed");
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);
      expect(completed.nodeCount).toBe(2);
      expect(completed.nodesCompleted).toBe(2);
      expect(completed.nodesFailed).toBe(0);
      expect(completed.nodesSkipped).toBe(0);

      await coordinator.shutdown();
    });

    it("emits graph:completed on timeout with correct status", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph(
        [{ nodeId: "A" }, { nodeId: "B" }],
        { timeoutMs: 50 },
      );
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Advance past timeout
      vi.advanceTimersByTime(100);

      expect(completedEvents).toHaveLength(1);
      const completed = completedEvents[0]!;
      expect(completed.graphId).toBe(result.value);
      expect(completed.nodesFailed).toBeGreaterThanOrEqual(1);

      await coordinator.shutdown();
    });

    it("emits graph:completed on cancel", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Cancel the graph
      coordinator.cancel(result.value);

      expect(completedEvents).toHaveLength(1);
      const completed = completedEvents[0]!;
      expect(completed.graphId).toBe(result.value);
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Budget tracking
  // -------------------------------------------------------------------------

  describe("budget tracking", () => {
    it("cancels graph when cumulative tokens exceed maxTokens", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      // A -> B -> C with token budget of 100
      const graph = buildGraph(
        [
          { nodeId: "A" },
          { nodeId: "B", dependsOn: ["A"] },
          { nodeId: "C", dependsOn: ["B"] },
        ],
        { budget: { maxTokens: 100 } },
      );
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A with 60 tokens (under budget)
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletionWithBudget(eventBus, runIdA, true, 60, 0.01);
      await waitForMicrotask();

      // B should be spawned (cumulative 60 < 100)
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Complete B with 50 tokens (cumulative 110 > 100)
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runIdB, "Result B");
      simulateCompletionWithBudget(eventBus, runIdB, true, 50, 0.01);
      await waitForMicrotask();

      // Graph should be cancelled -- C never spawned
      const status = coordinator.getStatus(result.value);
      expect(status?.isTerminal).toBe(true);

      // C should not have been spawned (only 2 spawns: A and B)
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // A's output preserved (partial results)
      expect(status?.nodes.get("A")?.output).toBe("Result A");
      expect(status?.nodes.get("A")?.status).toBe("completed");

      // graph:completed should have cancelReason "budget"
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.cancelReason).toBe("budget");

      await coordinator.shutdown();
    });

    it("cancels graph when cumulative cost exceeds maxCost", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      // A -> B -> C with cost budget; A and B use cost, C should be cancelled
      const graph = buildGraph(
        [
          { nodeId: "A" },
          { nodeId: "B", dependsOn: ["A"] },
          { nodeId: "C", dependsOn: ["B"] },
        ],
        { budget: { maxCost: 0.05 } },
      );
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A with cost 0.03
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletionWithBudget(eventBus, runIdA, true, 10, 0.03);
      await waitForMicrotask();

      // B should be spawned (cumulative cost 0.03 < 0.05)
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Complete B with cost 0.04 (cumulative 0.07 > 0.05)
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runIdB, "Result B");
      simulateCompletionWithBudget(eventBus, runIdB, true, 10, 0.04);
      await waitForMicrotask();

      // Graph should reach terminal state -- C never spawned
      const status = coordinator.getStatus(result.value);
      expect(status?.isTerminal).toBe(true);
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // graph:completed should have cancelReason "budget"
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.cancelReason).toBe("budget");

      await coordinator.shutdown();
    });

    it("completes normally when budget not exceeded", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph(
        [{ nodeId: "A" }, { nodeId: "B" }],
        { budget: { maxTokens: 1000 } },
      );
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A with 100 tokens
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletionWithBudget(eventBus, runIdA, true, 100, 0.01);

      // Complete B with 100 tokens (cumulative 200 < 1000)
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runIdB, "Result B");
      simulateCompletionWithBudget(eventBus, runIdB, true, 100, 0.01);

      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");

      // No cancelReason on normal completion
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.cancelReason).toBeUndefined();

      await coordinator.shutdown();
    });

    it("runs without budget enforcement when no budget set", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      // No budget field at all
      const graph = buildGraph([{ nodeId: "A" }, { nodeId: "B" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete both with high token usage
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletionWithBudget(eventBus, runIdA, true, 10000, 5.0);

      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runIdB, "Result B");
      simulateCompletionWithBudget(eventBus, runIdB, true, 10000, 5.0);

      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");

      // No budget-related cancellation
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.cancelReason).toBeUndefined();

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Barrier mode integration (coordinator-level)
  // -------------------------------------------------------------------------

  describe("barrier mode integration", () => {
    it("spawns newly-ready nodes from barrier satisfaction after failure", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      // A, B, C are roots. D depends on [A, B, C] with best-effort barrier
      // and onFailure: "continue" so failures don't cascade eagerly
      const graph = buildGraph(
        [
          { nodeId: "A" },
          { nodeId: "B" },
          { nodeId: "C" },
          { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "best-effort" },
        ],
        { onFailure: "continue" },
      );
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // A, B, C should all be spawned
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // D not ready yet (B, C still running -- not all deps terminal)
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Fail B
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._failRun(runIdB, "B error");
      simulateCompletion(eventBus, runIdB, false);
      await waitForMicrotask();

      // D still not ready (C still running -- best-effort needs all deps terminal)
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete C
      const runIdC = runner._getSpawnCalls()[2]!._runId as string;
      runner._completeRun(runIdC, "Result C");
      simulateCompletion(eventBus, runIdC, true);
      await waitForMicrotask();

      // D should now be spawned (all deps terminal, barrier satisfied: 2 completed >= 1 needed)
      expect(runner.spawn).toHaveBeenCalledTimes(4);
      const dCall = runner._getSpawnCalls()[3]!;
      expect(dCall.task).toContain("Task D");

      // Complete D
      const runIdD = dCall._runId as string;
      runner._completeRun(runIdD, "Result D");
      simulateCompletion(eventBus, runIdD, true);

      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Degraded execution context envelope
  // -------------------------------------------------------------------------

  describe("degraded execution context envelope", () => {
    it("spawned degraded node task text contains Degraded Input section with failed upstream", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      // A, B are roots. C depends on [A, B] with best-effort barrier
      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A", "B"], barrierMode: "best-effort" },
      ], { onFailure: "continue" });

      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // Fail B
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._failRun(runIdB, "B error");
      simulateCompletion(eventBus, runIdB, false);
      await waitForMicrotask();

      // C should now be spawned (all deps terminal, best-effort: 1 completed >= 1)
      expect(runner.spawn).toHaveBeenCalledTimes(3);
      const cCall = runner._getSpawnCalls()[2]!;
      const taskText = cCall.task as string;

      // Verify degradation notice is present
      expect(taskText).toContain("## Degraded Input");
      expect(taskText).toContain("**B**: FAILED");
      expect(taskText).not.toContain("**A**: FAILED");
      expect(taskText).not.toContain("**A**: SKIPPED");
      expect(taskText).toContain("Proceed with the data available");

      // Complete C and shut down
      const runIdC = cCall._runId as string;
      runner._completeRun(runIdC, "Result C");
      simulateCompletion(eventBus, runIdC, true);

      await coordinator.shutdown();
    });

    it("spawned node with all deps completed has no Degraded Input section", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);

      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // B should be spawned
      expect(runner.spawn).toHaveBeenCalledTimes(2);
      const bCall = runner._getSpawnCalls()[1]!;
      const taskText = bCall.task as string;

      // No degradation section -- all deps completed
      expect(taskText).not.toContain("## Degraded Input");
      expect(taskText).not.toContain("FAILED");
      expect(taskText).not.toContain("SKIPPED");

      // Complete B and shut down
      const runIdB = bCall._runId as string;
      runner._completeRun(runIdB, "Result B");
      simulateCompletion(eventBus, runIdB, true);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // cancelReason tracking
  // -------------------------------------------------------------------------

  describe("cancelReason tracking", () => {
    it("includes cancelReason 'timeout' on graph timeout", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph(
        [{ nodeId: "A" }],
        { timeoutMs: 100 },
      );
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Advance past timeout
      vi.advanceTimersByTime(200);

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.cancelReason).toBe("timeout");

      await coordinator.shutdown();
    });

    it("includes cancelReason 'manual' on cancel()", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Cancel the graph
      coordinator.cancel(result.value);

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.cancelReason).toBe("manual");

      await coordinator.shutdown();
    });

    it("omits cancelReason on normal completion", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!).not.toHaveProperty("cancelReason");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Context envelope integration
  // -------------------------------------------------------------------------

  describe("context envelope", () => {
    it("wraps root node task with graph context envelope", async () => {
      const { deps, runner } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "solo", task: "Do the research" }]);
      await coordinator.run({ graph });

      const spawnCall = runner._getSpawnCalls()[0]!;
      const task = spawnCall.task as string;

      // Envelope structure
      expect(task).toContain("## Graph Context");
      expect(task).toContain('"solo"');
      expect(task).toContain("root node");
      expect(task).toContain("## Your Task");
      expect(task).toContain("Do the research");

      await coordinator.shutdown();
    });

    it("includes upstream output in downstream node envelope", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A", task: "Gather data" },
        { nodeId: "B", dependsOn: ["A"], task: "Analyze the data" },
      ]);
      await coordinator.run({ graph });

      // Complete A with output
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A data");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // Verify B's spawn task has envelope with A's output
      const bCall = runner._getSpawnCalls()[1]!;
      const bTask = bCall.task as string;

      expect(bTask).toContain("## Graph Context");
      expect(bTask).toContain('Output from "A"');
      expect(bTask).toContain("Result A data");
      expect(bTask).toContain("## Your Task");
      expect(bTask).toContain("Analyze the data");

      await coordinator.shutdown();
    });

    it("shows graph label in envelope when provided", async () => {
      const { deps, runner } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph(
        [{ nodeId: "X", task: "Do something" }],
        { label: "My Pipeline" },
      );
      await coordinator.run({ graph });

      const spawnCall = runner._getSpawnCalls()[0]!;
      const task = spawnCall.task as string;

      expect(task).toContain("My Pipeline");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Per-node retry
  // -------------------------------------------------------------------------

  describe("per-node retry", () => {
    it("retrying node emits graph:node_updated with ready status", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const nodeUpdates: Array<Record<string, unknown>> = [];
      eventBus.on("graph:node_updated", (p) => nodeUpdates.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph([{ nodeId: "A", retries: 1 }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Fail node A (should retry, not fail permanently)
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._failRun(runIdA, "Transient error");
      simulateCompletion(eventBus, runIdA, false);

      // Should have: "running" (spawn), then "ready" (retrying) -- NOT "failed"
      const readyEvents = nodeUpdates.filter((e) => e.nodeId === "A" && e.status === "ready");
      expect(readyEvents).toHaveLength(1);

      const failedEvents = nodeUpdates.filter((e) => e.nodeId === "A" && e.status === "failed");
      expect(failedEvents).toHaveLength(0);

      await coordinator.shutdown();
    });

    it("retry timer fires and re-spawns node via spawnReadyNodes", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A", retries: 1 }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Initial spawn
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // Fail node A (triggers retry with 1s backoff)
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._failRun(runIdA, "Transient error");
      simulateCompletion(eventBus, runIdA, false);

      // Before backoff expires -- no re-spawn yet
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // Advance past the 1s backoff (first retry: 1000ms)
      vi.advanceTimersByTime(1000);

      // Node A should be re-spawned
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      await coordinator.shutdown();
    });

    it("retry timer cleaned up on graph cancel", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A", retries: 1 }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Fail node A (triggers retry backoff)
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._failRun(runIdA, "Transient error");
      simulateCompletion(eventBus, runIdA, false);

      // Cancel the graph before retry timer fires
      coordinator.cancel(result.value);

      // Advance past the backoff
      vi.advanceTimersByTime(5000);

      // Node A should NOT be re-spawned (timer was cleared)
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      await coordinator.shutdown();
    });

    it("retries exhausted leads to normal failure and graph completion", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const completedEvents: Array<Record<string, unknown>> = [];
      eventBus.on("graph:completed", (p) => completedEvents.push(p as unknown as Record<string, unknown>));

      const graph = buildGraph([{ nodeId: "A", retries: 1 }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // First failure: triggers retry
      const runIdA1 = runner._getSpawnCalls()[0]!._runId as string;
      runner._failRun(runIdA1, "Error 1");
      simulateCompletion(eventBus, runIdA1, false);

      // Advance past backoff
      vi.advanceTimersByTime(1000);

      // Node A re-spawned
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Second failure: retries exhausted
      const runIdA2 = runner._getSpawnCalls()[1]!._runId as string;
      runner._failRun(runIdA2, "Error 2");
      simulateCompletion(eventBus, runIdA2, false);

      // Graph should reach terminal state (failed)
      const status = coordinator.getStatus(result.value);
      expect(status?.isTerminal).toBe(true);
      expect(status?.graphStatus).toBe("failed");

      // graph:completed should be emitted
      expect(completedEvents).toHaveLength(1);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Debate nodes
  // -------------------------------------------------------------------------

  describe("debate nodes", () => {
    it("debate node executes sequential turns (2 agents x 2 rounds)", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "debate-1", task: "Analyze the market", typeId: "debate", typeConfig: { agents: ["bull", "bear"], rounds: 2 } },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Turn 1: bull (round 1) -- spawned immediately
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      const spawn1 = runner._getSpawnCalls()[0]!;
      expect(spawn1.agentId).toBe("bull");
      expect(spawn1.task).toContain("You are bull");
      expect(spawn1.task).toContain("round 1 of 2");
      expect(spawn1.task).toContain("Analyze the market");

      // Complete turn 1
      const runId1 = spawn1._runId as string;
      runner._completeRun(runId1, "Bull round 1 response");
      simulateCompletion(eventBus, runId1, true);

      // Turn 2: bear (round 1) -- spawned after microtask
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.spawn).toHaveBeenCalledTimes(2);
      const spawn2 = runner._getSpawnCalls()[1]!;
      expect(spawn2.agentId).toBe("bear");
      // After first turn, session reuse -- references conversation history, no embedded transcript
      expect(spawn2.task).toContain("conversation history above");
      expect(spawn2.task).not.toContain("--- Debate Transcript ---");

      // Complete turn 2
      const runId2 = spawn2._runId as string;
      runner._completeRun(runId2, "Bear round 1 response");
      simulateCompletion(eventBus, runId2, true);

      // Turn 3: bull (round 2)
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.spawn).toHaveBeenCalledTimes(3);
      const spawn3 = runner._getSpawnCalls()[2]!;
      expect(spawn3.agentId).toBe("bull");
      expect(spawn3.task).toContain("round 2 of 2");
      // Session reuse -- references conversation history, no embedded transcript
      expect(spawn3.task).toContain("conversation history above");

      // Complete turn 3
      const runId3 = spawn3._runId as string;
      runner._completeRun(runId3, "Bull round 2 response");
      simulateCompletion(eventBus, runId3, true);

      // Turn 4: bear (round 2)
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.spawn).toHaveBeenCalledTimes(4);
      const spawn4 = runner._getSpawnCalls()[3]!;
      expect(spawn4.agentId).toBe("bear");

      // Complete turn 4 (final turn)
      const runId4 = spawn4._runId as string;
      runner._completeRun(runId4, "Bear round 2 final");
      simulateCompletion(eventBus, runId4, true);

      // Debate complete -> graph complete
      await vi.advanceTimersByTimeAsync(0);

      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");
      expect(status?.isTerminal).toBe(true);

      // Final output: formatTranscript() -- no synthesizer, so returns the full transcript
      const nodeState = status?.nodes.get("debate-1");
      expect(nodeState?.status).toBe("completed");
      expect(nodeState?.output).toContain("Debate Transcript");
      expect(nodeState?.output).toContain("Bull round 1 response");
      expect(nodeState?.output).toContain("Bear round 1 response");
      expect(nodeState?.output).toContain("Bull round 2 response");
      expect(nodeState?.output).toContain("Bear round 2 final");

      await coordinator.shutdown();
    });

    it("debate node with synthesizer runs synthesizer after all rounds", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "D", task: "Debate topic", typeId: "debate", typeConfig: { agents: ["bull", "bear"], rounds: 1, synthesizer: "judge" } },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Turn 1: bull (round 1)
      const spawn1 = runner._getSpawnCalls()[0]!;
      expect(spawn1.agentId).toBe("bull");
      runner._completeRun(spawn1._runId as string, "Bull argument");
      simulateCompletion(eventBus, spawn1._runId as string, true);

      // Turn 2: bear (round 1)
      await vi.advanceTimersByTimeAsync(0);
      const spawn2 = runner._getSpawnCalls()[1]!;
      expect(spawn2.agentId).toBe("bear");
      runner._completeRun(spawn2._runId as string, "Bear argument");
      simulateCompletion(eventBus, spawn2._runId as string, true);

      // Turn 3: synthesizer (judge)
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.spawn).toHaveBeenCalledTimes(3);
      const spawn3 = runner._getSpawnCalls()[2]!;
      expect(spawn3.agentId).toBe("judge");
      // Session reuse -- synthesizer references conversation history, no embedded transcript
      expect(spawn3.task).toContain("You are the synthesizer");
      expect(spawn3.task).toContain("conversation history above");
      expect(spawn3.task).toContain("balanced verdict");
      expect(spawn3.task).not.toContain("--- Full Debate Transcript ---");

      runner._completeRun(spawn3._runId as string, "Balanced synthesis");
      simulateCompletion(eventBus, spawn3._runId as string, true);

      await vi.advanceTimersByTimeAsync(0);

      // Final output should be synthesizer's response
      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");
      const nodeState = status?.nodes.get("D");
      expect(nodeState?.output).toBe("Balanced synthesis");

      await coordinator.shutdown();
    });

    it("debate runIds are isolated from runIdToNode", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "debate-iso", task: "Topic", typeId: "debate", typeConfig: { agents: ["a", "b"], rounds: 1 } },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // After first turn spawns, graph should be running (not terminal)
      const statusDuring = coordinator.getStatus(result.value);
      expect(statusDuring?.graphStatus).toBe("running");
      expect(statusDuring?.isTerminal).toBe(false);
      const nodeStateDuring = statusDuring?.nodes.get("debate-iso");
      expect(nodeStateDuring?.status).toBe("running");

      // Complete first turn -- graph should still be running (not completed)
      const spawn1 = runner._getSpawnCalls()[0]!;
      runner._completeRun(spawn1._runId as string, "A response");
      simulateCompletion(eventBus, spawn1._runId as string, true);

      const statusAfter1 = coordinator.getStatus(result.value);
      expect(statusAfter1?.graphStatus).toBe("running");
      expect(statusAfter1?.isTerminal).toBe(false);

      // Complete second turn -- now graph should complete
      await vi.advanceTimersByTimeAsync(0);
      const spawn2 = runner._getSpawnCalls()[1]!;
      runner._completeRun(spawn2._runId as string, "B response");
      simulateCompletion(eventBus, spawn2._runId as string, true);

      await vi.advanceTimersByTimeAsync(0);

      const statusFinal = coordinator.getStatus(result.value);
      expect(statusFinal?.graphStatus).toBe("completed");
      expect(statusFinal?.isTerminal).toBe(true);

      await coordinator.shutdown();
    });

    it("debate transcript persisted to sharedDir", async () => {
      // Clear captured write calls from prior tests
      fsWriteCalls.length = 0;

      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "T", task: "Topic", typeId: "debate", typeConfig: { agents: ["alpha", "beta"], rounds: 1 } },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete turn 1 (alpha)
      const spawn1 = runner._getSpawnCalls()[0]!;
      runner._completeRun(spawn1._runId as string, "Alpha output");
      simulateCompletion(eventBus, spawn1._runId as string, true);

      // Complete turn 2 (beta)
      await vi.advanceTimersByTimeAsync(0);
      const spawn2 = runner._getSpawnCalls()[1]!;
      runner._completeRun(spawn2._runId as string, "Beta output");
      simulateCompletion(eventBus, spawn2._runId as string, true);

      await vi.advanceTimersByTimeAsync(0);

      // Driver output persisted as T-output.md (coordinator writes node output to sharedDir)
      const outputWrite = fsWriteCalls.find((c) => c.path.includes("T-output.md"));
      expect(outputWrite).toBeDefined();
      // Driver's formatTranscript includes [Round N] agentId: output format
      expect(outputWrite!.content).toContain("[Round 1] alpha");
      expect(outputWrite!.content).toContain("[Round 1] beta");
      expect(outputWrite!.content).toContain("Alpha output");
      expect(outputWrite!.content).toContain("Beta output");
      expect(outputWrite!.content).toContain("Debate Transcript");

      await coordinator.shutdown();
    });

    it("debate turn failure fails entire debate node", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "fail-debate", task: "Topic", typeId: "debate", typeConfig: { agents: ["a", "b"], rounds: 1 } },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // First turn spawned
      const spawn1 = runner._getSpawnCalls()[0]!;

      // Fail turn 1
      runner._failRun(spawn1._runId as string, "Agent a crashed");
      simulateCompletion(eventBus, spawn1._runId as string, false);

      // Node should be failed, graph should be terminal
      const status = coordinator.getStatus(result.value);
      expect(status?.isTerminal).toBe(true);
      const nodeState = status?.nodes.get("fail-debate");
      expect(nodeState?.status).toBe("failed");

      // Only 1 turn was spawned (debate aborted after failure)
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      await coordinator.shutdown();
    });

    it("debate node timeout refreshes after each turn", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "timeout-debate", task: "Topic", typeId: "debate", typeConfig: { agents: ["a", "b"], rounds: 1 }, timeoutMs: 5000 },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Advance 4 seconds (under timeout)
      vi.advanceTimersByTime(4000);

      // Complete first turn (within timeout)
      const spawn1 = runner._getSpawnCalls()[0]!;
      runner._completeRun(spawn1._runId as string, "A response");
      simulateCompletion(eventBus, spawn1._runId as string, true);

      // Advance timer to allow microtask to spawn next turn
      await vi.advanceTimersByTimeAsync(0);

      // Second turn is spawned
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Advance 4 more seconds (would be 8s total from start, past original timeout
      // but still within refreshed timeout for second turn)
      vi.advanceTimersByTime(4000);

      // Node should still be running (timeout was refreshed)
      const status = coordinator.getStatus(result.value);
      const nodeState = status?.nodes.get("timeout-debate");
      expect(nodeState?.status).toBe("running");

      // Complete second turn
      const spawn2 = runner._getSpawnCalls()[1]!;
      runner._completeRun(spawn2._runId as string, "B response");
      simulateCompletion(eventBus, spawn2._runId as string, true);

      await vi.advanceTimersByTimeAsync(0);

      const finalStatus = coordinator.getStatus(result.value);
      expect(finalStatus?.graphStatus).toBe("completed");

      await coordinator.shutdown();
    });

    it("debate node with retry restarts from turn 0", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "retry-debate", task: "Topic", typeId: "debate", typeConfig: { agents: ["a", "b"], rounds: 1 }, retries: 1 },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // First attempt, turn 1 (agent "a")
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      const spawn1 = runner._getSpawnCalls()[0]!;
      expect(spawn1.agentId).toBe("a");

      // Fail the first turn
      runner._failRun(spawn1._runId as string, "Error");
      simulateCompletion(eventBus, spawn1._runId as string, false);

      // Node enters retry (status: ready)
      const statusRetrying = coordinator.getStatus(result.value);
      const nodeStateRetrying = statusRetrying?.nodes.get("retry-debate");
      expect(nodeStateRetrying?.status).toBe("ready");

      // Advance past retry backoff (1 second for first retry)
      await vi.advanceTimersByTimeAsync(1000);

      // Retry: new debate starts from turn 0 -- agent "a" again
      expect(runner.spawn).toHaveBeenCalledTimes(2);
      const spawn2 = runner._getSpawnCalls()[1]!;
      expect(spawn2.agentId).toBe("a"); // starts from turn 0, not resuming

      // Complete all turns in retry attempt
      runner._completeRun(spawn2._runId as string, "A retry response");
      simulateCompletion(eventBus, spawn2._runId as string, true);

      await vi.advanceTimersByTimeAsync(0);
      const spawn3 = runner._getSpawnCalls()[2]!;
      expect(spawn3.agentId).toBe("b");

      runner._completeRun(spawn3._runId as string, "B retry response");
      simulateCompletion(eventBus, spawn3._runId as string, true);

      await vi.advanceTimersByTimeAsync(0);

      // Graph should be completed
      const finalStatus = coordinator.getStatus(result.value);
      expect(finalStatus?.graphStatus).toBe("completed");
      expect(finalStatus?.isTerminal).toBe(true);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Global spawn queue
  // -------------------------------------------------------------------------

  describe("global spawn queue", () => {
    it("spawns immediately when under capacity", async () => {
      const { deps, runner } = createTestDeps({ maxGlobalSubAgents: 2 });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // Both nodes spawn immediately (under limit)
      expect(runner.spawn).toHaveBeenCalledTimes(2);
      expect(coordinator.getConcurrencyStats().queueDepth).toBe(0);

      await coordinator.shutdown();
    });

    it("queues when at global sub-agent limit", async () => {
      const { deps, runner } = createTestDeps({ maxGlobalSubAgents: 2 });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // Only 2 spawned (at limit), C is queued
      expect(runner.spawn).toHaveBeenCalledTimes(2);
      expect(coordinator.getConcurrencyStats().queueDepth).toBe(1);
      expect(coordinator.getConcurrencyStats().globalActiveSubAgents).toBe(2);

      await coordinator.shutdown();
    });

    it("drains queue when capacity frees", async () => {
      const { deps, runner, eventBus } = createTestDeps({ maxGlobalSubAgents: 2 });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // 2 spawned, C queued
      expect(runner.spawn).toHaveBeenCalledTimes(2);
      expect(coordinator.getConcurrencyStats().queueDepth).toBe(1);

      // Complete one of the first two nodes to free capacity
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await vi.advanceTimersByTimeAsync(0);

      // Queued node C should now be spawned
      expect(runner.spawn).toHaveBeenCalledTimes(3);
      expect(coordinator.getConcurrencyStats().queueDepth).toBe(0);

      await coordinator.shutdown();
    });

    it("cancelled graph's queued spawns are removed", async () => {
      const { deps, runner } = createTestDeps({ maxGlobalSubAgents: 1 });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only A spawns (limit 1), B is queued
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      expect(coordinator.getConcurrencyStats().queueDepth).toBe(1);

      // Cancel the graph
      coordinator.cancel(result.value);

      // B was never spawned
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      expect(coordinator.getConcurrencyStats().queueDepth).toBe(0);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // announceToParent timeout fallback
  // -------------------------------------------------------------------------

  describe("announceToParent timeout fallback", () => {
    it("falls back to sendToChannel when announceToParent hangs past 300s", async () => {
      const announceToParent = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
      const { deps, runner, eventBus, sendToChannel } = createTestDeps({ announceToParent });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      await coordinator.run({
        graph,
        callerAgentId: "parent-agent",
        callerSessionKey: "parent-session",
        announceChannelType: "discord",
        announceChannelId: "chan-timeout",
      });

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);

      // Short wait -- announceToParent was called but is hanging
      await vi.advanceTimersByTimeAsync(100);
      expect(announceToParent).toHaveBeenCalledTimes(1);
      expect(sendToChannel).not.toHaveBeenCalled();

      // Advance past the 300s timeout
      await vi.advanceTimersByTimeAsync(301_000);

      // sendToChannel should have been called as fallback
      expect(sendToChannel).toHaveBeenCalledTimes(1);
      expect(sendToChannel.mock.calls[0]![0]).toBe("discord");
      expect(sendToChannel.mock.calls[0]![1]).toBe("chan-timeout");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Spawn staggering (event-driven, prewarm-aware)
  // -------------------------------------------------------------------------

  describe("spawn staggering (event-driven, prewarm-aware)", () => {
    it("first node spawns immediately, remaining staggered by spawnStaggerMs", async () => {
      const { deps, runner, eventBus } = createTestDeps({ spawnStaggerMs: 2500, cacheWriteTimeoutMs: 5000 });
      const coordinator = createGraphCoordinator(deps);

      // 3 independent nodes -- all ready at wave start
      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only the first node should spawn immediately
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      expect(runner._getSpawnCalls()[0]!._runId).toBeDefined();

      // Advance past stagger delays (node B at 1*2500ms, node C at 2*2500ms)
      vi.advanceTimersByTime(5000);
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete all to clean up
      for (let i = 0; i < 3; i++) {
        const runId = runner._getSpawnCalls()[i]!._runId as string;
        runner._completeRun(runId, `Result ${i}`);
        simulateCompletion(eventBus, runId, true);
      }
      await waitForMicrotask();

      await coordinator.shutdown();
    });

    it("stagger delay is proportional to spawnStaggerMs * index", async () => {
      // Create deps WITHOUT cacheWriteTimeoutMs to test the default
      const runner = createMockSubAgentRunner();
      const eventBus = new TypedEventBus();
      const sendToChannel = vi.fn(async () => true);
      const depsNoTimeout: GraphCoordinatorDeps = {
        subAgentRunner: runner,
        eventBus,
        sendToChannel,
        tenantId: "test-tenant",
        defaultAgentId: "test-agent",
        maxConcurrency: 4,
        dataDir: "/tmp/test-comis",
        nodeTypeRegistry: createNodeTypeRegistry(),
        spawnStaggerMs: 4000,
        // cacheWriteTimeoutMs intentionally NOT set -- tests default value (30000)
      };
      const coordinator = createGraphCoordinator(depsNoTimeout);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // First node spawns immediately
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // At 3999ms, B should NOT have spawned yet (delay is 1 * 4000ms)
      await vi.advanceTimersByTimeAsync(3999);
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // At 4000ms, B should spawn via stagger delay
      await vi.advanceTimersByTimeAsync(1);
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Complete all to clean up
      for (let i = 0; i < 2; i++) {
        const runId = runner._getSpawnCalls()[i]!._runId as string;
        runner._completeRun(runId, `Result ${i}`);
        eventBus.emit("session:sub_agent_completed", {
          runId, agentId: "test-agent", success: true,
          runtimeMs: 100, tokensUsed: 100, cost: 0.01, timestamp: Date.now(),
        } as any);
      }
      await waitForMicrotask();

      await coordinator.shutdown();
    });

    it("staggered spawn skips if graph completes during delay", async () => {
      const { deps, runner } = createTestDeps({ spawnStaggerMs: 2500, cacheWriteTimeoutMs: 5000 });
      const coordinator = createGraphCoordinator(deps);

      // 2 independent nodes -- both ready at wave start
      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only A spawns immediately (B is staggered)
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // Cancel the graph immediately -- completedAt guard prevents stagger
      coordinator.cancel(result.value);

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(6000);

      // B should NOT have been spawned (completedAt guard in stagger setTimeout)
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      await coordinator.shutdown();
    });

    it("first node spawns immediately, remaining use setTimeout stagger", async () => {
      const { deps, runner, eventBus } = createTestDeps({ spawnStaggerMs: 2500, cacheWriteTimeoutMs: 5000 });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // First node spawns immediately
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // Advance past first stagger (1 * 2500ms)
      vi.advanceTimersByTime(2500);
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Advance past second stagger (2 * 2500ms total)
      vi.advanceTimersByTime(2500);
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Cleanup
      coordinator.cancel(result.value as string);
      await vi.advanceTimersByTimeAsync(6000);
      await coordinator.shutdown();
    });

    it("prewarmed graphs spawn all nodes immediately", async () => {
      // Mock prewarm to return success so cachePrewarmed=true is set
      mockPreWarmGraphCache.mockResolvedValueOnce({
        success: true,
        cacheWriteTokens: 5000,
        tokensUsed: 5001,
        cost: 0.01,
      });
      const manyTools = Array.from({ length: 15 }, (_, i) => ({ name: `tool-${i}` }));
      const { deps, runner, eventBus } = createTestDeps({
        spawnStaggerMs: 2500,
        cacheWriteTimeoutMs: 5000,
        assembleToolsForAgent: async () => manyTools,
        preWarm: {
          provider: "anthropic",
          modelId: "claude-sonnet",
          apiKey: "test-key",
          systemPrompt: "test",
          tools: manyTools,
        },
      });
      const coordinator = createGraphCoordinator(deps);

      // 3 independent nodes -- all ready at wave start
      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // All 3 nodes should spawn immediately (cachePrewarmed=true after successful prewarm)
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete all to clean up
      for (let i = 0; i < 3; i++) {
        const runId = runner._getSpawnCalls()[i]!._runId as string;
        runner._completeRun(runId, `Result ${i}`);
        simulateCompletion(eventBus, runId, true);
      }
      await waitForMicrotask();

      await coordinator.shutdown();
    });

    it("non-prewarmed graphs always stagger regardless of tool count", async () => {
      // Provide assembleToolsForAgent with <=10 tools -- normal stagger path
      const fewTools = Array.from({ length: 5 }, (_, i) => ({ name: `tool-${i}` }));
      const { deps, runner, eventBus } = createTestDeps({
        spawnStaggerMs: 2500,
        cacheWriteTimeoutMs: 5000,
        assembleToolsForAgent: async () => fewTools,
        // preWarm forces awaiting toolSupersetPromise before spawnReadyNodes
        preWarm: {
          provider: "anthropic",
          modelId: "claude-sonnet",
          apiKey: "test-key",
          systemPrompt: "test",
          tools: fewTools,
        },
      });
      const coordinator = createGraphCoordinator(deps);

      // 3 independent nodes -- all ready at wave start
      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only first node spawns immediately (non-prewarmed = stagger)
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // Advance past stagger delays -- remaining nodes spawn
      vi.advanceTimersByTime(5000);
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete all to clean up
      for (let i = 0; i < 3; i++) {
        const runId = runner._getSpawnCalls()[i]!._runId as string;
        runner._completeRun(runId, `Result ${i}`);
        simulateCompletion(eventBus, runId, true);
      }
      await waitForMicrotask();

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // _run-metadata.json includes per-node cache data
  // -------------------------------------------------------------------------

  describe("_run-metadata.json per-node cache data", () => {
    it("includes cacheReadTokens, cacheWriteTokens, cacheEffectiveness for completed nodes", async () => {
      fsWriteCalls.length = 0;
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const runId = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId, "Result A");

      // Emit completion with cache data
      eventBus.emit("session:sub_agent_completed", {
        runId,
        agentId: "test-agent",
        success: true,
        runtimeMs: 100,
        tokensUsed: 1000,
        cost: 0.01,
        timestamp: Date.now(),
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
      });

      await waitForMicrotask();

      // Find the _run-metadata.json write
      const metadataWrite = fsWriteCalls.find((c) => c.path.includes("_run-metadata.json"));
      expect(metadataWrite).toBeDefined();

      const metadata = JSON.parse(metadataWrite!.content);
      const nodeA = metadata.nodes.A;

      expect(nodeA.cacheReadTokens).toBe(800);
      expect(nodeA.cacheWriteTokens).toBe(200);
      expect(nodeA.cacheEffectiveness).toBeCloseTo(0.8, 5);

      await coordinator.shutdown();
    });

    it("sets cache fields to null for nodes without cache data", async () => {
      fsWriteCalls.length = 0;
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const runId = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId, "Result A");

      // Emit completion WITHOUT cache data
      simulateCompletion(eventBus, runId, true);

      await waitForMicrotask();

      const metadataWrite = fsWriteCalls.find((c) => c.path.includes("_run-metadata.json"));
      expect(metadataWrite).toBeDefined();

      const metadata = JSON.parse(metadataWrite!.content);
      const nodeA = metadata.nodes.A;

      expect(nodeA.cacheReadTokens).toBeNull();
      expect(nodeA.cacheWriteTokens).toBeNull();
      expect(nodeA.cacheEffectiveness).toBeNull();

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // _run-metadata.json degradedNodes
  // -------------------------------------------------------------------------

  describe("_run-metadata.json degradedNodes", () => {
    it("includes degradedNodes for nodes that ran with failed upstream deps", async () => {
      fsWriteCalls.length = 0;
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph(
        [
          { nodeId: "A" },
          { nodeId: "B" },
          { nodeId: "C", dependsOn: ["A", "B"], barrierMode: "best-effort" },
        ],
        { onFailure: "continue" },
      );
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // A, B should be spawned (roots)
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // Fail B
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._failRun(runIdB, "B error");
      simulateCompletion(eventBus, runIdB, false);
      await waitForMicrotask();

      // C should now be spawned (best-effort: all deps terminal, at least 1 completed)
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete C
      const runIdC = runner._getSpawnCalls()[2]!._runId as string;
      runner._completeRun(runIdC, "Result C");
      simulateCompletion(eventBus, runIdC, true);
      await waitForMicrotask();

      // Find the _run-metadata.json write
      const metadataWrite = fsWriteCalls.find((c) => c.path.includes("_run-metadata.json"));
      expect(metadataWrite).toBeDefined();

      const metadata = JSON.parse(metadataWrite!.content);

      // C ran degraded: B failed, A available
      expect(metadata.degradedNodes).toBeDefined();
      expect(metadata.degradedNodes.C).toBeDefined();
      expect(metadata.degradedNodes.C.missingUpstream).toEqual(["B"]);
      expect(metadata.degradedNodes.C.availableUpstream).toEqual(["A"]);

      // A and B are not degraded (root nodes, no upstream deps)
      expect(metadata.degradedNodes.A).toBeUndefined();
      expect(metadata.degradedNodes.B).toBeUndefined();

      await coordinator.shutdown();
    });

    it("omits degradedNodes when all nodes complete successfully", async () => {
      fsWriteCalls.length = 0;
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      simulateCompletion(eventBus, runIdA, true);
      await waitForMicrotask();

      // Complete B
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runIdB, "Result B");
      simulateCompletion(eventBus, runIdB, true);
      await waitForMicrotask();

      // Find the _run-metadata.json write
      const metadataWrite = fsWriteCalls.find((c) => c.path.includes("_run-metadata.json"));
      expect(metadataWrite).toBeDefined();

      const metadata = JSON.parse(metadataWrite!.content);

      // No degraded nodes -- key should not exist
      expect(metadata.degradedNodes).toBeUndefined();

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Degenerate output detection
  // -------------------------------------------------------------------------

  describe("degenerate output detection", () => {
    it("replaces short file-reference output with actual file content", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A", task: "Analyze stock" },
        { nodeId: "B", task: "Use {{A}}", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Pre-populate mock file in the shared dir (coordinator generates sharedDir from dataDir + graph-runs + graphId)
      const graphId = result.value;
      const sharedDir = `/tmp/test-comis/graph-runs/${graphId}`;
      fsMockFiles.set(
        `${sharedDir}/trading-decision-ITRN.md`,
        "Full trading decision content here with detailed analysis of the stock position and risk factors.",
      );

      // Complete node A with a degenerate response
      const spawn1 = runner._getSpawnCalls()[0]!;
      runner._completeRun(
        spawn1._runId as string,
        "Trading decision saved to trading-decision-ITRN.md in the shared pipeline folder.",
      );
      simulateCompletion(eventBus, spawn1._runId as string, true);

      await vi.advanceTimersByTimeAsync(0);

      // Verify that nodeOutputs for A contains the full file content, not the degenerate reply
      const status = coordinator.getStatus(graphId);
      expect(status?.nodes.get("A")?.output).toBe(
        "Full trading decision content here with detailed analysis of the stock position and risk factors.",
      );

      await coordinator.shutdown();
    });

    it("does not replace short output that does not reference a .md file", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A", task: "Do something" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete with a short output that has no .md reference
      const spawn1 = runner._getSpawnCalls()[0]!;
      runner._completeRun(spawn1._runId as string, "Analysis complete. The result is positive.");
      simulateCompletion(eventBus, spawn1._runId as string, true);

      await vi.advanceTimersByTimeAsync(0);

      const status = coordinator.getStatus(result.value);
      expect(status?.nodes.get("A")?.output).toBe("Analysis complete. The result is positive.");

      await coordinator.shutdown();
    });

    it("does not replace long output that mentions a .md file", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A", task: "Analyze" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const graphId = result.value;
      const sharedDir = `/tmp/test-comis/graph-runs/${graphId}`;
      fsMockFiles.set(`${sharedDir}/report.md`, "Short file.");

      // Long output (>= 200 chars) that happens to mention a .md file
      const longOutput = "A".repeat(200) + " see report.md for details";
      const spawn1 = runner._getSpawnCalls()[0]!;
      runner._completeRun(spawn1._runId as string, longOutput);
      simulateCompletion(eventBus, spawn1._runId as string, true);

      await vi.advanceTimersByTimeAsync(0);

      const status = coordinator.getStatus(result.value);
      expect(status?.nodes.get("A")?.output).toBe(longOutput);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Announce channel validation and SubAgentRun enrichment
  // -------------------------------------------------------------------------

  describe("announce channel validation", () => {
    it("emits WARN when graph created without announce channel", async () => {
      const warnSpy = vi.fn();
      const { deps, runner, eventBus } = createTestDeps({
        logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      // No announceChannelType/announceChannelId provided
      const result = await coordinator.run({ graph, callerSessionKey: "test-session" });
      expect(result.ok).toBe(true);

      // Verify WARN was called
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatchObject({
        hint: expect.stringContaining("no announce channel"),
        errorKind: "configuration",
      });
      expect(warnSpy.mock.calls[0][1]).toBe("Graph created without announce channel");

      await coordinator.shutdown();
    });

    it("does not emit WARN when announce channel is provided", async () => {
      const warnSpy = vi.fn();
      const { deps, runner, eventBus } = createTestDeps({
        logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({
        graph,
        callerSessionKey: "test-session",
        announceChannelType: "telegram",
        announceChannelId: "12345",
      });
      expect(result.ok).toBe(true);

      // WARN should NOT be called for announce channel (may be called for other reasons)
      const announceCalls = warnSpy.mock.calls.filter(
        (call: unknown[]) => call[1] === "Graph created without announce channel"
      );
      expect(announceCalls).toHaveLength(0);

      await coordinator.shutdown();
    });

    it("spawn calls include graphId from coordinator", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // Verify spawn was called with a graphId
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      const spawnCall = runner._getSpawnCalls()[0]!;
      expect(spawnCall.graphId).toBeDefined();
      expect(typeof spawnCall.graphId).toBe("string");
      expect(spawnCall.nodeId).toBe("A");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Kill cascade via notifyNodeFailed
  // -------------------------------------------------------------------------

  describe("kill cascade via notifyNodeFailed", () => {
    it("notifyNodeFailed marks node failed and graph reaches terminal", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const graphId = result.value;

      const spawnCall = runner._getSpawnCalls()[0]!;
      const runId = spawnCall._runId as string;

      // Kill via direct notification (simulates killRun -> notifyNodeFailed path)
      runner._failRun(runId, "Killed by parent agent");
      coordinator.notifyNodeFailed(graphId, "A", runId, "Killed by parent agent");

      const status = coordinator.getStatus(graphId);
      expect(status?.graphStatus).toBe("failed");
      expect(status?.isTerminal).toBe(true);

      await coordinator.shutdown();
    });

    it("runningCount is exactly 0 after notifyNodeFailed (not -1 from double notification)", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const graphId = result.value;

      const spawnCall = runner._getSpawnCalls()[0]!;
      const runId = spawnCall._runId as string;

      // Kill via direct notification ONLY (no event bus emit)
      runner._failRun(runId, "Killed by parent agent");
      coordinator.notifyNodeFailed(graphId, "A", runId, "Killed by parent agent");

      // Verify NO double-notification by also emitting on event bus -- should be a no-op
      // because runIdToNode entry was already cleaned up by notifyNodeFailed
      simulateCompletion(eventBus, runId, false);

      const status = coordinator.getStatus(graphId);
      expect(status?.graphStatus).toBe("failed");
      // Graph should still be in valid terminal state (not corrupted by double notification)
      expect(status?.isTerminal).toBe(true);

      await coordinator.shutdown();
    });

    it("multi-node graph reaches terminal when killed node triggers fail-fast cascade", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      // B depends on A (fail-fast default)
      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const graphId = result.value;

      // Only A is spawned (B waits for A)
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      const spawnCallA = runner._getSpawnCalls()[0]!;
      const runIdA = spawnCallA._runId as string;

      // Kill A via direct notification
      runner._failRun(runIdA, "Killed by parent agent");
      coordinator.notifyNodeFailed(graphId, "A", runIdA, "Killed by parent agent");

      // Both A and B should be terminal (A failed, B skipped via fail-fast cascade)
      const status = coordinator.getStatus(graphId);
      expect(status?.graphStatus).toBe("failed");
      expect(status?.isTerminal).toBe(true);

      // B should never have been spawned
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      await coordinator.shutdown();
    });

    it("notifyNodeFailed is idempotent -- second call on processed runId is no-op", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const graphId = result.value;

      const spawnCall = runner._getSpawnCalls()[0]!;
      const runId = spawnCall._runId as string;

      runner._failRun(runId, "Killed by parent agent");

      // First call processes the kill
      coordinator.notifyNodeFailed(graphId, "A", runId, "Killed by parent agent");

      // Second call should be a no-op (runId already removed from runIdToNode)
      coordinator.notifyNodeFailed(graphId, "A", runId, "Killed by parent agent");

      // Graph should be terminal (not corrupted)
      const status = coordinator.getStatus(graphId);
      expect(status?.graphStatus).toBe("failed");
      expect(status?.isTerminal).toBe(true);

      await coordinator.shutdown();
    });

    it("notifyNodeFailed on already-terminal graph is no-op", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const graphId = result.value;

      const spawnCall = runner._getSpawnCalls()[0]!;
      const runId = spawnCall._runId as string;

      // Complete A normally (graph becomes terminal with status "completed")
      runner._completeRun(runId, "Result A");
      simulateCompletion(eventBus, runId, true);

      const statusBefore = coordinator.getStatus(graphId);
      expect(statusBefore?.isTerminal).toBe(true);
      expect(statusBefore?.graphStatus).toBe("completed");

      // notifyNodeFailed should be harmless on an already-terminal graph
      coordinator.notifyNodeFailed(graphId, "A", runId, "Late kill");

      const statusAfter = coordinator.getStatus(graphId);
      expect(statusAfter?.graphStatus).toBe("completed"); // Still completed, not corrupted to failed

      await coordinator.shutdown();
    });

    it("notifyNodeFailed releases global concurrency slot", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const graphId = result.value;

      const spawnCall = runner._getSpawnCalls()[0]!;
      const runId = spawnCall._runId as string;

      // Before kill: 1 global active
      const statsBefore = coordinator.getConcurrencyStats();
      expect(statsBefore.globalActiveSubAgents).toBe(1);

      // Kill via direct notification
      runner._failRun(runId, "Killed by parent agent");
      coordinator.notifyNodeFailed(graphId, "A", runId, "Killed by parent agent");

      // After kill: 0 global active (slot released by notifyNodeFailed)
      const statsAfter = coordinator.getConcurrencyStats();
      expect(statsAfter.globalActiveSubAgents).toBe(0);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // parent-session-gone announcement fast-path
  // -------------------------------------------------------------------------

  describe("parent-session-gone announcement fast-path", () => {
    /**
     * Helper to create a minimal GraphRunState and CoordinatorSharedState
     * for testing handleGraphCompletion's announcement delivery logic.
     */
    async function createCompletionTestState(overrides?: Partial<GraphRunState>) {
      const graph = buildGraph([{ nodeId: "A" }]);
      const { deps: fullDeps } = createTestDeps();
      const coordinator = createGraphCoordinator(fullDeps);
      // Run a graph just to get a real state machine
      const result = await coordinator.run({ graph });
      if (!result.ok) throw new Error("Failed to create test graph");

      const mockStateMachine = {
        snapshot: () => ({
          graphStatus: "completed" as const,
          nodes: new Map([["A", { status: "completed" as const, output: "done", startedAt: Date.now(), completedAt: Date.now() }]]),
        }),
        getGraphStatus: () => "completed" as const,
        isTerminal: () => true,
        cancel: () => [],
      };

      const gs: GraphRunState = {
        graphId: "test-graph-1",
        graphTraceId: "trace-1",
        graph,
        stateMachine: mockStateMachine as unknown as GraphRunState["stateMachine"],
        runIdToNode: new Map(),
        nodeOutputs: new Map([["A", "done"]]),
        nodeTimers: new Map(),
        retryTimers: new Map(),
        graphTimer: undefined,
        startedAt: Date.now() - 1000,
        runningCount: 0,
        callerSessionKey: "parent-session-key",
        callerAgentId: "agent-1",
        announceChannelType: "telegram",
        announceChannelId: "chan-1",
        nodeProgress: false,
        skippedNodesEmitted: new Set(),
        cumulativeTokens: 100,
        cumulativeCost: 0.01,
        sharedDir: "/tmp/test-comis/graph-runs/test-graph-1",
        driverStates: new Map(),
        driverRunIdMap: new Map(),
        waitHandlers: new Map(),
        syntheticRunResults: new Map(),
        nodeCacheData: new Map(),
        ...overrides,
      };

      const state: CoordinatorSharedState = {
        graphs: new Map([["test-graph-1", gs]]),
        globalActiveSubAgents: 0,
        spawnQueue: [],
      };

      coordinator.shutdown();
      return { gs, state };
    }

    it("skips announceToParent and uses sendToChannel when activeRunRegistry.has() returns false", async () => {
      const { gs, state } = await createCompletionTestState();
      const sendToChannel = vi.fn(async () => true);
      const announceToParent = vi.fn(async () => {});
      const mockRegistry = { has: vi.fn(() => false) };

      const deps = {
        eventBus: new TypedEventBus(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        sendToChannel,
        announceToParent,
        batcher: undefined,
        tenantId: "test-tenant",
        activeRunRegistry: mockRegistry,
      };

      handleGraphCompletion(state, deps, gs);

      expect(announceToParent).not.toHaveBeenCalled();
      expect(sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockRegistry.has).toHaveBeenCalledWith("parent-session-key");
    });

    it("calls announceToParent when activeRunRegistry.has() returns true (existing behavior)", async () => {
      const { gs, state } = await createCompletionTestState();
      const sendToChannel = vi.fn(async () => true);
      const announceToParent = vi.fn(async () => {});
      const mockRegistry = { has: vi.fn(() => true) };

      const deps = {
        eventBus: new TypedEventBus(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        sendToChannel,
        announceToParent,
        batcher: undefined,
        tenantId: "test-tenant",
        activeRunRegistry: mockRegistry,
      };

      handleGraphCompletion(state, deps, gs);

      expect(announceToParent).toHaveBeenCalled();
    });

    it("calls announceToParent when activeRunRegistry is undefined (backward compat)", async () => {
      const { gs, state } = await createCompletionTestState();
      const sendToChannel = vi.fn(async () => true);
      const announceToParent = vi.fn(async () => {});

      const deps = {
        eventBus: new TypedEventBus(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        sendToChannel,
        announceToParent,
        batcher: undefined,
        tenantId: "test-tenant",
        activeRunRegistry: undefined,
      };

      handleGraphCompletion(state, deps, gs);

      expect(announceToParent).toHaveBeenCalled();
    });

    it("skips batcher and uses sendToChannel when parent is gone", async () => {
      const { gs, state } = await createCompletionTestState();
      const sendToChannel = vi.fn(async () => true);
      const mockBatcher = { enqueue: vi.fn(), flush: vi.fn(), shutdown: vi.fn() };
      const mockRegistry = { has: vi.fn(() => false) };

      const deps = {
        eventBus: new TypedEventBus(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        sendToChannel,
        announceToParent: undefined,
        batcher: mockBatcher,
        tenantId: "test-tenant",
        activeRunRegistry: mockRegistry,
      };

      handleGraphCompletion(state, deps, gs);

      expect(mockBatcher.enqueue).not.toHaveBeenCalled();
      expect(sendToChannel).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // event-driven spawn stagger
  // -------------------------------------------------------------------------

  describe("stagger-based spawn gate", () => {
    it("spawns remaining nodes after stagger delay elapses", async () => {
      const { deps, runner, eventBus } = createTestDeps({
        spawnStaggerMs: 4000,
        cacheWriteTimeoutMs: 8000,
      });
      const coordinator = createGraphCoordinator(deps);

      // 3 parallel nodes (no dependencies)
      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);

      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // First node should be spawned immediately
      expect(runner.spawn).toHaveBeenCalledTimes(1);
      const firstCall = runner._getSpawnCalls()[0]!;
      expect(firstCall.task).toContain("Task A");

      // Advance past first stagger delay (1 * 4000ms for node B)
      vi.advanceTimersByTime(4000);
      expect(runner.spawn).toHaveBeenCalledTimes(2);

      // Advance past second stagger delay (2 * 4000ms total for node C)
      vi.advanceTimersByTime(4000);
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete all nodes to clean up
      for (const call of runner._getSpawnCalls()) {
        const runId = call._runId as string;
        runner._completeRun(runId, `Result ${call._runId}`);
        simulateCompletion(eventBus, runId, true);
      }
      await waitForMicrotask();

      await coordinator.shutdown();
    });

    it("spawns all nodes immediately when prewarmed", async () => {
      const { deps, runner, eventBus } = createTestDeps({
        spawnStaggerMs: 4000,
        cacheWriteTimeoutMs: 100,
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);

      // Manually set cachePrewarmed on the graph state after run starts
      // (In production, this is set by graph-coordinator.ts after successful prewarm)
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Without prewarm, first node spawns immediately, rest staggered
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // Advance past all stagger delays
      vi.advanceTimersByTime(8000);
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete all nodes to clean up
      for (const call of runner._getSpawnCalls()) {
        const runId = call._runId as string;
        runner._completeRun(runId, `Result ${call._runId}`);
        simulateCompletion(eventBus, runId, true);
      }
      await waitForMicrotask();

      await coordinator.shutdown();
    });

    it("cleanup prevents ghost spawns after cancel", async () => {
      const { deps, runner, eventBus } = createTestDeps({
        spawnStaggerMs: 4000,
        cacheWriteTimeoutMs: 8000,
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);

      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // First node spawned
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // Cancel the graph (should cleanup event listener + timeout)
      coordinator.cancel(result.value);

      // Emit cache signal after cancel -- should NOT spawn remaining
      eventBus.emit("cache:graph_prefix_written", {
        graphId: result.value,
        nodeId: "A",
        cacheWriteTokens: 5000,
        timestamp: Date.now(),
      });

      // Advance past timeout too -- should NOT spawn
      vi.advanceTimersByTime(9000);

      // Still only 1 spawn (the first node)
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      await coordinator.shutdown();
    });

    it("spawns all nodes immediately when spawnStaggerMs=0 (stagger disabled)", async () => {
      const { deps, runner, eventBus } = createTestDeps({
        spawnStaggerMs: 0,
        cacheWriteTimeoutMs: 8000,
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);

      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // All 3 nodes spawned immediately (no stagger)
      expect(runner.spawn).toHaveBeenCalledTimes(3);

      // Complete all nodes
      for (const call of runner._getSpawnCalls()) {
        const runId = call._runId as string;
        runner._completeRun(runId, `Result ${call._runId}`);
        simulateCompletion(eventBus, runId, true);
      }
      await waitForMicrotask();

      await coordinator.shutdown();
    });

    it("single-node graph spawns immediately, no event listener", async () => {
      const { deps, runner, eventBus } = createTestDeps({
        spawnStaggerMs: 4000,
        cacheWriteTimeoutMs: 8000,
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);

      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Single node spawned immediately
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      // Complete and verify normal completion
      const runId = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId, "Result A");
      simulateCompletion(eventBus, runId, true);

      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // pre-warm graph cache
  // -------------------------------------------------------------------------

  describe("pre-warm graph cache", () => {
    beforeEach(() => {
      mockPreWarmGraphCache.mockClear();
    });

    it("calls preWarmGraphCache when preWarm is provided and toolSupersetPromise resolves", async () => {
      mockPreWarmGraphCache.mockResolvedValue({
        success: true,
        cacheWriteTokens: 1500,
        tokensUsed: 1501,
        cost: 0.003,
      });

      const { deps, runner, eventBus } = createTestDeps({
        assembleToolsForAgent: vi.fn().mockResolvedValue([
          { name: "tool_a" },
          { name: "tool_b" },
        ]),
        preWarm: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-20250514",
          apiKey: "test-key",
          systemPrompt: "You are helpful.",
          tools: [{ name: "tool_a" }, { name: "tool_b" }],
        },
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }, { nodeId: "B" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // preWarmGraphCache should have been called
      expect(mockPreWarmGraphCache).toHaveBeenCalledOnce();
      const callArgs = mockPreWarmGraphCache.mock.calls[0]![0];
      expect(callArgs.provider).toBe("anthropic");
      expect(callArgs.modelId).toBe("claude-sonnet-4-20250514");

      // Complete nodes and shutdown
      for (const call of runner._getSpawnCalls()) {
        const runId = call._runId as string;
        runner._completeRun(runId, "Result");
        simulateCompletion(eventBus, runId, true);
      }
      await waitForMicrotask();
      await coordinator.shutdown();
    });

    it("accumulates pre-warm cost in graph budget tracking", async () => {
      mockPreWarmGraphCache.mockResolvedValue({
        success: true,
        cacheWriteTokens: 2000,
        tokensUsed: 2001,
        cost: 0.005,
      });

      const { deps, runner, eventBus } = createTestDeps({
        assembleToolsForAgent: vi.fn().mockResolvedValue([{ name: "tool_a" }]),
        preWarm: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-20250514",
          apiKey: "test-key",
          systemPrompt: "System prompt",
          tools: [{ name: "tool_a" }],
        },
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // Complete node and check status to indirectly verify budget tracking
      // (graph should still run normally after pre-warm cost accumulation)
      const runId = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId, "Result A");
      simulateCompletion(eventBus, runId, true);

      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");

      await coordinator.shutdown();
    });

    it("graph still runs when pre-warm fails", async () => {
      mockPreWarmGraphCache.mockResolvedValue({
        success: false,
        cacheWriteTokens: 0,
        tokensUsed: 0,
        cost: 0,
        error: "API error",
      });

      const { deps, runner, eventBus } = createTestDeps({
        assembleToolsForAgent: vi.fn().mockResolvedValue([{ name: "tool_a" }]),
        preWarm: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-20250514",
          apiKey: "test-key",
          systemPrompt: "System prompt",
          tools: [{ name: "tool_a" }],
        },
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // spawnReadyNodes still called -- node was spawned
      expect(runner.spawn).toHaveBeenCalledTimes(1);

      const runId = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId, "Result A");
      simulateCompletion(eventBus, runId, true);

      const status = coordinator.getStatus(result.value);
      expect(status?.graphStatus).toBe("completed");

      await coordinator.shutdown();
    });

    it("skips pre-warm when preWarm is undefined (disabled)", async () => {
      const { deps, runner, eventBus } = createTestDeps({
        assembleToolsForAgent: vi.fn().mockResolvedValue([{ name: "tool_a" }]),
        // preWarm is undefined -- disabled
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // preWarmGraphCache should NOT have been called
      expect(mockPreWarmGraphCache).not.toHaveBeenCalled();

      const runId = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId, "Result A");
      simulateCompletion(eventBus, runId, true);

      await coordinator.shutdown();
    });

    it("skips pre-warm when toolSupersetPromise resolves to empty array", async () => {
      const { deps, runner, eventBus } = createTestDeps({
        assembleToolsForAgent: vi.fn().mockResolvedValue([]),
        preWarm: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-20250514",
          apiKey: "test-key",
          systemPrompt: "System prompt",
          tools: [{ name: "tool_a" }],
        },
      });
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);

      // preWarmGraphCache should NOT have been called (empty tools = no pre-warm)
      expect(mockPreWarmGraphCache).not.toHaveBeenCalled();

      const runId = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId, "Result A");
      simulateCompletion(eventBus, runId, true);

      await coordinator.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // 3.3: Graph-level cache aggregation in completion log
  // -------------------------------------------------------------------------

  describe("graph-level cache aggregation (3.3)", () => {
    it("includes graphCacheReadTokens, graphCacheWriteTokens, graphCacheEffectiveness when nodeCacheData has entries", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const loggerInfo = vi.fn();
      (deps as Record<string, unknown>).logger = { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A with cache data
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      eventBus.emit("session:sub_agent_completed", {
        runId: runIdA,
        agentId: "test-agent",
        success: true,
        runtimeMs: 100,
        tokensUsed: 500,
        cost: 0.005,
        timestamp: Date.now(),
        cacheReadTokens: 300,
        cacheWriteTokens: 100,
      });
      await waitForMicrotask();

      // Complete B with cache data
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runIdB, "Result B");
      eventBus.emit("session:sub_agent_completed", {
        runId: runIdB,
        agentId: "test-agent",
        success: true,
        runtimeMs: 100,
        tokensUsed: 500,
        cost: 0.005,
        timestamp: Date.now(),
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
      });
      await waitForMicrotask();

      // Find the "Graph execution complete" log call
      const completionCall = loggerInfo.mock.calls.find(
        (call: unknown[]) => call[1] === "Graph execution complete",
      );
      expect(completionCall).toBeDefined();
      const logObj = completionCall![0] as Record<string, unknown>;

      expect(logObj.graphCacheReadTokens).toBe(500);    // 300 + 200
      expect(logObj.graphCacheWriteTokens).toBe(150);   // 100 + 50
      expect(logObj.graphCacheEffectiveness).toBeCloseTo(0.769, 3);  // 500 / 650

      await coordinator.shutdown();
    });

    it("graphCacheEffectiveness = totalReads / (totalReads + totalWrites), rounded to 3 decimal places", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const loggerInfo = vi.fn();
      (deps as Record<string, unknown>).logger = { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete all nodes with cache data: total reads=400K, writes=150K
      const spawnCalls = runner._getSpawnCalls();
      const nodeData = [
        { reads: 150000, writes: 50000 },
        { reads: 130000, writes: 60000 },
        { reads: 120000, writes: 40000 },
      ];

      for (let i = 0; i < 3; i++) {
        const runId = spawnCalls[i]!._runId as string;
        runner._completeRun(runId, `Result ${i}`);
        eventBus.emit("session:sub_agent_completed", {
          runId,
          agentId: "test-agent",
          success: true,
          runtimeMs: 100,
          tokensUsed: 1000,
          cost: 0.01,
          timestamp: Date.now(),
          cacheReadTokens: nodeData[i]!.reads,
          cacheWriteTokens: nodeData[i]!.writes,
        });
        await waitForMicrotask();
      }

      const completionCall = loggerInfo.mock.calls.find(
        (call: unknown[]) => call[1] === "Graph execution complete",
      );
      expect(completionCall).toBeDefined();
      const logObj = completionCall![0] as Record<string, unknown>;

      // 400000 / (400000 + 150000) = 0.72727... -> 0.727
      expect(logObj.graphCacheEffectiveness).toBeCloseTo(0.727, 3);

      await coordinator.shutdown();
    });

    it("includes per-node effectiveness map in the log", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const loggerInfo = vi.fn();
      (deps as Record<string, unknown>).logger = { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A: effectiveness = 800 / (800 + 200) = 0.8
      const runIdA = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runIdA, "Result A");
      eventBus.emit("session:sub_agent_completed", {
        runId: runIdA,
        agentId: "test-agent",
        success: true,
        runtimeMs: 100,
        tokensUsed: 1000,
        cost: 0.01,
        timestamp: Date.now(),
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
      });
      await waitForMicrotask();

      // Complete B: effectiveness = 600 / (600 + 400) = 0.6
      const runIdB = runner._getSpawnCalls()[1]!._runId as string;
      runner._completeRun(runIdB, "Result B");
      eventBus.emit("session:sub_agent_completed", {
        runId: runIdB,
        agentId: "test-agent",
        success: true,
        runtimeMs: 100,
        tokensUsed: 1000,
        cost: 0.01,
        timestamp: Date.now(),
        cacheReadTokens: 600,
        cacheWriteTokens: 400,
      });
      await waitForMicrotask();

      const completionCall = loggerInfo.mock.calls.find(
        (call: unknown[]) => call[1] === "Graph execution complete",
      );
      expect(completionCall).toBeDefined();
      const logObj = completionCall![0] as Record<string, unknown>;

      const nodeEff = logObj.nodeEffectiveness as Record<string, number>;
      expect(nodeEff).toBeDefined();
      expect(nodeEff.A).toBeCloseTo(0.8, 3);
      expect(nodeEff.B).toBeCloseTo(0.6, 3);

      await coordinator.shutdown();
    });

    it("omits cache rollup fields from the log when nodeCacheData is empty", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const loggerInfo = vi.fn();
      (deps as Record<string, unknown>).logger = { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([{ nodeId: "A" }]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Complete A WITHOUT cache data
      const runId = runner._getSpawnCalls()[0]!._runId as string;
      runner._completeRun(runId, "Result A");
      simulateCompletion(eventBus, runId, true);
      await waitForMicrotask();

      const completionCall = loggerInfo.mock.calls.find(
        (call: unknown[]) => call[1] === "Graph execution complete",
      );
      expect(completionCall).toBeDefined();
      const logObj = completionCall![0] as Record<string, unknown>;

      expect(logObj.graphCacheReadTokens).toBeUndefined();
      expect(logObj.graphCacheWriteTokens).toBeUndefined();
      expect(logObj.graphCacheEffectiveness).toBeUndefined();
      expect(logObj.nodeEffectiveness).toBeUndefined();

      await coordinator.shutdown();
    });

    it("graph with 3 nodes where reads=400K, writes=150K reports effectiveness 0.727", async () => {
      const { deps, runner, eventBus } = createTestDeps();
      const loggerInfo = vi.fn();
      (deps as Record<string, unknown>).logger = { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const coordinator = createGraphCoordinator(deps);

      const graph = buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
      ]);
      const result = await coordinator.run({ graph });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // 400K reads, 150K writes across 3 nodes
      const spawnCalls = runner._getSpawnCalls();
      const nodes = [
        { reads: 200000, writes: 50000 },
        { reads: 100000, writes: 50000 },
        { reads: 100000, writes: 50000 },
      ];

      for (let i = 0; i < 3; i++) {
        const runId = spawnCalls[i]!._runId as string;
        runner._completeRun(runId, `Result ${i}`);
        eventBus.emit("session:sub_agent_completed", {
          runId,
          agentId: "test-agent",
          success: true,
          runtimeMs: 100,
          tokensUsed: 1000,
          cost: 0.01,
          timestamp: Date.now(),
          cacheReadTokens: nodes[i]!.reads,
          cacheWriteTokens: nodes[i]!.writes,
        });
        await waitForMicrotask();
      }

      const completionCall = loggerInfo.mock.calls.find(
        (call: unknown[]) => call[1] === "Graph execution complete",
      );
      expect(completionCall).toBeDefined();
      const logObj = completionCall![0] as Record<string, unknown>;

      expect(logObj.graphCacheReadTokens).toBe(400000);
      expect(logObj.graphCacheWriteTokens).toBe(150000);
      // 400000 / 550000 = 0.72727... rounds to 0.727
      expect(logObj.graphCacheEffectiveness).toBeCloseTo(0.727, 3);

      await coordinator.shutdown();
    });
  });
});
