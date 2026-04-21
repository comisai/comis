// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini", () => {
  it("strips additionalProperties, $ref, $defs from top-level", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      $ref: "#/$defs/Foo",
      $defs: { Foo: { type: "string" } },
      properties: { name: { type: "string" } },
    };
    const result = cleanSchemaForGemini(schema) as Record<string, unknown>;

    expect(result.type).toBe("object");
    expect(result.properties).toBeDefined();
    expect(result.additionalProperties).toBeUndefined();
    expect(result.$ref).toBeUndefined();
    expect(result.$defs).toBeUndefined();
  });

  it("strips $schema, if, then, else, not from top-level", () => {
    const schema = {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      if: { properties: { type: { const: "a" } } },
      then: { required: ["a"] },
      else: { required: ["b"] },
      not: { type: "null" },
    };
    const result = cleanSchemaForGemini(schema) as Record<string, unknown>;

    expect(result.type).toBe("object");
    expect(result.$schema).toBeUndefined();
    expect(result.if).toBeUndefined();
    expect(result.then).toBeUndefined();
    expect(result.else).toBeUndefined();
    expect(result.not).toBeUndefined();
  });

  it("strips patternProperties, unevaluatedProperties, unevaluatedItems", () => {
    const schema = {
      type: "object",
      patternProperties: { "^S_": { type: "string" } },
      unevaluatedProperties: false,
      unevaluatedItems: false,
    };
    const result = cleanSchemaForGemini(schema) as Record<string, unknown>;

    expect(result.patternProperties).toBeUndefined();
    expect(result.unevaluatedProperties).toBeUndefined();
    expect(result.unevaluatedItems).toBeUndefined();
  });

  it("strips dependentRequired, dependentSchemas, contentEncoding, contentMediaType", () => {
    const schema = {
      type: "object",
      dependentRequired: { bar: ["foo"] },
      dependentSchemas: { bar: { properties: { baz: { type: "number" } } } },
      contentEncoding: "base64",
      contentMediaType: "image/png",
    };
    const result = cleanSchemaForGemini(schema) as Record<string, unknown>;

    expect(result.dependentRequired).toBeUndefined();
    expect(result.dependentSchemas).toBeUndefined();
    expect(result.contentEncoding).toBeUndefined();
    expect(result.contentMediaType).toBeUndefined();
  });

  it("strips keywords from nested properties (depth 2+)", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          additionalProperties: false,
          $ref: "#/foo",
          properties: {
            nested: {
              type: "object",
              patternProperties: { "^x": { type: "string" } },
              unevaluatedProperties: false,
            },
          },
        },
      },
    };
    const result = cleanSchemaForGemini(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, Record<string, unknown>>;
    const config = props.config;

    expect(config.type).toBe("object");
    expect(config.additionalProperties).toBeUndefined();
    expect(config.$ref).toBeUndefined();

    const nestedProps = config.properties as Record<string, Record<string, unknown>>;
    expect(nestedProps.nested.patternProperties).toBeUndefined();
    expect(nestedProps.nested.unevaluatedProperties).toBeUndefined();
    expect(nestedProps.nested.type).toBe("object");
  });

  it("strips keywords inside items (array item schemas)", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        $ref: "#/defs/Item",
        properties: {
          value: { type: "string" },
        },
      },
    };
    const result = cleanSchemaForGemini(schema) as Record<string, unknown>;
    const items = result.items as Record<string, unknown>;

    expect(items.type).toBe("object");
    expect(items.additionalProperties).toBeUndefined();
    expect(items.$ref).toBeUndefined();
    expect(items.properties).toBeDefined();
  });

  it("strips keywords inside allOf/anyOf/oneOf entries", () => {
    const schema = {
      type: "object",
      allOf: [
        { type: "object", additionalProperties: false, $defs: { X: {} } },
        { type: "string", contentEncoding: "base64" },
      ],
      anyOf: [
        { type: "number", $schema: "http://json-schema.org/draft-07" },
      ],
      oneOf: [
        { type: "boolean", contentMediaType: "text/plain" },
      ],
    };
    const result = cleanSchemaForGemini(schema) as Record<string, unknown>;

    const allOf = result.allOf as Array<Record<string, unknown>>;
    expect(allOf[0].additionalProperties).toBeUndefined();
    expect(allOf[0].$defs).toBeUndefined();
    expect(allOf[0].type).toBe("object");
    expect(allOf[1].contentEncoding).toBeUndefined();
    expect(allOf[1].type).toBe("string");

    const anyOf = result.anyOf as Array<Record<string, unknown>>;
    expect(anyOf[0].$schema).toBeUndefined();
    expect(anyOf[0].type).toBe("number");

    const oneOf = result.oneOf as Array<Record<string, unknown>>;
    expect(oneOf[0].contentMediaType).toBeUndefined();
    expect(oneOf[0].type).toBe("boolean");
  });

  it("preserves non-rejected keywords (type, description, enum, required, properties)", () => {
    const schema = {
      type: "object",
      description: "A test schema",
      required: ["name"],
      properties: {
        name: { type: "string", description: "User name", enum: ["a", "b"] },
      },
    };
    const result = cleanSchemaForGemini(schema) as Record<string, unknown>;

    expect(result.type).toBe("object");
    expect(result.description).toBe("A test schema");
    expect(result.required).toEqual(["name"]);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.name.type).toBe("string");
    expect(props.name.description).toBe("User name");
    expect(props.name.enum).toEqual(["a", "b"]);
  });

  it("does not mutate input (deep equality check before/after)", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      $ref: "#/foo",
      properties: {
        x: { type: "string", patternProperties: { "^a": {} } },
      },
    };
    const originalStr = JSON.stringify(schema);

    cleanSchemaForGemini(schema);

    expect(JSON.stringify(schema)).toBe(originalStr);
  });

  it("handles empty objects", () => {
    const result = cleanSchemaForGemini({});
    expect(result).toEqual({});
  });

  it("handles non-object inputs (primitives pass through)", () => {
    expect(cleanSchemaForGemini("hello")).toBe("hello");
    expect(cleanSchemaForGemini(42)).toBe(42);
    expect(cleanSchemaForGemini(true)).toBe(true);
  });

  it("handles null gracefully", () => {
    expect(cleanSchemaForGemini(null)).toBe(null);
  });

  it("handles undefined gracefully", () => {
    expect(cleanSchemaForGemini(undefined)).toBe(undefined);
  });

  it("handles arrays at top-level (pass through as-is)", () => {
    const arr = [1, 2, 3];
    expect(cleanSchemaForGemini(arr)).toEqual([1, 2, 3]);
  });
});
