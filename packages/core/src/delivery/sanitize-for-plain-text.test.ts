// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  PLAIN_TEXT_SURFACES,
  isPlainTextSurface,
  sanitizeForPlainText,
} from "./sanitize-for-plain-text.js";

// ---------------------------------------------------------------------------
// PLAIN_TEXT_SURFACES
// ---------------------------------------------------------------------------

describe("PLAIN_TEXT_SURFACES", () => {
  it("contains all 5 plain-text surfaces", () => {
    expect(PLAIN_TEXT_SURFACES.has("whatsapp")).toBe(true);
    expect(PLAIN_TEXT_SURFACES.has("signal")).toBe(true);
    expect(PLAIN_TEXT_SURFACES.has("irc")).toBe(true);
    expect(PLAIN_TEXT_SURFACES.has("imessage")).toBe(true);
    expect(PLAIN_TEXT_SURFACES.has("line")).toBe(true);
    expect(PLAIN_TEXT_SURFACES.size).toBe(5);
  });

  it("does NOT contain telegram, discord, slack, gateway, or echo", () => {
    expect(PLAIN_TEXT_SURFACES.has("telegram")).toBe(false);
    expect(PLAIN_TEXT_SURFACES.has("discord")).toBe(false);
    expect(PLAIN_TEXT_SURFACES.has("slack")).toBe(false);
    expect(PLAIN_TEXT_SURFACES.has("gateway")).toBe(false);
    expect(PLAIN_TEXT_SURFACES.has("echo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPlainTextSurface
// ---------------------------------------------------------------------------

describe("isPlainTextSurface", () => {
  it("returns true for whatsapp", () => {
    expect(isPlainTextSurface("whatsapp")).toBe(true);
  });

  it("returns true for signal", () => {
    expect(isPlainTextSurface("signal")).toBe(true);
  });

  it("returns true for irc", () => {
    expect(isPlainTextSurface("irc")).toBe(true);
  });

  it("returns true for imessage", () => {
    expect(isPlainTextSurface("imessage")).toBe(true);
  });

  it("returns true for line", () => {
    expect(isPlainTextSurface("line")).toBe(true);
  });

  it("returns false for telegram", () => {
    expect(isPlainTextSurface("telegram")).toBe(false);
  });

  it("returns false for discord", () => {
    expect(isPlainTextSurface("discord")).toBe(false);
  });

  it("returns false for slack", () => {
    expect(isPlainTextSurface("slack")).toBe(false);
  });

  it("returns false for gateway", () => {
    expect(isPlainTextSurface("gateway")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeForPlainText — tag conversion
// ---------------------------------------------------------------------------

describe("sanitizeForPlainText", () => {
  describe("tag conversion", () => {
    it("converts <b> to bold markup", () => {
      expect(sanitizeForPlainText("<b>bold</b>")).toBe("*bold*");
    });

    it("converts <strong> to bold markup", () => {
      expect(sanitizeForPlainText("<strong>bold</strong>")).toBe("*bold*");
    });

    it("converts <i> to italic markup", () => {
      expect(sanitizeForPlainText("<i>italic</i>")).toBe("_italic_");
    });

    it("converts <em> to italic markup", () => {
      expect(sanitizeForPlainText("<em>italic</em>")).toBe("_italic_");
    });

    it("converts <s> to strikethrough markup", () => {
      expect(sanitizeForPlainText("<s>strike</s>")).toBe("~strike~");
    });

    it("converts <del> to strikethrough markup", () => {
      expect(sanitizeForPlainText("<del>strike</del>")).toBe("~strike~");
    });

    it("converts <strike> to strikethrough markup", () => {
      expect(sanitizeForPlainText("<strike>strike</strike>")).toBe("~strike~");
    });

    it("converts <code> to backtick markup", () => {
      expect(sanitizeForPlainText("<code>inline</code>")).toBe("`inline`");
    });

    it("converts <br> to newline", () => {
      expect(sanitizeForPlainText("line1<br>line2")).toBe("line1\nline2");
    });

    it("converts <br/> to newline", () => {
      expect(sanitizeForPlainText("line1<br/>line2")).toBe("line1\nline2");
    });

    it("converts <br /> to newline", () => {
      expect(sanitizeForPlainText("line1<br />line2")).toBe("line1\nline2");
    });

    it("converts headings to bold with newlines", () => {
      expect(sanitizeForPlainText("<h1>Title</h1>")).toBe("*Title*");
    });

    it("converts h2 headings", () => {
      expect(sanitizeForPlainText("<h2>Subtitle</h2>")).toBe("*Subtitle*");
    });

    it("converts list items to dashes", () => {
      expect(sanitizeForPlainText("<li>item</li>")).toBe("- item");
    });

    it("converts paragraph tags to newlines", () => {
      const result = sanitizeForPlainText("<p>paragraph</p>");
      expect(result).toBe("paragraph");
    });
  });

  // ---------------------------------------------------------------------------
  // URL extraction
  // ---------------------------------------------------------------------------

  describe("URL extraction", () => {
    it("extracts URL from <a> tag with different label", () => {
      expect(
        sanitizeForPlainText(
          '<a href="https://example.com">Click here</a>',
        ),
      ).toBe("Click here (https://example.com)");
    });

    it("extracts URL from <a> tag when label matches URL (no duplicate)", () => {
      expect(
        sanitizeForPlainText(
          '<a href="https://example.com">https://example.com</a>',
        ),
      ).toBe("https://example.com");
    });

    it("preserves autolinks", () => {
      expect(sanitizeForPlainText("<https://example.com>")).toBe(
        "https://example.com",
      );
    });

    it("preserves mailto autolinks", () => {
      expect(sanitizeForPlainText("<mailto:user@example.com>")).toBe(
        "mailto:user@example.com",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Entity decoding
  // ---------------------------------------------------------------------------

  describe("entity decoding", () => {
    it("decodes &amp; to &", () => {
      expect(sanitizeForPlainText("A &amp; B")).toBe("A & B");
    });

    it("decodes &lt; to <", () => {
      expect(sanitizeForPlainText("5 &lt; 10")).toBe("5 < 10");
    });

    it("decodes &gt; to >", () => {
      expect(sanitizeForPlainText("10 &gt; 5")).toBe("10 > 5");
    });

    it("decodes &nbsp; to space", () => {
      expect(sanitizeForPlainText("hello&nbsp;world")).toBe("hello world");
    });

    it("decodes &#39; to apostrophe", () => {
      expect(sanitizeForPlainText("it&#39;s")).toBe("it's");
    });

    it("decodes &quot; to double quote", () => {
      expect(sanitizeForPlainText("&quot;quoted&quot;")).toBe('"quoted"');
    });

    it("decodes mixed entities", () => {
      expect(sanitizeForPlainText("5 &gt; 3 &amp; 3 &lt; 5")).toBe(
        "5 > 3 & 3 < 5",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Order-dependent: tags before entities
  // ---------------------------------------------------------------------------

  describe("order-dependent processing", () => {
    it("does not re-interpret entity-encoded tags as HTML", () => {
      // &lt;b&gt; should decode to literal <b>, not be processed as bold tag
      // Tags are processed first (no match since &lt;b&gt; is not a tag),
      // then entities decode to literal angle brackets.
      expect(sanitizeForPlainText("&lt;b&gt;not bold&lt;/b&gt;")).toBe(
        "<b>not bold</b>",
      );
    });

    it("processes real tags before decoding entities in their content", () => {
      // <b>5 &amp; 3</b> -> tag converted to *5 &amp; 3* -> entity decoded to *5 & 3*
      expect(sanitizeForPlainText("<b>5 &amp; 3</b>")).toBe("*5 & 3*");
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("returns empty string for empty input", () => {
      expect(sanitizeForPlainText("")).toBe("");
    });

    it("passes through text with no HTML unchanged", () => {
      expect(sanitizeForPlainText("plain text, no HTML")).toBe(
        "plain text, no HTML",
      );
    });

    it("handles nested tags (bold italic)", () => {
      expect(sanitizeForPlainText("<b><i>bold italic</i></b>")).toBe(
        "*_bold italic_*",
      );
    });

    it("collapses excessive newlines", () => {
      expect(sanitizeForPlainText("a\n\n\n\nb")).toBe("a\n\nb");
    });

    it("trims leading and trailing whitespace", () => {
      expect(sanitizeForPlainText("  hello  ")).toBe("hello");
    });

    it("strips unknown/unrecognized tags", () => {
      expect(sanitizeForPlainText("<span class='x'>text</span>")).toBe("text");
    });

    it("handles multiple tags in sequence", () => {
      const input = "<b>bold</b> and <i>italic</i> and <code>code</code>";
      expect(sanitizeForPlainText(input)).toBe(
        "*bold* and _italic_ and `code`",
      );
    });
  });
});
