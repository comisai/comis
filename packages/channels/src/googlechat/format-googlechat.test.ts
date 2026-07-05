// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { escapeGoogleChatText, formatGoogleChatText } from "./format-googlechat.js";

describe("format-googlechat", () => {
  describe("formatGoogleChatText — plain-text passthrough (load-bearing)", () => {
    it("returns markup-free plain text byte-identical", () => {
      expect(formatGoogleChatText("hello world")).toBe("hello world");
    });

    it("returns an empty string unchanged", () => {
      expect(formatGoogleChatText("")).toBe("");
    });

    it("leaves newlines and surrounding whitespace byte-identical", () => {
      expect(formatGoogleChatText("line one\nline two\n")).toBe("line one\nline two\n");
    });
  });

  describe("formatGoogleChatText — Slack-mrkdwn-shaped markers pass through", () => {
    it("preserves bold markers (*text*)", () => {
      expect(formatGoogleChatText("*bold*")).toBe("*bold*");
    });

    it("preserves italic markers (_text_)", () => {
      expect(formatGoogleChatText("_italic_")).toBe("_italic_");
    });

    it("preserves inline code markers (`text`)", () => {
      expect(formatGoogleChatText("`code`")).toBe("`code`");
    });

    it("preserves strikethrough markers (~text~)", () => {
      expect(formatGoogleChatText("~strike~")).toBe("~strike~");
    });

    it("preserves a multi-marker line byte-identical when it has no stray brackets", () => {
      expect(formatGoogleChatText("*b* and _i_ and `c` and ~s~")).toBe(
        "*b* and _i_ and `c` and ~s~",
      );
    });
  });

  describe("formatGoogleChatText — link and mention tokens are preserved", () => {
    it("preserves a hyperlink token <url|display text>", () => {
      expect(formatGoogleChatText("See <https://example.com|the docs>")).toBe(
        "See <https://example.com|the docs>",
      );
    });

    it("preserves a bare https link token", () => {
      expect(formatGoogleChatText("Visit <https://example.com>")).toBe(
        "Visit <https://example.com>",
      );
    });

    it("preserves a user mention token <users/{id}>", () => {
      expect(formatGoogleChatText("Hi <users/123456>")).toBe("Hi <users/123456>");
    });
  });

  describe("formatGoogleChatText — stray HTML-significant characters are escaped", () => {
    it("escapes a stray less-than so agent text cannot open a tag", () => {
      expect(formatGoogleChatText("a < b")).toBe("a &lt; b");
    });

    it("escapes a stray greater-than", () => {
      expect(formatGoogleChatText("a > b")).toBe("a &gt; b");
    });

    it("escapes a stray ampersand", () => {
      expect(formatGoogleChatText("Tom & Jerry")).toBe("Tom &amp; Jerry");
    });

    it("escapes an unrecognized angle-bracket token (an injected tag)", () => {
      expect(formatGoogleChatText("<script>alert(1)</script>")).toBe(
        "&lt;script&gt;alert(1)&lt;/script&gt;",
      );
    });

    it("escapes a stray bracket after a valid link token while preserving the token", () => {
      expect(formatGoogleChatText("see <https://x.com|x> then 5 > 6")).toBe(
        "see <https://x.com|x> then 5 &gt; 6",
      );
    });

    it("conservatively escapes a token an unmatched < swallows (never emits unbalanced markup)", () => {
      // An unmatched "<" pairs with the next token's ">"; escaping the whole span
      // is the safe outcome — no half-open tag ever reaches the wire.
      expect(formatGoogleChatText("5 < 6 see <https://x.com|x>")).toBe(
        "5 &lt; 6 see &lt;https://x.com|x&gt;",
      );
    });
  });

  describe("escapeGoogleChatText — raw escaping helper", () => {
    it("escapes &, <, > to HTML entities", () => {
      expect(escapeGoogleChatText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    });

    it("returns text with no special characters byte-identical", () => {
      expect(escapeGoogleChatText("plain text")).toBe("plain text");
    });

    it("escapes an angle-bracket token unconditionally (no token preservation)", () => {
      expect(escapeGoogleChatText("<https://x.com>")).toBe("&lt;https://x.com&gt;");
    });
  });
});
