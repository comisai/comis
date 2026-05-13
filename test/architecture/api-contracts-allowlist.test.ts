// SPDX-License-Identifier: Apache-2.0
/**
 * WEB-CONTRACTS-11: every contract Zod schema is built from the 12-shape
 * allowlist only.
 *
 * Walker import path per 35-PATTERNS.md OQ-1 option (a): the walker lives
 * at `scripts/contracts/walk-zod-schema.ts` (codegen home, Wave D), and
 * this test reaches across the tree to consume it. Single-source-of-truth
 * avoids drift between codegen-time and test-time enforcement.
 *
 * Wave A state (this commit): `API_CONTRACTS_ORDERED` is empty, so the
 * loop yields no `it()` blocks beyond a sanity check that the walker is
 * callable. Wave C plans expand the contract count and each contract is
 * exercised through `assertOnlyAllowlistShapes` — any forbidden shape
 * (e.g., `z.date()`, `z.refine(...)`, `z.lazy(...)`) throws with method +
 * direction + path + class name.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { API_CONTRACTS_ORDERED } from "@comis/core";
import { assertOnlyAllowlistShapes } from "../../scripts/contracts/walk-zod-schema.js";

describe("Contract registry — 12-shape allowlist (WEB-CONTRACTS-11)", () => {
  it("sanity: walker is callable", () => {
    expect(typeof assertOnlyAllowlistShapes).toBe("function");
  });

  it("API_CONTRACTS_ORDERED contains only allowlist-shape schemas", () => {
    // While registry is empty (Wave A state), this loop is a no-op
    // → trivial pass. Wave C plans add per-domain contracts; each
    // contract runs through assertOnlyAllowlistShapes, which throws on
    // any forbidden Zod shape.
    const errors: string[] = [];
    for (const c of API_CONTRACTS_ORDERED) {
      try {
        assertOnlyAllowlistShapes(c.method, "request", c.request);
      } catch (e) {
        errors.push(`${c.method} REQUEST: ${(e as Error).message}`);
      }
      try {
        assertOnlyAllowlistShapes(c.method, "response", c.response);
      } catch (e) {
        errors.push(`${c.method} RESPONSE: ${(e as Error).message}`);
      }
    }
    expect(errors, errors.join("\n---\n")).toEqual([]);
  });
});
