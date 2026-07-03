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

    // Constraint-only typeless nodes used to default to
    // "string" — `{minimum: 0}` became `{type:"string", minimum:0}` and the
    // grammar forced the model to emit a string where the tool expects a
    // number/array. Inference must read the constraint family first.
    it('infers type "number" from numeric constraint keys (minimum/maximum/exclusive*/multipleOf)', () => {
      expect(cleanSchemaForGbnf({ minimum: 0 }).schema).toEqual({ minimum: 0, type: "number" });
      expect(cleanSchemaForGbnf({ maximum: 10, multipleOf: 2 }).schema).toEqual({
        maximum: 10,
        multipleOf: 2,
        type: "number",
      });
      expect(cleanSchemaForGbnf({ exclusiveMinimum: 1 }).schema).toEqual({
        exclusiveMinimum: 1,
        type: "number",
      });
      expect(cleanSchemaForGbnf({ exclusiveMaximum: 9 }).schema).toEqual({
        exclusiveMaximum: 9,
        type: "number",
      });
    });

    it('infers type "array" from array constraint keys (minItems/maxItems/uniqueItems/contains)', () => {
      expect(cleanSchemaForGbnf({ minItems: 1 }).schema).toEqual({ minItems: 1, type: "array" });
      expect(cleanSchemaForGbnf({ maxItems: 5, uniqueItems: true }).schema).toEqual({
        maxItems: 5,
        uniqueItems: true,
        type: "array",
      });
      expect(cleanSchemaForGbnf({ contains: { type: "string" } }).schema).toEqual({
        contains: { type: "string" },
        type: "array",
      });
    });

    it('string constraint keys (minLength/maxLength/pattern/format) still infer type "string"', () => {
      expect(cleanSchemaForGbnf({ minLength: 3 }).schema).toEqual({ minLength: 3, type: "string" });
      expect(cleanSchemaForGbnf({ maxLength: 9 }).schema).toEqual({ maxLength: 9, type: "string" });
      // pattern/format survive the proactive profile — only the type is added.
      expect(cleanSchemaForGbnf({ pattern: "^x$" }).schema).toEqual({
        pattern: "^x$",
        type: "string",
      });
      expect(cleanSchemaForGbnf({ format: "date" }).schema).toEqual({
        format: "date",
        type: "string",
      });
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

  describe("T4 in open-record VALUE position (never scalar-narrow patternProperties/additionalProperties values)", () => {
    // The pipeline tool's `type_config` compiled to
    // `{"type":"object","patternProperties":{"^.*$":{}}}` — an open record
    // whose VALUE schema is typeless. T4's default stamped `type:"string"`
    // onto it, so the wire schema contradicted the daemon driver (debate
    // wants `agents: array`, `rounds: number`) and the model oscillated
    // between "must be string" and "expected array, received string" forever
    // (observed live in a small-model e2e run). An open record's values must
    // stay grammar-valid (llama.cpp rejects truly typeless nodes) WITHOUT
    // lying about their type: the full JSON type union admits the identical
    // value set as `{}`.
    it("injects the full JSON type union (not string) on a typeless patternProperties VALUE schema", () => {
      const input = { type: "object", patternProperties: { "^.*$": {} } };
      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);
      const pp = (schema as Record<string, unknown>).patternProperties as Record<
        string,
        Record<string, unknown>
      >;
      expect(pp["^.*$"].type).toEqual(["object", "array", "string", "number", "boolean", "null"]);
      expect(transformedKeywords).toContain("missing_type");
    });

    it("injects the full JSON type union (not string) on a typeless additionalProperties VALUE schema", () => {
      const input = { type: "object", additionalProperties: { description: "any value" } };
      const { schema } = cleanSchemaForGbnf(input);
      const ap = (schema as Record<string, unknown>).additionalProperties as Record<
        string,
        unknown
      >;
      expect(ap.type).toEqual(["object", "array", "string", "number", "boolean", "null"]);
      expect(ap.description).toBe("any value");
    });

    it("open-record VALUE schemas with constraint hints still infer honestly (number/array/string families)", () => {
      const input = {
        type: "object",
        patternProperties: {
          "^n-": { minimum: 0 },
          "^a-": { minItems: 1 },
          "^s-": { minLength: 3 },
        },
      };
      const { schema } = cleanSchemaForGbnf(input);
      const pp = (schema as Record<string, unknown>).patternProperties as Record<
        string,
        Record<string, unknown>
      >;
      expect(pp["^n-"].type).toBe("number");
      expect(pp["^a-"].type).toBe("array");
      expect(pp["^s-"].type).toBe("string");
    });

    it("nodes NESTED INSIDE an open-record value keep the plain string default (position applies to the value node only)", () => {
      const input = {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { note: { description: "bare leaf" } },
        },
      };
      const { schema } = cleanSchemaForGbnf(input);
      const ap = (schema as Record<string, unknown>).additionalProperties as {
        properties: Record<string, Record<string, unknown>>;
      };
      expect(ap.properties.note.type).toBe("string");
    });

    it("open-record union injection is idempotent (twice = once, byte-identical)", () => {
      const input = {
        type: "object",
        patternProperties: { "^.*$": {} },
        additionalProperties: {},
      };
      const once = cleanSchemaForGbnf(input);
      const twice = cleanSchemaForGbnf(once.schema);
      expect(JSON.stringify(twice.schema)).toBe(JSON.stringify(once.schema));
      expect(twice.transformedKeywords).toEqual([]);
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

    // $defs/definitions bodies are referenced via $ref,
    // which llama.cpp RESOLVES at grammar-compile — hostility inside a
    // definition 400s exactly like inline hostility, yet both walkers passed
    // these subtrees through untouched. patternProperties values and
    // prefixItems tuples are schemas too.
    it("collapses a nullable union and injects a missing type inside $defs entries ($ref resolved at grammar-compile)", () => {
      const input = {
        type: "object",
        properties: { item: { $ref: "#/$defs/assignee" } },
        $defs: {
          assignee: { anyOf: [{ type: "string" }, { type: "null" }], description: "who" },
          note: { description: "bare leaf inside a definition" },
        },
      };

      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);

      const defs = (schema as Record<string, unknown>).$defs as Record<string, unknown>;
      expect(defs.assignee).toEqual({ type: "string", description: "who (nullable)" });
      expect(defs.note).toEqual({
        type: "string",
        description: "bare leaf inside a definition",
      });
      // The $ref node itself stays untouched (T4's $ref guard).
      expect(propsOf(schema).item).toEqual({ $ref: "#/$defs/assignee" });
      expect(transformedKeywords).toEqual(["nullable_union", "missing_type"]);
    });

    it("walks legacy `definitions` map values the same way as $defs", () => {
      const input = {
        type: "object",
        properties: {},
        definitions: { retries: { type: ["integer", "null"] } },
      };

      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);

      const defs = (schema as Record<string, unknown>).definitions as Record<string, unknown>;
      expect(defs.retries).toEqual({ type: "integer", description: "(nullable)" });
      expect(transformedKeywords).toEqual(["type_array"]);
    });

    it("walks patternProperties VALUE schemas while leaving the key regexes untouched (keys are names, not nodes)", () => {
      const input = {
        type: "object",
        properties: {},
        patternProperties: {
          "^x-": { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      };

      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);

      const pp = (schema as Record<string, unknown>).patternProperties as Record<string, unknown>;
      expect(Object.keys(pp)).toEqual(["^x-"]);
      expect(pp["^x-"]).toEqual({ type: "string", description: "(nullable)" });
      expect(transformedKeywords).toEqual(["nullable_union"]);
    });

    it("walks prefixItems tuple entries like array-form items", () => {
      const input = {
        type: "array",
        prefixItems: [
          { type: ["string", "null"] },
          { description: "bare tuple member" },
        ],
      };

      const { schema, transformedKeywords } = cleanSchemaForGbnf(input);

      const tuple = (schema as Record<string, unknown>).prefixItems as Record<string, unknown>[];
      expect(tuple[0]).toEqual({ type: "string", description: "(nullable)" });
      expect(tuple[1]).toEqual({ type: "string", description: "bare tuple member" });
      expect(transformedKeywords).toEqual(["type_array", "missing_type"]);
    });

    it("the definition/pattern/tuple recursion positions stay idempotent (twice = once, byte-identical)", () => {
      const input = {
        type: "object",
        $defs: { a: { anyOf: [{ type: "string" }, { type: "null" }] } },
        definitions: { b: { description: "bare" } },
        patternProperties: { "^p-": { type: ["integer", "null"] } },
        properties: { tup: { type: "array", prefixItems: [{ description: "m" }] } },
      };

      const once = cleanSchemaForGbnf(input);
      const twice = cleanSchemaForGbnf(once.schema);

      expect(JSON.stringify(twice.schema)).toBe(JSON.stringify(once.schema));
      expect(twice.transformedKeywords).toEqual([]);
    });
  });

  describe("pattern/format survival (proactive gbnf does NOT strip — the reactive grammar-400 remedy owns that)", () => {
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
      expect(cleanSchemaForGbnf(null)).toEqual({ schema: null, transformedKeywords: [], depthLimited: false });
      expect(cleanSchemaForGbnf(undefined)).toEqual({
        schema: undefined,
        transformedKeywords: [],
        depthLimited: false,
      });
      expect(cleanSchemaForGbnf(42)).toEqual({ schema: 42, transformedKeywords: [], depthLimited: false });
      expect(cleanSchemaForGbnf("hello")).toEqual({
        schema: "hello",
        transformedKeywords: [],
        depthLimited: false,
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

  // Third-party MCP schemas are attacker-controlled — a
  // properties chain ~4000 levels deep parses cleanly through JSON.parse at
  // the transport boundary but overflowed the un-capped walk, and the
  // RangeError propagated out of assembleTools, failing the WHOLE turn for
  // ALL tools on every message.
  describe("depth-limited recursion (attacker-controlled MCP schemas)", () => {
    function makeDeepPropertiesChain(
      depth: number,
      leaf: Record<string, unknown>,
    ): Record<string, unknown> {
      let node: Record<string, unknown> = leaf;
      for (let i = 0; i < depth; i++) {
        node = { type: "object", properties: { child: node } };
      }
      return node;
    }

    it("survives a 6000-level properties chain without a stack overflow (a depth JSON.parse survives)", () => {
      const deep = makeDeepPropertiesChain(6000, { description: "leaf" });
      expect(() => cleanSchemaForGbnf(deep)).not.toThrow();
    });

    it("fails SAFE at the cap: shallow nodes are still transformed, the deep tail passes through, and depthLimited reports the cut", () => {
      const input = {
        type: "object",
        properties: {
          shallow: { anyOf: [{ type: "string" }, { type: "null" }] },
          tail: makeDeepPropertiesChain(6000, { description: "leaf" }),
        },
      };

      const result = cleanSchemaForGbnf(input);

      expect(propsOf(result.schema).shallow).toEqual({
        type: "string",
        description: "(nullable)",
      });
      expect(result.transformedKeywords).toContain("nullable_union");
      expect(
        (result as unknown as { depthLimited?: boolean }).depthLimited,
      ).toBe(true);
    });

    it("reports depthLimited false for ordinary schemas (the hostile toolset never reaches the cap)", () => {
      for (const tool of hostileMcpToolset) {
        const result = cleanSchemaForGbnf(tool.parameters);
        expect(
          (result as unknown as { depthLimited?: boolean }).depthLimited,
        ).toBe(false);
      }
    });
  });
});
