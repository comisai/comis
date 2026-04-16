import { describe, it, expect } from "vitest";
import type { webhook } from "@line/bot-sdk";
import { mapLineToNormalized, isMessageEvent } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Helpers for building test events
// ---------------------------------------------------------------------------

function makeBaseEvent(overrides: Partial<webhook.MessageEvent> = {}): webhook.MessageEvent {
  return {
    type: "message",
    timestamp: 1700000000000,
    mode: "active",
    webhookEventId: "evt-001",
    deliveryContext: { isRedelivery: false },
    replyToken: "reply-token-abc",
    source: { type: "user", userId: "U001" },
    message: { type: "text", id: "msg-001", text: "hello", quoteToken: "qt-1" },
    ...overrides,
  } as webhook.MessageEvent;
}

// ---------------------------------------------------------------------------
// mapLineToNormalized
// ---------------------------------------------------------------------------

describe("mapLineToNormalized", () => {
  it("maps a text message from a user DM", () => {
    const event = makeBaseEvent();
    const result = mapLineToNormalized(event);

    expect(result).not.toBeNull();
    expect(result!.channelType).toBe("line");
    expect(result!.channelId).toBe("U001");
    expect(result!.senderId).toBe("U001");
    expect(result!.text).toBe("hello");
    expect(result!.timestamp).toBe(1700000000000);
    expect(result!.metadata.lineReplyToken).toBe("reply-token-abc");
    expect(result!.metadata.lineMessageId).toBe("msg-001");
    expect(result!.metadata.lineSourceType).toBe("user");
    expect(result!.attachments).toEqual([]);
  });

  it("maps a text message from a group", () => {
    const event = makeBaseEvent({
      source: { type: "group", groupId: "G123", userId: "U002" } as webhook.GroupSource,
    });
    const result = mapLineToNormalized(event);

    expect(result).not.toBeNull();
    expect(result!.channelId).toBe("G123");
    expect(result!.senderId).toBe("U002");
    expect(result!.metadata.lineSourceType).toBe("group");
  });

  it("maps a text message from a room", () => {
    const event = makeBaseEvent({
      source: { type: "room", roomId: "R456", userId: "U003" } as webhook.RoomSource,
    });
    const result = mapLineToNormalized(event);

    expect(result).not.toBeNull();
    expect(result!.channelId).toBe("R456");
    expect(result!.senderId).toBe("U003");
    expect(result!.metadata.lineSourceType).toBe("room");
  });

  it("handles a group source without userId", () => {
    const event = makeBaseEvent({
      source: { type: "group", groupId: "G999" } as webhook.GroupSource,
    });
    const result = mapLineToNormalized(event);

    expect(result).not.toBeNull();
    expect(result!.channelId).toBe("G999");
    expect(result!.senderId).toBe("unknown");
  });

  it("maps an image message with attachment", () => {
    const event = makeBaseEvent({
      message: {
        type: "image",
        id: "img-001",
        contentProvider: { type: "line" },
      } as webhook.ImageMessageContent,
    });
    const result = mapLineToNormalized(event);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("");
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0].type).toBe("image");
    expect(result!.attachments[0].url).toBe("line-content://img-001");
  });

  it("maps a video message with attachment", () => {
    const event = makeBaseEvent({
      message: {
        type: "video",
        id: "vid-001",
        duration: 10000,
        contentProvider: { type: "line" },
      } as webhook.VideoMessageContent,
    });
    const result = mapLineToNormalized(event);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("");
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0].type).toBe("video");
  });

  it("maps a file message with attachment", () => {
    const event = makeBaseEvent({
      message: {
        type: "file",
        id: "file-001",
        fileName: "document.pdf",
        fileSize: 12345,
      } as webhook.FileMessageContent,
    });
    const result = mapLineToNormalized(event);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("");
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0].type).toBe("file");
    expect(result!.attachments[0].fileName).toBe("document.pdf");
    expect(result!.attachments[0].sizeBytes).toBe(12345);
  });

  it("maps a sticker message as [Sticker] text", () => {
    const event = makeBaseEvent({
      message: {
        type: "sticker",
        id: "stk-001",
        packageId: "11537",
        stickerId: "52002734",
        stickerResourceType: "STATIC",
        keywords: [],
        quoteToken: "qt-stk",
      } as webhook.StickerMessageContent,
    });
    const result = mapLineToNormalized(event);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("[Sticker]");
    expect(result!.attachments).toEqual([]);
  });

  it("returns null when source is missing", () => {
    const event = makeBaseEvent();
    (event as { source?: unknown }).source = undefined;
    const result = mapLineToNormalized(event);
    expect(result).toBeNull();
  });

  it("preserves webhookEventId in metadata", () => {
    const event = makeBaseEvent({ webhookEventId: "evt-unique-123" });
    const result = mapLineToNormalized(event);

    expect(result).not.toBeNull();
    expect(result!.metadata.lineWebhookEventId).toBe("evt-unique-123");
  });
});

// ---------------------------------------------------------------------------
// isMessageEvent
// ---------------------------------------------------------------------------

describe("isMessageEvent", () => {
  it("returns true for message events", () => {
    const event = makeBaseEvent();
    expect(isMessageEvent(event)).toBe(true);
  });

  it("returns false for follow events", () => {
    const event = {
      type: "follow",
      timestamp: 1700000000000,
      mode: "active",
      webhookEventId: "evt-002",
      deliveryContext: { isRedelivery: false },
      source: { type: "user", userId: "U001" },
      replyToken: "tok",
    } as webhook.FollowEvent;
    expect(isMessageEvent(event)).toBe(false);
  });

  it("returns false for unfollow events", () => {
    const event = {
      type: "unfollow",
      timestamp: 1700000000000,
      mode: "active",
      webhookEventId: "evt-003",
      deliveryContext: { isRedelivery: false },
      source: { type: "user", userId: "U001" },
    } as webhook.UnfollowEvent;
    expect(isMessageEvent(event)).toBe(false);
  });

  it("returns false for postback events", () => {
    const event = {
      type: "postback",
      timestamp: 1700000000000,
      mode: "active",
      webhookEventId: "evt-004",
      deliveryContext: { isRedelivery: false },
      source: { type: "user", userId: "U001" },
      replyToken: "tok",
      postback: { data: "action=buy" },
    } as webhook.PostbackEvent;
    expect(isMessageEvent(event)).toBe(false);
  });
});
