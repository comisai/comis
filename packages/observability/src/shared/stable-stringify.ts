// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical (digest-stable) JSON serializer.
 *
 * Emits object keys in lexicographic order at every depth so that two
 * semantically-equal inputs produce byte-identical output. Used by the
 * observability substrate when downstream consumers want to hash or
 * dedupe diagnostic payloads (the digest stability invariant: hash(stable)
 * is a function of the value, not the insertion order).
 *
 * Array element order is preserved — arrays are sequences, not maps;
 * reordering them would change the semantic.
 *
 * Behavior in all other respects matches `JSON.stringify` (undefined /
 * function fields in objects are dropped; undefined / functions in array
 * slots become `null`; primitives passthrough). Circular references
 * throw the same `TypeError` that `JSON.stringify` would — callers that
 * need a non-throwing wrapper should call `safeJsonStringify` first or
 * pass through `safeJsonStringify(stableStringify(...))`.
 *
 * @module
 */

/** Type guard for plain objects (not arrays, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursive normalizer: walks the value, returns a new shape with
 * sorted object keys. Array order is preserved. `undefined` and
 * function values inside objects are dropped (the caller's
 * `JSON.stringify` of the result then produces the canonical bytes
 * — JSON.stringify is the only reliable way to get correct string
 * escaping for nested strings).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (isPlainObject(value)) {
    const sortedKeys = Object.keys(value).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const v = value[key];
      // Drop undefined and function values to match JSON.stringify.
      if (v === undefined || typeof v === "function") continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/**
 * JSON-serialize `value` with sorted object keys at every depth.
 *
 * Two semantically-equal inputs always produce identical output — the
 * digest-stability invariant.
 *
 * @param value - any JSON-serializable JavaScript value
 * @returns the canonical JSON string
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
