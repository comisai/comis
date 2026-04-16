import { describe, it, expect } from "vitest";
import { stripXaiUnsupportedKeywords } from "./clean-for-xai.js";

describe("stripXaiUnsupportedKeywords", () => {
  it("strips all 14 constraint keywords from a schema with all of them present", () => {
    const schema = {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          pattern: "^[a-z]+$",
          format: "email",
        },
        count: {
          type: "integer",
          minimum: 0,
          maximum: 1000,
          exclusiveMinimum: -1,
          exclusiveMaximum: 1001,
          multipleOf: 5,
        },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
        },
        meta: {
          type: "object",
          minProperties: 1,
          maxProperties: 10,
        },
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;

    // String constraints stripped
    expect(props.name.minLength).toBeUndefined();
    expect(props.name.maxLength).toBeUndefined();
    expect(props.name.pattern).toBeUndefined();
    expect(props.name.format).toBeUndefined();
    expect(props.name.type).toBe("string");

    // Number constraints stripped
    expect(props.count.minimum).toBeUndefined();
    expect(props.count.maximum).toBeUndefined();
    expect(props.count.exclusiveMinimum).toBeUndefined();
    expect(props.count.exclusiveMaximum).toBeUndefined();
    expect(props.count.multipleOf).toBeUndefined();
    expect(props.count.type).toBe("integer");

    // Array constraints stripped
    expect(props.items.minItems).toBeUndefined();
    expect(props.items.maxItems).toBeUndefined();
    expect(props.items.uniqueItems).toBeUndefined();
    expect(props.items.type).toBe("array");

    // Object constraints stripped
    expect(props.meta.minProperties).toBeUndefined();
    expect(props.meta.maxProperties).toBeUndefined();
    expect(props.meta.type).toBe("object");
  });

  it("strips keywords from nested properties", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "string",
              minLength: 5,
              maxLength: 50,
              pattern: "^[A-Z]",
            },
          },
        },
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;
    const outer = (result.properties as Record<string, Record<string, unknown>>).outer;
    const inner = (outer.properties as Record<string, Record<string, unknown>>).inner;

    expect(inner.minLength).toBeUndefined();
    expect(inner.maxLength).toBeUndefined();
    expect(inner.pattern).toBeUndefined();
    expect(inner.type).toBe("string");
  });

  it("preserves structural keywords (type, description, properties, required, enum)", () => {
    const schema = {
      type: "object",
      description: "A test schema",
      required: ["name"],
      properties: {
        name: { type: "string", description: "User name", enum: ["a", "b"] },
        age: { type: "integer", description: "User age" },
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;

    expect(result.type).toBe("object");
    expect(result.description).toBe("A test schema");
    expect(result.required).toEqual(["name"]);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.name.type).toBe("string");
    expect(props.name.description).toBe("User name");
    expect(props.name.enum).toEqual(["a", "b"]);
    expect(props.age.type).toBe("integer");
    expect(props.age.description).toBe("User age");
  });

  it("does not mutate input", () => {
    const schema = {
      type: "object",
      properties: {
        x: { type: "string", minLength: 1, maxLength: 100, format: "uri" },
      },
    };
    const originalStr = JSON.stringify(schema);

    stripXaiUnsupportedKeywords(schema);

    expect(JSON.stringify(schema)).toBe(originalStr);
  });

  it("handles edge case: empty object", () => {
    expect(stripXaiUnsupportedKeywords({})).toEqual({});
  });

  it("handles edge case: non-object input", () => {
    expect(stripXaiUnsupportedKeywords("hello")).toBe("hello");
    expect(stripXaiUnsupportedKeywords(42)).toBe(42);
    expect(stripXaiUnsupportedKeywords(null)).toBe(null);
    expect(stripXaiUnsupportedKeywords(undefined)).toBe(undefined);
    expect(stripXaiUnsupportedKeywords(true)).toBe(true);
  });

  it("handles arrays at item level (items schema)", () => {
    const schema = {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        maxLength: 255,
        format: "date-time",
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;
    const items = result.items as Record<string, unknown>;

    expect(items.minLength).toBeUndefined();
    expect(items.maxLength).toBeUndefined();
    expect(items.format).toBeUndefined();
    expect(items.type).toBe("string");
  });

  it("strips keywords inside allOf/anyOf/oneOf entries", () => {
    const schema = {
      allOf: [
        { type: "string", minLength: 1 },
        { type: "number", minimum: 0, maximum: 100 },
      ],
      anyOf: [
        { type: "string", pattern: "^[a-z]" },
      ],
      oneOf: [
        { type: "integer", multipleOf: 3 },
      ],
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;

    const allOf = result.allOf as Array<Record<string, unknown>>;
    expect(allOf[0].minLength).toBeUndefined();
    expect(allOf[0].type).toBe("string");
    expect(allOf[1].minimum).toBeUndefined();
    expect(allOf[1].maximum).toBeUndefined();
    expect(allOf[1].type).toBe("number");

    const anyOf = result.anyOf as Array<Record<string, unknown>>;
    expect(anyOf[0].pattern).toBeUndefined();
    expect(anyOf[0].type).toBe("string");

    const oneOf = result.oneOf as Array<Record<string, unknown>>;
    expect(oneOf[0].multipleOf).toBeUndefined();
    expect(oneOf[0].type).toBe("integer");
  });

  it("handles arrays at top-level (pass through)", () => {
    const arr = [1, 2, 3];
    expect(stripXaiUnsupportedKeywords(arr)).toEqual([1, 2, 3]);
  });
});
