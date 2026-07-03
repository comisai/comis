// SPDX-License-Identifier: Apache-2.0
/**
 * The sub-agent runner's durable-checkpoint + keep-alive heartbeat
 * instrumentation.
 *
 * These cases assert:
 *   - a cron-fired spawn (isCronAgentTurn + jobId) writes a checkpoint whose
 *     cronOrigin is the jobId (derived from the REAL cron signal);
 *   - a non-cron spawn writes cronOrigin = null;
 *   - the initial checkpoint is at stepIndex -1 (the never-sent sentinel — the
 *     outward counter is owned by allocateOutwardStep, NOT the checkpoint);
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
import type {
  ClockPort,
  TimerPort,
  TimerHandle,
  DurableRunPort,
  DurableRunRecord,
} from "@comis/core";
import { ok, type Result } from "@comis/shared";

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

// ---------------------------------------------------------------------------
// A recording DurableRunPort stub.
// ---------------------------------------------------------------------------

interface RecordingStore extends DurableRunPort {
  readonly checkpoints: DurableRunRecord[];
  readonly heartbeats: Array<{ rootRunId: string; atMs: number }>;
  readonly completed: string[];
}

function createRecordingStore(): RecordingStore {
  const checkpoints: DurableRunRecord[] = [];
  const heartbeats: Array<{ rootRunId: string; atMs: number }> = [];
  const completed: string[] = [];
  return {
    checkpoints,
    heartbeats,
    completed,
    upsertCheckpoint: (record): Promise<Result<void, Error>> => { checkpoints.push(record); return Promise.resolve(ok(undefined)); },
    touchHeartbeat: (rootRunId, atMs): Promise<Result<void, Error>> => { heartbeats.push({ rootRunId, atMs }); return Promise.resolve(ok(undefined)); },
    markCompleted: (rootRunId): Promise<Result<void, Error>> => { completed.push(rootRunId); return Promise.resolve(ok(undefined)); },
    listResumable: () => Promise.resolve(ok([])),
    getByRootRun: () => Promise.resolve(ok(undefined)),
    markOrphaned: () => Promise.resolve(ok(undefined)),
    invalidateForRevoke: () => Promise.resolve(ok(undefined)),
    allocateOutwardStep: () => Promise.resolve(ok(0)),
  };
}

function createDeps(over: Partial<SubAgentRunnerDeps> = {}): SubAgentRunnerDeps {
  return {
    sessionStore: { save: vi.fn(), delete: vi.fn() },
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
    ...over,
  };
}

describe("sub-agent-runner durable checkpoint and keep-alive heartbeat", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("writes an initial checkpoint at the spawn boundary (stepIndex -1, status running)", async () => {
    const store = createRecordingStore();
    const runner = createSubAgentRunner(createDeps({ durableRuns: store }));
    runner.spawn({ task: "long task", agentId: "worker", rootRunId: "root-A" });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.checkpoints.length).toBe(1);
    const cp = store.checkpoints[0]!;
    expect(cp.rootRunId).toBe("root-A");
    expect(cp.stepIndex).toBe(-1); // the never-sent sentinel — NOT the outward counter
    expect(cp.status).toBe("running");
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
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.checkpoints[0]!.cronOrigin).toBe("job-42");
  });

  it("a non-cron spawn records cronOrigin = null", async () => {
    const store = createRecordingStore();
    const runner = createSubAgentRunner(createDeps({ durableRuns: store }));
    runner.spawn({ task: "interactive task", agentId: "worker", rootRunId: "root-B" });
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
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.checkpoints[0]!.caps).toEqual(["orch:read", "orch:message"]);
  });

  it("emits a keep-alive heartbeat on the injected timer at the keepAlive cadence", async () => {
    const store = createRecordingStore();
    const runner = createSubAgentRunner(
      createDeps({ durableRuns: store, durability: { keepAliveMs: 1_000, staleHeartbeatMs: 4_000 } }),
    );
    runner.spawn({ task: "long task", agentId: "worker", rootRunId: "root-HB" });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.heartbeats.length).toBe(0); // not yet — interval has not fired

    // Advance past three keep-alive intervals — the run is still running
    // (never-resolving executeAgent), so the heartbeat must fire independent of
    // step/spawn completion.
    await vi.advanceTimersByTimeAsync(3_500);
    expect(store.heartbeats.length).toBe(3);
    expect(store.heartbeats.every((h) => h.rootRunId === "root-HB")).toBe(true);
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
    runner.spawn({ task: "quick task", agentId: "worker", rootRunId: "root-DONE" });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.completed).toContain("root-DONE");

    // After completion the heartbeat interval is cancelled — advancing the clock
    // produces NO further heartbeats (the leaked-timer guard).
    const before = store.heartbeats.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.heartbeats.length).toBe(before);
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
