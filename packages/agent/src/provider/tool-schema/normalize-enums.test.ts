// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { normalizeAnyOfToEnum } from "./normalize-enums.js";

describe("normalizeAnyOfToEnum", () => {
  describe("anyOf/const to enum conversion", () => {
    it("converts simple 2-value anyOf/const to enum", () => {
      const input = {
        anyOf: [
          { const: "read", type: "string" },
          { const: "write", type: "string" },
        ],
      };

      const result = normalizeAnyOfToEnum(input) as Record<string, unknown>;

      expect(result).toEqual({
        type: "string",
        enum: ["read", "write"],
      });
    });

    it("converts 3+ value anyOf/const to enum", () => {
      const input = {
        anyOf: [
          { const: "low", type: "string" },
          { const: "medium", type: "string" },
          { const: "high", type: "string" },
          { const: "critical", type: "string" },
        ],
      };

      const result = normalizeAnyOfToEnum(input) as Record<string, unknown>;

      expect(result).toEqual({
        type: "string",
        enum: ["low", "medium", "high", "critical"],
      });
    });

    it("preserves description from parent alongside converted enum", () => {
      const input = {
        description: "The severity level of the alert",
        anyOf: [
          { const: "info", type: "string" },
          { const: "warn", type: "string" },
          { const: "error", type: "string" },
        ],
      };

      const result = normalizeAnyOfToEnum(input) as Record<string, unknown>;

      expect(result).toEqual({
        type: "string",
        enum: ["info", "warn", "error"],
        description: "The severity level of the alert",
      });
    });

    it("converts single-value anyOf/const to enum", () => {
      const input = {
        anyOf: [{ const: "only", type: "string" }],
      };

      const result = normalizeAnyOfToEnum(input) as Record<string, unknown>;

      expect(result).toEqual({
        type: "string",
        enum: ["only"],
      });
    });
  });

  describe("recursive conversion", () => {
    it("converts nested anyOf/const inside properties", () => {
      const input = {
        type: "object",
        properties: {
          action: {
            anyOf: [
              { const: "start", type: "string" },
              { const: "stop", type: "string" },
            ],
          },
          name: { type: "string" },
        },
      };

      const result = normalizeAnyOfToEnum(input) as Record<string, unknown>;
      const props = result.properties as Record<string, Record<string, unknown>>;

      expect(props.action).toEqual({
        type: "string",
        enum: ["start", "stop"],
      });
      expect(props.name).toEqual({ type: "string" });
    });

    it("converts deeply nested schemas (properties > properties > anyOf/const)", () => {
      const input = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              level: {
                anyOf: [
                  { const: "debug", type: "string" },
                  { const: "info", type: "string" },
                ],
              },
            },
          },
        },
      };

      const result = normalizeAnyOfToEnum(input) as Record<string, unknown>;
      const config = (result.properties as Record<string, Record<string, unknown>>).config;
      const level = (config.properties as Record<string, Record<string, unknown>>).level;

      expect(level).toEqual({
        type: "string",
        enum: ["debug", "info"],
      });
    });

    it("converts anyOf/const inside items", () => {
      const input = {
        type: "array",
        items: {
          anyOf: [
            { const: "a", type: "string" },
            { const: "b", type: "string" },
          ],
        },
      };

      const result = normalizeAnyOfToEnum(input) as Record<string, unknown>;

      expect(result.items).toEqual({
        type: "string",
        enum: ["a", "b"],
      });
    });

    it("converts anyOf/const inside tuple items array", () => {
      const input = {
        type: "array",
        items: [
          {
            anyOf: [
              { const: "x", type: "string" },
              { const: "y", type: "string" },
            ],
          },
          { type: "number" },
        ],
      };

      const result = normalizeAnyOfToEnum(input) as Record<string, unknown>;
      const items = result.items as unknown[];

      expect(items[0]).toEqual({ type: "string", enum: ["x", "y"] });
      expect(items[1]).toEqual({ type: "number" });
    });
  });

  describe("non-conversion cases", () => {
    it("does NOT convert mixed-type anyOf (string + number)", () => {
      const input = {
        anyOf: [{ type: "string" }, { type: "number" }],
      };

      const result = normalizeAnyOfToEnum(input);

      expect(result).toEqual(input);
    });

    it("does NOT convert anyOf with non-const elements", () => {
      const input = {
        anyOf: [
          { type: "string", minLength: 1 },
          { type: "string", maxLength: 100 },
        ],
      };

      const result = normalizeAnyOfToEnum(input);

      expect(result).toEqual(input);
    });

    it("does NOT convert anyOf with numeric const values", () => {
      const input = {
        anyOf: [
          { const: 1, type: "number" },
          { const: 2, type: "number" },
        ],
      };

      const result = normalizeAnyOfToEnum(input);

      // Preserved as-is (const is number, not string)
      expect(result).toEqual(input);
    });

    it("does NOT convert anyOf with mixed const and non-const", () => {
      const input = {
        anyOf: [
          { const: "a", type: "string" },
          { type: "number" },
        ],
      };

      const result = normalizeAnyOfToEnum(input);

      expect(result).toEqual(input);
    });

    it("handles empty anyOf array (returns as-is)", () => {
      const input = {
        anyOf: [],
      };

      const result = normalizeAnyOfToEnum(input);

      expect(result).toEqual({ anyOf: [] });
    });
  });

  describe("edge cases", () => {
    it("passes through null unchanged", () => {
      expect(normalizeAnyOfToEnum(null)).toBeNull();
    });

    it("passes through undefined unchanged", () => {
      expect(normalizeAnyOfToEnum(undefined)).toBeUndefined();
    });

    it("passes through primitives unchanged", () => {
      expect(normalizeAnyOfToEnum(42)).toBe(42);
      expect(normalizeAnyOfToEnum("hello")).toBe("hello");
      expect(normalizeAnyOfToEnum(true)).toBe(true);
    });

    it("passes through top-level arrays unchanged", () => {
      const input = [1, 2, 3];
      expect(normalizeAnyOfToEnum(input)).toEqual([1, 2, 3]);
    });

    it("does not mutate input", () => {
      const input = {
        type: "object",
        properties: {
          action: {
            anyOf: [
              { const: "start", type: "string" },
              { const: "stop", type: "string" },
            ],
          },
        },
      };
      const snapshot = JSON.stringify(input);

      normalizeAnyOfToEnum(input);

      expect(JSON.stringify(input)).toBe(snapshot);
    });
  });
});
