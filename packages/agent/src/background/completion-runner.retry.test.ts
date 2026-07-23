// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  type BackgroundTaskOrigin,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { createBackgroundCompletionRunner } from "./completion-runner.js";
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

describe("background completion retry lifecycle", () => {
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
    const commitDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) return ok(false);
      task.dispatchState = next;
      if (next === "executing") task.dispatchAttempts++;
      return ok(true);
    });
    const deliverCompletion = vi.fn()
      .mockResolvedValueOnce({
        kind: "retryable_pre_send",
        errorKind: "dependency",
        message: "offline",
      })
      .mockResolvedValueOnce({ kind: "accepted" });
    const execute = vi.fn(async (...args: unknown[]) => {
      const result = {
        response: "continued",
        executionId: "executor-result-a",
      };
      const overrides = args[7] as {
        onProviderStart?: () => Result<void, Error>;
        onFinalizedResult?: (value: typeof result) => Promise<void>;
      } | undefined;
      const started = overrides?.onProviderStart?.();
      if (started !== undefined && !started.ok) return Promise.reject(started.error);
      await overrides?.onFinalizedResult?.(result);
      return result;
    });
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({
        execute,
      }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(undefined)),
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
        scheduleDispatchRetry,
      },
      deliverCompletion,
      deliverFallback: vi.fn(async () => ({ kind: "accepted" })),
      deliveryProtection: "ledger",
      maxBackgroundHops: 3,
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
    expect(task.dispatchState).toBe("ready_to_deliver");
    expect(scheduleDispatchRetry).toHaveBeenCalledWith(task.id);
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

  it("rebuilds a finalized journal result without re-running the executor", async () => {
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
      dispatchState: "executing",
    };
    const execute = vi.fn();
    const deliverCompletion = vi.fn().mockResolvedValue({ kind: "accepted" });
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
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok({
        response: "persisted exact response",
        executionId: "execution-recovered",
      })),
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
        scheduleDispatchRetry: vi.fn(),
      },
      deliverCompletion,
      deliverFallback: vi.fn(async () => ({ kind: "accepted" })),
      deliveryProtection: "ledger",
      maxBackgroundHops: 3,
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
    expect(deliverCompletion).toHaveBeenCalledWith({
      taskId: task.id,
      origin: task.origin,
      response: "persisted exact response",
      executionId: "execution-recovered",
      idempotencyKey: "background-continuation:continuation-recovered",
    });
    expect(task.dispatchState).toBe("delivered");
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
        onFinalizedResult?: (value: typeof exactResult) => Promise<void>;
      } | undefined;
      const started = overrides?.onProviderStart?.();
      if (started !== undefined && !started.ok) return Promise.reject(started.error);
      await overrides?.onFinalizedResult?.(exactResult);
      return exactResult;
    });
    const recoverFinalizedResult = vi.fn().mockResolvedValue(ok(exactResult));
    const deliverCompletion = vi.fn().mockResolvedValue({ kind: "accepted" });
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult,
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox,
        scheduleDispatchRetry,
      },
      deliverCompletion,
      deliverFallback: vi.fn(async () => ({ kind: "accepted" })),
      deliveryProtection: "ledger",
      maxBackgroundHops: 3,
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
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(err(new Error("journal unavailable"))),
      taskManager: {
        getTask: () => task,
        commitDispatchState,
        persistContinuationOutbox: vi.fn(),
        scheduleDispatchRetry,
      },
      deliverCompletion: vi.fn(),
      deliverFallback: vi.fn(async () => ({ kind: "accepted" })),
      deliveryProtection: "ledger",
      maxBackgroundHops: 3,
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
    expect(commitDispatchState).not.toHaveBeenCalledWith(
      task.id,
      "parked_uncertain",
      expect.anything(),
    );
    await runner.shutdown();
  });

  it("delivers a protected outbox when post-handoff session cleanup rejects", async () => {
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
        onFinalizedResult?: (value: typeof finalized) => Promise<void>;
      } | undefined;
      const started = overrides?.onProviderStart?.();
      if (started !== undefined && !started.ok) return Promise.reject(started.error);
      await overrides?.onFinalizedResult?.(finalized);
      return Promise.reject(new Error("session cleanup failed"));
    });
    const deliverCompletion = vi.fn().mockResolvedValue({ kind: "accepted" });
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(undefined)),
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
        scheduleDispatchRetry: vi.fn(),
      },
      deliverCompletion,
      deliverFallback: vi.fn(async () => ({ kind: "accepted" })),
      deliveryProtection: "ledger",
      maxBackgroundHops: 3,
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

    expect(deliverCompletion).toHaveBeenCalledWith(expect.objectContaining({
      response: finalized.response,
      executionId: finalized.executionId,
    }));
    expect(task.dispatchState).toBe("delivered");
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
      taskManager: {
        getTask: () => task,
        commitDispatchState: vi.fn(() => err(new Error("protected storage unavailable"))),
        persistContinuationOutbox: vi.fn(),
        scheduleDispatchRetry,
      },
      deliverCompletion,
      deliverFallback: vi.fn(async () => ({ kind: "accepted" })),
      deliveryProtection: "ledger",
      maxBackgroundHops: 3,
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
