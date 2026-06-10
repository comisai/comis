// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { cleanSchemaForGbnf } from "./clean-for-gbnf.js";
import {
  hostileMcpTool,
  hostileMcpToolset,
  nestedHostilityTool,
  wellFormedTool,
} from "./gbnf-hostile-fixtures.js";

/** Drill into the `properties` map of a cleaned schema. */
function propsOf(schema: unknown): Record<string, Record<string, unknown>> {
  return (schema as Record<string, unknown>).properties as Record<
    string,
    Record<string, unknown>
  >;
}

describe("cleanSchemaForGbnf", () => {
  describe("T1: nullable anyOf/oneOf collapse", () => {
    it("collapses a nullable anyOf to the non-null branch, node description wins + ' (nullable)' hint", () => {
      const { schema, transformedKeywords } = cleanSchemaForGbnf(hostileMcpTool.parameters);
      expect(propsOf(schema).assignee).toEqual({
        type: "string",
        description: "who (nullable)",
      });
      expect(transformedKeywords).toContain("nullable_union");
    });

    it('collapses a nullable oneOf with an enum branch; no description anywhere becomes "(nullable)"', () => {
      const { schema } = cleanSchemaForGbnf(hostileMcpTool.parameters);
      expect(propsOf(schema).mode).toEqual({
        type: "string",
        enum: ["a", "b"],
        description: "(nullable)",
      });
    });

    it("leaves an anyOf with 3 branches untouched (removal/relaxation only — never pick-first)", () => {
      const input = {
        anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
      };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual(input);
      expect(transformedKeywords).toEqual([]);
    });

    it("leaves a 2-branch anyOf with no null branch untouched", () => {
      const input = { anyOf: [{ type: "string" }, { type: "number" }] };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual(input);
      expect(transformedKeywords).toEqual([]);
    });

    it('only a branch deep-equal to { type: "null" } counts as the null branch', () => {
      // The null-ish branch carries an extra key — NOT a deep-equal match, so untouched.
      const input = {
        oneOf: [{ type: "string" }, { type: "null", description: "x" }],
      };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual(input);
      expect(transformedKeywords).toEqual([]);
    });
  });

  describe("T2: type-array collapse", () => {
    it('collapses ["integer", "null"] to type: "integer" with the "(nullable)" hint', () => {
      const { schema, transformedKeywords } = cleanSchemaForGbnf(hostileMcpTool.parameters);
      expect(propsOf(schema).retries).toEqual({
        type: "integer",
        description: "(nullable)",
      });
      expect(transformedKeywords).toContain("type_array");
    });

    it('leaves a non-null multi-type ["string", "integer"] untouched', () => {
      const input = { type: ["string", "integer"] };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual(input);
      expect(transformedKeywords).toEqual([]);
    });

    it('leaves a 3-entry ["string", "integer", "null"] untouched (only the locked 2-element null form collapses)', () => {
      const input = { type: ["string", "integer", "null"] };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual(input);
      expect(transformedKeywords).toEqual([]);
    });
  });

  describe("T3: free-form object injection", () => {
    it("injects properties: {} on a free-form object (no properties, no additionalProperties)", () => {
      const { schema, transformedKeywords } = cleanSchemaForGbnf(hostileMcpTool.parameters);
      expect(propsOf(schema).metadata).toEqual({ type: "object", properties: {} });
      expect(transformedKeywords).toContain("free_form_object");
    });

    it("leaves an object with boolean additionalProperties untouched", () => {
      const input = { type: "object", additionalProperties: true };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual(input);
      expect(transformedKeywords).toEqual([]);
    });

    it("leaves an object with schema-valued additionalProperties untouched (no properties injected)", () => {
      const input = { type: "object", additionalProperties: { type: "string" } };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual(input);
      expect(transformedKeywords).toEqual([]);
    });
  });

  describe("T4: missing-type injection", () => {
    it('injects type: "string" on a bare description-only node (llama.cpp #19716 class)', () => {
      const { schema, transformedKeywords } = cleanSchemaForGbnf(hostileMcpTool.parameters);
      expect(propsOf(schema).note).toEqual({
        type: "string",
        description: "Value for add/replace/test operations",
      });
      expect(transformedKeywords).toContain("missing_type");
    });

    it('injects type: "object" on a typeless node that has properties', () => {
      const input = { properties: { a: { type: "string" } } };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
      });
      expect(transformedKeywords).toContain("missing_type");
    });

    it('injects type: "array" on a typeless node that has items', () => {
      const input = { items: { type: "string" } };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual({ type: "array", items: { type: "string" } });
      expect(transformedKeywords).toContain("missing_type");
    });

    it("does NOT inject a type on nodes carrying enum/const/anyOf/oneOf/allOf/$ref/not", () => {
      const carriers: Record<string, unknown>[] = [
        { enum: ["a", "b"] },
        { const: "fixed" },
        { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
        { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
        { allOf: [{ type: "string" }] },
        { $ref: "#/$defs/thing" },
        { not: { type: "string" } },
      ];
      for (const input of carriers) {
        const { schema } = cleanSchemaForGbnf(input);
        expect((schema as Record<string, unknown>).type).toBeUndefined();
      }
    });
  });

  describe("recursion into nested schema positions", () => {
    it("collapses a nullable union inside items of an array property", () => {
      const { schema, transformedKeywords } = cleanSchemaForGbnf(
        nestedHostilityTool.parameters,
      );
      expect(propsOf(schema).tags).toEqual({
        type: "array",
        items: { type: "string", description: "tag (nullable)" },
      });
      expect(transformedKeywords).toEqual(["nullable_union"]);
    });

    it("collapses a nullable union nested inside an allOf entry", () => {
      const { schema } = cleanSchemaForGbnf(nestedHostilityTool.parameters);
      expect(propsOf(schema).combo).toEqual({
        allOf: [
          {
            type: "object",
            properties: {
              deep: { type: "number", description: "(nullable)" },
            },
          },
        ],
      });
    });

    it("recurses into additionalProperties when it is an object schema (free-form transform's recursion branch)", () => {
      const input = {
        type: "object",
        additionalProperties: { anyOf: [{ type: "string" }, { type: "null" }] },
      };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      expect(schema).toEqual({
        type: "object",
        additionalProperties: { type: "string", description: "(nullable)" },
      });
      expect(transformedKeywords).toEqual(["nullable_union"]);
    });
  });

  describe("pattern/format survival (proactive gbnf does NOT strip — GBNF-02's reactive remedy owns that)", () => {
    it("keeps pattern and format on the due property after cleaning", () => {
      const { schema } = cleanSchemaForGbnf(hostileMcpTool.parameters);
      expect(propsOf(schema).due).toEqual({
        type: "string",
        pattern: "\\d{4}-\\d{2}-\\d{2}",
        format: "date",
      });
    });
  });

  describe("idempotency (twice = once)", () => {
    it("produces byte-identical schema output on a second run for every tool in the hostile toolset", () => {
      for (const tool of hostileMcpToolset) {
        const once = cleanSchemaForGbnf(tool.parameters);
        const twice = cleanSchemaForGbnf(once.schema);
        expect(JSON.stringify(twice.schema)).toBe(JSON.stringify(once.schema));
        // A clean schema reports zero transforms — the second run is a true no-op.
        expect(twice.transformedKeywords).toEqual([]);
      }
    });

    it('does not double-append the " (nullable)" hint when the description already ends with it (guarded append)', () => {
      const input = { type: ["integer", "null"], description: "retries (nullable)" };
      const { schema } = cleanSchemaForGbnf(input);
      expect(schema).toEqual({ type: "integer", description: "retries (nullable)" });
    });

    it('keeps a description that is exactly "(nullable)" stable across runs', () => {
      const input = {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "(nullable)",
      };
      const { schema } = cleanSchemaForGbnf(input);
      expect(schema).toEqual({ type: "string", description: "(nullable)" });
    });
  });

  describe("no mutation", () => {
    it("never mutates the input schema for any tool in the hostile toolset", () => {
      for (const tool of hostileMcpToolset) {
        const snapshot = JSON.stringify(tool.parameters);
        cleanSchemaForGbnf(tool.parameters);
        expect(JSON.stringify(tool.parameters)).toBe(snapshot);
      }
    });
  });

  describe("pass-throughs", () => {
    it("returns null/undefined/primitives as-is with no transforms reported", () => {
      expect(cleanSchemaForGbnf(null)).toEqual({ schema: null, transformedKeywords: [] });
      expect(cleanSchemaForGbnf(undefined)).toEqual({
        schema: undefined,
        transformedKeywords: [],
      });
      expect(cleanSchemaForGbnf(42)).toEqual({ schema: 42, transformedKeywords: [] });
      expect(cleanSchemaForGbnf("hello")).toEqual({
        schema: "hello",
        transformedKeywords: [],
      });
    });

    it("returns a top-level array as-is with no transforms reported", () => {
      const arr = [1, 2, 3];
      const { schema, transformedKeywords } = cleanSchemaForGbnf(arr);
      expect(schema).toEqual([1, 2, 3]);
      expect(transformedKeywords).toEqual([]);
    });

    it("returns a fully well-formed schema deep-equal to its input with no transforms reported", () => {
      const { schema, transformedKeywords } = cleanSchemaForGbnf(wellFormedTool.parameters);
      expect(schema).toEqual(wellFormedTool.parameters);
      expect(transformedKeywords).toEqual([]);
    });
  });

  describe("transformedKeywords reporting", () => {
    it("reports all four tokens exactly once each in stable order for the full hostile tool", () => {
      const { transformedKeywords } = cleanSchemaForGbnf(hostileMcpTool.parameters);
      expect(transformedKeywords).toEqual([
        "nullable_union",
        "type_array",
        "free_form_object",
        "missing_type",
      ]);
    });
  });
});
