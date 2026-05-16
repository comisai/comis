// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic JSON serialization helper for parity-snapshot tests.
 *
 * Extracted in Phase 43 Wave 1 per AGENTS.md §2.3 rule-of-three: ~16
 * Phase 43 parity test files + the existing CONFIG-DELIV-03
 * section-registry-parity.test.ts consumer = 17 consumers; the rule of three is
 * crossed for the first time.
 *
 * Source provenance: copied verbatim from
 * packages/core/src/config/section-registry-parity.test.ts:26-44 (Phase 30
 * CONFIG-DELIV-03; commit predates Phase 30 close 2026-04-22).
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
