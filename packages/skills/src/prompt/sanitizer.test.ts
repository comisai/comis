// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  stripHtmlComments,
  sanitizeSkillBody,
  ZERO_WIDTH_REGEX,
  HTML_COMMENT_REGEX,
  TRUNCATION_MARKER,
} from "./sanitizer.js";
import type { SanitizeResult } from "./sanitizer.js";

describe("stripHtmlComments", () => {
  it("returns unchanged text when no comments present", () => {
    const result = stripHtmlComments("hello");
    expect(result).toEqual({ text: "hello", count: 0 });
  });

  it("strips a single HTML comment", () => {
    const result = stripHtmlComments("before <!-- comment --> after");
    expect(result).toEqual({ text: "before  after", count: 1 });
  });

  it("strips multiple HTML comments", () => {
    const result = stripHtmlComments("a <!-- c1 --> b <!-- c2 --> c");
    expect(result).toEqual({ text: "a  b  c", count: 2 });
  });

  it("strips multiline comments", () => {
    const result = stripHtmlComments("<!-- multiline\ncomment -->");
    expect(result).toEqual({ text: "", count: 1 });
  });

  it("uses non-greedy matching (stops at first -->)", () => {
    const result = stripHtmlComments("<!-- nested <!-- --> text");
    expect(result).toEqual({ text: " text", count: 1 });
  });

  it("returns zero count for text without comments", () => {
    const result = stripHtmlComments("no comments here");
    expect(result).toEqual({ text: "no comments here", count: 0 });
  });
});

describe("sanitizeSkillBody", () => {
  describe("NFKC normalization", () => {
    it("decomposes fullwidth characters", () => {
      const result = sanitizeSkillBody("\uFF21\uFF22\uFF23", 1000);
      expect(result.body).toBe("ABC");
    });

    it("decomposes ligatures", () => {
      const result = sanitizeSkillBody("\uFB01", 1000);
      expect(result.body).toBe("fi");
    });
  });

  describe("zero-width character stripping", () => {
    it("removes zero-width space", () => {
      const result = sanitizeSkillBody("hello\u200Bworld", 1000);
      expect(result.body).toBe("helloworld");
    });

    it("removes multiple zero-width characters", () => {
      const result = sanitizeSkillBody("a\u200B\u200C\u200Db", 1000);
      expect(result.body).toBe("ab");
    });

    it("removes BOM character", () => {
      const result = sanitizeSkillBody("a\uFEFFb", 1000);
      expect(result.body).toBe("ab");
    });

    it("removes soft hyphen", () => {
      const result = sanitizeSkillBody("a\u00ADb", 1000);
      expect(result.body).toBe("ab");
    });
  });

  describe("body size enforcement", () => {
    it("does not truncate body under maxBodyLength", () => {
      const result = sanitizeSkillBody("short", 100);
      expect(result.truncated).toBe(false);
      expect(result.body).toBe("short");
    });

    it("does not truncate body exactly at maxBodyLength", () => {
      const body = "a".repeat(100);
      const result = sanitizeSkillBody(body, 100);
      expect(result.truncated).toBe(false);
      expect(result.body).toBe(body);
    });

    it("truncates body over maxBodyLength with marker", () => {
      const body = "a".repeat(150);
      const result = sanitizeSkillBody(body, 100);
      expect(result.truncated).toBe(true);
      expect(result.body).toBe("a".repeat(100) + "\n[TRUNCATED]");
    });

    it("truncates 100 chars with maxBodyLength 50", () => {
      const body = "a".repeat(100);
      const result = sanitizeSkillBody(body, 50);
      expect(result.truncated).toBe(true);
      expect(result.body).toBe("a".repeat(50) + "\n[TRUNCATED]");
    });
  });

  describe("full pipeline order", () => {
    it("strips comments first, then normalizes, then strips zero-width, then enforces size", () => {
      // Body with HTML comments + zero-width + oversized
      const body = "<!-- comment -->hello\u200Bworld" + "x".repeat(100);
      const result = sanitizeSkillBody(body, 50);

      // After comment strip: "hello\u200Bworld" + "x"*100 (115 chars)
      // After NFKC: same (no NFKC changes)
      // After zero-width: "helloworld" + "x"*100 (110 chars)
      // After size: first 50 chars + marker
      expect(result.htmlCommentsStripped).toBe(1);
      expect(result.truncated).toBe(true);
      expect(result.body).toBe("helloworld" + "x".repeat(40) + "\n[TRUNCATED]");
    });

    it("does not truncate after comment stripping reduces size below limit", () => {
      // 19KB content + 2KB of HTML comments = 21KB raw
      const content = "a".repeat(19_000);
      const comments = "<!-- " + "c".repeat(1990) + " -->";
      const body = comments + content;

      const result = sanitizeSkillBody(body, 20_000);

      // After comment strip: 19KB content only -> under 20KB limit
      expect(result.htmlCommentsStripped).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.body).toBe(content);
    });

    it("returns correct htmlCommentsStripped count", () => {
      const body = "a <!-- c1 --> b <!-- c2 --> c";
      const result = sanitizeSkillBody(body, 1000);
      expect(result.htmlCommentsStripped).toBe(2);
    });

    it("returns correct truncated flag", () => {
      const shortResult = sanitizeSkillBody("short", 1000);
      expect(shortResult.truncated).toBe(false);

      const longResult = sanitizeSkillBody("x".repeat(200), 100);
      expect(longResult.truncated).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      const result = sanitizeSkillBody("", 1000);
      expect(result).toEqual({
        body: "",
        htmlCommentsStripped: 0,
        truncated: false,
        tagBlockDetected: false,
      });
    });

    it("handles maxBodyLength of 0", () => {
      const result = sanitizeSkillBody("some content", 0);
      expect(result.truncated).toBe(true);
      expect(result.body).toBe("\n[TRUNCATED]");
    });

    it("handles body with only HTML comments", () => {
      const result = sanitizeSkillBody("<!-- one --><!-- two --><!-- three -->", 1000);
      expect(result).toEqual({
        body: "",
        htmlCommentsStripped: 3,
        truncated: false,
        tagBlockDetected: false,
      });
    });
  });
});

describe("exported constants", () => {
  it("exports ZERO_WIDTH_REGEX with global flag", () => {
    expect(ZERO_WIDTH_REGEX).toBeInstanceOf(RegExp);
    expect(ZERO_WIDTH_REGEX.flags).toContain("g");
  });

  it("exports HTML_COMMENT_REGEX with global flag", () => {
    expect(HTML_COMMENT_REGEX).toBeInstanceOf(RegExp);
    expect(HTML_COMMENT_REGEX.flags).toContain("g");
  });

  it("exports TRUNCATION_MARKER as newline-prefixed string", () => {
    expect(TRUNCATION_MARKER).toBe("\n[TRUNCATED]");
  });
});
