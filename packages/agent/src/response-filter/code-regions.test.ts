// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import type { CodeRegion } from "./code-regions.js";

describe("findCodeRegions", () => {
  it("returns empty array for empty string", () => {
    expect(findCodeRegions("")).toEqual([]);
  });

  it("returns empty array for text without code", () => {
    expect(findCodeRegions("Just plain text")).toEqual([]);
  });

  it("finds fenced code block with backticks", () => {
    const text = "before\n```\ncode here\n```\nafter";
    const regions = findCodeRegions(text);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    const fenced = regions[0]!;
    expect(text.slice(fenced.start, fenced.end)).toContain("```");
    expect(text.slice(fenced.start, fenced.end)).toContain("code here");
  });

  it("finds fenced code block with tildes", () => {
    const text = "before\n~~~\ncode here\n~~~\nafter";
    const regions = findCodeRegions(text);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    const fenced = regions[0]!;
    expect(text.slice(fenced.start, fenced.end)).toContain("~~~");
    expect(text.slice(fenced.start, fenced.end)).toContain("code here");
  });

  it("finds inline backtick span", () => {
    const text = "Use the `<think>` tag for reasoning.";
    const regions = findCodeRegions(text);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    const inline = regions.find((r) =>
      text.slice(r.start, r.end).includes("<think>"),
    );
    expect(inline).toBeDefined();
  });

  it("finds multiple regions", () => {
    const text = "A `code1` B `code2` C";
    const regions = findCodeRegions(text);
    expect(regions.length).toBe(2);
  });

  it("does not create inline regions inside fenced blocks", () => {
    const text = "before\n```\n`inline inside fenced`\n```\nafter";
    const regions = findCodeRegions(text);
    // Only the fenced region should exist
    const fencedRegions = regions.filter((r) => {
      const content = text.slice(r.start, r.end);
      return content.includes("```");
    });
    expect(fencedRegions.length).toBe(1);
    // No separate inline region
    const inlineRegions = regions.filter((r) => {
      const content = text.slice(r.start, r.end);
      return !content.includes("```") && content.includes("`");
    });
    expect(inlineRegions.length).toBe(0);
  });

  it("handles unclosed fence (extends to end of string)", () => {
    const text = "before\n```\ncode without closing fence";
    const regions = findCodeRegions(text);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    const fenced = regions[0]!;
    // Should extend to end of string
    expect(fenced.end).toBe(text.length);
  });
});

describe("isInsideCode", () => {
  it("returns false when no regions exist", () => {
    expect(isInsideCode(5, [])).toBe(false);
  });

  it("returns true for position inside a region", () => {
    const regions: CodeRegion[] = [{ start: 10, end: 20 }];
    expect(isInsideCode(15, regions)).toBe(true);
  });

  it("returns true at exact start boundary (half-open interval)", () => {
    const regions: CodeRegion[] = [{ start: 10, end: 20 }];
    expect(isInsideCode(10, regions)).toBe(true);
  });

  it("returns false at exact end boundary (half-open interval)", () => {
    const regions: CodeRegion[] = [{ start: 10, end: 20 }];
    expect(isInsideCode(20, regions)).toBe(false);
  });

  it("returns false for position outside all regions", () => {
    const regions: CodeRegion[] = [{ start: 10, end: 20 }];
    expect(isInsideCode(5, regions)).toBe(false);
    expect(isInsideCode(25, regions)).toBe(false);
  });
});
