// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for JSON-aware truncation utility.
 *
 * Covers: arrays, objects, nested structures, non-JSON fallback,
 * malformed JSON, edge cases, and string values containing brackets.
 */

import { describe, it, expect } from "vitest";
import { truncateJsonAware } from "./json-truncate.js";

// ---------------------------------------------------------------------------
// No truncation needed
// ---------------------------------------------------------------------------

describe("truncateJsonAware - no truncation", () => {
  it("returns original text when length <= maxChars", () => {
    const text = JSON.stringify([1, 2, 3]);
    const result = truncateJsonAware(text, 1000);
    expect(result.truncated).toBe(text);
    expect(result.wasTruncated).toBe(false);
  });

  it("returns original text when length exactly equals maxChars", () => {
    const text = JSON.stringify({ a: 1 });
    const result = truncateJsonAware(text, text.length);
    expect(result.truncated).toBe(text);
    expect(result.wasTruncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSON array truncation
// ---------------------------------------------------------------------------

describe("truncateJsonAware - JSON arrays", () => {
  it("truncates array to last complete element fitting within budget", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const text = JSON.stringify(items);
    const maxChars = 500;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated.length).toBeLessThanOrEqual(maxChars);
    // Must be valid JSON
    const parsed = JSON.parse(result.truncated);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(100);
  });

  it("preserves complete elements (no partial objects)", () => {
    const items = [
      { id: 1, data: "a".repeat(50) },
      { id: 2, data: "b".repeat(50) },
      { id: 3, data: "c".repeat(50) },
    ];
    const text = JSON.stringify(items);
    const maxChars = 100;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    const parsed = JSON.parse(result.truncated);
    expect(Array.isArray(parsed)).toBe(true);
    // Each element should be complete
    for (const item of parsed) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("data");
    }
  });

  it("handles empty array within budget", () => {
    const text = "[]";
    const result = truncateJsonAware(text, 100);
    expect(result.truncated).toBe("[]");
    expect(result.wasTruncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSON object truncation
// ---------------------------------------------------------------------------

describe("truncateJsonAware - JSON objects", () => {
  it("truncates object to last complete key-value pair fitting within budget", () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      obj[`key_${i}`] = `value_${i}_${"x".repeat(20)}`;
    }
    const text = JSON.stringify(obj);
    const maxChars = 500;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated.length).toBeLessThanOrEqual(maxChars);
    // Must be valid JSON
    const parsed = JSON.parse(result.truncated);
    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed)).toBe(false);
    const keys = Object.keys(parsed);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(50);
  });

  it("handles empty object within budget", () => {
    const text = "{}";
    const result = truncateJsonAware(text, 100);
    expect(result.truncated).toBe("{}");
    expect(result.wasTruncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nested JSON structures
// ---------------------------------------------------------------------------

describe("truncateJsonAware - nested structures", () => {
  it("handles deeply nested structures (array of objects containing arrays)", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      tags: ["tag1", "tag2", "tag3"],
      nested: { x: i * 10, y: i * 20 },
    }));
    const text = JSON.stringify(items);
    const maxChars = 300;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated.length).toBeLessThanOrEqual(maxChars);
    const parsed = JSON.parse(result.truncated);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    // Each element should have complete nested structure
    for (const item of parsed) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("tags");
      expect(Array.isArray(item.tags)).toBe(true);
      expect(item).toHaveProperty("nested");
    }
  });

  it("handles 3+ levels of nesting when elements fit", () => {
    // Each nested element is small enough that multiple fit within budget
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      meta: { tags: ["a", "b"], info: { score: i * 10 } },
    }));
    const text = JSON.stringify(items);
    const maxChars = 500;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated.length).toBeLessThanOrEqual(maxChars);
    // Must be valid JSON with nested structure preserved
    const parsed = JSON.parse(result.truncated);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(30);
    // Verify nested structure is intact
    expect(parsed[0].meta.tags).toEqual(["a", "b"]);
    expect(parsed[0].meta.info).toHaveProperty("score");
  });

  it("falls back to plain slice when first entry of nested object exceeds budget", () => {
    const data = {
      level1: {
        level2: {
          level3: Array.from({ length: 10 }, (_, i) => ({ val: "x".repeat(50) + i })),
        },
      },
      other: "data",
    };
    const text = JSON.stringify(data);
    const maxChars = 200;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    // First entry is too large, so falls back to plain slice
    expect(result.truncated).toBe(text.slice(0, maxChars));
  });
});

// ---------------------------------------------------------------------------
// Non-JSON fallback
// ---------------------------------------------------------------------------

describe("truncateJsonAware - non-JSON fallback", () => {
  it("falls back to plain slice for non-JSON text", () => {
    const text = "This is plain text, not JSON at all. ".repeat(100);
    const maxChars = 200;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated).toBe(text.slice(0, maxChars));
    expect(result.truncated.length).toBe(maxChars);
  });

  it("falls back to plain slice when text starts with { but is not valid JSON", () => {
    const text = "{this is not json at all, just starts with a brace" + "x".repeat(200);
    const maxChars = 100;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated).toBe(text.slice(0, maxChars));
  });

  it("falls back to plain slice when text starts with [ but is not valid JSON", () => {
    const text = "[not json" + "y".repeat(200);
    const maxChars = 50;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated).toBe(text.slice(0, maxChars));
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("truncateJsonAware - edge cases", () => {
  it("falls back to plain slice when maxChars < 10", () => {
    const text = JSON.stringify([1, 2, 3, 4, 5]);
    const result = truncateJsonAware(text, 5);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated).toBe(text.slice(0, 5));
  });

  it("falls back to plain slice when single array element exceeds budget", () => {
    const items = [{ data: "x".repeat(1000) }];
    const text = JSON.stringify(items);
    const maxChars = 50;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    // Single element doesn't fit, so falls back to plain slice
    expect(result.truncated).toBe(text.slice(0, maxChars));
  });

  it("falls back to plain slice for JSON primitive string", () => {
    const text = JSON.stringify("hello world".repeat(100));
    const maxChars = 50;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated).toBe(text.slice(0, maxChars));
  });

  it("falls back to plain slice for JSON primitive number", () => {
    // A really long number string
    const text = "12345678901234567890";
    const maxChars = 10;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated).toBe(text.slice(0, maxChars));
  });

  it("string values containing brackets do not confuse the algorithm", () => {
    const items = [
      { msg: "Hello [world] {test}" },
      { msg: "Another {obj} [arr]" },
      { msg: "Escaped \\\"quotes\\\" here" },
    ];
    const text = JSON.stringify(items);
    // Budget enough for 2 elements but not all 3
    const singleElem = JSON.stringify([items[0]]);
    const twoElems = JSON.stringify([items[0], items[1]]);
    // Set budget between twoElems and full text
    const maxChars = twoElems.length + 5;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    const parsed = JSON.parse(result.truncated);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].msg).toBe("Hello [world] {test}");
    expect(parsed[1].msg).toBe("Another {obj} [arr]");
  });

  it("handles object where first key-value pair exceeds budget", () => {
    const obj = { longKey: "x".repeat(1000) };
    const text = JSON.stringify(obj);
    const maxChars = 50;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    // Falls back to plain slice since even one entry doesn't fit
    expect(result.truncated).toBe(text.slice(0, maxChars));
  });
});

// ---------------------------------------------------------------------------
// Recursive descent (single-element containers)
// ---------------------------------------------------------------------------

describe("truncateJsonAware - recursive descent (single-element containers)", () => {
  it("single-key object with nested object value produces valid truncated JSON", () => {
    // Build {"semiconductors": {"NVDA": {...50 chars...}, "AMD": {...50 chars...}, ... 20 stocks}}
    const inner: Record<string, unknown> = {};
    const stocks = ["NVDA", "AMD", "INTC", "QCOM", "AVGO", "TXN", "MU", "MRVL", "NXPI", "ON",
      "KLAC", "LRCX", "AMAT", "ASML", "TSM", "ADI", "MCHP", "SWKS", "QRVO", "MPWR"];
    for (const s of stocks) {
      inner[s] = { price: 130.5, volume: 1234567, change: "+2.3%" };
    }
    const data = { semiconductors: inner };
    const text = JSON.stringify(data);
    const maxChars = 300;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated.length).toBeLessThanOrEqual(maxChars);
    // Must be valid JSON
    const parsed = JSON.parse(result.truncated);
    expect(parsed).toHaveProperty("semiconductors");
    const innerKeys = Object.keys(parsed.semiconductors);
    expect(innerKeys.length).toBeGreaterThan(0);
    expect(innerKeys.length).toBeLessThan(20);
  });

  it("single-key object with nested array value produces valid truncated JSON", () => {
    const data = { results: Array.from({ length: 30 }, (_, i) => ({ id: i, val: "x".repeat(20) })) };
    const text = JSON.stringify(data);
    const maxChars = 300;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated.length).toBeLessThanOrEqual(maxChars);
    const parsed = JSON.parse(result.truncated);
    expect(parsed).toHaveProperty("results");
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.length).toBeLessThan(30);
  });

  it("single-element array wrapping a nested object produces valid truncated JSON", () => {
    const innerObj = Object.fromEntries(
      Array.from({ length: 26 }, (_, i) => [String.fromCharCode(97 + i), "val_" + i]),
    );
    const data = [innerObj];
    const text = JSON.stringify(data);
    const maxChars = 150;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated.length).toBeLessThanOrEqual(maxChars);
    const parsed = JSON.parse(result.truncated);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const objKeys = Object.keys(parsed[0]);
    expect(objKeys.length).toBeGreaterThan(0);
    expect(objKeys.length).toBeLessThan(26);
  });

  it("deep nesting (3+ levels) still produces valid JSON", () => {
    const data = {
      outer: {
        mid: {
          inner: Array.from({ length: 20 }, (_, i) => ({ n: i, d: "x".repeat(30) })),
        },
      },
    };
    const text = JSON.stringify(data);
    const maxChars = 400;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated.length).toBeLessThanOrEqual(maxChars);
    const parsed = JSON.parse(result.truncated);
    expect(parsed).toHaveProperty("outer");
    expect(parsed.outer).toHaveProperty("mid");
    expect(parsed.outer.mid).toHaveProperty("inner");
    expect(Array.isArray(parsed.outer.mid.inner)).toBe(true);
    expect(parsed.outer.mid.inner.length).toBeGreaterThan(0);
    expect(parsed.outer.mid.inner.length).toBeLessThan(20);
  });

  it("terminal case: single-key with primitive string value falls back to .slice()", () => {
    const data = { longKey: "x".repeat(1000) };
    const text = JSON.stringify(data);
    const maxChars = 50;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated).toBe(text.slice(0, maxChars));
  });

  it("terminal case: single-element array with primitive falls back to .slice()", () => {
    const data = ["x".repeat(1000)];
    const text = JSON.stringify(data);
    const maxChars = 50;
    const result = truncateJsonAware(text, maxChars);

    expect(result.wasTruncated).toBe(true);
    expect(result.truncated).toBe(text.slice(0, maxChars));
  });
});
