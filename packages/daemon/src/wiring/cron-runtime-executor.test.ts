// SPDX-License-Identifier: Apache-2.0
import { createConversationRef } from "@comis/core";
import { err, ok } from "@comis/shared";
import type {
  CronRuntimeExecutionInput,
  CronRuntimeOutcome,
} from "@comis/scheduler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createDaemonCronRuntimeExecutor } from "./cron-runtime-executor.js";

const NOW_MS = 1_800_000_000_000;

function target() {
  const destinationEndpoint = {
    channelType: "telegram",
    channelInstanceId: "bot-a",
    conversationId: "chat-a",
    threadId: "thread-a",
    conversationKind: "direct" as const,
  };
  const conversationScope = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "endpoint-conversation" as const, endpoint: destinationEndpoint },
  };
  const conversationRef = createConversationRef(conversationScope);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    conversation: { conversationScope, conversationRef: conversationRef.value },
    destinationEndpoint,
  };
}

function baseJob() {
  return {
    id: "job-a",
    name: "Status",
    agentId: "agent-a",
    source: "authored" as const,
    schedule: { kind: "every" as const, everyMs: 60_000, anchorMs: NOW_MS },
    lifecycle: {
      status: "scheduled" as const,
      nextRunAtMs: NOW_MS + 60_000,
      consecutiveDependencyErrors: 0,
    },
  };
}

function heartbeatInput(): CronRuntimeExecutionInput {
  return {
    executionId: "execution-a",
    scheduledForMs: NOW_MS,
    trigger: "scheduled",
    kind: "heartbeat_event",
    job: {
      ...baseJob(),
      payload: { kind: "heartbeat_event", text: "Inspect tasks", wakeMode: "now" },
    },
  };
}

function deliveryInput(): CronRuntimeExecutionInput {
  return {
    executionId: "execution-a",
    scheduledForMs: NOW_MS,
    trigger: "scheduled",
    kind: "delivery_only",
    job: {
      ...baseJob(),
      payload: { kind: "delivery", text: "Maintenance complete" },
      deliveryTarget: target(),
    },
  };
}

function deps() {
  const adapter = {
    channelId: "bot-a",
    channelType: "telegram",
    sendMessage: vi.fn(async () => ok("message-a")),
  };
  const deliveryService = {
    deliverToChannel: vi.fn(async () => ok({
      chunks: [{ status: "accepted" as const, messageId: "message-a", charCount: 20, retried: false }],
      totalChars: 20,
      platform: {
        status: "accepted" as const,
        deliveredChunks: 1,
        settledAtMs: NOW_MS,
        lastMessageId: "message-a",
      },
      queueDisposition: "settled" as const,
    })),
    drainInFlight: vi.fn(),
  };
  return {
    clock: createFakeClock(NOW_MS),
    adaptersByType: new Map([["telegram", adapter]]),
    deliveryService,
    outputGuard: {
      scan: vi.fn(() => ok({ safe: true, blocked: false, findings: [], sanitized: "Maintenance complete" })),
      registerSecret: vi.fn(),
    },
    isQuietHours: vi.fn(() => ok(false)),
    dispatchHeartbeatEvent: vi.fn(async () => ok({
      correlationId: "heartbeat-execution-a",
      queueDisposition: "accepted" as const,
    })),
    executeAgentTurn: vi.fn(async () => err({
      code: "precondition_failed" as const,
      errorKind: "precondition" as const,
      message: "not used",
    })),
    executeInternalAction: vi.fn(async () => err({
      code: "precondition_failed" as const,
      errorKind: "precondition" as const,
      message: "not used",
    })),
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), audit: vi.fn(),
    } as never,
    _adapter: adapter,
  };
}

describe("daemon cron runtime executor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correlated heartbeat admission without emitting a command event", async () => {
    const runtimeDeps = deps();
    const executor = createDaemonCronRuntimeExecutor(runtimeDeps);

    const result = await executor.execute(heartbeatInput(), new AbortController().signal);

    expect(result).toEqual(ok({
      kind: "heartbeat_event",
      status: "dispatched",
      correlationId: "heartbeat-execution-a",
      queueDisposition: "accepted",
    }));
    expect(runtimeDeps.dispatchHeartbeatEvent).toHaveBeenCalledWith(
      heartbeatInput(),
      expect.any(AbortSignal),
    );
  });

  it("delivers guarded text through the exact adapter instance with settled ownership", async () => {
    const runtimeDeps = deps();
    const executor = createDaemonCronRuntimeExecutor(runtimeDeps);

    const result = await executor.execute(deliveryInput(), new AbortController().signal);

    expect(result).toEqual(ok({
      kind: "delivery_only",
      delivery: {
        status: "accepted",
        deliveredChunks: 1,
        settledAtMs: NOW_MS,
        lastMessageId: "message-a",
      },
    }));
    expect(runtimeDeps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      runtimeDeps._adapter,
      "chat-a",
      "Maintenance complete",
      expect.objectContaining({
        completionMode: "settled",
        destinationEndpoint: target().destinationEndpoint,
        threadId: "thread-a",
        authority: {
          tenantId: "tenant-a",
          agentId: "agent-a",
          conversationRef: target().conversation.conversationRef,
        },
      }),
    );
  });

  it("fails before platform send when the registered adapter instance differs", async () => {
    const runtimeDeps = deps();
    runtimeDeps._adapter.channelId = "bot-b";
    const executor = createDaemonCronRuntimeExecutor(runtimeDeps);

    const result = await executor.execute(deliveryInput(), new AbortController().signal);

    expect(result).toEqual(ok({
      kind: "delivery_only",
      delivery: { status: "pre_send_failed", reason: "target_precondition", errorKind: "precondition" },
    }));
    expect(runtimeDeps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("records cancellation before a direct platform call", async () => {
    const runtimeDeps = deps();
    const executor = createDaemonCronRuntimeExecutor(runtimeDeps);
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(deliveryInput(), controller.signal);

    expect(result).toEqual(ok({
      kind: "delivery_only",
      delivery: { status: "pre_send_failed", reason: "cancelled", errorKind: "precondition" },
    }));
    expect(runtimeDeps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("delegates governed variants and retains their strict terminal evidence", async () => {
    const runtimeDeps = deps();
    const expected: CronRuntimeOutcome = {
      kind: "internal_action",
      action: "memory_lifecycle",
      rootRunId: "root-cron-execution-a",
      modelResolved: null,
      modelResolutionSource: null,
      metrics: { totalTokens: null, costUsd: null, llmCalls: 0 },
      execution: { status: "completed", counters: [] },
    };
    runtimeDeps.executeInternalAction.mockResolvedValue(ok(expected));
    const executor = createDaemonCronRuntimeExecutor(runtimeDeps);
    const input: CronRuntimeExecutionInput = {
      executionId: "execution-a",
      scheduledForMs: NOW_MS,
      trigger: "scheduled",
      kind: "internal_action",
      rootRunId: "root-cron-execution-a",
      job: {
        ...baseJob(),
        source: "built_in",
        payload: { kind: "internal_action", action: "memory_lifecycle" },
      },
    };

    expect(await executor.execute(input, new AbortController().signal)).toEqual(ok(expected));
    expect(runtimeDeps.executeInternalAction).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  });
});
