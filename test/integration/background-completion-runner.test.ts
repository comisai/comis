// SPDX-License-Identifier: Apache-2.0
/**
 * Background-task completion re-triggers agent session — integration tests.
 *
 * Verifies acceptance criteria against a real daemon with the full
 * background-task completion pipeline wired:
 *   BackgroundTaskManager.complete() → background_task:completed event →
 *   completion runner → background_task:reentered event → executor.execute()
 *
 * Test strategy: drive the runner via BackgroundTaskManager.promote() +
 * complete()/fail() on the daemon's exposed backgroundTaskManager. This
 * exercises the exact code path the runner uses in production while avoiding
 * an LLM dependency (the executor.execute() call is triggered but its result
 * is irrelevant — the runner's suppressError absorbs LLM failures gracefully).
 *
 * The `background_task:reentered` event (emitted immediately before
 * executor.execute()) is the observable proxy for "runner fired and is about
 * to invoke executor". It is the p95 latency measurement endpoint and the
 * execution-start proof.
 *
 * Restart-recovery test promotes a task then calls fail() with
 * error === "Daemon restarted while task was running" and verifies the runner
 * emits background_task:reentered with the formatted restart announcement.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import { createFakeClock } from "../support/fake-clock.js";
import { createFakeTimers } from "../support/fake-timers.js";
import { createBackgroundTaskManager, loadTask } from "@comis/agent";
import { EchoChannelAdapter } from "@comis/channels";
import { createConversationRef, TypedEventBus } from "@comis/core";
import type { BackgroundTaskOrigin } from "@comis/core";
import { ok } from "@comis/shared";
import { createCompletionRecovery } from "../../packages/agent/dist/background/completion-recovery.js";
import { createBackgroundTaskRecoveryController } from "../../packages/agent/dist/background/background-task-recovery-controller.js";
import {
  persistBackgroundRecoveryAuthority,
  recoverBackgroundRecoveryAuthorities,
  removeBackgroundRecoveryAuthority,
} from "../../packages/agent/dist/background/background-recovery-authority.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, "../config/config.test-background-completion.yaml");

// Colon-joined identity string the tests use as a compact source for the
// tenantId/userId components of the origin's conversation scope. Segments are
// "{tenantId}:{userId}:{channelId}".
const TEST_SESSION_KEY = "test:test-user:bg-completion-test";
const TEST_AGENT_ID = "default";
const TEST_CHANNEL_TYPE = "echo";
const TEST_CHANNEL_ID = "bg-completion-test";

/**
 * Build a BackgroundTaskOrigin for test use.
 *
 * The origin carries the canonical conversation authority
 * (turnScope + conversationRef + deliveryOrigin); the completion runner
 * projects a query scope from it and looks the session up via
 * loadByRef(scope, conversationRef). Callers may override the identity via
 * flat helper args (agentId/sessionKey/channelType/channelId/userId), which
 * are folded into the scope; any BackgroundTaskOrigin field passed through
 * overrides wins. backgroundHopCount=0 means a first-generation background task.
 */
function makeTestOrigin(
  over: Partial<BackgroundTaskOrigin> & {
    agentId?: string;
    sessionKey?: string;
    channelType?: string;
    channelId?: string;
    userId?: string;
  } = {},
): BackgroundTaskOrigin {
  const agentId = over.agentId ?? TEST_AGENT_ID;
  const sessionParts = (over.sessionKey ?? TEST_SESSION_KEY).split(":");
  const tenantId = sessionParts[0] ?? "test";
  const userId = over.userId ?? sessionParts[1] ?? "test-user";
  const channelType = over.channelType ?? TEST_CHANNEL_TYPE;
  const channelId = over.channelId ?? TEST_CHANNEL_ID;
  const endpoint = {
    channelType,
    channelInstanceId: "test-instance",
    conversationId: channelId,
    conversationKind: "direct" as const,
  };
  const turnScope = {
    conversation: {
      tenantId,
      agentId,
      partition: {
        kind: "endpoint-conversation-principal" as const,
        endpoint,
        principalId: userId,
      },
    },
    principal: { principalId: userId },
    endpoint,
  };
  const conversationRef = createConversationRef(turnScope.conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    turnScope,
    conversationRef: conversationRef.value,
    deliveryOrigin: { channelType, channelId, userId, tenantId },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
    ...Object.fromEntries(
      Object.entries(over).filter(
        ([key]) => !["agentId", "sessionKey", "channelType", "channelId", "userId"].includes(key),
      ),
    ),
  };
}

/**
 * Promote a synthetic task into the manager and return the taskId.
 * The task promise resolves immediately; we call complete() manually in tests
 * to control when the event fires.
 *
 * Using an already-resolved promise means the manager's internal hard-timeout
 * timer fires immediately on the next tick; we call complete() before that.
 */
function promoteSyntheticTask(
  handle: TestDaemonHandle,
  toolName: string,
  origin: BackgroundTaskOrigin,
): { taskId: string; completeTask: (result: string) => void; failTask: (error: string) => void } {
  // A promise that never resolves on its own — we control resolution via
  // completeTask / failTask below. The AbortController is unused (test-only).
  let externalResolve: ((v: unknown) => void) | undefined;
  let externalReject: ((e: Error) => void) | undefined;
  const controlledPromise = new Promise<unknown>((res, rej) => {
    externalResolve = res;
    externalReject = rej;
  });

  const ac = new AbortController();
  const result = handle.daemon.backgroundTaskManager.promote(
    toolName,
    controlledPromise,
    ac,
    origin,
  );

  if (!result.ok) {
    throw new Error(`promote() failed: ${result.error.message}`);
  }

  const taskId = result.value;

  return {
    taskId,
    completeTask: (taskResult: string) => {
      externalResolve?.(taskResult);
      handle.daemon.backgroundTaskManager.complete(taskId, taskResult);
    },
    failTask: (error: string) => {
      externalReject?.(new Error(error));
      handle.daemon.backgroundTaskManager.fail(taskId, new Error(error));
    },
  };
}

describe("background-task completion re-triggers agent session (integration)", () => {
  let handle: TestDaemonHandle;
  let echoAdapter: EchoChannelAdapter;

  beforeAll(async () => {
    echoAdapter = new EchoChannelAdapter({
      channelId: TEST_CHANNEL_ID,
      channelType: TEST_CHANNEL_TYPE,
    });

    handle = await startTestDaemon({ configPath });

    // Register the echo adapter so the delivery-queue drainer and direct
    // message.send dispatch can find it. Mirrors delivery-queue-recurring.test.ts.
    handle.daemon.adapterRegistry.set(TEST_CHANNEL_TYPE, echoAdapter);
    handle.daemon.deliveryAdapters.set(TEST_CHANNEL_TYPE, echoAdapter);

    // Seed the session store so the completion runner's
    // loadByRef(queryScope, origin.conversationRef) returns non-undefined
    // (runner falls back to notifyFn if the session is absent). Save at the
    // exact conversation scope makeTestOrigin() projects, so the runner's
    // scope+ref lookup resolves it. Empty message history is sufficient for
    // the runner's existence check.
    if (handle.daemon.sessionStoreBridge) {
      const seeded = handle.daemon.sessionStoreBridge.save(
        makeTestOrigin().turnScope.conversation,
        [],
      );
      if (!seeded.ok) throw seeded.error;
    }
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Backgrounded tool completion triggers the re-entry pipeline.
  //
  // Drive: promote → complete → background_task:completed event →
  //   runner emits background_task:reentered (right before executor.execute).
  //
  // The reentered event is emitted immediately before executor.execute().
  // The executor call itself may fail in test environments without a real LLM
  // key (runner's suppressError absorbs it); the test only asserts the
  // pipeline entry-point fired correctly.
  // ---------------------------------------------------------------------------

  it(
    "background_task:completed → runner emits background_task:reentered within 2000ms",
    async () => {
      const origin = makeTestOrigin();
      const { taskId, completeTask } = promoteSyntheticTask(handle, "test_sleep", origin);

      const reenteredPromise = new Promise<{ taskId: string; timestamp: number }>(
        (resolveP, rejectP) => {
          const timeout = setTimeout(() => {
            handle.daemon.container.eventBus.off("background_task:reentered", handler);
            rejectP(
              new Error(
                "background_task:reentered not emitted within 2000ms after background_task:completed",
              ),
            );
          }, 2_000);

          function handler(data: {
            taskId: string;
            agentId: string;
            sessionKey: string;
            hopCount: number;
            timestamp: number;
          }): void {
            if (data.taskId !== taskId) return; // different task; ignore
            clearTimeout(timeout);
            handle.daemon.container.eventBus.off("background_task:reentered", handler);
            resolveP({ taskId: data.taskId, timestamp: data.timestamp });
          }

          handle.daemon.container.eventBus.on("background_task:reentered", handler);
        },
      );

      // Trigger completion. manager.complete() emits background_task:completed,
      // which the runner consumes.
      completeTask('{"slept":500}');

      // Wait for reentered event (runner fires it just before executor.execute).
      const reentered = await reenteredPromise;
      expect(reentered.taskId).toBe(taskId);
    },
    15_000,
  );

  // ---------------------------------------------------------------------------
  // p95 latency from manager.complete() to executor.execute() start is
  // ≤ 1000ms across ≥ 50 trials.
  //
  // Measurement: delta between background_task:completed.timestamp
  // (set by manager.complete()) and background_task:reentered.timestamp
  // (emitted immediately before executor.execute).
  // ---------------------------------------------------------------------------

  it(
    "p95 latency background_task:completed → background_task:reentered ≤ 1000ms over 50 trials",
    async () => {
      const latencies: number[] = [];
      const TRIALS = 50;

      for (let i = 0; i < TRIALS; i++) {
        const origin = makeTestOrigin();
        const { taskId, completeTask } = promoteSyntheticTask(
          handle,
          `test_sleep_trial_${i}`,
          origin,
        );

        // Set up listener BEFORE calling completeTask() to avoid a race where
        // the runner fires and emits reentered before we start listening.
        let resolveReentered!: (ts: number) => void;
        let rejectReentered!: (e: Error) => void;
        const reenteredPromise = new Promise<number>((resolveP, rejectP) => {
          resolveReentered = resolveP;
          rejectReentered = rejectP;
        });

        const timeout = setTimeout(() => {
          handle.daemon.container.eventBus.off("background_task:reentered", handler);
          rejectReentered(
            new Error(`Trial ${i}: background_task:reentered not emitted within 2000ms`),
          );
        }, 2_000);

        function handler(data: {
          taskId: string;
          timestamp: number;
        }): void {
          if (data.taskId !== taskId) return;
          clearTimeout(timeout);
          handle.daemon.container.eventBus.off("background_task:reentered", handler);
          resolveReentered(data.timestamp);
        }

        handle.daemon.container.eventBus.on("background_task:reentered", handler);

        // Capture completed-at epoch just before firing complete() — this is
        // the upper-bound start of the latency window.
        const completedAt = Date.now();
        completeTask(`{"trial":${i}}`);

        // Await the reentered event (fired by runner just before executor.execute).
        const reenteredTimestamp = await reenteredPromise;

        // Delta: runner dispatch latency from complete() to reentered event.
        // completedAt is a conservative upper bound (slightly before the
        // manager sets completed.timestamp), so measured latency ≥ actual.
        latencies.push(reenteredTimestamp - completedAt);

        // Allow one event loop turn between trials to avoid overwhelming the runner.
        await new Promise((r) => setTimeout(r, 0));
      }

      expect(latencies).toHaveLength(TRIALS);

      latencies.sort((a, b) => a - b);
      const p95Index = Math.floor(latencies.length * 0.95);
      const p95 = latencies[p95Index]!;
      const p50 = latencies[Math.floor(latencies.length * 0.5)]!;

      // eslint-disable-next-line no-console -- intentional observability for latency SLO
      console.log(
        `[latency] count=${latencies.length} min=${latencies[0]} p50=${p50} p95=${p95} max=${latencies[latencies.length - 1]}`,
      );

      expect(p95).toBeLessThanOrEqual(1000);
    },
    120_000,
  );

  // ---------------------------------------------------------------------------
  // Concurrent background_task:completed events for the same sessionKey are
  // serialized by the existing session lock.
  //
  // Two tasks are completed near-simultaneously. Both should trigger
  // background_task:reentered (i.e., executor.execute is called for each).
  // The session lock serializes the turns; both succeed (the runner's
  // suppressError absorbs LLM failures). Observable: both reentered events fire.
  // ---------------------------------------------------------------------------

  it(
    "two concurrent background_task:completed for same sessionKey both reach executor.execute (session-lock serialization)",
    async () => {
      const origin = makeTestOrigin();
      const { taskId: taskId1, completeTask: completeTask1 } = promoteSyntheticTask(
        handle,
        "test_sleep_a",
        origin,
      );
      const { taskId: taskId2, completeTask: completeTask2 } = promoteSyntheticTask(
        handle,
        "test_sleep_b",
        origin,
      );

      const reentered: string[] = [];
      let resolve1: (() => void) | undefined;
      let resolve2: (() => void) | undefined;

      const p1 = new Promise<void>((r) => {
        resolve1 = r;
      });
      const p2 = new Promise<void>((r) => {
        resolve2 = r;
      });

      function handler(data: { taskId: string }): void {
        if (data.taskId === taskId1) {
          reentered.push(taskId1);
          resolve1?.();
        } else if (data.taskId === taskId2) {
          reentered.push(taskId2);
          resolve2?.();
        }
      }

      handle.daemon.container.eventBus.on("background_task:reentered", handler);

      try {
        // Fire two completions near-simultaneously for the same sessionKey.
        // The completion runner processes them sequentially (session lock
        // serializes turns); both should reach executor.execute().
        completeTask1('{"result":"a"}');
        completeTask2('{"result":"b"}');

        // Wait for both reentered events with a generous timeout (session lock
        // may serialize the second behind the first executor.execute() call).
        await Promise.race([
          Promise.all([p1, p2]),
          new Promise<void>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `only ${reentered.length}/2 reentered events fired within 10s`,
                  ),
                ),
              10_000,
            ),
          ),
        ]);

        // Both tasks should have been processed (order is non-deterministic due
        // to session-lock queue, but both must appear).
        expect(reentered).toContain(taskId1);
        expect(reentered).toContain(taskId2);
        expect(reentered).toHaveLength(2);
      } finally {
        handle.daemon.container.eventBus.off("background_task:reentered", handler);
      }
    },
    30_000,
  );

  // ---------------------------------------------------------------------------
  // Daemon restart-recovery surfaces "task interrupted by daemon restart"
  // announcement to the user.
  //
  // Drive: promote → fail() with error "Daemon restarted while task was
  // running" (the exact error string recoverOnStartup uses).
  //
  // The completion runner handles background_task:failed events the same way
  // as completed. For the restart-recovery error, completion-formatter.ts
  // formats the copy: "This background task was interrupted by a daemon
  // restart..."
  //
  // Verification: background_task:reentered fires (runner invoked executor).
  // If no real LLM key: executor call fails, suppressError absorbs it.
  // ---------------------------------------------------------------------------

  it(
    "background_task:failed with restart error → runner emits background_task:reentered (recovery pipeline)",
    async () => {
      // Use a fresh session key for this test to isolate from prior state.
      const restartSessionKey = "test:restart-user:bg-restart-test";

      const origin = makeTestOrigin({
        sessionKey: restartSessionKey,
        channelId: "bg-restart-test",
      });

      // Seed a session at this origin's scope so the runner finds it and calls
      // executor.execute() (loadByRef(queryScope, origin.conversationRef)).
      if (handle.daemon.sessionStoreBridge) {
        const seeded = handle.daemon.sessionStoreBridge.save(
          origin.turnScope.conversation,
          [],
        );
        if (!seeded.ok) throw seeded.error;
      }

      const { taskId, failTask } = promoteSyntheticTask(
        handle,
        "test_sleep_restart",
        origin,
      );

      const reenteredPromise = new Promise<{ taskId: string; timestamp: number }>(
        (resolveP, rejectP) => {
          const timeout = setTimeout(() => {
            handle.daemon.container.eventBus.off("background_task:reentered", handler);
            rejectP(
              new Error(
                "background_task:reentered not emitted within 5000ms for restart-recovery",
              ),
            );
          }, 5_000);

          function handler(data: {
            taskId: string;
            timestamp: number;
          }): void {
            if (data.taskId !== taskId) return;
            clearTimeout(timeout);
            handle.daemon.container.eventBus.off("background_task:reentered", handler);
            resolveP({ taskId: data.taskId, timestamp: data.timestamp });
          }

          handle.daemon.container.eventBus.on("background_task:reentered", handler);
        },
      );

      // Fail the task with the exact restart-recovery error string.
      // This mirrors what recoverOnStartup() does.
      failTask("Daemon restarted while task was running");

      // Runner should pick up the failed event, format the restart-recovery
      // announcement ("This background task was interrupted by a daemon restart..."),
      // and invoke executor.execute() (triggering reentered).
      const reentered = await reenteredPromise;
      expect(reentered.taskId).toBe(taskId);
    },
    20_000,
  );
});

describe("background-task durable timeout integration", () => {
  it("persists the configured hard-timeout terminal state before reporting failure", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-background-timeout-"));
    try {
      const clock = createFakeClock(1_000);
      const timers = createFakeTimers(1_000);
      const eventBus = new TypedEventBus();
      const abortController = new AbortController();
      const manager = createBackgroundTaskManager({
        dataDir,
        eventBus,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          debug: () => undefined,
        },
        clock,
        timers,
        maxBackgroundDurationMs: 500,
      });
      const promoted = manager.promote(
        "test_timeout",
        new Promise(() => undefined),
        abortController,
        makeTestOrigin(),
      );
      expect(promoted.ok).toBe(true);
      if (!promoted.ok) return;

      clock.advance(500);
      timers.advance(500);

      const task = manager.getTask(promoted.value);
      expect(task?.status).toBe("failed");
      expect(task?.error).toBe("Hard timeout exceeded");
      expect(abortController.signal.aborted).toBe(true);
      expect(loadTask(dataDir, TEST_AGENT_ID, promoted.value)).toMatchObject({
        id: promoted.value,
        status: "failed",
        error: "Hard timeout exceeded",
        completedAt: 1_500,
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("background-task compiled durable recovery integration", () => {
  function makeRecoveryDeps(
    task: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      taskManager: {
        getTask: vi.fn(() => task),
        persistContinuationOutbox: vi.fn(() => ok(true)),
        persistCleanupPendingOutbox: vi.fn(() => ok(true)),
        persistFinalizedResult: vi.fn(() => ok(true)),
        scheduleDispatchRetry: vi.fn(),
        scheduleStateRetry: vi.fn(),
        recordRecoveryIncident: vi.fn(() => ok(undefined)),
      },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn(),
      deliveryProtection: "ledger" as const,
      commitState: vi.fn(() => ok(true)),
      emitRoutingOutcome: vi.fn(),
      deliverPersistedOutbox: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("recovers a finalized continuation from the protected journal and delivers its persisted outbox", async () => {
    const origin = makeTestOrigin();
    const task = {
      id: "task-recovered",
      toolName: "report",
      status: "completed",
      origin,
      continuationExecutionId: "execution-recovered",
      dispatchState: "executing",
    };
    const recovered = {
      response: "Recovered continuation",
      executionId: "execution-recovered",
      cleanupRequired: false,
    };
    const deps = makeRecoveryDeps(task, {
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(recovered)),
    });
    const recovery = createCompletionRecovery(deps as never);

    await recovery.recoverClaimedTask(task.id, origin, task.toolName);

    expect(deps.taskManager.persistContinuationOutbox).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        kind: "continuation",
        response: recovered.response,
        executionId: recovered.executionId,
        idempotencyKey: "background-continuation:execution-recovered",
        deliveryProtection: "ledger",
      }),
      ["executing"],
    );
    expect(deps.deliverPersistedOutbox).toHaveBeenCalledWith(
      task.id,
      origin,
      expect.objectContaining({ response: recovered.response }),
    );
  });

  it("finishes protected-session cleanup before making the recovered continuation deliverable", async () => {
    const origin = makeTestOrigin();
    const task: Record<string, unknown> = {
      id: "task-cleanup",
      toolName: "report",
      status: "completed",
      origin,
      continuationExecutionId: "execution-cleanup",
      dispatchState: "executing",
    };
    const recovered = {
      response: "Recovered after cleanup",
      executionId: "execution-cleanup",
      cleanupRequired: true,
    };
    const persistCleanupPendingOutbox = vi.fn(
      (_taskId: string, outbox: unknown) => {
        task.dispatchState = "cleanup_pending";
        task.continuationOutbox = outbox;
        return ok(true);
      },
    );
    const deps = makeRecoveryDeps(task, {
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(recovered)),
    });
    deps.taskManager.persistCleanupPendingOutbox = persistCleanupPendingOutbox;
    const recovery = createCompletionRecovery(deps as never);

    await recovery.recoverClaimedTask(
      task.id as string,
      origin,
      task.toolName as string,
    );

    expect(deps.cleanupFinalizedSession).toHaveBeenCalledWith({
      agentId: TEST_AGENT_ID,
      sessionKey: {
        tenantId: "test",
        agentId: TEST_AGENT_ID,
        channelId: "echo:test-instance:bg-completion-test",
        userId: "test-user",
        peerId: "test-user",
      },
    });
    expect(deps.commitState).toHaveBeenCalledWith(
      task.id,
      "ready_to_deliver",
      ["cleanup_pending"],
    );
    expect(deps.deliverPersistedOutbox).toHaveBeenCalledWith(
      task.id,
      origin,
      expect.objectContaining({ response: recovered.response }),
    );
  });

  it("reconciles an accepted delivery claim into the durable delivered state", async () => {
    const origin = makeTestOrigin();
    const task = {
      id: "task-delivering",
      toolName: "report",
      status: "completed",
      origin,
      continuationExecutionId: "execution-delivering",
      dispatchState: "delivering",
    };
    const deps = makeRecoveryDeps(task, {
      reconcileDelivery: vi.fn().mockResolvedValue(ok({ kind: "accepted" })),
    });
    const recovery = createCompletionRecovery(deps as never);
    const outbox = {
      kind: "continuation" as const,
      response: "Delivered continuation",
      executionId: "execution-delivering",
      idempotencyKey: "background-continuation:execution-delivering",
      deliveryProtection: "ledger" as const,
    };

    await recovery.reconcileDeliveryClaim(task.id, origin, outbox);

    expect(deps.reconcileDelivery).toHaveBeenCalledWith({
      taskId: task.id,
      origin,
      response: outbox.response,
      executionId: outbox.executionId,
      idempotencyKey: outbox.idempotencyKey,
    });
    expect(deps.commitState).toHaveBeenCalledWith(
      task.id,
      "delivered",
      ["delivering"],
    );
    expect(deps.emitRoutingOutcome).toHaveBeenCalledWith(
      task.id,
      origin,
      task.toolName,
      true,
      "continuation_accepted",
    );
  });

  it("resets an unstarted claimed continuation so durable dispatch can retry it", async () => {
    const origin = makeTestOrigin();
    const task = {
      id: "task-unstarted",
      toolName: "report",
      status: "completed",
      origin,
      continuationExecutionId: "execution-unstarted",
      dispatchState: "execution_claimed",
    };
    const deps = makeRecoveryDeps(task);
    const recovery = createCompletionRecovery(deps as never);

    await recovery.recoverClaimedTask(task.id, origin, task.toolName);

    expect(deps.commitState).toHaveBeenCalledWith(
      task.id,
      "pending",
      ["execution_claimed"],
    );
    expect(deps.taskManager.scheduleDispatchRetry).toHaveBeenCalledWith(task.id);
    expect(deps.emitRoutingOutcome).toHaveBeenCalledWith(
      task.id,
      origin,
      task.toolName,
      false,
      "retry_scheduled",
    );
  });

  it("consumes a silent continuation after cleanup without sending a user message", async () => {
    const origin = makeTestOrigin();
    const task = {
      id: "task-silent",
      toolName: "report",
      status: "completed",
      origin,
      continuationExecutionId: "execution-silent",
      dispatchState: "cleanup_pending",
      continuationOutbox: {
        kind: "continuation",
        response: "NO_REPLY",
        executionId: "execution-silent",
        idempotencyKey: "background-continuation:execution-silent",
        deliveryProtection: "ledger",
      },
    };
    const deps = makeRecoveryDeps(task);
    const recovery = createCompletionRecovery(deps as never);

    await recovery.finishCleanup(task.id, origin, task.toolName);

    expect(deps.cleanupFinalizedSession).toHaveBeenCalledOnce();
    expect(deps.commitState).toHaveBeenCalledWith(
      task.id,
      "delivered",
      ["cleanup_pending"],
    );
    expect(deps.deliverPersistedOutbox).not.toHaveBeenCalled();
  });

  it("returns a retryable pre-send delivery claim to its durable retry state", async () => {
    const origin = makeTestOrigin();
    const task = {
      id: "task-retryable",
      toolName: "report",
      status: "completed",
      origin,
      continuationExecutionId: "execution-retryable",
      dispatchState: "delivering",
    };
    const deps = makeRecoveryDeps(task, {
      reconcileDelivery: vi.fn().mockResolvedValue(ok({
        kind: "retryable_pre_send",
        errorKind: "resource",
        message: "delivery queue busy",
      })),
    });
    const recovery = createCompletionRecovery(deps as never);
    const outbox = {
      kind: "continuation" as const,
      response: "Retry this continuation",
      executionId: "execution-retryable",
      idempotencyKey: "background-continuation:execution-retryable",
      deliveryProtection: "ledger" as const,
    };

    await recovery.reconcileDeliveryClaim(task.id, origin, outbox);

    expect(deps.commitState).toHaveBeenCalledWith(
      task.id,
      "pre_send",
      ["delivering"],
    );
    expect(deps.taskManager.recordRecoveryIncident).toHaveBeenCalledWith(task.id);
    expect(deps.taskManager.scheduleDispatchRetry).toHaveBeenCalledWith(task.id);
  });

  it("parks a permanent delivery rejection and records its terminal routing reason", async () => {
    const origin = makeTestOrigin();
    const task = {
      id: "task-permanent",
      toolName: "report",
      status: "completed",
      origin,
      continuationExecutionId: "execution-permanent",
      dispatchState: "delivering",
    };
    const deps = makeRecoveryDeps(task, {
      reconcileDelivery: vi.fn().mockResolvedValue(ok({
        kind: "permanent",
        errorKind: "validation",
        message: "destination rejected",
      })),
    });
    const recovery = createCompletionRecovery(deps as never);
    const outbox = {
      kind: "fallback" as const,
      response: "Fallback completion",
      executionId: "execution-permanent",
      idempotencyKey: "background-continuation:execution-permanent",
      deliveryProtection: "ledger" as const,
    };

    await recovery.reconcileDeliveryClaim(task.id, origin, outbox);

    expect(deps.commitState).toHaveBeenCalledWith(
      task.id,
      "parked_permanent",
      ["delivering"],
    );
    expect(deps.emitRoutingOutcome).toHaveBeenCalledWith(
      task.id,
      origin,
      task.toolName,
      false,
      "permanent_parked",
    );
  });

  it("round-trips protected recovery authority through the compiled restart store", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-recovery-authority-"));
    const authority = {
      agentId: TEST_AGENT_ID,
      taskId: "task-authority",
      toolName: "report",
      sessionKey: TEST_SESSION_KEY,
      projectedSessionKey: {
        tenantId: "test",
        agentId: TEST_AGENT_ID,
        channelId: "echo:test-instance:bg-completion-test",
        userId: "test-user",
        peerId: "test-user",
      },
      traceId: null,
      timestamp: 1_000,
      source: "scan" as const,
      requiredDisposition: "accepted" as const,
      resolutionRequested: false,
    };
    try {
      const persisted = persistBackgroundRecoveryAuthority(dataDir, authority);
      const recovered = recoverBackgroundRecoveryAuthorities(dataDir);
      const incidentDir = join(
        dataDir,
        TEST_AGENT_ID,
        ".recovery-incidents",
      );

      expect(persisted).toEqual({ ok: true, value: { kind: "committed" } });
      expect(recovered).toEqual({ ok: true, value: [authority] });
      expect(statSync(incidentDir).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(incidentDir, readdirSync(incidentDir)[0]!)).mode & 0o777,
      ).toBe(0o600);

      expect(removeBackgroundRecoveryAuthority(dataDir, authority)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(recoverBackgroundRecoveryAuthorities(dataDir)).toEqual({
        ok: true,
        value: [],
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records and resolves a recovery incident through the compiled durable controller", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-recovery-controller-"));
    const eventBus = new TypedEventBus();
    const notified = vi.fn();
    const recorder = vi.fn(() => ok("accepted" as const));
    eventBus.on("background_task:notified", notified);
    try {
      const controller = createBackgroundTaskRecoveryController({
        eventBus,
        logger: { warn: vi.fn() },
        clock: createFakeClock(1_000),
        timers: createFakeTimers(1_000),
        dataDir,
      });
      controller.setRecorder(recorder);
      const task = {
        id: "task-controller-lifecycle",
        toolName: "report",
        origin: makeTestOrigin(),
      };

      controller.recordTask(task);

      expect(recoverBackgroundRecoveryAuthorities(dataDir)).toEqual({
        ok: true,
        value: [
          expect.objectContaining({
            taskId: task.id,
            requiredDisposition: "accepted",
            resolutionRequested: false,
          }),
        ],
      });
      expect(notified).toHaveBeenCalledWith(expect.objectContaining({
        taskId: task.id,
        reason: "recovery_retry_required",
        trajectoryRecorded: true,
      }));

      controller.resolveTask(task);

      expect(recorder.mock.calls.map(([incident]) => incident.reason)).toEqual([
        "recovery_retry_required",
        "recovery_resolved",
      ]);
      expect(notified).toHaveBeenCalledWith(expect.objectContaining({
        taskId: task.id,
        reason: "recovery_resolved",
        trajectoryRecorded: true,
      }));
      expect(recoverBackgroundRecoveryAuthorities(dataDir)).toEqual({
        ok: true,
        value: [],
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reconciles restored recovery authority only after a complete restart scan", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-recovery-controller-"));
    const origin = makeTestOrigin();
    const authority = {
      agentId: TEST_AGENT_ID,
      taskId: "task-restored-controller",
      toolName: "report",
      sessionKey: TEST_SESSION_KEY,
      projectedSessionKey: {
        tenantId: "test",
        agentId: TEST_AGENT_ID,
        channelId: "echo:test-instance:bg-completion-test",
        userId: "test-user",
        peerId: "test-user",
      },
      traceId: null,
      timestamp: 1_000,
      source: "scan" as const,
      requiredDisposition: "accepted" as const,
      resolutionRequested: false,
    };
    const persisted = persistBackgroundRecoveryAuthority(dataDir, authority);
    expect(persisted.ok).toBe(true);
    const recorder = vi.fn(() => ok("accepted" as const));
    try {
      const controller = createBackgroundTaskRecoveryController({
        eventBus: new TypedEventBus(),
        logger: { warn: vi.fn() },
        clock: createFakeClock(2_000),
        timers: createFakeTimers(2_000),
        dataDir,
      });
      controller.setRecorder(recorder);

      expect(recorder).not.toHaveBeenCalled();

      controller.reportScanFailures([], [], vi.fn());

      expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
        taskId: authority.taskId,
        reason: "recovery_resolved",
      }));
      expect(recoverBackgroundRecoveryAuthorities(dataDir)).toEqual({
        ok: true,
        value: [],
      });

      controller.recordTask({
        id: "task-after-restart",
        toolName: "report",
        origin,
      });
      expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
        taskId: "task-after-restart",
        reason: "recovery_retry_required",
      }));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps restart authority durable while trajectory resolution is suppressed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-recovery-controller-"));
    const eventBus = new TypedEventBus();
    const systemErrors = vi.fn();
    const logger = { warn: vi.fn() };
    const recorder = vi.fn()
      .mockReturnValueOnce(ok("accepted" as const))
      .mockReturnValueOnce(ok("suppressed" as const))
      .mockReturnValue(ok("accepted" as const));
    eventBus.on("system:error", systemErrors);
    try {
      const controller = createBackgroundTaskRecoveryController({
        eventBus,
        logger,
        clock: createFakeClock(2_500),
        timers: createFakeTimers(2_500),
        dataDir,
      });
      controller.setRecorder(recorder);
      const task = {
        id: "task-suppressed-resolution",
        toolName: "report",
        origin: makeTestOrigin(),
      };
      controller.recordTask(task);

      controller.resolveTask(task);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          errorKind: "config",
          hint: expect.stringContaining("diagnostics.trajectory.enabled"),
        }),
        "Background recovery resolution is suppressed",
      );
      expect(systemErrors).toHaveBeenCalledWith(expect.objectContaining({
        source: "background-recovery-configuration",
      }));
      expect(recoverBackgroundRecoveryAuthorities(dataDir)).toEqual({
        ok: true,
        value: [
          expect.objectContaining({
            taskId: task.id,
            resolutionRequested: true,
          }),
        ],
      });

      controller.setRecorder(recorder);

      expect(recoverBackgroundRecoveryAuthorities(dataDir)).toEqual({
        ok: true,
        value: [],
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("surfaces an incomplete restart scan and retries it deterministically", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-recovery-controller-"));
    const eventBus = new TypedEventBus();
    const systemErrors = vi.fn();
    const logger = { warn: vi.fn() };
    const timers = createFakeTimers(3_000);
    const retry = vi.fn();
    eventBus.on("system:error", systemErrors);
    try {
      const controller = createBackgroundTaskRecoveryController({
        eventBus,
        logger,
        clock: createFakeClock(3_000),
        timers,
        dataDir,
      });
      controller.setRecorder(vi.fn(() => ok("accepted" as const)));
      const failedTask = {
        id: "task-incomplete-scan",
        toolName: "report",
        origin: makeTestOrigin(),
      };

      controller.reportScanFailures(
        [{ kind: "task_read", identity: failedTask }],
        [],
        retry,
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCount: 1,
          failureKinds: ["task_read"],
          errorKind: "resource",
        }),
        "Background task recovery scan incomplete",
      );
      expect(systemErrors).toHaveBeenCalledWith(expect.objectContaining({
        source: "background-task-recovery",
      }));
      expect(timers.unrefRecord()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "timeout",
          delay: 1_000,
          unrefCalled: true,
        }),
      ]));

      timers.advance(1_000);

      expect(retry).toHaveBeenCalledOnce();
      expect(recoverBackgroundRecoveryAuthorities(dataDir)).toEqual({
        ok: true,
        value: [
          expect.objectContaining({
            taskId: failedTask.id,
            source: "scan",
            requiredDisposition: "accepted",
          }),
        ],
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Poll-and-fail helper (exported for potential future use by other tests).
// ---------------------------------------------------------------------------

/** Poll a condition every 50ms until it returns true or the timeout elapses. */
async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  desc: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForCondition timeout (${timeoutMs}ms): ${desc}`);
}

export { waitForCondition };
