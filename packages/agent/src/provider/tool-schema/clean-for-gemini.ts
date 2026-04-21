// SPDX-License-Identifier: Apache-2.0
/**
 * Gemini-specific JSON Schema deep cleaning.
 *
 * Recursively builds new schema objects with 15 Gemini-rejected keywords
 * removed at all nesting depths. Uses a filter-and-recurse pattern that
 * constructs new objects (never mutates the input).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Gemini-rejected keywords (15 total)
// ---------------------------------------------------------------------------

const GEMINI_REJECTED = new Set([
  "additionalProperties",
  "$ref",
  "$defs",
  "$schema",
  "if",
  "then",
  "else",
  "not",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "contentEncoding",
  "contentMediaType",
]);

// ---------------------------------------------------------------------------
// Recursive cleaner
// ---------------------------------------------------------------------------

/**
 * Recursively clean a JSON Schema node for Gemini compatibility.
 *
 * Strips 15 Gemini-rejected keywords from all nesting levels. Recurses
 * into `properties` (object values), `items` (single or array), and
 * `allOf`/`anyOf`/`oneOf` (array elements).
 *
 * Returns a new object tree -- never mutates the input.
 * Non-object inputs (primitives, arrays, null, undefined) pass through unchanged.
 */
export function cleanSchemaForGemini(schema: unknown): unknown {
  if (schema === null || schema === undefined) return schema;
  if (typeof schema !== "object" || Array.isArray(schema)) return schema;

  const node = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    // Skip rejected keywords
    if (GEMINI_REJECTED.has(key)) continue;

    // Recurse into properties (each value is a schema)
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const propsOut: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        propsOut[propName] = cleanSchemaForGemini(propSchema);
      }
      cleaned[key] = propsOut;
      continue;
    }

    // Recurse into items (single schema or array of schemas)
    if (key === "items") {
      if (Array.isArray(value)) {
        cleaned[key] = value.map((item) => cleanSchemaForGemini(item));
      } else {
        cleaned[key] = cleanSchemaForGemini(value);
      }
      continue;
    }

    // Recurse into allOf/anyOf/oneOf (array of schemas)
    if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      cleaned[key] = value.map((entry) => cleanSchemaForGemini(entry));
      continue;
    }

    // Pass through all other keys unchanged
    cleaned[key] = value;
  }

  return cleaned;
}
