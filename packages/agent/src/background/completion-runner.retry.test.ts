// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  type BackgroundTaskOrigin,
} from "@comis/core";
import { ok } from "@comis/shared";
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
    const transitionDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) return false;
      task.dispatchState = next;
      if (next === "executing") task.dispatchAttempts++;
      return true;
    });
    const deliverCompletion = vi.fn()
      .mockResolvedValueOnce({
        kind: "retryable_pre_send",
        errorKind: "dependency",
        message: "offline",
      })
      .mockResolvedValueOnce({ kind: "accepted" });
    const execute = vi.fn().mockResolvedValue({
      response: "continued",
      executionId: "executor-result-a",
    });
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({
        execute,
      }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      taskManager: {
        getTask: () => task,
        transitionDispatchState,
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

  it("delivers a recovered protected outbox without re-running the executor", async () => {
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
      dispatchState: "ready_to_deliver",
      continuationOutbox: {
        kind: "continuation",
        response: "persisted exact response",
        executionId: "execution-recovered",
        idempotencyKey: "background-continuation:continuation-recovered",
        deliveryProtection: "ledger",
      },
    };
    const execute = vi.fn();
    const deliverCompletion = vi.fn().mockResolvedValue({ kind: "accepted" });
    const transitionDispatchState = vi.fn((
      _taskId: string,
      next: BackgroundSessionState,
      expected?: readonly BackgroundSessionState[],
    ) => {
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) return false;
      task.dispatchState = next;
      return true;
    });
    const runner = createBackgroundCompletionRunner({
      eventBus,
      getExecutor: () => ({ execute }) as never,
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      taskManager: {
        getTask: () => task,
        transitionDispatchState,
        persistContinuationOutbox: vi.fn(),
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
});
