// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { buildReactionContent, buildTextMessageContent } from "../matrix-adapter-outbound.js";

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
