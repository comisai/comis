// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  safePath,
  createConversationLocator,
  type BackgroundTaskOrigin,
  type ClockPort,
  type TimerPort,
  type TimerHandle,
} from "@comis/core";
import { createBackgroundTaskManager } from "@comis/agent";
import { ok } from "@comis/shared";
import { setupBackgroundCompletionRunner } from "./setup-background-completion-runner.js";

function executeFinalized(result: Record<string, unknown>) {
  return async (...args: unknown[]) => {
    const overrides = args[7] as {
      onProviderStart?: () => import("@comis/shared").Result<void, Error>;
      onFinalizedResult?: (
        value: Record<string, unknown>,
        phase: "cleanup_pending" | "ready",
      ) => Promise<void>;
      onJournalFinalizedResult?: (value: Record<string, unknown>) => Promise<void>;
    } | undefined;
    const started = overrides?.onProviderStart?.();
    if (started !== undefined && !started.ok) return Promise.reject(started.error);
    await overrides?.onJournalFinalizedResult?.(result);
    await overrides?.onFinalizedResult?.(result, "ready");
    return result;
  };
}

// ---------------------------------------------------------------------------
// Lightweight port wrappers that delegate to globals.
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

/**
 * Recording event bus that captures handler subscription order so tests
 * can assert the dispatcher subscribes BEFORE the runner (at-most-once
 * gate). Subscriptions ordered by `subscribedAt` timestamp — incrementing
 * per `on()` call.
 */
function makeRecordingEventBus() {
  let nextSubId = 0;
  const subscriptions: Array<{ event: string; handlerId: number; handler: (data: unknown) => void }> = [];
  const handlers = new Map<string, Array<{ id: number; fn: (data: unknown) => void }>>();
  return {
    bus: {
      on(event: string, handler: (data: unknown) => void) {
        const id = nextSubId++;
        subscriptions.push({ event, handlerId: id, handler });
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push({ id, fn: handler });
        return this;
      },
      off(event: string, handler: (data: unknown) => void) {
        const list = handlers.get(event);
        if (!list) return this;
        const idx = list.findIndex((h) => h.fn === handler);
        if (idx >= 0) list.splice(idx, 1);
        return this;
      },
      emit(event: string, data: unknown) {
        // Fire in subscription order (matching production TypedEventBus).
        for (const h of handlers.get(event) ?? []) h.fn(data);
      },
    } as unknown as import("@comis/core").TypedEventBus,
    subscriptions,
  };
}

function makeFakeEventBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event: string, handler: (data: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return this;
    },
    off(event: string, handler: (data: unknown) => void) {
      handlers.get(event)?.delete(handler);
      return this;
    },
    emit(_event: string, _data: unknown) {},
  } as unknown as import("@comis/core").TypedEventBus;
}

function makeLogger() {
  const child = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => child),
  } as unknown as import("@comis/infra").ComisLogger;
}

function makeDeliveryDeps() {
  return {
    adaptersByType: new Map(),
    resolveSessionManager: vi.fn(() => undefined),
    deliveryService: {
      deliverToChannel: vi.fn(),
      drainInFlight: vi.fn(),
    } as unknown as import("@comis/core").DeliveryService,
  };
}

function buildOrigin(
  over: Partial<BackgroundTaskOrigin> & { agentId?: string } = {},
): BackgroundTaskOrigin {
  const { agentId = "default", ...authorityOverrides } = over;
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "test-instance",
    conversationId: "test",
    conversationKind: "direct" as const,
  };
  const locator = createConversationLocator({
    tenantId: "default",
    agentId,
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint,
      principalId: "user1",
    },
  });
  if (!locator.ok) throw locator.error;
  return {
    turnScope: {
      conversation: locator.value.conversationScope,
      principal: { principalId: "user1" },
      endpoint,
    },
    conversationRef: locator.value.conversationRef,
    deliveryOrigin: {
      tenantId: "default",
      userId: "user1",
      channelType: "echo",
      channelId: "test",
    },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
    ...authorityOverrides,
  };
}

describe("setupBackgroundCompletionRunner", () => {
  it("returns a context object with a runner.shutdown function", async () => {
    const ctx = setupBackgroundCompletionRunner({
      eventBus: makeFakeEventBus(),
      ...makeDeliveryDeps(),
      getExecutor: vi.fn().mockReturnValue({ execute: vi.fn() }) as unknown as (agentId: string) => import("@comis/agent").AgentExecutor,
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      sessionStore: { loadByRef: vi.fn().mockReturnValue({ ok: true, value: undefined }) },
      taskManager: { getTask: vi.fn() } as unknown as import("@comis/agent").BackgroundTaskManager,
      fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
      maxBackgroundHops: 3,
      logger: makeLogger(),
    });
    expect(ctx).toBeDefined();
    expect(ctx.runner).toBeDefined();
    expect(typeof ctx.runner.shutdown).toBe("function");
  });

  it("shutdown() resolves cleanly", async () => {
    const ctx = setupBackgroundCompletionRunner({
      eventBus: makeFakeEventBus(),
      ...makeDeliveryDeps(),
      getExecutor: vi.fn().mockReturnValue({ execute: vi.fn() }) as unknown as (agentId: string) => import("@comis/agent").AgentExecutor,
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      sessionStore: { loadByRef: vi.fn().mockReturnValue({ ok: true, value: undefined }) },
      taskManager: { getTask: vi.fn() } as unknown as import("@comis/agent").BackgroundTaskManager,
      fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
      maxBackgroundHops: 3,
      logger: makeLogger(),
    });
    await expect(ctx.runner.shutdown()).resolves.toBeUndefined();
  });

  it("shutdown() is idempotent", async () => {
    const ctx = setupBackgroundCompletionRunner({
      eventBus: makeFakeEventBus(),
      ...makeDeliveryDeps(),
      getExecutor: vi.fn().mockReturnValue({ execute: vi.fn() }) as unknown as (agentId: string) => import("@comis/agent").AgentExecutor,
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      sessionStore: { loadByRef: vi.fn().mockReturnValue({ ok: true, value: undefined }) },
      taskManager: { getTask: vi.fn() } as unknown as import("@comis/agent").BackgroundTaskManager,
      fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
      maxBackgroundHops: 3,
      logger: makeLogger(),
    });
    await ctx.runner.shutdown();
    await expect(ctx.runner.shutdown()).resolves.toBeUndefined();
  });

  it("delivers the continuation through the exact persisted channel authority", async () => {
    const recording = makeRecordingEventBus();
    const origin = buildOrigin();
    const task: import("@comis/agent").BackgroundTask = {
      id: "task-delivery",
      toolName: "report",
      status: "completed" as const,
      startedAt: 1,
      completedAt: 2,
      result: "raw result",
      origin,
      dispatchState: "pending",
      continuationExecutionId: "task-delivery",
      dispatchAttempts: 0,
    };
    const adapter = {
      channelId: origin.turnScope.endpoint.channelInstanceId,
      channelType: origin.turnScope.endpoint.channelType,
      sendMessage: vi.fn(),
    };
    const deliverToChannel = vi.fn().mockResolvedValue(ok({
      chunks: [],
      totalChars: 19,
      queueDisposition: "settled" as const,
      platform: {
        status: "accepted" as const,
        deliveredChunks: 1,
        settledAtMs: 4,
        lastMessageId: "outbound-1",
      },
    }));
    const taskManager = {
      getTask: vi.fn(() => task),
      commitDispatchState: vi.fn((_taskId: string, next: import("@comis/agent").BackgroundSessionState) => {
        task.dispatchState = next;
        return ok(true);
      }),
      persistContinuationOutbox: vi.fn((_taskId, outbox) => {
        task.continuationOutbox = outbox;
        task.dispatchState = "ready_to_deliver";
        return ok(undefined);
      }),
      persistCleanupPendingOutbox: vi.fn(),
      persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
      recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
      scheduleDispatchRetry: vi.fn(),
      scheduleStateRetry: vi.fn(),
    };
    const ctx = setupBackgroundCompletionRunner({
      eventBus: recording.bus,
      adaptersByType: new Map([[adapter.channelType, adapter]]) as never,
      deliveryService: {
        deliverToChannel,
        drainInFlight: vi.fn(),
      },
      getExecutor: vi.fn().mockReturnValue({
        execute: vi.fn(executeFinalized({
          response: "finalized completion",
          executionId: "execution-1",
          finishReason: "stop",
        })),
      }) as unknown as (agentId: string) => import("@comis/agent").AgentExecutor,
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      sessionStore: { loadByRef: vi.fn().mockReturnValue(ok(undefined)) },
      resolveSessionManager: vi.fn(() => undefined),
      taskManager: taskManager as unknown as import("@comis/agent").BackgroundTaskManager,
      fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
      maxBackgroundHops: 3,
      logger: makeLogger(),
    });

    recording.bus.emit("background_task:completed", {
      agentId: "default",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin,
      timestamp: 3,
    });
    await ctx.runner.shutdown();

    expect(task.dispatchState).toBe("delivered");
    expect(deliverToChannel).toHaveBeenCalledWith(
      adapter,
      origin.turnScope.endpoint.conversationId,
      "finalized completion",
      {
        completionMode: "settled",
        authority: {
          tenantId: origin.turnScope.conversation.tenantId,
          agentId: origin.turnScope.conversation.agentId,
          conversationRef: origin.conversationRef,
        },
        destinationEndpoint: origin.turnScope.endpoint,
        origin: "background-completion",
      },
    );
  });

  it("parks an adapter rejection without a ledger instead of resending", async () => {
    const recording = makeRecordingEventBus();
    const origin = buildOrigin();
    const task: import("@comis/agent").BackgroundTask = {
      id: "task-uncertain",
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "raw result",
      origin,
      dispatchState: "pending",
      continuationExecutionId: "task-uncertain",
      dispatchAttempts: 0,
    };
    const adapter = {
      channelId: origin.turnScope.endpoint.channelInstanceId,
      channelType: origin.turnScope.endpoint.channelType,
      sendMessage: vi.fn(),
    };
    const deliverToChannel = vi.fn().mockRejectedValue(new Error("transport disconnected"));
    const taskManager = {
      getTask: () => task,
      commitDispatchState: (_taskId: string, next: import("@comis/agent").BackgroundSessionState) => {
        task.dispatchState = next;
        return ok(true);
      },
      persistContinuationOutbox: (_taskId: string, outbox: import("@comis/agent").BackgroundContinuationOutbox) => {
        task.continuationOutbox = outbox;
        task.dispatchState = "ready_to_deliver";
        return ok(undefined);
      },
      persistCleanupPendingOutbox: vi.fn(),
      persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
      recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
      scheduleDispatchRetry: vi.fn(),
      scheduleStateRetry: vi.fn(),
    };
    const execute = vi.fn(executeFinalized({
      response: "finalized completion",
      executionId: "execution-uncertain",
      finishReason: "stop",
    }));
    const ctx = setupBackgroundCompletionRunner({
      eventBus: recording.bus,
      adaptersByType: new Map([[adapter.channelType, adapter]]) as never,
      deliveryService: { deliverToChannel, drainInFlight: vi.fn() },
      getExecutor: () => ({ execute }) as never,
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      sessionStore: { loadByRef: vi.fn().mockReturnValue(ok(undefined)) },
      resolveSessionManager: vi.fn(() => undefined),
      taskManager,
      fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
      maxBackgroundHops: 3,
      logger: makeLogger(),
    });
    const completion = {
      agentId: "default",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin,
      timestamp: 3,
    };

    recording.bus.emit("background_task:completed", completion);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    recording.bus.emit("background_task:completed", completion);
    await ctx.runner.shutdown();

    expect(task.dispatchState).toBe("parked_uncertain");
    expect(deliverToChannel).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(taskManager.scheduleDispatchRetry).not.toHaveBeenCalled();
  });

  it("parks a ledger-recorded permanent rejection without retrying", async () => {
    const recording = makeRecordingEventBus();
    const origin = buildOrigin();
    const task: import("@comis/agent").BackgroundTask = {
      id: "task-permanent",
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "raw result",
      origin,
      dispatchState: "pending",
      continuationExecutionId: "task-permanent",
      dispatchAttempts: 0,
    };
    const adapter = {
      channelId: origin.turnScope.endpoint.channelInstanceId,
      channelType: origin.turnScope.endpoint.channelType,
      sendMessage: vi.fn(),
    };
    const ledgerRow = {
      id: "row-a",
      rootRunId: "background-task:task-permanent",
      stepIndex: 1,
      agentId: "default",
      channelType: "echo",
      channelId: "test",
      state: "failed",
      operationKind: "message_send",
      operationFingerprint: "a".repeat(64),
      contentDigest: "b".repeat(64),
      attemptCount: 1,
      attemptedAtMs: 1,
    };
    const outwardLedger = {
      allocateStep: vi.fn().mockResolvedValue(ok(1)),
      lookup: vi.fn()
        .mockResolvedValueOnce(ok(undefined))
        .mockResolvedValueOnce(ok(ledgerRow)),
      begin: vi.fn().mockResolvedValue(ok(undefined)),
      markUnknown: vi.fn().mockResolvedValue(ok(undefined)),
      reclaimPreSend: vi.fn().mockResolvedValue(ok(true)),
      commit: vi.fn().mockResolvedValue(ok(undefined)),
      markFailed: vi.fn().mockResolvedValue(ok(undefined)),
      parkUncertain: vi.fn().mockResolvedValue(ok(true)),
      hasUncertainty: vi.fn().mockResolvedValue(ok(false)),
      listUnreconciled: vi.fn().mockResolvedValue(ok([])),
    };
    const taskManager = {
      getTask: () => task,
      commitDispatchState: (_taskId: string, next: import("@comis/agent").BackgroundSessionState) => {
        task.dispatchState = next;
        return ok(true);
      },
      persistContinuationOutbox: (_taskId: string, outbox: import("@comis/agent").BackgroundContinuationOutbox) => {
        task.continuationOutbox = outbox;
        task.dispatchState = "ready_to_deliver";
        return ok(undefined);
      },
      persistCleanupPendingOutbox: vi.fn(),
      persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
      recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
      scheduleDispatchRetry: vi.fn(),
      scheduleStateRetry: vi.fn(),
    };
    const ctx = setupBackgroundCompletionRunner({
      eventBus: recording.bus,
      adaptersByType: new Map([[adapter.channelType, adapter]]) as never,
      deliveryService: {
        deliverToChannel: vi.fn().mockRejectedValue(new Error("chat not found")),
        drainInFlight: vi.fn(),
      },
      getExecutor: () => ({
        execute: vi.fn(executeFinalized({
          response: "finalized completion",
          executionId: "execution-permanent",
          finishReason: "stop",
        })),
      }) as never,
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      sessionStore: { loadByRef: vi.fn().mockReturnValue(ok(undefined)) },
      resolveSessionManager: vi.fn(() => undefined),
      taskManager,
      fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
      outwardLedger: outwardLedger as never,
      maxBackgroundHops: 3,
      logger: makeLogger(),
    });

    recording.bus.emit("background_task:completed", {
      agentId: "default",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin,
      timestamp: 3,
    });
    await ctx.runner.shutdown();

    expect(task.dispatchState).toBe("parked_permanent");
    expect(outwardLedger.markFailed).toHaveBeenCalledOnce();
    expect(taskManager.scheduleDispatchRetry).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // The observation subscriber is installed before the execution owner.
  // ---------------------------------------------------------------------------
  describe("dispatcher subscribes before runner", () => {
    it("dispatcher subscribes to background_task:completed BEFORE the runner", () => {
      const recording = makeRecordingEventBus();
      setupBackgroundCompletionRunner({
        eventBus: recording.bus,
        ...makeDeliveryDeps(),
        getExecutor: vi.fn().mockReturnValue({ execute: vi.fn() }) as unknown as (agentId: string) => import("@comis/agent").AgentExecutor,
        assembleToolsForAgent: vi.fn().mockResolvedValue([]),
        sessionStore: { loadByRef: vi.fn().mockReturnValue({ ok: true, value: undefined }) },
        taskManager: {
          getTask: vi.fn(),
          commitDispatchState: vi.fn().mockReturnValue(ok(false)),
        } as unknown as import("@comis/agent").BackgroundTaskManager,
        fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
        maxBackgroundHops: 3,
        logger: makeLogger(),
      });

      const completedSubs = recording.subscriptions.filter(
        (s) => s.event === "background_task:completed",
      );
      // Both dispatcher and runner subscribe.
      expect(completedSubs.length).toBe(2);
      // The first subscription must be the dispatcher (lower handlerId).
      expect(completedSubs[0]!.handlerId).toBeLessThan(completedSubs[1]!.handlerId);
    });

    it("returns a dispatcher handle alongside the runner; both shut down cleanly", async () => {
      const ctx = setupBackgroundCompletionRunner({
        eventBus: makeFakeEventBus(),
        ...makeDeliveryDeps(),
        getExecutor: vi.fn().mockReturnValue({ execute: vi.fn() }) as unknown as (agentId: string) => import("@comis/agent").AgentExecutor,
        assembleToolsForAgent: vi.fn().mockResolvedValue([]),
        sessionStore: { loadByRef: vi.fn().mockReturnValue({ ok: true, value: undefined }) },
        taskManager: {
          getTask: vi.fn(),
          commitDispatchState: vi.fn().mockReturnValue(ok(false)),
        } as unknown as import("@comis/agent").BackgroundTaskManager,
        fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
        maxBackgroundHops: 3,
        logger: makeLogger(),
      });
      expect(ctx.dispatcher).toBeDefined();
      expect(typeof ctx.dispatcher.shutdown).toBe("function");
      await expect(ctx.runner.shutdown()).resolves.toBeUndefined();
      // Dispatcher is also shut down by ctx.runner.shutdown (reverse-order
      // teardown), so calling its shutdown again should be a no-op.
      await expect(ctx.dispatcher.shutdown()).resolves.toBeUndefined();
    });

    it("on background_task:completed, the dispatcher observes before the runner", async () => {
      const recording = makeRecordingEventBus();
      const callOrder: string[] = [];
      const commitDispatchState = vi.fn(() => {
        return ok(true);
      });
      const getTaskMock = vi.fn().mockImplementation((id: string) => {
        callOrder.push(`getTask:${callOrder.length}`);
        return {
          id,
          toolName: "exec",
          status: "completed" as const,
          startedAt: 1,
          completedAt: 2,
          origin: buildOrigin(),
          dispatchState: "pending",
          continuationExecutionId: id,
          dispatchAttempts: 0,
        };
      });

      setupBackgroundCompletionRunner({
        eventBus: recording.bus,
        ...makeDeliveryDeps(),
        getExecutor: vi.fn().mockReturnValue({ execute: vi.fn() }) as unknown as (agentId: string) => import("@comis/agent").AgentExecutor,
        assembleToolsForAgent: vi.fn().mockResolvedValue([]),
        sessionStore: { loadByRef: vi.fn().mockReturnValue({ ok: true, value: { messages: [] } }) },
        taskManager: {
          getTask: getTaskMock,
          commitDispatchState,
          persistContinuationOutbox: vi.fn(),
          persistCleanupPendingOutbox: vi.fn(),
          scheduleDispatchRetry: vi.fn(),
        } as unknown as import("@comis/agent").BackgroundTaskManager,
        fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
        maxBackgroundHops: 3,
        logger: makeLogger(),
      });

      // Fire the event. Both dispatcher and runner are subscribed; they fire
      // in subscription order (dispatcher first).
      (recording.bus as unknown as { emit: (e: string, d: unknown) => void }).emit(
        "background_task:completed",
        {
          agentId: "default",
          taskId: "task-1",
          toolName: "exec",
          durationMs: 1,
          origin: buildOrigin(),
          timestamp: 3,
        },
      );
      // Wait for microtask drain.
      await new Promise((r) => setTimeout(r, 10));

      expect(callOrder.slice(0, 2)).toEqual(["getTask:0", "getTask:1"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Restart recovery preserves parked uncertain delivery without replay.
  // background_task:failed event re-emitted (recovery-without-events).
  // The dispatcher is not constructed in this test; we only verify the
  // manager preserves state without re-emit.
  // ---------------------------------------------------------------------------
  describe("SIGKILL-recovery: dispatchState survives daemon restart", () => {
    let dataDir: string;
    beforeEach(() => {
      dataDir = safePath(tmpdir(), `comis-ac5-${randomUUID()}`);
      mkdirSync(dataDir, { recursive: true });
    });
    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("recovered parked uncertain task does not re-emit background_task:failed", () => {
      const origin = buildOrigin({ agentId: "ac5-agent" });
      const seeded: Record<string, unknown> = {
        id: "ac5-task-1",
        toolName: "exec",
        status: "failed",
        startedAt: Date.now() - 5000,
        completedAt: Date.now() - 4000,
        error: "Daemon restarted while task was running",
        origin,
        dispatchState: "parked_uncertain",
        notificationPolicy: "deferred",
        continuationExecutionId: "ac5-task-1",
        dispatchAttempts: 1,
        continuationOutbox: {
          kind: "fallback",
          response: "exact fallback",
          executionId: "execution-a",
          idempotencyKey: "fallback-a",
          deliveryProtection: "none",
        },
      };
      const agentDir = safePath(dataDir, origin.turnScope.conversation.agentId);
      mkdirSync(agentDir, { recursive: true });
      const filePath = safePath(agentDir, `${seeded.id as string}.json`);
      writeFileSync(filePath, JSON.stringify(seeded, null, 2), "utf-8");

      // Build a manager with a recording event bus.
      const recordedEmits: Array<{ event: string; data: unknown }> = [];
      const eventBus = {
        emitSafely: vi.fn((event: string, data: unknown) => {
          recordedEmits.push({ event, data });
          return {
            hadListeners: false,
            failures: [],
            pendingFailures: Promise.resolve([]),
          };
        }),
      } as unknown as import("@comis/core").TypedEventBus;

      const manager = createBackgroundTaskManager({
        dataDir,
        eventBus,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        clock: testClock,
        timers: testTimers,
        maxPerAgent: 5,
        maxTotal: 20,
        maxBackgroundDurationMs: 60_000,
      });

      manager.recoverOnStartup(() => ok(undefined));

      // The recovered task is in memory, with dispatchState preserved.
      const recovered = manager.getTask("ac5-task-1") as
        | (import("@comis/agent").BackgroundTask & { dispatchState?: string })
        | undefined;
      expect(recovered).toBeDefined();
      expect(recovered?.dispatchState).toBe("parked_uncertain");

      // No background_task:failed event was emitted (recovery without
      // re-emitting events).
      const failedEmits = recordedEmits.filter(
        (e) => e.event === "background_task:failed",
      );
      expect(failedEmits).toHaveLength(0);
    });

  });
});
