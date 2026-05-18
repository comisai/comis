// SPDX-License-Identifier: Apache-2.0
/**
 * Circular-safe JSON.stringify wrapper.
 *
 * Returns the JSON serialization of `value` on success, or `undefined`
 * when serialization is not possible (circular reference, BigInt,
 * top-level function, top-level `undefined`). Callers use the
 * `string | undefined` return as a sentinel for "could not serialize"
 * without paying the throw/catch overhead at every call site.
 *
 * Behavior matches `JSON.stringify` for happy paths byte-identically.
 * The only deviation is the suppression of three thrown errors:
 *   - `TypeError: Converting circular structure to JSON`
 *   - `TypeError: Do not know how to serialize a BigInt`
 *   - any other host-throw from inside `JSON.stringify` (defensive)
 *
 * Used by the observability substrate when serializing diagnostic
 * payloads where logging the failure is preferable to crashing the
 * artifact writer.
 *
 * @module
 */

/**
 * JSON-serialize `value`, returning `undefined` if `JSON.stringify`
 * throws or returns `undefined` (top-level function / undefined input).
 *
 * @param value - any JavaScript value
 * @returns the JSON string, or `undefined` on failure
 */
export function safeJsonStringify(value: unknown): string | undefined {
  try {
    const out = JSON.stringify(value);
    return out;
  } catch {
    return undefined;
  }
}
