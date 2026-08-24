// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type { QueuedAnnouncement } from "./announcement-batcher.js";
import { sendOnce, type SendOnceDeps } from "./announcement-send-once.js";

const item = {
  announcementText: "completion",
  announceChannelType: "telegram",
  announceChannelId: "chat-a",
  callerAgentId: "agent-a",
  callerSessionKey: "default:agent-a:telegram:chat-a:user_a",
  callerConversation: { tenantId: "default", agentId: "agent-a", conversationRef: "conversation-a" },
  destinationEndpoint: {
    channelType: "telegram",
    channelInstanceId: "test-instance",
    conversationId: "chat-a",
    conversationKind: "direct",
  },
  terminalOutcome: { status: "completed" },
  runId: "run-a",
  reservationRootRunId: "root-a",
} as QueuedAnnouncement;

function deps(overrides: Partial<SendOnceDeps> = {}): SendOnceDeps {
  return {
    sendToChannel: vi.fn(async () => true),
    ...overrides,
  };
}

describe("single announcement send boundaries", () => {
  it("propagates governed boundary, delivery, terminal, and failure outcomes", async () => {
    const controller = new AbortController();
    await expect(sendOnce(deps({
      sendGovernedAnnouncement: async () => err(new Error("boundary unavailable")),
    }), controller, item, "completion", ["operation-a"]))
      .resolves.toMatchObject({ delivered: false, lastError: "governed announcement boundary failed" });
    await expect(sendOnce(deps({
      sendGovernedAnnouncement: async () => ok({
        delivered: true,
        identity: { agentId: "agent-a", rootRunId: "root-a", stepIndex: 1 },
      }),
    }), controller, item, "completion", ["operation-a"]))
      .resolves.toMatchObject({ delivered: true });
    await expect(sendOnce(deps({
      sendGovernedAnnouncement: async () => ok({ delivered: false, terminalDecision: "discarded" }),
    }), controller, item, "completion", ["operation-a"]))
      .resolves.toEqual({ delivered: true, terminalDecision: true });
    await expect(sendOnce(deps({
      sendGovernedAnnouncement: async () => ok({ delivered: false, failure: "lookup_blocked" }),
    }), controller, item, "completion", ["operation-a"]))
      .resolves.toMatchObject({ delivered: false, failure: "lookup_blocked" });
  });

  it("rejects attachment downgrade on a recoverable-only sender", async () => {
    await expect(sendOnce(deps({
      sendRecoverableAnnouncement: vi.fn(),
    }), new AbortController(), item, "completion", ["operation-a"], {
      sourceAgentId: "agent-a",
      path: "artifact.bin",
    })).resolves.toMatchObject({
      delivered: false,
      failure: "operation_validation_blocked",
      platformStatus: "rejected",
    });
  });

  it("propagates recoverable boundary, terminal, and rejected outcomes", async () => {
    const controller = new AbortController();
    await expect(sendOnce(deps({
      sendRecoverableAnnouncement: async () => err(new Error("boundary unavailable")),
    }), controller, item, "completion", ["operation-a"]))
      .resolves.toMatchObject({ delivered: false, platformStatus: "unknown" });
    await expect(sendOnce(deps({
      sendRecoverableAnnouncement: async () => ok({ delivered: false, terminalDecision: "no_reply" }),
    }), controller, item, "completion", ["operation-a"]))
      .resolves.toEqual({ delivered: true, terminalDecision: true });
    await expect(sendOnce(deps({
      sendRecoverableAnnouncement: async () => ok({ delivered: false, status: "rejected" }),
    }), controller, item, "completion", ["operation-a"]))
      .resolves.toMatchObject({ delivered: false, failure: "transport_rejected" });
  });

  it("retains an unavailable receipt-aware direct boundary", async () => {
    await expect(sendOnce(deps({
      sendToChannelWithReceipt: async () => err(new Error("transport unavailable")),
    }), new AbortController(), item, "completion", ["operation-a"]))
      .resolves.toMatchObject({
        delivered: false,
        failure: "transport_uncertain",
        platformStatus: "unknown",
      });
  });
});
