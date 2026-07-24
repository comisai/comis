// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  type BackgroundTaskOrigin,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import {
  createBackgroundCompletionRunner,
  type BackgroundCompletionDeliveryInput,
} from "./completion-runner.js";
import type {
  BackgroundSessionState,
  BackgroundTask,
} from "./background-task-types.js";

function makeOrigin(): BackgroundTaskOrigin {
  const endpoint = {
    channelType: "telegram",
    channelInstanceId: "telegram-main",
    conversationId: "chat-a",
    conversationKind: "direct" as const,
  };
  const conversation = {
    tenantId: "default",
    agentId: "agent-a",
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint,
      principalId: "user_a",
    },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    turnScope: {
      conversation,
      principal: { principalId: "user_a" },
      endpoint,
    },
    conversationRef: conversationRef.value,
    deliveryOrigin: {
      tenantId: "default",
      userId: "user_a",
      channelType: "telegram",
      channelId: "chat-a",
    },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function acceptDelivery(
  input: BackgroundCompletionDeliveryInput,
) {
  const started = input.onSendStart();
  return started.ok
    ? { kind: "accepted" as const }
    : { kind: "retryable_pre_send" as const, errorKind: "resource" as const, message: started.error.message };
}

describe("background completion retry lifecycle", () => {
  it("retries a proven pre-send failure without ledger reconciliation", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-pre-send",
      continuationExecutionId: "continuation-pre-send",
      dispatchAttempts: 1,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      origin: makeOrigin(),
      dispatchState: "ready_to_deliver",
      continuationOutbox: {
        kind: "continuation",
        response: "ready",
        executionId: "execution-pre-send",
        idempotencyKey: "background-continuation:continuation-pre-send",
        deliveryProtection: "none",
      },
    };
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) return ok(false);
      task.dispatchState = next;
      return ok(true);
    });
    let attempt = 0;
    const deliverCompletion = vi.fn(async (input: BackgroundCompletionDeliveryInput) => {
      attempt++;
      if (attempt === 1) {
        return {
          kind: "retryable_pre_send" as const,
          errorKind: "precondition" as const,
          message: "adapter unavailable",
        };
      }
      return acceptDelivery(input);
    });
    const reconcileDelivery = vi.fn();
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: vi.fn() as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery,
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox: vi.fn().mockReturnValue(ok(undefined)),
        persistCleanupPendingOutbox: vi.fn().mockReturnValue(ok(undefined)),
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
        scheduleDispatchRetry: vi.fn(),
        scheduleStateRetry: vi.fn(),
      },
      deliverCompletion,
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "none",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });
    const completed = {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    };

    eventBus.emit("background_task:completed", completed);
    await flush();
    expect(task.dispatchState).toBe("pre_send");
    expect(reconcileDelivery).not.toHaveBeenCalled();

    eventBus.emit("background_task:completed", completed);
    await flush();
    expect(task.dispatchState).toBe("delivered");
    expect(deliverCompletion).toHaveBeenCalledTimes(2);
    expect(reconcileDelivery).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("schedules a state-only retry when accepted delivery cannot terminalize", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-terminal-retry",
      continuationExecutionId: "continuation-terminal-retry",
      dispatchAttempts: 1,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      origin: makeOrigin(),
      dispatchState: "ready_to_deliver",
      continuationOutbox: {
        kind: "continuation",
        response: "ready",
        executionId: "execution-terminal-retry",
        idempotencyKey: "background-continuation:continuation-terminal-retry",
        deliveryProtection: "none",
      },
    };
    const scheduleStateRetry = vi.fn();
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) return ok(false);
      if (next === "delivered") return err(new Error("terminal storage unavailable"));
      task.dispatchState = next;
      return ok(true);
    });
    const deliverCompletion = vi.fn(acceptDelivery);
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: vi.fn() as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn().mockResolvedValue(ok({ kind: "accepted" })),
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox: vi.fn().mockReturnValue(ok(undefined)),
        persistCleanupPendingOutbox: vi.fn().mockReturnValue(ok(undefined)),
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
        scheduleDispatchRetry: vi.fn(),
        scheduleStateRetry,
      },
      deliverCompletion,
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "none",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });

    eventBus.emit("background_task:completed", {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    });
    await flush();

    expect(deliverCompletion).toHaveBeenCalledOnce();
    expect(scheduleStateRetry).toHaveBeenCalledWith(
      task.id,
      "delivered",
      ["delivering"],
    );
    await runner.shutdown();
  });

  it("retries failed delivery with stable identities and commits only after acceptance", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-a",
      continuationExecutionId: "continuation-a",
      dispatchAttempts: 0,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "ready",
      origin: makeOrigin(),
      dispatchState: "pending",
    };
    const scheduleDispatchRetry = vi.fn();
    const scheduleStateRetry = vi.fn();
    let failFirstPreSendReset = true;
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) return ok(false);
      if (
        failFirstPreSendReset
        && current === "delivering"
        && next === "pre_send"
      ) {
        failFirstPreSendReset = false;
        return err(new Error("protected storage unavailable"));
      }
      task.dispatchState = next;
      if (next === "executing") task.dispatchAttempts++;
      return ok(true);
    });
    let deliveryAttempt = 0;
    const deliverCompletion = vi.fn(async (input: BackgroundCompletionDeliveryInput) => {
      const started = input.onSendStart();
      if (!started.ok) {
        return { kind: "retryable_pre_send" as const, errorKind: "resource" as const, message: started.error.message };
      }
      deliveryAttempt++;
      return deliveryAttempt === 1
        ? { kind: "retryable_pre_send" as const, errorKind: "dependency" as const, message: "offline" }
        : { kind: "accepted" as const };
    });
    const execute = vi.fn(async (...args: unknown[]) => {
      const result = {
        response: "continued",
        executionId: "executor-result-a",
      };
      const overrides = args[7] as {
        onProviderStart?: () => Result<void, Error>;
        onJournalFinalizedResult?: (value: typeof result) => Promise<void>;
        onFinalizedResult?: (
          value: typeof result,
          phase: "cleanup_pending" | "ready",
        ) => Promise<void>;
      } | undefined;
      const started = overrides?.onProviderStart?.();
      if (started !== undefined && !started.ok) return Promise.reject(started.error);
      await overrides?.onJournalFinalizedResult?.(result);
      await overrides?.onFinalizedResult?.(result, "ready");
      return result;
    });
    const recordRecoveryIncident = vi.fn().mockReturnValue(ok(undefined));
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({
        execute,
      }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn().mockResolvedValue(ok({
        kind: "retryable_pre_send",
        errorKind: "dependency",
        message: "no send entered the adapter",
      })),
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox: (_taskId, outbox, expected) => {
          const current = task.dispatchState ?? "pending";
          if (expected && !expected.includes(current)) {
            return { ok: false, error: new Error("outbox transition rejected") };
          }
          task.continuationOutbox = outbox;
          task.dispatchState = "ready_to_deliver";
          return ok(undefined);
        },
        persistCleanupPendingOutbox: vi.fn().mockReturnValue(ok(undefined)),
        scheduleDispatchRetry,
        scheduleStateRetry,
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident,
      },
      deliverCompletion,
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "none",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });
    const completion = {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    };
    eventBus.emit("background_task:completed", completion);
    await flush();
    expect(task.dispatchState).toBe("delivering");
    expect(scheduleStateRetry).toHaveBeenCalledWith(
      task.id,
      "pre_send",
      ["delivering"],
    );
    expect(scheduleDispatchRetry).not.toHaveBeenCalled();
    expect(recordRecoveryIncident).not.toHaveBeenCalled();
    task.dispatchState = "pre_send";
    eventBus.emit("background_task:completed", completion);
    await flush();
    expect(task.dispatchState).toBe("delivered");
    expect(execute).toHaveBeenCalledOnce();
    expect(deliverCompletion.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      "background-continuation:continuation-a",
      "background-continuation:continuation-a",
    ]);
    await runner.shutdown();
  });

  it("rebuilds a pre-provider journal result without re-running the executor", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-recovered",
      continuationExecutionId: "continuation-recovered",
      dispatchAttempts: 1,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "ready",
      origin: makeOrigin(),
      dispatchState: "execution_claimed",
      finalizedResult: {
        response: "persisted exact response",
        executionId: "execution-recovered",
        cleanupRequired: false,
      },
    };
    const execute = vi.fn();
    const deliverCompletion = vi.fn(acceptDelivery);
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) return ok(false);
      task.dispatchState = next;
      return ok(true);
    });
    const recoverFinalizedResult = vi.fn().mockResolvedValue(ok(undefined));
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult,
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn().mockResolvedValue(ok({ kind: "accepted" })),
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox: vi.fn((_taskId, outbox, expected) => {
          if (expected?.includes(task.dispatchState ?? "pending") !== true) {
            return err(new Error("outbox transition rejected"));
          }
          task.continuationOutbox = outbox;
          task.dispatchState = "ready_to_deliver";
          return ok(undefined);
        }),
        persistCleanupPendingOutbox: vi.fn().mockReturnValue(ok(undefined)),
        scheduleDispatchRetry: vi.fn(),
        scheduleStateRetry: vi.fn(),
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
      },
      deliverCompletion,
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "ledger",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });

    eventBus.emit("background_task:completed", {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    });
    await flush();

    expect(execute).not.toHaveBeenCalled();
    expect(recoverFinalizedResult).not.toHaveBeenCalled();
    expect(deliverCompletion).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      origin: task.origin,
      response: "persisted exact response",
      executionId: "execution-recovered",
      idempotencyKey: "background-continuation:continuation-recovered",
    }));
    expect(task.dispatchState).toBe("delivered");
    await runner.shutdown();
  });

  it("terminalizes a journaled silent pre-provider result without re-execution", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-recovered-silent",
      continuationExecutionId: "continuation-recovered-silent",
      dispatchAttempts: 1,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "ready",
      origin: makeOrigin(),
      dispatchState: "execution_claimed",
    };
    const execute = vi.fn();
    const deliverCompletion = vi.fn();
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      if (expected?.includes(task.dispatchState ?? "pending") !== true) return ok(false);
      task.dispatchState = next;
      return ok(true);
    });
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok({
        response: "NO_REPLY",
        executionId: "execution-recovered-silent",
        cleanupRequired: false,
      })),
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn().mockResolvedValue(ok({ kind: "accepted" })),
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox: vi.fn(),
        persistCleanupPendingOutbox: vi.fn(),
        scheduleDispatchRetry: vi.fn(),
        scheduleStateRetry: vi.fn(),
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
      },
      deliverCompletion,
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "ledger",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });

    eventBus.emit("background_task:completed", {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    });
    await flush();

    expect(task.dispatchState).toBe("delivered");
    expect(execute).not.toHaveBeenCalled();
    expect(deliverCompletion).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("rebuilds a journaled result after in-process outbox persistence failure", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-handoff-retry",
      continuationExecutionId: "continuation-handoff-retry",
      dispatchAttempts: 0,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "ready",
      origin: makeOrigin(),
      dispatchState: "pending",
    };
    const scheduleDispatchRetry = vi.fn();
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      if (expected?.includes(task.dispatchState ?? "pending") !== true) return ok(false);
      task.dispatchState = next;
      return ok(true);
    });
    const exactResult = {
      response: "journaled exact response",
      executionId: "execution-handoff-retry",
      cleanupRequired: false,
    };
    const persistContinuationOutbox = vi.fn()
      .mockReturnValueOnce(err(new Error("protected outbox unavailable")))
      .mockImplementation((_taskId, outbox, expected) => {
        if (expected?.includes(task.dispatchState ?? "pending") !== true) {
          return err(new Error("outbox transition rejected"));
        }
        task.continuationOutbox = outbox;
        task.dispatchState = "ready_to_deliver";
        return ok(undefined);
      });
    const execute = vi.fn(async (...args: unknown[]) => {
      const overrides = args[7] as {
        onProviderStart?: () => Result<void, Error>;
        onFinalizedResult?: (
          value: typeof exactResult,
          phase: "cleanup_pending" | "ready",
        ) => Promise<void>;
      } | undefined;
      const started = overrides?.onProviderStart?.();
      if (started !== undefined && !started.ok) return Promise.reject(started.error);
      await overrides?.onFinalizedResult?.(exactResult, "ready");
      return exactResult;
    });
    const recoverFinalizedResult = vi.fn().mockResolvedValue(ok(exactResult));
    const deliverCompletion = vi.fn(acceptDelivery);
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult,
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn().mockResolvedValue(ok({ kind: "accepted" })),
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox,
        persistCleanupPendingOutbox: vi.fn().mockReturnValue(ok(undefined)),
        scheduleDispatchRetry,
        scheduleStateRetry: vi.fn(),
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
      },
      deliverCompletion,
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "ledger",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });

    eventBus.emit("background_task:completed", {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    });
    await flush();

    expect(execute).toHaveBeenCalledOnce();
    expect(recoverFinalizedResult).toHaveBeenCalledWith(expect.objectContaining({
      journalKey: task.continuationExecutionId,
    }));
    expect(persistContinuationOutbox).toHaveBeenCalledTimes(2);
    expect(deliverCompletion).toHaveBeenCalledWith(expect.objectContaining({
      response: exactResult.response,
      executionId: exactResult.executionId,
      idempotencyKey: "background-continuation:continuation-handoff-retry",
    }));
    expect(scheduleDispatchRetry).not.toHaveBeenCalled();
    expect(task.dispatchState).toBe("delivered");
    await runner.shutdown();
  });

  it("retains executing state when in-process journal recovery is transiently unavailable", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-journal-read-retry",
      continuationExecutionId: "continuation-journal-read-retry",
      dispatchAttempts: 0,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "ready",
      origin: makeOrigin(),
      dispatchState: "pending",
    };
    const scheduleDispatchRetry = vi.fn();
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      if (expected?.includes(task.dispatchState ?? "pending") !== true) return ok(false);
      task.dispatchState = next;
      return ok(true);
    });
    const execute = vi.fn(async (...args: unknown[]) => {
      const overrides = args[7] as {
        onProviderStart?: () => Result<void, Error>;
      } | undefined;
      const started = overrides?.onProviderStart?.();
      if (started !== undefined && !started.ok) return Promise.reject(started.error);
      return Promise.reject(new Error("handoff failed"));
    });
    const recordJournalRecoveryIncident = vi.fn().mockReturnValue(ok(undefined));
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(err(new Error("journal unavailable"))),
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn().mockResolvedValue(ok({ kind: "accepted" })),
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox: vi.fn(),
        persistCleanupPendingOutbox: vi.fn(),
        scheduleDispatchRetry,
        scheduleStateRetry: vi.fn(),
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident: recordJournalRecoveryIncident,
      },
      deliverCompletion: vi.fn(),
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "ledger",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });

    eventBus.emit("background_task:completed", {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    });
    await flush();

    expect(task.dispatchState).toBe("executing");
    expect(scheduleDispatchRetry).toHaveBeenCalledWith(task.id);
    expect(recordJournalRecoveryIncident).toHaveBeenCalledWith(task.id);
    expect(commitDispatchState).not.toHaveBeenCalledWith(
      task.id,
      "parked_uncertain",
      expect.anything(),
    );
    await runner.shutdown();
  });

  it("retries an unstarted execution claim only after journal absence is proven", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-unstarted-claim",
      continuationExecutionId: "continuation-unstarted-claim",
      dispatchAttempts: 0,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "ready",
      origin: makeOrigin(),
      dispatchState: "pending",
    };
    const scheduleDispatchRetry = vi.fn();
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      if (expected?.includes(task.dispatchState ?? "pending") !== true) return ok(false);
      task.dispatchState = next;
      return ok(true);
    });
    const recoverFinalizedResult = vi.fn().mockResolvedValue(ok(undefined));
    const execute = vi.fn().mockRejectedValue(new Error("identity preparation failed"));
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult,
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn().mockResolvedValue(ok({ kind: "accepted" })),
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox: vi.fn(),
        persistCleanupPendingOutbox: vi.fn(),
        scheduleDispatchRetry,
        scheduleStateRetry: vi.fn(),
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
      },
      deliverCompletion: vi.fn(),
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "ledger",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });

    eventBus.emit("background_task:completed", {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    });
    await flush();

    expect(recoverFinalizedResult).toHaveBeenCalledOnce();
    expect(task.dispatchState).toBe("pending");
    expect(scheduleDispatchRetry).toHaveBeenCalledWith(task.id);
    expect(execute).toHaveBeenCalledOnce();
    await runner.shutdown();
  });

  it("retains a non-deliverable outbox until session cleanup succeeds", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-cleanup-reject",
      continuationExecutionId: "continuation-cleanup-reject",
      dispatchAttempts: 0,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "ready",
      origin: makeOrigin(),
      dispatchState: "pending",
    };
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      if (expected?.includes(task.dispatchState ?? "pending") !== true) return ok(false);
      task.dispatchState = next;
      return ok(true);
    });
    const finalized = {
      response: "protected response",
      executionId: "execution-cleanup-reject",
    };
    const execute = vi.fn(async (...args: unknown[]) => {
      const overrides = args[7] as {
        onProviderStart?: () => Result<void, Error>;
        onFinalizedResult?: (
          value: typeof finalized,
          phase: "cleanup_pending" | "ready",
        ) => Promise<void>;
      } | undefined;
      const started = overrides?.onProviderStart?.();
      if (started !== undefined && !started.ok) return Promise.reject(started.error);
      await overrides?.onFinalizedResult?.(finalized, "cleanup_pending");
      return Promise.reject(new Error("session cleanup failed"));
    });
    const scheduleDispatchRetry = vi.fn();
    const cleanupFinalizedSession = vi.fn()
      .mockResolvedValueOnce(err(new Error("session cleanup unavailable")))
      .mockResolvedValueOnce(ok(undefined));
    const deliverCompletion = vi.fn(acceptDelivery);
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupFinalizedSession,
      reconcileDelivery: vi.fn().mockResolvedValue(ok({ kind: "accepted" })),
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox: (_taskId, outbox, expected) => {
          if (expected?.includes(task.dispatchState ?? "pending") !== true) {
            return err(new Error("outbox transition rejected"));
          }
          task.continuationOutbox = outbox;
          task.dispatchState = "ready_to_deliver";
          return ok(undefined);
        },
        persistCleanupPendingOutbox: vi.fn((_taskId, outbox, expected) => {
          if (expected?.includes(task.dispatchState ?? "pending") !== true) {
            return err(new Error("cleanup transition rejected"));
          }
          task.continuationOutbox = outbox;
          task.dispatchState = "cleanup_pending";
          return ok(undefined);
        }),
        scheduleDispatchRetry,
        scheduleStateRetry: vi.fn(),
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
      },
      deliverCompletion,
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "ledger",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });

    eventBus.emit("background_task:completed", {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    });
    await flush();

    expect(deliverCompletion).not.toHaveBeenCalled();
    expect(task.dispatchState).toBe("cleanup_pending");
    expect(scheduleDispatchRetry).toHaveBeenCalledWith(task.id);

    eventBus.emit("background_task:completed", {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await flush();

    expect(deliverCompletion).toHaveBeenCalledWith(expect.objectContaining({
      response: finalized.response,
      executionId: finalized.executionId,
    }));
    expect(task.dispatchState).toBe("delivered");
    expect(execute).toHaveBeenCalledOnce();
    await runner.shutdown();
  });

  it("retries a ready outbox when its durable delivery claim fails", async () => {
    const eventBus = new TypedEventBus();
    const task: BackgroundTask = {
      id: "task-delivery-claim",
      continuationExecutionId: "continuation-delivery-claim",
      dispatchAttempts: 1,
      toolName: "report",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "ready",
      origin: makeOrigin(),
      dispatchState: "ready_to_deliver",
      continuationOutbox: {
        kind: "continuation",
        response: "persisted exact response",
        executionId: "execution-recovered",
        idempotencyKey: "background-continuation:continuation-delivery-claim",
        deliveryProtection: "ledger",
      },
    };
    const scheduleDispatchRetry = vi.fn();
    const deliverCompletion = vi.fn();
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute: vi.fn() }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn().mockResolvedValue(ok({ kind: "accepted" })),
      taskManager: {
        getTask: () => task,
        commitDispatchState: vi.fn(() => err(new Error("protected storage unavailable"))),
        persistContinuationOutbox: vi.fn(),
        persistCleanupPendingOutbox: vi.fn(),
        persistFinalizedResult: vi.fn().mockReturnValue(ok(undefined)),
        recordRecoveryIncident: vi.fn().mockReturnValue(ok(undefined)),
        scheduleDispatchRetry,
        scheduleStateRetry: vi.fn(),
      },
      deliverCompletion,
      deliverFallback: vi.fn(acceptDelivery),
      deliveryProtection: "ledger",
      resolveMaxBackgroundHops: () => 3,
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      } as never,
    });

    eventBus.emit("background_task:completed", {
      agentId: "agent-a",
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 2,
    });
    await flush();

    expect(task.dispatchState).toBe("ready_to_deliver");
    expect(scheduleDispatchRetry).toHaveBeenCalledWith(task.id);
    expect(deliverCompletion).not.toHaveBeenCalled();
    await runner.shutdown();
  });
});
