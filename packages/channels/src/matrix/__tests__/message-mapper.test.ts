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
}

/** Build a minimal MatrixEvent double exposing only the accessors the mapper reads. */
function makeEvent(overrides: Partial<FakeEventShape> = {}): MatrixEvent {
  const base: FakeEventShape = {
    type: "m.room.message",
    id: "$evt:hs",
    sender: "@real:hs",
    content: { msgtype: "m.text", body: "hello world" },
    ...overrides,
  };
  return {
    getType: () => base.type,
    getId: () => base.id,
    getSender: () => base.sender,
    getContent: () => base.content,
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
});
