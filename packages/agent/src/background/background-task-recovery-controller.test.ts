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

  it("backs off repeated scan failures and records task resolution", () => {
    const eventBus = new TypedEventBus();
    const systemErrors = vi.fn();
    const notified = vi.fn();
    eventBus.on("system:error", systemErrors);
    eventBus.on("background_task:notified", notified);
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    let now = 0;
    const logger = { warn: vi.fn() };
    const recorder = vi.fn(() => ok(undefined));
    const controller = createBackgroundTaskRecoveryController({
      eventBus,
      logger,
      clock: { now: () => now, nowDate: () => new Date(now) },
      timers: {
        setTimeout: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return {
            cancelled: false,
            cancel: vi.fn(),
            unref: vi.fn(),
          };
        },
        setInterval: vi.fn(),
      },
    });
    controller.setRecorder(recorder);
    const identity = {
      id: "task-scan",
      toolName: "report",
      origin: makeOrigin(),
    };
    const retry = vi.fn();

    controller.reportScanFailures(
      [{ kind: "task_validation", identity }],
      retry,
    );
    expect(scheduled[0]?.delayMs).toBe(1_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(systemErrors).toHaveBeenCalledTimes(1);

    scheduled[0]?.callback();
    now = 1_000;
    controller.reportScanFailures(
      [{ kind: "task_validation", identity }],
      retry,
    );
    expect(scheduled[1]?.delayMs).toBe(2_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(systemErrors).toHaveBeenCalledTimes(1);

    scheduled[1]?.callback();
    now = 3_000;
    controller.reportScanFailures([], retry);

    expect(recorder).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: "task-scan",
      reason: "recovery_resolved",
    }));
    expect(notified).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: "task-scan",
      reason: "recovery_resolved",
      trajectoryRecorded: true,
    }));
  });
});
