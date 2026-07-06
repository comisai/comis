// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { parseMessage } from "@comis/core";
import { mapMatrixEventToNormalized } from "../message-mapper.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FakeEventShape {
  type: string;
  id: string | undefined;
  sender: string | undefined;
  content: Record<string, unknown>;
  /** The thread-root id the SDK getter reports; undefined for a non-thread event. */
  threadRootId: string | undefined;
  /** The id `getAssociatedId()` reports for a redaction (its redacted target). */
  associatedId: string | undefined;
}

/** Build a minimal MatrixEvent double exposing only the accessors the mapper reads. */
function makeEvent(overrides: Partial<FakeEventShape> = {}): MatrixEvent {
  const base: FakeEventShape = {
    type: "m.room.message",
    id: "$evt:hs",
    sender: "@real:hs",
    content: { msgtype: "m.text", body: "hello world" },
    threadRootId: undefined,
    associatedId: undefined,
    ...overrides,
  };
  return {
    getType: () => base.type,
    getId: () => base.id,
    getSender: () => base.sender,
    getContent: () => base.content,
    // For a redaction, the SDK reports the redacted target id here.
    getAssociatedId: () => base.associatedId,
    // A getter, as in the SDK — undefined for a non-thread event.
    threadRootId: base.threadRootId,
  } as unknown as MatrixEvent;
}

function makeRoom(roomId = "!room:hs"): Room {
  return { roomId } as unknown as Room;
}

describe("mapMatrixEventToNormalized", () => {
  it("returns null for a non-m.room.message event", () => {
    const result = mapMatrixEventToNormalized(makeEvent({ type: "m.reaction" }), makeRoom(), {
      isDirect: false,
    });
    expect(result).toBeNull();
  });

  it("maps a text event to a NormalizedMessage the domain schema accepts", () => {
    const result = mapMatrixEventToNormalized(makeEvent(), makeRoom("!abc:hs"), {
      isDirect: false,
    });
    expect(result).not.toBeNull();
    expect(result?.channelType).toBe("matrix");
    expect(result?.channelId).toBe("!abc:hs");
    expect(result?.text).toBe("hello world");
    expect(result?.id).toMatch(UUID_RE);
    expect(Number.isInteger(result?.timestamp)).toBe(true);
    expect(result?.timestamp ?? 0).toBeGreaterThan(0);
    expect(result?.attachments).toEqual([]);
    // The whole object round-trips through the domain validator.
    const parsed = parseMessage(result);
    expect(parsed.ok).toBe(true);
  });

  it("carries the Matrix event id in metadata.matrixEventId", () => {
    const result = mapMatrixEventToNormalized(makeEvent({ id: "$specific:hs" }), makeRoom(), {
      isDirect: false,
    });
    expect(result?.metadata.matrixEventId).toBe("$specific:hs");
  });

  it("generates a fresh UUID id on each call", () => {
    const a = mapMatrixEventToNormalized(makeEvent(), makeRoom(), { isDirect: false });
    const b = mapMatrixEventToNormalized(makeEvent(), makeRoom(), { isDirect: false });
    expect(a?.id).not.toBe(b?.id);
  });

  it("sets senderId to the full MXID from getSender()", () => {
    const result = mapMatrixEventToNormalized(makeEvent({ sender: "@alice:example.org" }), makeRoom(), {
      isDirect: true,
    });
    expect(result?.senderId).toBe("@alice:example.org");
  });

  it("uses the MXID for senderId even when the content sets a spoofing display name", () => {
    // A hostile sender can set any display name; identity must key on the MXID.
    const result = mapMatrixEventToNormalized(
      makeEvent({
        sender: "@real:hs",
        content: {
          msgtype: "m.text",
          body: "hi",
          displayname: "@admin:hs",
          "m.mentions": { sender_name: "@admin:hs" },
        },
      }),
      makeRoom(),
      { isDirect: false },
    );
    expect(result?.senderId).toBe("@real:hs");
  });

  it("derives chatType dm for a direct room", () => {
    const result = mapMatrixEventToNormalized(makeEvent(), makeRoom(), { isDirect: true });
    expect(result?.chatType).toBe("dm");
  });

  it("derives chatType group for a non-direct room", () => {
    const result = mapMatrixEventToNormalized(makeEvent(), makeRoom(), { isDirect: false });
    expect(result?.chatType).toBe("group");
  });

  it("maps a thread event to chatType thread carrying the thread-root id in metadata", () => {
    const result = mapMatrixEventToNormalized(
      makeEvent({ threadRootId: "$root:hs" }),
      makeRoom(),
      { isDirect: false },
    );
    expect(result?.chatType).toBe("thread");
    expect(result?.metadata.matrixThreadId).toBe("$root:hs");
  });

  it("does not set chatType thread or a thread id for a non-thread event", () => {
    const result = mapMatrixEventToNormalized(makeEvent(), makeRoom(), { isDirect: false });
    expect(result?.chatType).toBe("group");
    expect(result?.metadata.matrixThreadId).toBeUndefined();
  });

  it("sanitizes an inbound formatted_body so a script tag never reaches the normalized message", () => {
    const result = mapMatrixEventToNormalized(
      makeEvent({
        content: {
          msgtype: "m.text",
          body: "safe text",
          format: "org.matrix.custom.html",
          formatted_body: '<script>alert(1)</script><b>bold</b>',
        },
      }),
      makeRoom(),
      { isDirect: false },
    );
    // No trace of the active markup anywhere in the returned object.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("<script>");
    expect(serialized).not.toContain("alert");
    // The sanitized formatted body is retained (safe subset only).
    expect(result?.metadata.matrixFormattedBody).toContain("<b>bold</b>");
  });

  it("returns null for a message event with no verifiable sender", () => {
    // Without a sender MXID there is no trustworthy identity to key on.
    const result = mapMatrixEventToNormalized(makeEvent({ sender: undefined }), makeRoom(), {
      isDirect: false,
    });
    expect(result).toBeNull();
  });

  it("yields empty text when the message content carries no body", () => {
    const result = mapMatrixEventToNormalized(
      makeEvent({ content: { msgtype: "m.text" } }),
      makeRoom(),
      { isDirect: false },
    );
    expect(result?.text).toBe("");
  });

  it("surfaces an inbound edit as a new message carrying the new content and a replaces pointer, without mutating the input", () => {
    // A remote edit arrives as an m.replace: its m.new_content is the authoritative
    // new text and its relation names the replaced event. It must surface as a NEW
    // normalized event (advisory replaces pointer) — never an in-place rewrite of
    // what the bot already received — so the agent reasons on receipt-time events.
    const editContent = {
      msgtype: "m.text",
      body: "* edited text",
      "m.new_content": { msgtype: "m.text", body: "edited text" },
      "m.relates_to": { rel_type: "m.replace", event_id: "$orig:hs" },
    };
    const event = makeEvent({ id: "$edit:hs", content: editContent });
    const inputBefore = JSON.stringify(event.getContent());

    const result = mapMatrixEventToNormalized(event, makeRoom("!r:hs"), { isDirect: false });

    // Its text is the NEW content, not the leading-"* " fallback body.
    expect(result?.text).toBe("edited text");
    // An advisory pointer to the replaced event (never a silent rewrite).
    expect(result?.metadata.matrixReplacesEventId).toBe("$orig:hs");
    // The new event has its own identity: a fresh UUID + the edit event's own id.
    expect(result?.id).toMatch(UUID_RE);
    expect(result?.metadata.matrixEventId).toBe("$edit:hs");
    // The whole object round-trips through the domain validator.
    expect(parseMessage(result).ok).toBe(true);
    // The input event object was not mutated (the mapper reads, never writes).
    expect(JSON.stringify(event.getContent())).toBe(inputBefore);
  });

  it("sanitizes the edit's new formatted_body so a script tag never reaches the normalized message", () => {
    const result = mapMatrixEventToNormalized(
      makeEvent({
        content: {
          msgtype: "m.text",
          body: "* safe",
          "m.new_content": {
            msgtype: "m.text",
            body: "safe",
            format: "org.matrix.custom.html",
            formatted_body: "<script>alert(1)</script><b>bold</b>",
          },
          "m.relates_to": { rel_type: "m.replace", event_id: "$orig:hs" },
        },
      }),
      makeRoom(),
      { isDirect: false },
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("<script>");
    expect(serialized).not.toContain("alert");
    expect(result?.metadata.matrixFormattedBody).toContain("<b>bold</b>");
  });

  it("surfaces an inbound redaction as a new honest event naming the redacted target with no reconstructed body", () => {
    // A redaction must surface honestly — the bot learns a message was removed —
    // without ever reconstructing the removed content. The target id is advisory
    // metadata; prior context is never silently rewritten or dropped.
    const result = mapMatrixEventToNormalized(
      makeEvent({ type: "m.room.redaction", id: "$redact:hs", content: {}, associatedId: "$gone:hs" }),
      makeRoom("!r:hs"),
      { isDirect: false },
    );

    expect(result).not.toBeNull();
    expect(result?.metadata.matrixRedactsEventId).toBe("$gone:hs");
    // An honest, non-empty marker — never the removed content.
    expect(typeof result?.text).toBe("string");
    expect(result?.text.length).toBeGreaterThan(0);
    // The honest event round-trips through the domain validator.
    expect(parseMessage(result).ok).toBe(true);
  });

  it("still surfaces an honest redaction event when the redacted target id is unresolved", () => {
    // A redaction whose target cannot be resolved must NOT be silently dropped —
    // the bot must still learn that a message was removed.
    const result = mapMatrixEventToNormalized(
      makeEvent({ type: "m.room.redaction", content: {}, associatedId: undefined }),
      makeRoom(),
      { isDirect: false },
    );
    expect(result).not.toBeNull();
    expect(result?.metadata.matrixRedactsEventId).toBeUndefined();
  });

  it("returns null for a redaction event with no verifiable sender", () => {
    const result = mapMatrixEventToNormalized(
      makeEvent({ type: "m.room.redaction", sender: undefined, associatedId: "$gone:hs" }),
      makeRoom(),
      { isDirect: false },
    );
    expect(result).toBeNull();
  });

  it("sets metadata.isBotMentioned true when the inbound m.mentions name the bot MXID", () => {
    const result = mapMatrixEventToNormalized(
      makeEvent({
        content: { msgtype: "m.text", body: "hey there", "m.mentions": { user_ids: ["@bot:hs"] } },
      }),
      makeRoom(),
      { isDirect: false, botUserId: "@bot:hs" },
    );
    expect(result?.metadata.isBotMentioned).toBe(true);
  });

  it("does not flag isBotMentioned when the inbound mentions do not name the bot", () => {
    const result = mapMatrixEventToNormalized(
      makeEvent({
        content: { msgtype: "m.text", body: "hey all", "m.mentions": { user_ids: ["@other:hs"] } },
      }),
      makeRoom(),
      { isDirect: false, botUserId: "@bot:hs" },
    );
    expect(result?.metadata.isBotMentioned).toBe(false);
  });

  it("sets the exact isBotMentioned gate key (never mentionedBot) the group @-mention gate reads", () => {
    // The group @-mention gate reads metadata.isBotMentioned; the Teams channel uses
    // a different key (mentionedBot) the gate does NOT read. Matrix must set the one
    // the gate keys on, so the bot answers when addressed in a group.
    const result = mapMatrixEventToNormalized(
      makeEvent({
        content: { msgtype: "m.text", body: "hey", "m.mentions": { user_ids: ["@bot:hs"] } },
      }),
      makeRoom(),
      { isDirect: false, botUserId: "@bot:hs" },
    );
    const meta = result?.metadata ?? {};
    expect(Object.prototype.hasOwnProperty.call(meta, "isBotMentioned")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(meta, "mentionedBot")).toBe(false);
  });
});
