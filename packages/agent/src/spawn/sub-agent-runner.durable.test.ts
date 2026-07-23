// SPDX-License-Identifier: Apache-2.0
/**
 * The sub-agent runner's durable-checkpoint + keep-alive heartbeat
 * instrumentation.
 *
 * These cases assert:
 *   - a cron-fired spawn (isCronAgentTurn + jobId) writes a checkpoint whose
 *     cronOrigin is the jobId (derived from the REAL cron signal);
 *   - a non-cron spawn writes cronOrigin = null;
 *   - the execution checkpoint is keyed by the unique run id, independently of
 *     the outward-send sequence;
 *   - a keep-alive heartbeat fires on the injected timer at the keepAlive cadence
 *     (independent of step/spawn completion);
 *   - the run is marked completed + the heartbeat cleared on terminal settle (no
 *     leaked interval);
 *   - the whole thing is INERT when no durableRuns store is wired (default path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@comis/agent", () => ({
  sanitizeAssistantResponse: (text: string) => text,
}));

import { createSubAgentRunner, type SubAgentRunnerDeps } from "./sub-agent-runner.js";
import {
  hashSubAgentResumeDescriptor,
  type SubAgentResumeDescriptor,
} from "./sub-agent-resume-descriptor.js";
import { computeWorkspacePolicyCombinedHash, createConversationRef } from "@comis/core";
import type {
  ClockPort,
  TimerPort,
  TimerHandle,
  DurableRunPort,
  DurableRunRecord,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Port wrappers delegating to globals so vi.useFakeTimers() intercepts them.
// ---------------------------------------------------------------------------

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() { if (cancelled) return; cancelled = true; clearInterval(t); },
    unref() { if (!cancelled) t.unref(); },
  };
}

const testClock: ClockPort = { now: () => Date.now(), nowDate: () => new Date() };
const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};
const POLICY_HASH = computeWorkspacePolicyCombinedHash([]);

// ---------------------------------------------------------------------------
// A recording DurableRunPort stub.
// ---------------------------------------------------------------------------

interface RecordingStore extends DurableRunPort {
  readonly checkpoints: DurableRunRecord[];
  readonly heartbeats: Array<{ checkpointId: string; atMs: number }>;
  readonly completed: Array<{ checkpointId: string; terminalReason: DurableRunRecord["terminalReason"] }>;
}

function createRecordingStore(): RecordingStore {
  const checkpoints: DurableRunRecord[] = [];
  const heartbeats: Array<{ checkpointId: string; atMs: number }> = [];
  const completed: Array<{ checkpointId: string; terminalReason: DurableRunRecord["terminalReason"] }> = [];
  return {
    checkpoints,
    heartbeats,
    completed,
    upsertCheckpoint: (record): Promise<Result<void, Error>> => { checkpoints.push(record); return Promise.resolve(ok(undefined)); },
    touchHeartbeat: (checkpointId, atMs): Promise<Result<void, Error>> => { heartbeats.push({ checkpointId, atMs }); return Promise.resolve(ok(undefined)); },
    markCompleted: (checkpointId, terminalReason): Promise<Result<void, Error>> => {
      completed.push({ checkpointId, terminalReason });
      return Promise.resolve(ok(undefined));
    },
    listResumable: () => Promise.resolve(ok({ records: [], invalid: [] })),
    getByCheckpoint: () => Promise.resolve(ok(undefined)),
    markOrphaned: () => Promise.resolve(ok(undefined)),
    invalidateForRevoke: () => Promise.resolve(ok(undefined)),
    countByStatus: () => Promise.resolve(ok({ orphaned: 0, revoked: 0, running: 0, completed: 0 })),
  };
}

function createDeps(over: Partial<SubAgentRunnerDeps> = {}): SubAgentRunnerDeps {
  return {
    sessionStore: {
      save: vi.fn(() => ok(undefined)),
      delete: vi.fn(() => ok(false)),
      loadByRef: vi.fn(() => ok(undefined)),
    },
    // A never-resolving executeAgent keeps the run RUNNING so the heartbeat can
    // tick before terminal settle (each test that needs completion overrides it).
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
    },
    tenantId: "default",
    clock: testClock,
    timers: testTimers,
    resolveWorkspacePolicySnapshot: async (agentId) => ok({
      agentId,
      sections: [],
      combinedHash: POLICY_HASH,
    }),
    ...over,
  };
}

describe("sub-agent-runner durable checkpoint and keep-alive heartbeat", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("writes an initial execution checkpoint at the spawn boundary", async () => {
    const store = createRecordingStore();
    const runner = createSubAgentRunner(createDeps({ durableRuns: store }));
    const runId = runner.spawn({ task: "long task", agentId: "worker", rootRunId: "root-A", workspacePolicyHash: POLICY_HASH });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.checkpoints.length).toBe(1);
    const cp = store.checkpoints[0]!;
    expect(cp.rootRunId).toBe("root-A");
    expect(cp.checkpointId).toBe(runId);
    expect(cp.status).toBe("running");
    expect(cp.scriptRef).toBeNull();
    expect(cp.checkpointRef).toBeNull();
  });

  it("rejects durable admission before execution when checkpoint storage fails", async () => {
    const credential = `xoxb-${"s".repeat(32)}`;
    const store = createRecordingStore();
    store.upsertCheckpoint = vi.fn(async () => err(new Error(`write failed ${credential}`)));
    const warn = vi.fn();
    const log = vi.fn();
    const logger = {
      level: "info",
      trace: log,
      debug: log,
      info: log,
      warn,
      error: log,
      fatal: log,
      audit: log,
      child() { return this; },
    } as unknown as NonNullable<SubAgentRunnerDeps["logger"]>;
    const executeAgent = vi.fn().mockReturnValue(new Promise(() => undefined));
    const runner = createSubAgentRunner(createDeps({ durableRuns: store, logger, executeAgent }));

    const runId = runner.spawn({ task: "long task", agentId: "worker", rootRunId: "root-safe-log", workspacePolicyHash: POLICY_HASH });
    await vi.advanceTimersByTimeAsync(0);

    const failure = log.mock.calls.find((call) =>
      call[1] === "Sub-agent execution failed"
    );
    expect(failure).toBeDefined();
    expect(String((failure![0] as Record<string, unknown>).err)).not.toContain(credential);
    expect(executeAgent).not.toHaveBeenCalled();
    expect(runner.getRunStatus(runId)?.status).toBe("failed");
  });

  it("rejects durable execution without an exact immutable policy snapshot", async () => {
    const executeAgent = vi.fn().mockReturnValue(new Promise(() => undefined));
    const runner = createSubAgentRunner(createDeps({
      durableRuns: createRecordingStore(),
      executeAgent,
      resolveWorkspacePolicySnapshot: undefined,
    }));
    const runId = runner.spawn({
      task: "protected task",
      agentId: "worker",
      rootRunId: "root-policy-missing",
      workspacePolicyHash: POLICY_HASH,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(executeAgent).not.toHaveBeenCalled();
    expect(runner.getRunStatus(runId)?.status).toBe("failed");
  });

  it("loads the target agent policy instead of inheriting caller authority", async () => {
    const store = createRecordingStore();
    const resolveWorkspacePolicySnapshot = vi.fn(async (agentId: string) => ok({
      agentId,
      sections: [],
      combinedHash: POLICY_HASH,
    }));
    const runner = createSubAgentRunner(createDeps({
      durableRuns: store,
      resolveWorkspacePolicySnapshot,
    }));

    runner.spawn({
      task: "cross-agent task",
      agentId: "worker",
      callerAgentId: "caller",
      rootRunId: "root-target-policy",
      workspacePolicyHash: "f".repeat(64),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveWorkspacePolicySnapshot).toHaveBeenCalledWith("worker");
    expect(store.checkpoints[0]?.agentId).toBe("worker");
    expect(store.checkpoints[0]?.workspacePolicyHash).toBe(POLICY_HASH);
  });

  it("does not start the provider when watchdog terminalizes deferred checkpoint admission", async () => {
    let releaseCheckpoint!: (value: Result<void, Error>) => void;
    const store = createRecordingStore();
    store.upsertCheckpoint = vi.fn(() => new Promise((resolve) => {
      releaseCheckpoint = resolve;
    }));
    const executeAgent = vi.fn().mockReturnValue(new Promise(() => undefined));
    const runner = createSubAgentRunner(createDeps({
      durableRuns: store,
      executeAgent,
      config: {
        ...createDeps().config,
        subagentContext: { maxRunTimeoutMs: 10, perStepTimeoutMs: 10 },
      },
    }));
    const runId = runner.spawn({
      task: "deferred checkpoint",
      agentId: "worker",
      rootRunId: "root-deferred-checkpoint",
      workspacePolicyHash: POLICY_HASH,
    });
    await vi.advanceTimersByTimeAsync(10);
    releaseCheckpoint(ok(undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(executeAgent).not.toHaveBeenCalled();
    expect(runner.getRunStatus(runId)?.status).toBe("failed");
    expect(store.completed.at(-1)).toEqual({
      checkpointId: runId,
      terminalReason: "watchdog_timeout",
    });
    const checkpointCount = store.checkpoints.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.checkpoints).toHaveLength(checkpointCount);
  });

  it("does not start the provider when watchdog terminalizes deferred spawn preparation", async () => {
    let releasePreparation!: () => void;
    const executeAgent = vi.fn().mockReturnValue(new Promise(() => undefined));
    const runner = createSubAgentRunner(createDeps({
      durableRuns: createRecordingStore(),
      executeAgent,
      lifecycleHooks: {
        prepareSpawn: vi.fn(() => new Promise((resolve) => {
          releasePreparation = () => resolve(undefined);
        })),
        onEnded: vi.fn(async () => undefined),
      },
      config: {
        ...createDeps().config,
        subagentContext: { maxRunTimeoutMs: 10, perStepTimeoutMs: 10 },
      },
    }));
    const runId = runner.spawn({
      task: "deferred preparation",
      agentId: "worker",
      rootRunId: "root-deferred-preparation",
      workspacePolicyHash: POLICY_HASH,
    });
    await vi.advanceTimersByTimeAsync(10);
    releasePreparation();
    await vi.advanceTimersByTimeAsync(0);
    expect(executeAgent).not.toHaveBeenCalled();
    expect(runner.getRunStatus(runId)?.status).toBe("failed");
  });

  it("rejects an oversized protected resume descriptor before execution", async () => {
    const executeAgent = vi.fn().mockReturnValue(new Promise(() => undefined));
    const deps = createDeps({
      durableRuns: createRecordingStore(),
      executeAgent,
    });
    const runner = createSubAgentRunner(deps);

    const runId = runner.spawn({
      task: "x".repeat(65_537),
      agentId: "worker",
      rootRunId: "root-oversized",
      workspacePolicyHash: POLICY_HASH,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(executeAgent).not.toHaveBeenCalled();
    expect(deps.sessionStore.save).not.toHaveBeenCalled();
    expect(runner.getRunStatus(runId)?.status).toBe("failed");
  });

  it("a cron-fired spawn records cronOrigin = the jobId (derived from isCronAgentTurn + jobId)", async () => {
    const store = createRecordingStore();
    const runner = createSubAgentRunner(createDeps({ durableRuns: store }));
    runner.spawn({
      task: "cron task",
      agentId: "worker",
      rootRunId: "root-cron",
      isCronAgentTurn: true,
      jobId: "job-42",
      workspacePolicyHash: POLICY_HASH,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.checkpoints[0]!.cronOrigin).toBe("job-42");
  });

  it("a non-cron spawn records cronOrigin = null", async () => {
    const store = createRecordingStore();
    const runner = createSubAgentRunner(createDeps({ durableRuns: store }));
    runner.spawn({ task: "interactive task", agentId: "worker", rootRunId: "root-B", workspacePolicyHash: POLICY_HASH });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.checkpoints[0]!.cronOrigin).toBe(null);
  });

  it("records the lease's attenuated caps verbatim from the spawn param", async () => {
    const store = createRecordingStore();
    const runner = createSubAgentRunner(createDeps({ durableRuns: store }));
    runner.spawn({
      task: "scoped task",
      agentId: "worker",
      rootRunId: "root-C",
      caps: ["orch:read", "orch:message"],
      workspacePolicyHash: POLICY_HASH,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.checkpoints[0]!.caps).toEqual(["orch:read", "orch:message"]);
  });

  it("records the child assembly lease and further-attenuated capabilities for descendants", async () => {
    const store = createRecordingStore();
    let receivedContext: Parameters<SubAgentRunnerDeps["executeAgent"]>[8];
    const executeAgent: SubAgentRunnerDeps["executeAgent"] = vi.fn(async (...args) => {
      receivedContext = args[8];
      receivedContext?.onAssemblyAuthority({
        rootRunId: "root-child",
        leaseId: "lease-child",
        caps: ["orch:read"],
      });
      return {
        response: "done",
        tokensUsed: { total: 1 },
        cost: { total: 0 },
        finishReason: "stop",
        stepsExecuted: 1,
      };
    });
    const runner = createSubAgentRunner(createDeps({ durableRuns: store, executeAgent }));
    const runId = runner.spawn({
      task: "scoped child",
      agentId: "worker",
      rootRunId: "root-child",
      parentLeaseId: "lease-parent",
      caps: ["orch:read", "orch:message"],
      workspacePolicyHash: POLICY_HASH,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(receivedContext).toEqual(expect.objectContaining({
      rootRunId: "root-child",
      parentLeaseId: "lease-parent",
      parentCaps: ["orch:read", "orch:message"],
    }));
    expect(runner.getRunStatus(runId)).toEqual(expect.objectContaining({
      leaseId: "lease-child",
      caps: ["orch:read"],
    }));
    expect(store.checkpoints.at(-1)).toEqual(expect.objectContaining({
      checkpointId: runId,
      caps: ["orch:read"],
    }));
  });

  it("persists keep-alive checkpoints on the injected timer at the keepAlive cadence", async () => {
    const store = createRecordingStore();
    const runner = createSubAgentRunner(
      createDeps({ durableRuns: store, durability: { keepAliveMs: 1_000, staleHeartbeatMs: 4_000 } }),
    );
    runner.spawn({ task: "long task", agentId: "worker", rootRunId: "root-HB", workspacePolicyHash: POLICY_HASH });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.checkpoints.length).toBe(1); // initial boundary only

    // Advance past three keep-alive intervals — the run is still running
    // (never-resolving executeAgent), so the heartbeat must fire independent of
    // step/spawn completion.
    await vi.advanceTimersByTimeAsync(3_500);
    expect(store.checkpoints.length).toBe(4);
    const checkpointId = store.checkpoints[0]!.checkpointId;
    expect(store.checkpoints.every((checkpoint) => checkpoint.checkpointId === checkpointId)).toBe(true);
  });

  it("marks the run completed + clears the heartbeat on terminal settle (no leaked timer)", async () => {
    const store = createRecordingStore();
    const runner = createSubAgentRunner(
      createDeps({
        durableRuns: store,
        durability: { keepAliveMs: 1_000, staleHeartbeatMs: 4_000 },
        // This run completes immediately so we can assert the terminal seam.
        executeAgent: vi.fn().mockResolvedValue({
          response: "done", tokensUsed: { total: 10 }, cost: { total: 0 }, finishReason: "stop", stepsExecuted: 1,
        }),
      }),
    );
    const runId = runner.spawn({ task: "quick task", agentId: "worker", rootRunId: "root-DONE", workspacePolicyHash: POLICY_HASH });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.completed).toContainEqual({ checkpointId: runId, terminalReason: "completed" });

    // After completion the heartbeat interval is cancelled — advancing the clock
    // produces NO further heartbeats (the leaked-timer guard).
    const before = store.checkpoints.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.checkpoints.length).toBe(before);
  });

  it("watchdog immediately closes durable resources when execution ignores abort", async () => {
    const store = createRecordingStore();
    const closeTrajectory = vi.fn(async () => undefined);
    const runner = createSubAgentRunner(createDeps({
      durableRuns: store,
      closeTrajectory,
      durability: { keepAliveMs: 1_000, staleHeartbeatMs: 4_000 },
      config: {
        ...createDeps().config,
        subagentContext: { maxRunTimeoutMs: 500, perStepTimeoutMs: 500 },
      },
      executeAgent: vi.fn().mockReturnValue(new Promise(() => undefined)),
    }));
    const runId = runner.spawn({ task: "stuck task", agentId: "worker", rootRunId: "root-timeout", workspacePolicyHash: POLICY_HASH });
    await vi.advanceTimersByTimeAsync(500);
    expect(store.completed).toContainEqual({
      checkpointId: runId,
      terminalReason: "watchdog_timeout",
    });
    expect(closeTrajectory).toHaveBeenCalledOnce();
    const before = store.checkpoints.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.checkpoints.length).toBe(before);
  });

  it("re-enters a protected durable descriptor with the reserved execution identity", async () => {
    const endpoint = {
      channelType: "telegram",
      channelInstanceId: "telegram-main",
      conversationId: "chat-a",
      conversationKind: "direct" as const,
    };
    const conversationScope = {
      tenantId: "default",
      agentId: "worker",
      partition: {
        kind: "endpoint-conversation-principal" as const,
        endpoint,
        principalId: "user_a",
      },
    };
    const conversationRef = createConversationRef(conversationScope);
    expect(conversationRef.ok).toBe(true);
    if (!conversationRef.ok) return;
    const descriptor: SubAgentResumeDescriptor = {
      kind: "subagent_resume",
      task: "continue protected work",
      agentId: "worker",
      depth: 0,
      maxDepth: 3,
      rootRunId: "root-resume",
      capabilityCeiling: ["orch:read"],
      workspacePolicyHash: POLICY_HASH,
    };
    const record: DurableRunRecord = {
      checkpointId: "run-resume",
      rootRunId: "root-resume",
      tenantId: "default",
      agentId: "worker",
      conversationRef: conversationRef.value,
      conversationScope,
      principalId: "user_a",
      deliveryOrigin: null,
      spawnTree: ["run-resume"],
      caps: ["orch:read"],
      leaseIds: ["lease-old"],
      budgetConsumed: 0,
      rootBudget: { startedAtMs: 1, tokensConsumed: 0, usdConsumed: 0 },
      cronOrigin: null,
      trustLevel: "user",
      status: "running",
      lastHeartbeatAt: 1,
      scriptRef: null,
      checkpointRef: null,
      workspacePolicyHash: descriptor.workspacePolicyHash,
      resumeDescriptorHash: hashSubAgentResumeDescriptor(descriptor),
    };
    const executeAgent = vi.fn(async (
      ...args: Parameters<SubAgentRunnerDeps["executeAgent"]>
    ) => {
      args[9]?.onProviderStart();
      return {
        response: "done",
        tokensUsed: { total: 1 },
        cost: { total: 0 },
        finishReason: "stop",
        stepsExecuted: 1,
      };
    });
    const runner = createSubAgentRunner(createDeps({
      durableRuns: createRecordingStore(),
      executeAgent,
      sessionStore: {
        save: vi.fn(() => ok(undefined)),
        delete: vi.fn(() => ok(false)),
        loadByRef: vi.fn(() => ok({
          conversationRef: conversationRef.value,
          conversationScope,
          messages: [],
          metadata: { durableResumeDescriptor: descriptor },
          createdAt: 1,
          updatedAt: 1,
        })),
      },
    }));
    const resumePromise = runner.resumeDurable(record, "lease-resumed", {
      agentId: "worker",
      sections: [],
      combinedHash: descriptor.workspacePolicyHash,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(executeAgent).toHaveBeenCalledOnce();
    expect(executeAgent.mock.calls[0]?.[9]).toEqual({
      onProviderStart: expect.any(Function),
    });
    const resumed = await resumePromise;
    expect(resumed).toEqual(ok("run-resume"));
    expect(executeAgent.mock.calls[0]![6]).toEqual({
      reuseConversation: {
        conversationRef: record.conversationRef,
        conversationScope: record.conversationScope,
      },
      workspacePolicySnapshot: {
        agentId: "worker",
        sections: [],
        combinedHash: descriptor.workspacePolicyHash,
      },
    });
  });

  it("no durableRuns store wired ⇒ zero checkpoint/heartbeat work (default install)", async () => {
    // No durableRuns in deps. A spawn must not throw and must do no durable work
    // (there is no store to record into — this is the byte-identical default).
    const runner = createSubAgentRunner(createDeps());
    const runId = runner.spawn({ task: "default task", agentId: "worker", rootRunId: "root-INERT" });
    await vi.advanceTimersByTimeAsync(2_000);
    // The run exists and is running; the absence of a store is a clean no-op.
    expect(runner.getRunStatus(runId)?.status).toBe("running");
  });
});
