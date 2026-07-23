// SPDX-License-Identifier: Apache-2.0
import {
  TypedEventBus,
  createConversationRef,
  type BackgroundTaskOrigin,
  type EventMap,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createTaskSettledDelivery } from "./task-settled-delivery.js";

const NOW_MS = 1_800_000_000_000;

function origin(): BackgroundTaskOrigin {
  const endpoint = {
    channelType: "telegram",
    channelInstanceId: "bot-a",
    conversationId: "chat-a",
    threadId: "topic-a",
    conversationKind: "direct" as const,
  };
  const conversation = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint,
      principalId: "user-a",
    },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    turnScope: { conversation, principal: { principalId: "user-a" }, endpoint },
    conversationRef: conversationRef.value,
    deliveryOrigin: {
      tenantId: "tenant-a",
      channelType: "telegram",
      channelId: "chat-a",
      threadId: "topic-a",
      userId: "user-a",
    },
    traceId: "trace-a",
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
  };
}

function makeDeps() {
  const adapter = { channelId: "bot-a", channelType: "telegram", sendMessage: vi.fn() };
  const eventBus = new TypedEventBus();
  return {
    clock: createFakeClock(NOW_MS),
    adaptersByType: new Map([["telegram", adapter]]),
    deliveryService: {
      deliverToChannel: vi.fn(async () => ok({
        chunks: [],
        totalChars: 12,
        queueDisposition: "settled" as const,
        platform: {
          status: "accepted" as const,
          deliveredChunks: 1,
          settledAtMs: NOW_MS,
          lastMessageId: "message-a",
        },
      })),
      drainInFlight: vi.fn(),
    },
    outputGuard: {
      scan: vi.fn(() => ok({ safe: true, blocked: false, findings: [], sanitized: "safe check-in" })),
    },
    deliveredHistory: {
      append: vi.fn(async () => ok("appended" as const)),
    },
    eventBus,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    _adapter: adapter,
  };
}

function request(signal = new AbortController().signal) {
  return {
    attemptId: "attempt-a",
    agentExecutionId: "execution-a",
    rootRunId: "root-task-check-a",
    taskIds: ["task-a"],
    origin: origin(),
    text: "raw check-in",
    signal,
  };
}

describe("task settled delivery", () => {
  it("prepares exact origin authority before the send boundary and records accepted text in origin history", async () => {
    const deps = makeDeps();
    const delivery = createTaskSettledDelivery(deps);
    const prepared = delivery.prepare(request());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    await expect(delivery.deliver(prepared.value)).resolves.toEqual({
      status: "accepted",
      deliveredChunks: 1,
      settledAtMs: NOW_MS,
      lastMessageId: "message-a",
      history: { status: "appended" },
    });

    expect(deps.outputGuard.scan).toHaveBeenCalledWith("raw check-in");
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      deps._adapter,
      "chat-a",
      "safe check-in",
      expect.objectContaining({
        completionMode: "settled",
        authority: {
          tenantId: "tenant-a",
          agentId: "agent-a",
          conversationRef: origin().conversationRef,
        },
        destinationEndpoint: origin().turnScope.endpoint,
        threadId: "topic-a",
        origin: "task-check",
      }),
    );
    expect(deps.deliveredHistory.append).toHaveBeenCalledWith({
      conversation: {
        conversationScope: origin().turnScope.conversation,
        conversationRef: origin().conversationRef,
      },
      deliveredText: "safe check-in",
      sourceExecutionId: "execution-a",
      attemptId: "attempt-a",
      lastPlatformMessageId: "message-a",
      deliveredAtMs: NOW_MS,
    });
  });

  it("rejects cancellation, unsafe output, invalid origin, and channel-instance drift before send", () => {
    const cases = [
      {
        mutate: (deps: ReturnType<typeof makeDeps>, value: ReturnType<typeof request>, controller: AbortController) => controller.abort(),
        expected: { code: "cancelled", errorKind: "precondition" },
      },
      {
        mutate: (deps: ReturnType<typeof makeDeps>) => deps.outputGuard.scan.mockReturnValue(
          ok({ safe: false, blocked: true, findings: [], sanitized: "" }),
        ),
        expected: { code: "output_guard", errorKind: "auth" },
      },
      {
        mutate: (_deps: ReturnType<typeof makeDeps>, value: ReturnType<typeof request>) => {
          value.origin = { ...value.origin, conversationRef: "invalid" as never };
        },
        expected: { code: "invalid_origin", errorKind: "validation" },
      },
      {
        mutate: (deps: ReturnType<typeof makeDeps>) => {
          deps._adapter.channelId = "bot-b";
        },
        expected: { code: "target_precondition", errorKind: "precondition" },
      },
    ] as const;

    for (const testCase of cases) {
      const deps = makeDeps();
      const controller = new AbortController();
      const value = request(controller.signal);
      testCase.mutate(deps, value, controller);
      const delivery = createTaskSettledDelivery(deps);
      expect(delivery.prepare(value)).toEqual({ ok: false, error: testCase.expected });
      expect(deps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
    }
  });

  it("does not append intended text when platform truth is partial", async () => {
    const deps = makeDeps();
    deps.deliveryService.deliverToChannel.mockResolvedValue(ok({
      chunks: [],
      totalChars: 12,
      queueDisposition: "settled" as const,
      platform: {
        status: "partial" as const,
        errorKind: "dependency" as const,
        deliveredChunks: 1,
        failedChunks: 1,
        settledAtMs: NOW_MS,
        lastMessageId: "message-a",
      },
    }));
    const delivery = createTaskSettledDelivery(deps);
    const prepared = delivery.prepare(request());
    if (!prepared.ok) throw new Error("expected prepared delivery");

    await expect(delivery.deliver(prepared.value)).resolves.toEqual({
      status: "partial",
      errorKind: "dependency",
      deliveredChunks: 1,
      failedChunks: 1,
      settledAtMs: NOW_MS,
      lastMessageId: "message-a",
    });
    expect(deps.deliveredHistory.append).not.toHaveBeenCalled();
  });

  it("keeps accepted platform truth when history append fails and emits content-free health", async () => {
    const deps = makeDeps();
    const handler = vi.fn<(event: EventMap["scheduler:task_delivery_history_failed"]) => void>();
    deps.eventBus.on("scheduler:task_delivery_history_failed", handler);
    deps.deliveredHistory.append.mockResolvedValue(err({ code: "append_failed", errorKind: "resource" as const }));
    const delivery = createTaskSettledDelivery(deps);
    const prepared = delivery.prepare(request());
    if (!prepared.ok) throw new Error("expected prepared delivery");

    await expect(delivery.deliver(prepared.value)).resolves.toEqual(expect.objectContaining({
      status: "accepted",
      history: { status: "failed", errorKind: "resource" },
    }));
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: "attempt-a",
      agentId: "agent-a",
      errorKind: "resource",
      hint: expect.any(String),
    }), "Task delivery history append failed");
    expect(handler).toHaveBeenCalledWith({
      attemptId: "attempt-a",
      agentId: "agent-a",
      rootRunId: "root-task-check-a",
      taskIds: ["task-a"],
      errorKind: "resource",
      durationMs: 0,
      timestamp: NOW_MS,
    });
  });
});
