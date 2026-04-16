/**
 * anyOf/const-to-enum normalization for tool schemas.
 *
 * TypeBox emits `Type.Union([Type.Literal("a"), Type.Literal("b")])` as:
 *   `{ anyOf: [{ const: "a", type: "string" }, { const: "b", type: "string" }] }`
 *
 * LLMs parse `{ type: "string", enum: ["a", "b"] }` far more reliably.
 * This module provides a recursive pure function that converts the former
 * pattern to the latter while preserving all other schema structures.
 *
 * Runs as Layer 0 (universal) in the normalization pipeline — before any
 * provider-specific cleaning.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Detection helper
// ---------------------------------------------------------------------------

/**
 * Returns true when every element in the array is a TypeBox-style
 * string-const object: `{ const: <string>, type: "string", ... }`.
 *
 * Non-string const values or elements missing `const` cause a false return,
 * preserving arbitrary `anyOf` unions (e.g., `Type.Union([Type.String(), Type.Number()])`).
 */
function isAllStringConstPattern(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  for (const el of arr) {
    if (el === null || el === undefined || typeof el !== "object" || Array.isArray(el)) {
      return false;
    }
    const node = el as Record<string, unknown>;
    if (typeof node.const !== "string") return false;
    if (node.type !== "string") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Recursive normalizer
// ---------------------------------------------------------------------------

/**
 * Recursively walk a JSON Schema and convert TypeBox `anyOf/const` patterns
 * to standard `enum` arrays.
 *
 * Converts:
 * ```json
 * { "anyOf": [{ "const": "a", "type": "string" }, { "const": "b", "type": "string" }] }
 * ```
 * To:
 * ```json
 * { "type": "string", "enum": ["a", "b"] }
 * ```
 *
 * Preserves `description` if present alongside `anyOf` on the parent node.
 * Does NOT collapse arbitrary `anyOf` unions (mixed types, non-const elements).
 * Returns new objects — never mutates the input.
 */
export function normalizeAnyOfToEnum(schema: unknown): unknown {
  if (schema === null || schema === undefined) return schema;
  if (typeof schema !== "object" || Array.isArray(schema)) return schema;

  const node = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // Check if this node's anyOf matches the all-string-const pattern
  if (Array.isArray(node.anyOf) && isAllStringConstPattern(node.anyOf)) {
    // Convert to enum
    const enumValues = (node.anyOf as Array<Record<string, unknown>>).map(
      (el) => el.const as string,
    );
    result.type = "string";
    result.enum = enumValues;

    // Preserve description if present alongside anyOf
    if (node.description !== undefined) {
      result.description = node.description;
    }

    // Copy through any other keys that aren't anyOf (rare but safe)
    for (const [key, value] of Object.entries(node)) {
      if (key === "anyOf" || key === "description") continue;
      result[key] = value;
    }

    return result;
  }

  // Not an anyOf-const pattern — recurse into known schema structures
  for (const [key, value] of Object.entries(node)) {
    // Recurse into properties (each value is a sub-schema)
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const propsOut: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        propsOut[propName] = normalizeAnyOfToEnum(propSchema);
      }
      result[key] = propsOut;
      continue;
    }

    // Recurse into items (single schema or array of schemas)
    if (key === "items") {
      if (Array.isArray(value)) {
        result[key] = value.map((item) => normalizeAnyOfToEnum(item));
      } else {
        result[key] = normalizeAnyOfToEnum(value);
      }
      continue;
    }

    // Recurse into allOf/anyOf/oneOf arrays (non-matching anyOf reaches here)
    if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      result[key] = value.map((entry) => normalizeAnyOfToEnum(entry));
      continue;
    }

    // Pass through all other keys unchanged
    result[key] = value;
  }

  return result;
}
