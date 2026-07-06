// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  buildAttachmentContent,
  buildEditContent,
  buildReactionContent,
  buildTextMessageContent,
  buildThreadRelation,
  chunkBySerializedBytes,
  MATRIX_EVENT_BYTE_BUDGET,
  type MatrixTextMessageContent,
} from "../matrix-adapter-outbound.js";

/** Serialized-event byte size the homeserver federation cap is measured against. */
function serializedBytes(content: MatrixTextMessageContent): number {
  return Buffer.byteLength(JSON.stringify(content));
}

/**
 * Build an HTML-heavy markdown message whose PLAINTEXT source stays under the
 * 32768 maxMessageChars a char-count splitter would check, but whose rendered
 * `formatted_body` (the HTML roughly doubles the source) pushes the SERIALIZED
 * content past the byte budget. This is the load-bearing proof fixture: a
 * char-count check passes, the byte budget is exceeded.
 */
function htmlHeavyOverBudgetMarkdown(units = 480): string {
  let md = "";
  for (let i = 0; i < units; i++) {
    const n = String(i).padStart(4, "0");
    md += `**bold ${n}** and [link ${n}](https://example.com/path/${n}) `;
  }
  return md;
}

describe("buildTextMessageContent", () => {
  it("renders markdown into an m.text content carrying body plus an org.matrix.custom.html formatted_body", () => {
    const content = buildTextMessageContent("**bold** and `code`");

    expect(content.msgtype).toBe("m.text");
    // The plaintext fallback is the raw markdown source.
    expect(content.body).toBe("**bold** and `code`");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toContain("<strong>bold</strong>");
    expect(content.formatted_body).toContain("<code>code</code>");
  });

  it("escapes HTML-significant characters in the formatted_body so agent text cannot inject markup", () => {
    const content = buildTextMessageContent("a < b & c > d");

    expect(content.body).toBe("a < b & c > d");
    expect(content.formatted_body).toContain("&lt;");
    expect(content.formatted_body).toContain("&amp;");
    expect(content.formatted_body).toContain("&gt;");
    // The raw angle brackets never survive into the HTML rendering.
    expect(content.formatted_body).not.toContain("< b");
  });

  it("produces both fields for a plain single-line message with no markup", () => {
    const content = buildTextMessageContent("hello world");

    expect(content.msgtype).toBe("m.text");
    expect(content.body).toBe("hello world");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toBe("hello world");
  });
});

describe("buildReactionContent", () => {
  it("builds an m.annotation relation to the target event carrying the emoji key", () => {
    const content = buildReactionContent("$target:hs", "👍");

    expect(content).toEqual({
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$target:hs",
        key: "👍",
      },
    });
  });

  it("passes the emoji key through verbatim (no closed vocabulary — the key IS the emoji)", () => {
    // A multi-codepoint emoji survives unchanged: there is no reaction allowlist,
    // exactly mirroring the inbound mapper (the m.annotation key is the emoji).
    const content = buildReactionContent("$evt:hs", "🎉");

    expect(content["m.relates_to"].key).toBe("🎉");
    expect(content["m.relates_to"].event_id).toBe("$evt:hs");
    expect(content["m.relates_to"].rel_type).toBe("m.annotation");
  });
});

describe("buildThreadRelation", () => {
  it("builds an m.thread relation to the thread root with the spec reply fallback", () => {
    const relation = buildThreadRelation("$root:hs");

    expect(relation).toEqual({
      rel_type: "m.thread",
      event_id: "$root:hs",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$root:hs" },
    });
  });

  it("roots both the thread relation and the reply fallback at the same event id", () => {
    // A client that ignores threads still renders it as a reply to the root, so
    // both the thread event_id and the in-reply-to target are the thread root.
    const relation = buildThreadRelation("$anchor:hs");
    expect(relation.event_id).toBe("$anchor:hs");
    expect(relation["m.in_reply_to"].event_id).toBe("$anchor:hs");
  });
});

describe("buildEditContent", () => {
  it("builds an m.replace whose m.new_content carries the new rendered text and relates to the target", () => {
    const content = buildEditContent("$orig:hs", "**bold** new");

    // The replacement relation names the edited event.
    expect(content["m.relates_to"]).toEqual({
      rel_type: "m.replace",
      event_id: "$orig:hs",
    });
    // m.new_content is the authoritative new message: the rendered body + HTML.
    expect(content["m.new_content"].msgtype).toBe("m.text");
    expect(content["m.new_content"].body).toBe("**bold** new");
    expect(content["m.new_content"].format).toBe("org.matrix.custom.html");
    expect(content["m.new_content"].formatted_body).toContain("<strong>bold</strong>");
  });

  it("prefixes the top-level fallback body and formatted_body with the leading edit marker", () => {
    // The top-level fields are the fallback a client that ignores m.replace shows;
    // the Matrix convention prefixes them with "* " so they read as an edit.
    const content = buildEditContent("$orig:hs", "hello");

    expect(content.msgtype).toBe("m.text");
    expect(content.body).toBe("* hello");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body.startsWith("* ")).toBe(true);
    expect(content.formatted_body).toContain("hello");
    // The un-prefixed new text is the one that lands under m.new_content.
    expect(content["m.new_content"].body).toBe("hello");
  });

  it("escapes HTML-significant characters in the new content so edited text cannot inject markup", () => {
    const content = buildEditContent("$orig:hs", "a < b & c");

    expect(content["m.new_content"].formatted_body).toContain("&lt;");
    expect(content["m.new_content"].formatted_body).toContain("&amp;");
    expect(content["m.new_content"].formatted_body).not.toContain("< b");
  });
});

describe("buildAttachmentContent", () => {
  /** A stand-in encrypted-file record (JWK key + iv + hashes + version), url-less. */
  const encInfo = {
    key: { alg: "A256CTR", key_ops: ["encrypt", "decrypt"], kty: "oct", k: "kkk", ext: true },
    iv: "aviv",
    hashes: { sha256: "abc" },
    v: "v2",
  };

  it("maps an image MIME to m.image and a plaintext room to a top-level url (no file)", () => {
    const content = buildAttachmentContent({
      mime: "image/png",
      fileName: "photo.png",
      sizeBytes: 1234,
      contentUri: "mxc://hs/abc",
    });

    expect(content.msgtype).toBe("m.image");
    expect(content.body).toBe("photo.png");
    // Plaintext: the uploaded mxc rides content.url and there is NO encrypted file record.
    expect(content.url).toBe("mxc://hs/abc");
    expect(content.file).toBeUndefined();
    expect(content.info).toEqual({ mimetype: "image/png", size: 1234 });
  });

  it("maps an audio MIME to m.audio", () => {
    const content = buildAttachmentContent({
      mime: "audio/ogg",
      fileName: "clip.ogg",
      sizeBytes: 10,
      contentUri: "mxc://hs/a",
    });
    expect(content.msgtype).toBe("m.audio");
  });

  it("maps a video MIME to m.video", () => {
    const content = buildAttachmentContent({
      mime: "video/mp4",
      fileName: "clip.mp4",
      sizeBytes: 20,
      contentUri: "mxc://hs/v",
    });
    expect(content.msgtype).toBe("m.video");
  });

  it("maps any other MIME (a document) to m.file", () => {
    const content = buildAttachmentContent({
      mime: "application/pdf",
      fileName: "doc.pdf",
      sizeBytes: 30,
      contentUri: "mxc://hs/d",
    });
    expect(content.msgtype).toBe("m.file");
  });

  it("in an encrypted room emits content.file (the record + the uploaded url) and NO top-level url", () => {
    const content = buildAttachmentContent({
      mime: "image/png",
      fileName: "secret.png",
      sizeBytes: 99,
      contentUri: "mxc://hs/enc",
      encryptedInfo: encInfo,
    });

    // The encrypted-file record is the url-less info plus the uploaded mxc; the
    // plaintext content.url must be absent so no plaintext link leaks in an
    // encrypted room.
    expect(content.file).toEqual({ ...encInfo, url: "mxc://hs/enc" });
    expect(content.url).toBeUndefined();
    // The declared info block still rides alongside for a client's preview.
    expect(content.info).toEqual({ mimetype: "image/png", size: 99 });
    expect(content.msgtype).toBe("m.image");
  });
});

describe("chunkBySerializedBytes", () => {
  it("splits an HTML-heavy message that passes a char-count check but exceeds the byte budget", () => {
    const md = htmlHeavyOverBudgetMarkdown();
    const budget = MATRIX_EVENT_BYTE_BUDGET;

    // Proof preconditions: a char-count splitter (keyed on maxMessageChars 32768)
    // would NOT split this — yet the SINGLE rendered content overflows the byte
    // budget once the HTML formatted_body is serialized alongside the body.
    expect(md.length).toBeLessThan(32768);
    expect(serializedBytes(buildTextMessageContent(md))).toBeGreaterThan(budget);

    const chunks = chunkBySerializedBytes(md);

    // It genuinely splits (the char-count-passing / byte-failing message),
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // and — the load-bearing assertion — EVERY emitted chunk is within budget by
    // SERIALIZED BYTES, not char count. A test that only asserted chunk count
    // would miss a chunk that overflows once rendered.
    for (const chunk of chunks) {
      expect(serializedBytes(chunk)).toBeLessThanOrEqual(budget);
    }
    // Every chunk is a well-formed m.text content (both fields present).
    for (const chunk of chunks) {
      expect(chunk.msgtype).toBe("m.text");
      expect(chunk.format).toBe("org.matrix.custom.html");
    }
  });

  it("returns exactly one content for a short message (never over-splits)", () => {
    const chunks = chunkBySerializedBytes("**hello** world");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.msgtype).toBe("m.text");
    expect(chunks[0]?.body).toBe("**hello** world");
    expect(chunks[0]?.formatted_body).toContain("<strong>hello</strong>");
  });

  it("reserves relation bytes so a threaded chunk still fits once the relation is merged", () => {
    const md = htmlHeavyOverBudgetMarkdown();
    const budget = MATRIX_EVENT_BYTE_BUDGET;
    const relation = buildThreadRelation("$root:hs");
    const reserve = Buffer.byteLength(JSON.stringify({ "m.relates_to": relation }));

    const chunks = chunkBySerializedBytes(md, budget, reserve);

    // With the relation merged into each chunk, the resulting event still fits.
    for (const chunk of chunks) {
      const threaded = { ...chunk, "m.relates_to": relation };
      expect(Buffer.byteLength(JSON.stringify(threaded))).toBeLessThanOrEqual(budget);
    }
  });

  it("never emits an empty chunk", () => {
    const chunks = chunkBySerializedBytes(htmlHeavyOverBudgetMarkdown());
    for (const chunk of chunks) {
      expect(chunk.body.length).toBeGreaterThan(0);
    }
  });

  it("splits a plain over-budget message into in-budget chunks (no markup needed)", () => {
    // A long plain message with word boundaries splits at those boundaries.
    const md = ("word ".repeat(7000)).trimEnd();
    const budget = MATRIX_EVENT_BYTE_BUDGET;
    expect(serializedBytes(buildTextMessageContent(md))).toBeGreaterThan(budget);

    const chunks = chunkBySerializedBytes(md, budget);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(serializedBytes(chunk)).toBeLessThanOrEqual(budget);
    }
  });
});
