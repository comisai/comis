// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic JSON serialization helper for parity-snapshot tests.
 *
 * Extracted per AGENTS.md §2.3 rule-of-three from the original
 * section-registry-parity.test.ts implementation.
 *
 * @module
 */

/**
 * Sort keys deterministically; drop `description: undefined` keys
 * consistently; produces a snapshot string that does not vary across
 * Node patch versions.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(val as Record<string, unknown>).sort()) {
          const v = (val as Record<string, unknown>)[k];
          if (v !== undefined) sorted[k] = v;
        }
        return sorted;
      }
      return val;
    },
    2,
  );
}
