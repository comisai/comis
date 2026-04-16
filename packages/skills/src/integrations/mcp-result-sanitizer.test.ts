/**
 * Tests for MCP tool result sanitizer.
 *
 * Covers NFKC normalization, invisible character stripping, and combined cases.
 */

import { describe, it, expect } from "vitest";
import { sanitizeMcpToolResult } from "./mcp-result-sanitizer.js";

describe("sanitizeMcpToolResult", () => {
  it("returns empty string for empty input", () => {
    expect(sanitizeMcpToolResult("")).toBe("");
  });

  it("passes through normal ASCII text unchanged", () => {
    const text = "Hello, world! Result: 42 items found.";
    expect(sanitizeMcpToolResult(text)).toBe(text);
  });

  it("applies NFKC normalization: fullwidth chars become ASCII", () => {
    // Fullwidth "Hello" -> ASCII "Hello"
    expect(sanitizeMcpToolResult("\uFF28\uFF45\uFF4C\uFF4C\uFF4F")).toBe("Hello");
  });

  it("strips zero-width space (U+200B)", () => {
    expect(sanitizeMcpToolResult("he\u200Bllo")).toBe("hello");
  });

  it("strips BOM / ZWNBSP (U+FEFF)", () => {
    expect(sanitizeMcpToolResult("\uFEFFhello")).toBe("hello");
  });

  it("strips bidirectional overrides (U+202A-202E)", () => {
    // U+202A = LRE, U+202C = PDF
    expect(sanitizeMcpToolResult("hello\u202Aworld\u202C")).toBe("helloworld");
  });

  it("handles combined NFKC + invisible chars in same string", () => {
    // Fullwidth "A" + ZWSP + fullwidth "B"
    const input = "\uFF21\u200B\uFF22";
    expect(sanitizeMcpToolResult(input)).toBe("AB");
  });

  it("strips Mongolian vowel separator (U+180E)", () => {
    expect(sanitizeMcpToolResult("test\u180Evalue")).toBe("testvalue");
  });

  it("strips word joiner (U+2060)", () => {
    expect(sanitizeMcpToolResult("foo\u2060bar")).toBe("foobar");
  });

  it("strips invisible math operators (U+2061-2064)", () => {
    expect(sanitizeMcpToolResult("a\u2061b\u2062c\u2063d\u2064e")).toBe("abcde");
  });

  it("strips ZWNJ (U+200C) and ZWJ (U+200D)", () => {
    expect(sanitizeMcpToolResult("a\u200Cb\u200Dc")).toBe("abc");
  });

  it("strips LRM (U+200E) and RLM (U+200F)", () => {
    expect(sanitizeMcpToolResult("left\u200Eright\u200Ftext")).toBe("leftrighttext");
  });

  it("handles real-world JSON-like output with embedded zero-width chars", () => {
    const input = '{"result"\u200B: "found \u200B3 items",\u200B "status"\u200B: "ok"\u200B}';
    const expected = '{"result": "found 3 items", "status": "ok"}';
    expect(sanitizeMcpToolResult(input)).toBe(expected);
  });

  it("preserves legitimate non-ASCII characters (emoji, CJK)", () => {
    const text = "Status: OK. Items found in Tokyo.";
    expect(sanitizeMcpToolResult(text)).toBe(text);
  });
});
