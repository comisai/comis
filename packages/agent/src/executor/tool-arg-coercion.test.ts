// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for per-field stringified-JSON tool-argument coercion (F-3, live 2026-06-12).
 * Use-case descriptions name the observable behavior; pure-function tests, no SDK.
 * @module
 */

import { describe, it, expect } from "vitest";
import { coerceStringifiedStructuredFields, declaredJsonTypes } from "./tool-arg-coercion.js";

const schema = (properties: Record<string, unknown>) => ({ properties });

describe("declaredJsonTypes — normalizes a schema property's declared type into a Set", () => {
  it("returns the single scalar type for the common form", () => {
    expect(declaredJsonTypes({ type: "array" })).toEqual(new Set(["array"]));
  });
  it("returns each type for the nullable-array union form", () => {
    expect(declaredJsonTypes({ type: ["array", "null"] })).toEqual(new Set(["array", "null"]));
  });
  it("returns an empty set for absent/unknown type (anyOf, missing)", () => {
    expect(declaredJsonTypes({ anyOf: [{ type: "string" }] }).size).toBe(0);
    expect(declaredJsonTypes(undefined).size).toBe(0);
  });
});

describe("coerceStringifiedStructuredFields — schema-aware stringified array/object coercion", () => {
  it("coerces a stringified array when the field is declared array (the live memory_manage.ids case)", () => {
    const { args, coercedKeys } = coerceStringifiedStructuredFields(
      { action: "delete", ids: '["728844b3"]' },
      schema({ action: { type: "string" }, ids: { type: "array", items: { type: "string" } } }),
    );
    expect(args).toEqual({ action: "delete", ids: ["728844b3"] });
    expect(coercedKeys).toEqual(["ids"]);
  });

  it("coerces a stringified object when the field is declared object", () => {
    const { args } = coerceStringifiedStructuredFields(
      { type_config: '{"agents":["a","b"],"rounds":2}' },
      schema({ type_config: { type: "object" } }),
    );
    expect(args).toEqual({ type_config: { agents: ["a", "b"], rounds: 2 } });
  });

  it("coerces array fields declared via the nullable union [array,null]", () => {
    const { args } = coerceStringifiedStructuredFields(
      { ids: '["x"]' },
      schema({ ids: { type: ["array", "null"] } }),
    );
    expect(args).toEqual({ ids: ["x"] });
  });

  it("does NOT coerce a JSON-array-shaped string when the field is declared string", () => {
    const { args, coercedKeys } = coerceStringifiedStructuredFields(
      { content: "[1,2,3]" },
      schema({ content: { type: "string" } }),
    );
    expect(args).toEqual({ content: "[1,2,3]" });
    expect(coercedKeys).toEqual([]);
  });

  it("does NOT coerce when the field type is a union that includes string (ambiguous)", () => {
    const { args } = coerceStringifiedStructuredFields(
      { v: "[1,2]" },
      schema({ v: { type: ["array", "string"] } }),
    );
    expect(args).toEqual({ v: "[1,2]" });
  });

  it("leaves a correctly-typed array value untouched and returns identity (no copy)", () => {
    const input = { action: "delete", ids: ["x", "y"] };
    const { args, coercedKeys } = coerceStringifiedStructuredFields(
      input,
      schema({ action: { type: "string" }, ids: { type: "array" } }),
    );
    expect(args).toBe(input); // identity — no needless clone
    expect(coercedKeys).toEqual([]);
  });

  it("leaves a malformed JSON string for schema validation to reject (no throw)", () => {
    const { args, coercedKeys } = coerceStringifiedStructuredFields(
      { ids: "[not json" },
      schema({ ids: { type: "array" } }),
    );
    expect(args).toEqual({ ids: "[not json" });
    expect(coercedKeys).toEqual([]);
  });

  it("does not coerce an array-typed field whose string is actually an object (type mismatch)", () => {
    const { args } = coerceStringifiedStructuredFields(
      { ids: '{"a":1}' },
      schema({ ids: { type: "array" } }),
    );
    expect(args).toEqual({ ids: '{"a":1}' }); // parsed object ≠ array → leave for validation
  });

  it("returns identity when the tool has no properties schema", () => {
    const input = { ids: '["x"]' };
    expect(coerceStringifiedStructuredFields(input, undefined).args).toBe(input);
    expect(coerceStringifiedStructuredFields(input, {}).args).toBe(input);
  });
});
