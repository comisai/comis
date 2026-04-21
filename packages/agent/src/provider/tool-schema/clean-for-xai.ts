// SPDX-License-Identifier: Apache-2.0
/**
 * xAI-specific constraint keyword stripping.
 *
 * Recursively builds new schema objects with 14 xAI-rejected constraint
 * keywords removed at all nesting depths. Uses the same filter-and-recurse
 * pattern as the Gemini cleaner.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// xAI-rejected keywords (14 constraint keywords)
// ---------------------------------------------------------------------------

const XAI_REJECTED = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

// ---------------------------------------------------------------------------
// Recursive cleaner
// ---------------------------------------------------------------------------

/**
 * Recursively strip xAI-unsupported constraint keywords from a JSON Schema.
 *
 * Strips 14 constraint keywords from all nesting levels. Recurses into
 * `properties` (object values), `items` (single or array), and
 * `allOf`/`anyOf`/`oneOf` (array elements).
 *
 * Returns a new object tree -- never mutates the input.
 * Non-object inputs (primitives, arrays, null, undefined) pass through unchanged.
 */
export function stripXaiUnsupportedKeywords(schema: unknown): unknown {
  if (schema === null || schema === undefined) return schema;
  if (typeof schema !== "object" || Array.isArray(schema)) return schema;

  const node = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    // Skip rejected keywords
    if (XAI_REJECTED.has(key)) continue;

    // Recurse into properties (each value is a schema)
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const propsOut: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        propsOut[propName] = stripXaiUnsupportedKeywords(propSchema);
      }
      cleaned[key] = propsOut;
      continue;
    }

    // Recurse into items (single schema or array of schemas)
    if (key === "items") {
      if (Array.isArray(value)) {
        cleaned[key] = value.map((item) => stripXaiUnsupportedKeywords(item));
      } else {
        cleaned[key] = stripXaiUnsupportedKeywords(value);
      }
      continue;
    }

    // Recurse into allOf/anyOf/oneOf (array of schemas)
    if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      cleaned[key] = value.map((entry) => stripXaiUnsupportedKeywords(entry));
      continue;
    }

    // Pass through all other keys unchanged
    cleaned[key] = value;
  }

  return cleaned;
}
