import { describe, it, expect } from "vitest";
import { sanitizeFts5Query } from "./fts5-sanitizer.js";

describe("sanitizeFts5Query", () => {
  it("preserves balanced quoted phrases", () => {
    expect(sanitizeFts5Query('"exact phrase" other')).toBe('"exact phrase" other');
  });

  it("strips unmatched FTS5-special characters", () => {
    expect(sanitizeFts5Query("hello + world {test}")).toBe("hello world test");
  });

  it("collapses repeated stars to single star", () => {
    expect(sanitizeFts5Query("test***")).toBe("test*");
  });

  it("removes leading star", () => {
    expect(sanitizeFts5Query("*test")).toBe("test");
  });

  it("removes dangling AND at start", () => {
    expect(sanitizeFts5Query("AND query")).toBe("query");
  });

  it("removes dangling OR at end", () => {
    expect(sanitizeFts5Query("query OR")).toBe("query");
  });

  it("returns original when result would be empty (standalone NOT)", () => {
    expect(sanitizeFts5Query("NOT")).toBe("NOT");
  });

  it("wraps dotted terms in double quotes", () => {
    expect(sanitizeFts5Query("P2.2 search")).toBe('"P2.2" search');
  });

  it("wraps multi-dotted terms in double quotes", () => {
    expect(sanitizeFts5Query("v1.0.3 release")).toBe('"v1.0.3" release');
  });

  it("wraps hyphenated terms in double quotes", () => {
    expect(sanitizeFts5Query("chat-send log")).toBe('"chat-send" log');
  });

  it("wraps multi-hyphenated terms in double quotes", () => {
    expect(sanitizeFts5Query("foo-bar-baz test")).toBe('"foo-bar-baz" test');
  });

  it("handles mixed edge case: quoted phrase + special + dotted + dangling operator", () => {
    expect(sanitizeFts5Query('"my phrase" + P2.2 AND')).toBe('"my phrase" "P2.2"');
  });

  it("returns trimmed original for empty/whitespace input", () => {
    expect(sanitizeFts5Query("")).toBe("");
    expect(sanitizeFts5Query("   ")).toBe("");
  });

  it("passes already-clean queries through unchanged", () => {
    expect(sanitizeFts5Query("simple search")).toBe("simple search");
  });

  it("strips braces from import-style queries", () => {
    // import { Type } from -> strips { and }
    expect(sanitizeFts5Query("import { Type } from")).toBe("import Type from");
  });

  it("collapses internal whitespace after stripping", () => {
    expect(sanitizeFts5Query("hello  +  world")).toBe("hello world");
  });

  it("handles parentheses removal", () => {
    expect(sanitizeFts5Query("test (group) query")).toBe("test group query");
  });

  it("handles backslash removal", () => {
    // Backslashes are stripped; adjacent chars merge (no space inserted)
    expect(sanitizeFts5Query("path\\to\\file")).toBe("pathtofile");
    // With spaces around backslashes, tokens remain separate
    expect(sanitizeFts5Query("path \\to\\ file")).toBe("path to file");
  });

  it("handles caret removal", () => {
    // Caret stripped; adjacent chars merge
    expect(sanitizeFts5Query("test^2")).toBe("test2");
    expect(sanitizeFts5Query("test ^ 2")).toBe("test 2");
  });

  it("preserves trailing wildcard star", () => {
    expect(sanitizeFts5Query("test*")).toBe("test*");
  });

  it("removes per-token leading stars", () => {
    expect(sanitizeFts5Query("hello *world")).toBe("hello world");
  });

  it("handles null-ish input gracefully", () => {
    expect(sanitizeFts5Query(undefined as unknown as string)).toBe("");
    expect(sanitizeFts5Query(null as unknown as string)).toBe("");
  });
});
