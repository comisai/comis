// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { stableStringify } from "./stable-stringify.js";

describe("stableStringify", () => {
  describe("sorted-key invariant — the digest-stability guarantee", () => {
    it("emits keys in lexicographic order at the top level", () => {
      expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it("emits keys in lexicographic order at nested depth", () => {
      expect(
        stableStringify({ outer: { y: 1, x: 2 } }),
      ).toBe('{"outer":{"x":2,"y":1}}');
    });

    it("emits identical strings for two semantically-equal inputs with different insertion order", () => {
      const a = { z: 1, m: { c: 3, a: 1, b: 2 }, a: [1, 2] };
      const b = { a: [1, 2], m: { a: 1, b: 2, c: 3 }, z: 1 };
      expect(stableStringify(a)).toBe(stableStringify(b));
    });

    it("differs from JSON.stringify when the input has a non-sorted key order", () => {
      const value = { b: 1, a: 2 };
      // JSON.stringify preserves insertion order; stableStringify sorts.
      expect(JSON.stringify(value)).toBe('{"b":1,"a":2}');
      expect(stableStringify(value)).toBe('{"a":2,"b":1}');
    });
  });

  describe("array semantics — order is data, never reordered", () => {
    it("preserves array element order even when keys would sort differently", () => {
      expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
    });

    it("preserves array element order at nested depth inside an object", () => {
      expect(
        stableStringify({ list: ["c", "a", "b"] }),
      ).toBe('{"list":["c","a","b"]}');
    });

    it("recursively sorts keys inside array elements that are objects", () => {
      expect(
        stableStringify([{ b: 1, a: 2 }]),
      ).toBe('[{"a":2,"b":1}]');
    });
  });

  describe("undefined / function handling — matches JSON.stringify spec", () => {
    it("drops object fields whose value is undefined", () => {
      expect(
        stableStringify({ a: 1, b: undefined, c: 2 }),
      ).toBe('{"a":1,"c":2}');
    });

    it("drops object fields whose value is a function", () => {
      expect(
        stableStringify({ a: 1, fn: () => 1, b: 2 }),
      ).toBe('{"a":1,"b":2}');
    });

    it("emits null for array slots holding undefined (matches JSON.stringify spec)", () => {
      expect(stableStringify([1, undefined, 3])).toBe("[1,null,3]");
    });

    it("emits null for array slots holding functions (matches JSON.stringify spec)", () => {
      expect(stableStringify([1, () => 1, 3])).toBe("[1,null,3]");
    });
  });

  describe("primitive passthrough — matches JSON.stringify", () => {
    it("emits the same JSON literal as JSON.stringify for a string", () => {
      expect(stableStringify("hello")).toBe('"hello"');
    });

    it("emits the same JSON literal as JSON.stringify for a number", () => {
      expect(stableStringify(42)).toBe("42");
    });

    it("emits the same JSON literal as JSON.stringify for null", () => {
      expect(stableStringify(null)).toBe("null");
    });

    it("emits the same JSON literal as JSON.stringify for a boolean", () => {
      expect(stableStringify(true)).toBe("true");
    });
  });

  describe("edge cases", () => {
    it("emits {} for an empty object", () => {
      expect(stableStringify({})).toBe("{}");
    });

    it("emits [] for an empty array", () => {
      expect(stableStringify([])).toBe("[]");
    });

    it("emits identical strings when one input uses an extra undefined field — undefined-suppression is byte-stable", () => {
      const a = { x: 1 };
      const b = { x: 1, y: undefined };
      expect(stableStringify(a)).toBe(stableStringify(b));
    });
  });
});
