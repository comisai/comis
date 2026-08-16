// SPDX-License-Identifier: Apache-2.0

import {
  createConversationLocator,
  type AnnouncementParentDecisionReservation,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createRecoverableAnnouncementDelivery } from "./recoverable-announcement-delivery.js";

function makeRequest() {
  const conversation = createConversationLocator({
    tenantId: "default",
    agentId: "agent-1",
    partition: { kind: "agent" },
  });
  if (!conversation.ok) throw conversation.error;
  return {
    agentId: "agent-1",
    callerSessionKey: "default:user_a:telegram:chat-1",
    callerConversation: conversation.value,
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "telegram-primary",
      conversationId: "chat-1",
      conversationKind: "direct" as const,
    },
    runId: "run-1",
    channelType: "telegram",
    channelId: "chat-1",
    text: "completion",
    completionKeys: ["default:user_a:telegram:chat-1::run-1"],
  };
}

describe("recoverable completion announcement delivery", () => {
  it("persists the operation before sending and retains a failed attempt", async () => {
    const order: string[] = [];
    let retained: AnnouncementParentDecisionReservation | undefined;
    const deadLetterQueue = {
      lookupDecision: vi.fn(async () => {
        order.push("lookup");
        return ok(undefined);
      }),
      reserveDecision: vi.fn(async (reservation: AnnouncementParentDecisionReservation) => {
        order.push("reserve");
        retained = reservation;
        return ok({ created: true });
      }),
      resolveDecision: vi.fn(async () => ok(true)),
    };
    const send = vi.fn(async () => {
      order.push("send");
      return ok({
        delivered: false as const,
        identity: { agentId: "agent-1", rootRunId: "root-1", stepIndex: 3 },
        failure: "transport_uncertain" as const,
      });
    });
    const delivery = createRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", { channelId: "telegram-primary", channelType: "telegram" }],
      ]),
      deadLetterQueue,
      resolveRootRunId: vi.fn(() => ok("root-1")),
      send,
    });

    const result = await delivery({
      ...makeRequest(),
      options: {
        threadId: "topic-1",
        extra: { reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "open:1" }]] } },
      },
      destinationEndpoint: {
        ...makeRequest().destinationEndpoint,
        threadId: "topic-1",
      },
    });

    expect(result).toMatchObject({ ok: true, value: { delivered: false } });
    expect(order).toEqual(["lookup", "reserve", "send"]);
    expect(retained).toMatchObject({
      rootRunId: "root-1",
      completionKeys: ["default:user_a:telegram:chat-1::run-1"],
      threadId: "topic-1",
      extra: { reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "open:1" }]] } },
    });
    expect(deadLetterQueue.resolveDecision).not.toHaveBeenCalled();
  });

  it("blocks transport when durable admission has no capacity", async () => {
    const send = vi.fn();
    const delivery = createRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", { channelId: "telegram-primary", channelType: "telegram" }],
      ]),
      deadLetterQueue: {
        lookupDecision: vi.fn(async () => ok(undefined)),
        reserveDecision: vi.fn(async () => err(new Error("capacity exhausted"))),
        resolveDecision: vi.fn(async () => ok(true)),
      },
      resolveRootRunId: vi.fn(() => ok("root-1")),
      send,
    });

    const result = await delivery(makeRequest());

    expect(result).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns terminal settlement evidence when durable admission is already decided", async () => {
    const send = vi.fn(async () => ok({
      delivered: false as const,
      terminalDecision: "discarded" as const,
    }));
    const deadLetterQueue = {
      lookupDecision: vi.fn(async () => ok(undefined)),
      reserveDecision: vi.fn(async () => ok({ created: false })),
      resolveDecision: vi.fn(async () => ok(false)),
    };
    const delivery = createRecoverableAnnouncementDelivery({
      adaptersByType: new Map([
        ["telegram", { channelId: "telegram-primary", channelType: "telegram" }],
      ]),
      deadLetterQueue,
      resolveRootRunId: vi.fn(() => ok("root-1")),
      send,
    });

    const result = await delivery(makeRequest());

    expect(result).toEqual(ok({ delivered: false, terminalDecision: "discarded" }));
    expect(send).toHaveBeenCalledOnce();
    expect(deadLetterQueue.resolveDecision).not.toHaveBeenCalled();
  });
});
