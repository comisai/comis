// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { similarity, normalizeLine } from "./apply-patch-similarity.js";

describe("similarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(similarity("hello world", "hello world")).toBe(1.0);
  });

  it("returns 1.0 for two empty strings", () => {
    expect(similarity("", "")).toBe(1.0);
  });

  it("returns 0.0 for completely different strings", () => {
    expect(similarity("abc", "xyz")).toBe(0.0);
  });

  it("returns 0.0 when one string is empty", () => {
    expect(similarity("abc", "")).toBe(0.0);
  });

  it("returns high score for partial match", () => {
    const score = similarity("const x = 1;", "const x = 2;");
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThan(1.0);
  });

  it("returns high score for indentation difference", () => {
    const score = similarity("  const x = 1;", "    const x = 1;");
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThan(1.0);
  });

  it("returns low score for significantly different lines", () => {
    const score = similarity("function foo() {", "class Bar extends Baz {");
    expect(score).toBeLessThan(0.8);
  });

  it("returns high score for short matching strings with minor difference", () => {
    const score = similarity("}", " }");
    expect(score).toBeGreaterThan(0.5);
  });

  it("scores decrease as strings diverge more", () => {
    const identical = similarity("const x = 1;", "const x = 1;");
    const similar = similarity("const x = 1;", "const x = 2;");
    const different = similarity("const x = 1;", "function foo() {");
    expect(identical).toBeGreaterThan(similar);
    expect(similar).toBeGreaterThan(different);
  });
});

describe("normalizeLine", () => {
  it("strips BOM", () => {
    expect(normalizeLine("\uFEFFhello")).toBe("hello");
  });

  it("converts smart single quotes", () => {
    expect(normalizeLine("it\u2019s")).toBe("it's");
    expect(normalizeLine("\u2018quoted\u2019")).toBe("'quoted'");
  });

  it("converts smart double quotes", () => {
    expect(normalizeLine("\u201Cquoted\u201D")).toBe('"quoted"');
  });

  it("converts en dash", () => {
    expect(normalizeLine("a\u2013b")).toBe("a-b");
  });

  it("converts em dash", () => {
    expect(normalizeLine("a\u2014b")).toBe("a-b");
  });

  it("converts NBSP to regular space", () => {
    expect(normalizeLine("hello\u00A0world")).toBe("hello world");
  });

  it("trims trailing whitespace", () => {
    expect(normalizeLine("hello   ")).toBe("hello");
  });

  it("handles multiple normalizations in one line", () => {
    expect(normalizeLine("\uFEFFit\u2019s \u201Cnice\u201D   ")).toBe(
      "it's \"nice\"",
    );
  });

  it("preserves leading whitespace", () => {
    expect(normalizeLine("  indented")).toBe("  indented");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeLine("")).toBe("");
  });
});
