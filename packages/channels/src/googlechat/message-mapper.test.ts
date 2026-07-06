// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseMessage } from "@comis/core";
import {
  mapGoogleChatEventToNormalized,
  extractGoogleChatAttachments,
  type GoogleChatEvent,
} from "./message-mapper.js";

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

  it("captures the thread resource name under BOTH the generic threadId and the googlechat key", () => {
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
    // The generic key is what the shared inbound→outbound thread propagation
    // consumes; the channel-scoped key is retained alongside it.
    expect(result?.metadata.threadId).toBe("spaces/AAAA/threads/TTTT");
    expect(result?.metadata.googlechatThreadId).toBe("spaces/AAAA/threads/TTTT");
  });

  it("omits both thread metadata keys when no thread is present", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: { name: "spaces/AAAA/messages/1", sender: { name: "users/1" }, text: "hi" },
      }),
    );
    expect(result?.metadata.threadId).toBeUndefined();
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

describe("extractGoogleChatAttachments", () => {
  /**
   * Build a message carrying the given raw attachment objects. The wire carries
   * more fields than the mapper reads (a browser-facing download link among
   * them), so the array is loosely typed on purpose — the extractor must ignore
   * everything but the downloadable resource name.
   */
  function messageWith(attachment: unknown[]): GoogleChatEvent["message"] {
    return {
      name: "spaces/AAAA/messages/1",
      sender: { name: "users/1" },
      text: "see attached",
      attachment,
    } as unknown as GoogleChatEvent["message"];
  }

  it("surfaces an attachment carrying attachmentDataRef.resourceName as a googlechat-attachment:// ref", () => {
    const resourceName = "spaces/A/attachments/C";
    const { attachments, skipped } = extractGoogleChatAttachments(
      messageWith([
        {
          contentType: "image/png",
          contentName: "pic.png",
          attachmentDataRef: { resourceName },
        },
      ]),
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0].url).toBe(
      `googlechat-attachment://${encodeURIComponent(resourceName)}`,
    );
    expect(attachments[0].type).toBe("image");
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].fileName).toBe("pic.png");
    expect(skipped).toEqual([]);
  });

  it("skips a share carrying no resource name (Drive-picker) and records it under skipped, not attachments", () => {
    const { attachments, skipped } = extractGoogleChatAttachments(
      messageWith([
        { source: "DRIVE_FILE", contentName: "doc", driveDataRef: { driveFileId: "x" } },
      ]),
    );
    expect(attachments).toEqual([]);
    expect(skipped).toEqual([{ source: "DRIVE_FILE", contentName: "doc" }]);
  });

  it("RESOLVES a drag-drop share that DOES carry a resource name — the branch is on resource-name presence, never the source enum", () => {
    const resourceName = "spaces/A/attachments/D";
    const { attachments, skipped } = extractGoogleChatAttachments(
      messageWith([{ source: "DRIVE_FILE", attachmentDataRef: { resourceName } }]),
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0].url).toBe(
      `googlechat-attachment://${encodeURIComponent(resourceName)}`,
    );
    expect(skipped).toEqual([]);
  });

  it("splits a mixed list: the resolvable ref into attachments, the resource-name-less share into skipped", () => {
    const { attachments, skipped } = extractGoogleChatAttachments(
      messageWith([
        {
          contentType: "image/png",
          attachmentDataRef: { resourceName: "spaces/A/attachments/C" },
        },
        { source: "DRIVE_FILE", contentName: "shared.pdf", driveDataRef: { driveFileId: "y" } },
      ]),
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0].url).toBe(
      `googlechat-attachment://${encodeURIComponent("spaces/A/attachments/C")}`,
    );
    expect(skipped).toEqual([{ source: "DRIVE_FILE", contentName: "shared.pdf" }]);
  });

  it("guards a null / non-object array element without throwing (neither surfaced nor skipped)", () => {
    let out: ReturnType<typeof extractGoogleChatAttachments> | undefined;
    expect(() => {
      out = extractGoogleChatAttachments(
        messageWith([
          null,
          42,
          "str",
          { attachmentDataRef: { resourceName: "spaces/A/attachments/C" } },
        ]),
      );
    }).not.toThrow();
    expect(out?.attachments).toHaveLength(1);
    expect(out?.skipped).toEqual([]);
  });

  it("never surfaces a browser-facing download link into att.url — only the resource-name scheme", () => {
    const resourceName = "spaces/A/attachments/C";
    const { attachments } = extractGoogleChatAttachments(
      messageWith([
        {
          contentType: "image/png",
          attachmentDataRef: { resourceName },
          downloadUri: "https://chat.example.test/download/browser-only",
          thumbnailUri: "https://chat.example.test/thumb/browser-only",
        },
      ]),
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0].url).toBe(
      `googlechat-attachment://${encodeURIComponent(resourceName)}`,
    );
    expect(attachments[0].url).not.toContain("chat.example.test");
  });

  it("classifies the coarse type from the MIME so the pipeline routes: audio/* → audio, application/pdf → file", () => {
    const { attachments } = extractGoogleChatAttachments(
      messageWith([
        { contentType: "audio/ogg", attachmentDataRef: { resourceName: "spaces/A/attachments/AUD" } },
        { contentType: "application/pdf", attachmentDataRef: { resourceName: "spaces/A/attachments/PDF" } },
      ]),
    );
    expect(attachments).toHaveLength(2);
    expect(attachments[0].type).toBe("audio");
    expect(attachments[1].type).toBe("file");
  });

  it("omits mimeType and fileName when the attachment carries neither contentType nor contentName", () => {
    const { attachments } = extractGoogleChatAttachments(
      messageWith([{ attachmentDataRef: { resourceName: "spaces/A/attachments/BARE" } }]),
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe("file");
    expect(attachments[0].mimeType).toBeUndefined();
    expect(attachments[0].fileName).toBeUndefined();
  });

  it("returns empty attachments and skipped for an undefined message", () => {
    const { attachments, skipped } = extractGoogleChatAttachments(undefined);
    expect(attachments).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it.each([
    ["an empty object", {}],
    ["a number", 42],
    ["a boolean", true],
  ])(
    "degrades to empty (never throws) when message.attachment is a truthy non-array container (%s)",
    (_label, attachment) => {
      // `message.attachment` is untrusted decoded JSON. The `?? []` fallback only
      // covers null/undefined; a truthy NON-ITERABLE container (`{}`, `42`,
      // `true`) makes `for...of` throw `TypeError: … is not iterable`. Guard the
      // container as the elements are guarded so a hostile shape degrades to empty.
      let out: ReturnType<typeof extractGoogleChatAttachments> | undefined;
      expect(() => {
        out = extractGoogleChatAttachments(
          { attachment } as unknown as GoogleChatEvent["message"],
        );
      }).not.toThrow();
      expect(out).toEqual({ attachments: [], skipped: [] });
    },
  );
});

describe("mapGoogleChatEventToNormalized — inbound attachments", () => {
  it("populates NormalizedMessage.attachments from a resolvable message.attachment ref (was always [])", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: {
          name: "spaces/AAAA/messages/1",
          sender: { name: "users/1" },
          text: "see attached",
          attachment: [
            {
              contentType: "image/png",
              contentName: "pic.png",
              attachmentDataRef: { resourceName: "spaces/AAAA/attachments/C" },
            },
          ],
        },
      }),
    );
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments[0].type).toBe("image");
    expect(result?.attachments[0].url).toBe(
      `googlechat-attachment://${encodeURIComponent("spaces/AAAA/attachments/C")}`,
    );
  });

  it("keeps attachments [] for a MESSAGE event carrying only a resource-name-less share", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: {
          name: "spaces/AAAA/messages/1",
          sender: { name: "users/1" },
          text: "hi",
          attachment: [{ source: "DRIVE_FILE", driveDataRef: { driveFileId: "z" } }],
        },
      }),
    );
    expect(result?.attachments).toEqual([]);
  });

  it("round-trips through parseMessage with a resolvable attachment present", () => {
    const result = mapGoogleChatEventToNormalized(
      makeChatEvent({
        message: {
          name: "spaces/AAAA/messages/1",
          sender: { name: "users/1" },
          text: "see attached",
          attachment: [
            {
              contentType: "image/png",
              attachmentDataRef: { resourceName: "spaces/AAAA/attachments/C" },
            },
          ],
        },
      }),
    );
    const parsed = parseMessage(result);
    expect(parsed.ok).toBe(true);
  });

  // A non-array `message.attachment`/`message.annotations` in an untrusted decoded
  // event would make `for...of`/`.some` throw. Because the adapter calls the mapper
  // UNWRAPPED, that TypeError escapes the mapper's documented "never crash → return
  // null/valid" contract and lands on the pull loop's skip-ack path — the malformed
  // message is never ACKed and Pub/Sub redelivers it forever (dedup never engages
  // because the name is marked seen only on the success path). Each of these must
  // map to a schema-valid message, never throw.
  it.each([
    ["message.attachment = {} (non-iterable object)", { attachment: {} }],
    ["message.attachment = 42 (non-iterable number)", { attachment: 42 }],
    ["message.attachment = true (non-iterable boolean)", { attachment: true }],
    ["message.annotations = 'x' (non-array string — .some is not a function)", { annotations: "x" }],
    ["message.annotations = 42 (non-array number)", { annotations: 42 }],
  ])(
    "maps a MESSAGE event with a non-array container (%s) to a valid NormalizedMessage, never throwing into the redelivery path",
    (_label, badField) => {
      let result: ReturnType<typeof mapGoogleChatEventToNormalized> | undefined;
      expect(() => {
        result = mapGoogleChatEventToNormalized(
          makeChatEvent({
            message: {
              name: "spaces/AAAA/messages/1",
              sender: { name: "users/1" },
              text: "hi",
              ...badField,
            } as unknown as GoogleChatEvent["message"],
          }),
        );
      }).not.toThrow();
      expect(result).not.toBeNull();
      expect(result?.attachments).toEqual([]);
      expect(parseMessage(result).ok).toBe(true);
    },
  );

  it("guards a null annotation element without throwing, still detecting a real USER_MENTION alongside it", () => {
    // A decoded annotations array can carry a literal null element; `a.type` on it
    // throws. Guard the element (a?.type) so the mapper never crashes and still
    // reads a genuine mention in the same array.
    let result: ReturnType<typeof mapGoogleChatEventToNormalized> | undefined;
    expect(() => {
      result = mapGoogleChatEventToNormalized(
        makeChatEvent({
          message: {
            name: "spaces/AAAA/messages/1",
            sender: { name: "users/1" },
            text: "hi",
            annotations: [null, { type: "USER_MENTION" }],
          } as unknown as GoogleChatEvent["message"],
        }),
      );
    }).not.toThrow();
    expect(result?.metadata.wasMentioned).toBe(true);
  });
});
