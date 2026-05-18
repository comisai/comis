// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { safeJsonStringify } from "./safe-json-stringify.js";

describe("safeJsonStringify", () => {
  describe("happy paths — passthrough JSON.stringify", () => {
    it("round-trips a plain object byte-identically to JSON.stringify", () => {
      const value = { a: 1, b: "two", c: [3, 4] };
      expect(safeJsonStringify(value)).toBe(JSON.stringify(value));
    });

    it("emits a JSON string literal for a string input", () => {
      expect(safeJsonStringify("hello")).toBe('"hello"');
    });

    it("emits a JSON number literal for a number input", () => {
      expect(safeJsonStringify(42)).toBe("42");
    });

    it("emits the literal null for a null input", () => {
      expect(safeJsonStringify(null)).toBe("null");
    });

    it("emits a serialized empty array as the literal []", () => {
      expect(safeJsonStringify([])).toBe("[]");
    });

    it("emits a serialized nested object preserving depth", () => {
      const value = { x: { y: { z: 1 } } };
      expect(safeJsonStringify(value)).toBe('{"x":{"y":{"z":1}}}');
    });
  });

  describe("error paths — return undefined instead of throwing", () => {
    it("returns undefined for a circular object reference", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj["self"] = obj;
      expect(safeJsonStringify(obj)).toBeUndefined();
    });

    it("returns undefined for a BigInt value (JSON.stringify throws TypeError on BigInt)", () => {
      expect(safeJsonStringify(BigInt(123))).toBeUndefined();
    });

    it("returns undefined for an object containing a BigInt field", () => {
      expect(safeJsonStringify({ count: BigInt(7) })).toBeUndefined();
    });

    it("returns undefined when input is undefined (JSON.stringify returns undefined for top-level undefined)", () => {
      // Note: this is NOT a thrown error path — JSON.stringify(undefined) returns
      // undefined directly. The behavior matches our spec contract: the function
      // returns `string | undefined`, and undefined is the right sentinel either way.
      expect(safeJsonStringify(undefined)).toBeUndefined();
    });

    it("returns undefined when input is a bare function (JSON.stringify returns undefined for top-level functions)", () => {
      expect(safeJsonStringify(() => 1)).toBeUndefined();
    });
  });

  describe("partial-serialization cases — JSON.stringify drops functions/undefined in non-array fields", () => {
    it("drops object fields whose value is a function (matches JSON.stringify semantics)", () => {
      const value = { keep: 1, drop: () => 2 };
      expect(safeJsonStringify(value)).toBe('{"keep":1}');
    });

    it("drops object fields whose value is undefined (matches JSON.stringify semantics)", () => {
      const value = { keep: 1, drop: undefined };
      expect(safeJsonStringify(value)).toBe('{"keep":1}');
    });
  });
});
