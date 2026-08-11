// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  runWithContext,
  type ChannelPort,
  type HookRunner,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import { instrumentAttachmentDeliveries } from "./attachment-delivery-hooks.js";

function makeAdapter() {
  const sendAttachment = vi.fn(async () => ok({
    kind: "tracked" as const,
    messageId: "photo-1",
  }));
  return {
    channelId: "telegram-main",
    channelType: "telegram",
    sendAttachment,
  } as unknown as ChannelPort & { sendAttachment: typeof sendAttachment };
}

describe("attachment delivery hook instrumentation", () => {
  it("publishes media evidence with exact conversation authority", async () => {
    const adapter = makeAdapter();
    const runAfterDelivery = vi.fn(async () => undefined);
    const endpoint = {
      channelType: "telegram",
      channelInstanceId: "telegram-main",
      conversationId: "chat-1",
      conversationKind: "direct" as const,
    };
    instrumentAttachmentDeliveries(new Map([["telegram", adapter]]), {
      hookRunner: { runAfterDelivery } as Pick<HookRunner, "runAfterDelivery">,
      logger: { warn: vi.fn() } as never,
      clock: { now: vi.fn(() => 1_700_000_000_100) },
    });

    const result = await runWithContext({
      tenantId: "tenant-a",
      userId: "user_a",
      sessionKey: "tenant-a:agent:agent-1:user_a:telegram:peer:user_a",
      agentId: "agent-1",
      turnScope: {
        conversation: {
          tenantId: "tenant-a",
          agentId: "agent-1",
          partition: {
            kind: "endpoint-conversation-principal",
            endpoint,
            principalId: "user_a",
          },
        },
        principal: { principalId: "user_a" },
        endpoint,
      },
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      startedAt: 1_700_000_000_000,
      trustLevel: "admin",
    }, () => adapter.sendAttachment("chat-1", {
      type: "audio",
      url: "/workspace/media/briefing.ogg",
      caption: "Briefing",
      isVoiceNote: true,
    }));

    expect(result).toEqual(ok({ kind: "tracked", messageId: "photo-1" }));
    expect(runAfterDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Briefing",
        mediaUrls: ["/workspace/media/briefing.ogg"],
        channelType: "telegram",
        channelId: "chat-1",
        result: { kind: "tracked", messageId: "photo-1" },
        origin: "channel:attachment",
      }),
      expect.objectContaining({
        agentId: "agent-1",
        destinationEndpoint: endpoint,
        deliveryAuthority: expect.objectContaining({
          tenantId: "tenant-a",
          agentId: "agent-1",
        }),
      }),
    );
  });

  it("does not publish failed attachment attempts", async () => {
    const adapter = makeAdapter();
    adapter.sendAttachment.mockResolvedValueOnce(err(new Error("rejected")));
    const runAfterDelivery = vi.fn(async () => undefined);
    instrumentAttachmentDeliveries(new Map([["telegram", adapter]]), {
      hookRunner: { runAfterDelivery } as Pick<HookRunner, "runAfterDelivery">,
      logger: { warn: vi.fn() } as never,
      clock: { now: vi.fn(() => 5) },
    });

    const result = await adapter.sendAttachment("chat-1", {
      type: "image",
      url: "/workspace/image.png",
    });

    expect(result.ok).toBe(false);
    expect(runAfterDelivery).not.toHaveBeenCalled();
  });
});
