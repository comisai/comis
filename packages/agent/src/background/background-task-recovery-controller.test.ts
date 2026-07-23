// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  type BackgroundTaskOrigin,
  type TimerHandle,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import { createBackgroundTaskRecoveryController } from "./background-task-recovery-controller.js";

function makeOrigin(): BackgroundTaskOrigin {
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "conversation-a",
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
      channelType: "echo",
      channelId: "conversation-a",
    },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
  };
}

describe("background task recovery controller", () => {
  it("surfaces and retries a failed canonical incident write", () => {
    const eventBus = new TypedEventBus();
    const notified = vi.fn();
    eventBus.on("background_task:notified", notified);
    let retry: (() => void) | undefined;
    const handle: TimerHandle = {
      cancelled: false,
      cancel: vi.fn(),
      unref: vi.fn(),
    };
    const recorder = vi.fn()
      .mockReturnValueOnce(err(new Error("trajectory unavailable")))
      .mockReturnValue(ok(undefined));
    const controller = createBackgroundTaskRecoveryController({
      eventBus,
      logger: { warn: vi.fn() },
      clock: { now: () => 10, nowDate: () => new Date(10) },
      timers: {
        setTimeout: (callback) => {
          retry = callback;
          return handle;
        },
        setInterval: vi.fn(),
      },
    });
    controller.setRecorder(recorder);

    controller.recordTask({
      id: "task-a",
      toolName: "report",
      origin: makeOrigin(),
    });

    expect(notified).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-a",
      reason: "recovery_retry_required",
    }));
    retry?.();
    expect(recorder).toHaveBeenCalledTimes(2);
    expect(notified).toHaveBeenCalledTimes(2);
  });
});
