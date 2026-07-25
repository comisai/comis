// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import { createConversationRef } from "../domain/conversation-scope.js";
import type { DeliveryQueuePort } from "../ports/delivery-queue.js";
import { createNoOpDeliveryQueue } from "./no-op-delivery-queue.js";
import { DeliveryQueueTransitionError } from "./types.js";
import { createDeliveryService, type DeliveryServiceDeps } from "./delivery-service.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import type { ComisLogger } from "../logging/log-fields.js";

const conversationScope = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: { kind: "channel-principal" as const, channelType: "telegram", principalId: "user_a" },
};
const conversationRef = createConversationRef(conversationScope);
if (!conversationRef.ok) throw conversationRef.error;

function options(completionMode: "settled" | "deferred_retry") {
  return {
    completionMode,
    authority: { tenantId: "tenant_a", agentId: "agent_a", conversationRef: conversationRef.value },
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "default",
      conversationId: "chat_a",
      conversationKind: "direct" as const,
    },
  };
}

function queue(overrides: Partial<DeliveryQueuePort> = {}): DeliveryQueuePort {
  return { ...createNoOpDeliveryQueue(), ...overrides };
}

function service(overrides: Partial<DeliveryServiceDeps> = {}) {
  const hookRunner = {
    runBeforeDelivery: async () => ({}),
    runAfterDelivery: async () => undefined,
  } as unknown as HookRunner;
  const logger = {
    warn: vi.fn(),
  } as unknown as ComisLogger;
  return createDeliveryService({
    hookRunner,
    deliveryQueue: createNoOpDeliveryQueue(),
    logger,
    clock: { now: () => 42_000, nowDate: () => new Date(42_000) },
    ...overrides,
  });
}

describe("delivery service immutable platform outcome", () => {
  it("returns a strict accepted aggregate using the injected settlement clock", async () => {
    const deliveryService = service();
    const result = await deliveryService.deliverToChannel({
      channelId: "default",
      channelType: "telegram",
      sendMessage: async () => ok("message_a"),
    }, "chat_a", "hello", options("settled"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        platform: { status: "accepted", deliveredChunks: 1, settledAtMs: 42_000, lastMessageId: "message_a" },
        queueDisposition: "settled",
        chunks: [{ status: "accepted", messageId: "message_a" }],
      },
    });
    expect(result.ok && "ok" in result.value).toBe(false);
  });

  it("classifies ambiguous adapter failure as unknown in original chunk order", async () => {
    const deliveryService = service({ clock: { now: () => 43_000, nowDate: () => new Date(43_000) } });
    const result = await deliveryService.deliverToChannel({
      channelId: "default",
      channelType: "telegram",
      sendMessage: async () => err(new Error("503 Service Unavailable")),
    }, "chat_a", "hello", options("settled"));

    expect(result).toMatchObject({
      ok: true,
      value: {
        platform: {
          status: "unknown",
          errorKind: "platform",
          deliveredChunks: 0,
          failedChunks: 1,
          ambiguousChunks: 1,
          settledAtMs: 43_000,
        },
        queueDisposition: "settled",
        chunks: [{ status: "unknown", errorKind: "platform" }],
      },
    });
  });

  it("settles caller-owned failure while deferred retry exposes queue ownership", async () => {
    const fail = vi.fn(async () => ok(undefined));
    const nack = vi.fn(async () => ok(undefined));
    const deliveryQueue = queue({ fail, nack });
    const deliveryService = service({
      deliveryQueue,
      clock: { now: () => 44_000, nowDate: () => new Date(44_000) },
    });
    const adapter = {
      channelId: "default",
      channelType: "telegram",
      sendMessage: async () => err(new Error("429 Too Many Requests")),
    };

    const settled = await deliveryService.deliverToChannel(adapter, "chat_a", "settled", options("settled"));
    const deferred = await deliveryService.deliverToChannel(adapter, "chat_a", "deferred", options("deferred_retry"));

    expect(settled).toMatchObject({ ok: true, value: { queueDisposition: "settled" } });
    expect(deferred).toMatchObject({ ok: true, value: { queueDisposition: "retry_pending" } });
    expect(fail).toHaveBeenCalledTimes(1);
    expect(nack).toHaveBeenCalledTimes(1);
  });

  it("retains accepted platform truth when durable acknowledgement fails", async () => {
    const deliveryQueue = queue({ ack: async () => err(new Error("ack disk failure")) });
    const deliveryService = service({
      deliveryQueue,
      clock: { now: () => 45_000, nowDate: () => new Date(45_000) },
    });
    const result = await deliveryService.deliverToChannel({
      channelId: "default",
      channelType: "telegram",
      sendMessage: async () => ok("message_a"),
    }, "chat_a", "hello", options("settled"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(DeliveryQueueTransitionError);
    const transition = result.error as DeliveryQueueTransitionError;
    expect(transition.platformResult).toMatchObject({
      platform: { status: "accepted", deliveredChunks: 1, lastMessageId: "message_a" },
      queueDisposition: "transition_failed",
    });
  });
});
