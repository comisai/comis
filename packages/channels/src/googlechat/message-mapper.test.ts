// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseMessage } from "@comis/core";
import { mapGoogleChatEventToNormalized, type GoogleChatEvent } from "./message-mapper.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build a minimal MESSAGE interaction event; each test overrides only the
 * fields it exercises. The base is a space (group) event with a full sender.
 */
function makeChatEvent(overrides: Partial<GoogleChatEvent> = {}): GoogleChatEvent {
  return {
    type: "MESSAGE",
    eventTime: "2026-07-05T00:00:00Z",
    user: { name: "users/sender-1" },
    space: { name: "spaces/AAAA", spaceType: "SPACE" },
    message: {
      name: "spaces/AAAA/messages/BBBB",
      sender: { name: "users/sender-1" },
      text: "hello",
    },
    ...overrides,
  };
}

describe("mapGoogleChatEventToNormalized", () => {
  it("returns null for a non-MESSAGE event", () => {
    expect(mapGoogleChatEventToNormalized(makeChatEvent({ type: "ADDED_TO_SPACE" }))).toBeNull();
  });

  it("returns null for an event with no message payload", () => {
    expect(mapGoogleChatEventToNormalized(makeChatEvent({ message: undefined }))).toBeNull();
  });

  it("maps a DM via the current spaceType enum to chatType dm (isGroup false)", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({ space: { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" } }),
    );
    expect(result?.chatType).toBe("dm");
    expect(result?.metadata.isGroup).toBe(false);
  });

  it("maps a DM via the legacy type enum to chatType dm (isGroup false)", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({ space: { name: "spaces/DM2", type: "DM" } }),
    );
    expect(result?.chatType).toBe("dm");
    expect(result?.metadata.isGroup).toBe(false);
  });

  it("maps a space to chatType group (isGroup true)", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({ space: { name: "spaces/SP1", spaceType: "SPACE" } }),
    );
    expect(result?.chatType).toBe("group");
    expect(result?.metadata.isGroup).toBe(true);
  });

  it("prefers message.space over the top-level event.space", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        space: { name: "spaces/OUTER", spaceType: "SPACE" },
        message: {
          name: "spaces/INNER/messages/1",
          sender: { name: "users/s" },
          space: { name: "spaces/INNER", spaceType: "DIRECT_MESSAGE" },
        },
      }),
    );
    expect(result?.channelId).toBe("spaces/INNER");
    expect(result?.chatType).toBe("dm");
  });

  it("sets channelId to the space resource name and senderId to the message sender", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        space: { name: "spaces/CID", spaceType: "SPACE" },
        message: { name: "spaces/CID/messages/1", sender: { name: "users/999" }, text: "hi" },
      }),
    );
    expect(result?.channelId).toBe("spaces/CID");
    expect(result?.senderId).toBe("users/999");
    expect(result?.channelType).toBe("googlechat");
  });

  it("falls back to event.user.name for senderId when message.sender is absent", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        user: { name: "users/fallback" },
        message: { name: "spaces/AAAA/messages/1", text: "hi" },
      }),
    );
    expect(result?.senderId).toBe("users/fallback");
  });

  it("uses the 'unknown' sentinel for senderId when neither sender nor user name is present", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        user: undefined,
        message: { name: "spaces/AAAA/messages/1", text: "hi" },
      }),
    );
    expect(result?.senderId).toBe("unknown");
  });

  it("yields a non-empty channelId sentinel when the MESSAGE event omits space.name", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        space: undefined,
        message: { name: "spaces/X/messages/1", sender: { name: "users/1" }, text: "hi" },
      }),
    );
    expect(result?.channelId).toBe("spaces/unknown");
    expect((result?.channelId ?? "").length).toBeGreaterThanOrEqual(1);
  });

  it("prefers argumentText over text", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: {
          name: "spaces/AAAA/messages/1",
          sender: { name: "users/1" },
          text: "@bot raw text",
          argumentText: "clean text",
        },
      }),
    );
    expect(result?.text).toBe("clean text");
  });

  it("falls back to text when argumentText is absent", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: { name: "spaces/AAAA/messages/1", sender: { name: "users/1" }, text: "plain" },
      }),
    );
    expect(result?.text).toBe("plain");
  });

  it("emits an empty text when neither argumentText nor text is present", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: { name: "spaces/AAAA/messages/1", sender: { name: "users/1" } },
      }),
    );
    expect(result?.text).toBe("");
  });

  it("sets metadata.wasMentioned true when a USER_MENTION annotation is present", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: {
          name: "spaces/AAAA/messages/1",
          sender: { name: "users/1" },
          text: "hi",
          annotations: [{ type: "USER_MENTION" }],
        },
      }),
    );
    expect(result?.metadata.wasMentioned).toBe(true);
  });

  it("sets metadata.wasMentioned false when no USER_MENTION annotation is present", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: {
          name: "spaces/AAAA/messages/1",
          sender: { name: "users/1" },
          text: "hi",
          annotations: [{ type: "SLASH_COMMAND" }],
        },
      }),
    );
    expect(result?.metadata.wasMentioned).toBe(false);
  });

  it("populates the advertised replyToMetaKey (metadata.googlechatMessageName) from message.name", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: {
          name: "spaces/AAAA/messages/MMMM",
          sender: { name: "users/1" },
          text: "hi",
        },
      }),
    );
    // The plugin advertises replyToMetaKey "googlechatMessageName"; the mapper
    // must write it so the inbound-message-id resolver can record the native id.
    expect(result?.metadata.googlechatMessageName).toBe("spaces/AAAA/messages/MMMM");
  });

  it("omits googlechatMessageName when the MESSAGE event carries no message.name", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: { sender: { name: "users/1" }, text: "hi" },
      }),
    );
    expect(result?.metadata.googlechatMessageName).toBeUndefined();
  });

  it("captures the thread resource name under a googlechat metadata key", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: {
          name: "spaces/AAAA/messages/1",
          sender: { name: "users/1" },
          text: "hi",
          thread: { name: "spaces/AAAA/threads/TTTT" },
        },
      }),
    );
    expect(result?.metadata.googlechatThreadId).toBe("spaces/AAAA/threads/TTTT");
  });

  it("omits the thread metadata key when no thread is present", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: { name: "spaces/AAAA/messages/1", sender: { name: "users/1" }, text: "hi" },
      }),
    );
    expect(result?.metadata.googlechatThreadId).toBeUndefined();
  });

  it("emits a UUID id, an empty attachments array, and a positive integer timestamp", () => {
    const result = mapGoogleChatEventToNormalized(makeChatEvent());
    expect(result?.id).toMatch(UUID_RE);
    expect(result?.attachments).toEqual([]);
    expect(result?.timestamp).toBeGreaterThan(0);
    expect(Number.isInteger(result?.timestamp ?? 0)).toBe(true);
  });

  it("produces a schema-valid NormalizedMessage (round-trips through parseMessage)", () => {
    const result = mapGoogleChatEventToNormalized(makeChatEvent());
    expect(result).not.toBeNull();
    const parsed = parseMessage(result);
    expect(parsed.ok).toBe(true);
  });

  it("produces a schema-valid NormalizedMessage even when space.name is omitted", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({ space: undefined, message: { name: "spaces/X/messages/1", text: "hi" } }),
    );
    const parsed = parseMessage(result);
    expect(parsed.ok).toBe(true);
  });
});

describe("mapGoogleChatEventToNormalized — untrusted-input boundary", () => {
  // The module contract is "normalizes untrusted JSON": a decoded Pub/Sub
  // payload can be the literal JSON `null` (base64 of "null" parses to null,
  // typeof null === "object", and null.type throws) or any non-object JSON
  // scalar/array. None of these may crash the mapper — each must return null so
  // the pull loop ACK-drops it rather than misrouting a TypeError into the
  // enqueue-backpressure path and redelivering forever.
  it("returns null (never throws) for a decoded literal JSON null", () => {
    expect(() =>
      mapGoogleChatEventToNormalized(null as unknown as GoogleChatEvent),
    ).not.toThrow();
    expect(mapGoogleChatEventToNormalized(null as unknown as GoogleChatEvent)).toBeNull();
  });

  it("returns null (never throws) for non-object scalar/array decodes", () => {
    for (const payload of [42, "a string", true, []]) {
      expect(() =>
        mapGoogleChatEventToNormalized(payload as unknown as GoogleChatEvent),
      ).not.toThrow();
      expect(
        mapGoogleChatEventToNormalized(payload as unknown as GoogleChatEvent),
      ).toBeNull();
    }
  });
});
