// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 35 CONTEXT D-04: no contract request schema declares any
 * `INTERNAL_FIELD_NAMES` key.
 *
 * Internal `_X` fields are dispatcher-injected; the dispatcher strips them
 * via `stripInternalFields()` before parse. Modeling any of them in the
 * contract request schema would either (a) leak them through
 * `z.toJSONSchema`, surfacing server-only fields in the generated web
 * artifact, or (b) cause `additionalProperties: false` calls to FAIL when
 * the dispatcher injects them after the CLI sent its request (35-RESEARCH.md
 * Pitfall 6, lines 1271–1287).
 *
 * Wave A state: `API_CONTRACTS_ORDERED` is empty, so the loop body
 * executes zero times → trivial pass. Wave C contracts get checked by
 * construction.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { z, type ZodTypeAny } from "zod";
import { API_CONTRACTS_ORDERED, INTERNAL_FIELD_NAMES } from "@comis/core";

const INTERNAL_SET = new Set<string>(INTERNAL_FIELD_NAMES);

/**
 * Collect the top-level `ZodObject.shape` keys of a contract request
 * schema. Unwraps a leading `ZodOptional` / `ZodNullable` so contracts that
 * declare `request: z.object({...}).optional()` are still checked.
 */
function collectObjectKeys(schema: ZodTypeAny): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.keys(schema.shape);
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return collectObjectKeys(schema.unwrap());
  }
  return [];
}

describe("Contract registry — no INTERNAL_FIELD_NAMES in request schemas (D-04)", () => {
  it("no contract request schema declares any _X internal key", () => {
    const violations: string[] = [];
    for (const c of API_CONTRACTS_ORDERED) {
      const keys = collectObjectKeys(c.request);
      for (const k of keys) {
        if (INTERNAL_SET.has(k)) {
          violations.push(`${c.method}.request declares internal field ${k}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
