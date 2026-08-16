// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createConversationLocator } from "@comis/core";
import {
  createAnnouncementReservationPlan,
  type AnnouncementBatchOperation,
} from "./announcement-batcher-reservations.js";
import type { QueuedAnnouncement } from "./announcement-batcher-types.js";

function makeItem(overrides: Partial<QueuedAnnouncement> = {}): QueuedAnnouncement {
  const callerConversation = createConversationLocator({
    tenantId: "default",
    agentId: "parent-agent",
    partition: { kind: "agent" },
  });
  if (!callerConversation.ok) throw callerConversation.error;
  return {
    announcementText: "completed",
    announceChannelType: "telegram",
    announceChannelId: "chat-1",
    callerAgentId: "parent-agent",
    callerSessionKey: "default:parent-agent:telegram:chat-1:user_a",
    callerConversation: callerConversation.value,
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "test-instance",
      conversationId: "chat-1",
      conversationKind: "direct",
    },
    terminalOutcome: { status: "completed" },
    runId: "run-1",
    idempotencyKey: "completion-1",
    reservationRootRunId: "root-1",
    ...overrides,
  };
}

describe("announcement batch operation reservations", () => {
  it("maps actual operations to their durable completion owners", () => {
    const first = makeItem();
    const second = makeItem({
      runId: "run-2",
      idempotencyKey: "completion-2",
      reservationRootRunId: "root-2",
    });
    const summary: AnnouncementBatchOperation = {
      item: first, text: "summary", partId: "summary", completionItems: [first, second],
    };
    const attachment: AnnouncementBatchOperation = {
      item: second,
      text: "",
      partId: "attachment:0",
      attachment: { sourceAgentId: "worker-a", path: "report.txt" },
      completionItems: [first, second],
    };

    const plan = createAnnouncementReservationPlan([summary, attachment]);

    expect(plan).toMatchObject({
      ok: true,
      value: { expectedKeys: ["completion-1", "completion-2"] },
    });
    expect(summary.reservationKey).toMatch(/^completion-announcement:/u);
    expect(attachment.reservationKey).toMatch(/^completion-announcement:/u);
    if (!plan.ok) throw plan.error;
    expect(plan.value.reservations).toMatchObject([
      {
        partId: "summary",
        completionKeys: [summary.reservationKey, "completion-1", "completion-2"],
      },
      {
        partId: "attachment:0",
        completionKeys: [attachment.reservationKey, "completion-1", "completion-2"],
        attachment: { kind: "source", sourceAgentId: "worker-a", path: "report.txt" },
      },
    ]);
  });

  it("rejects an operation whose owner cannot be adjudicated", () => {
    const item = makeItem({ idempotencyKey: undefined });

    expect(createAnnouncementReservationPlan([
      { item, text: "completion", completionItems: [item] },
    ])).toMatchObject({ ok: false });
  });
});
