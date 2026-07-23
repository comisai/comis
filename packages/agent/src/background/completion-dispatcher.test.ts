// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus, createConversationRef, type BackgroundTaskOrigin } from "@comis/core";
import { createCompletionDispatcher, STATES } from "./completion-dispatcher.js";
import type { BackgroundTask } from "./background-task-types.js";

function makeOrigin(): BackgroundTaskOrigin {
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "echo-main",
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
  const reference = createConversationRef(conversation);
  if (!reference.ok) throw reference.error;
  return {
    turnScope: {
      conversation,
      principal: { principalId: "user_a" },
      endpoint,
    },
    conversationRef: reference.value,
    deliveryOrigin: {
      tenantId: "default",
      userId: "user_a",
      channelType: "echo",
      channelId: "chat-a",
    },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
  };
}

function makeTask(): BackgroundTask {
  return {
    id: "task-a",
    toolName: "report",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    origin: makeOrigin(),
    dispatchState: "ready_to_deliver",
    continuationExecutionId: "task-a",
    dispatchAttempts: 1,
  };
}

describe("completion dispatcher observation boundary", () => {
  it("exports the closed durable dispatch lifecycle", () => {
    expect(STATES).toEqual([
      "pending",
      "execution_claimed",
      "executing",
      "cleanup_pending",
      "ready_to_deliver",
      "delivering",
      "delivered",
      "parked_permanent",
      "parked_uncertain",
      "consumed_live",
    ]);
  });

  it("observes a terminal task without mutating delivery ownership", async () => {
    const eventBus = new TypedEventBus();
    const task = makeTask();
    const dispatcher = createCompletionDispatcher({
      eventBus,
      taskManager: {
        getTask: () => task,
      },
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
      timestamp: 3,
    });
    await dispatcher.shutdown();

    expect(task.dispatchState).toBe("ready_to_deliver");
  });
});
