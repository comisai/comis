// SPDX-License-Identifier: Apache-2.0
/**
 * Every contract Zod schema is built from the 12-shape allowlist only.
 *
 * The walker lives at `scripts/contracts/walk-zod-schema.ts` (codegen home)
 * and this test reaches across the tree to consume it. Single source of
 * truth — avoids drift between codegen-time and test-time enforcement.
 *
 * Each contract in `API_CONTRACTS_ORDERED` is exercised through
 * `assertOnlyAllowlistShapes` — any forbidden shape (e.g., `z.date()`,
 * `z.refine(...)`, `z.lazy(...)`) throws with method + direction + path
 * + class name.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { API_CONTRACTS_ORDERED } from "@comis/core";
import { assertOnlyAllowlistShapes } from "../../scripts/contracts/walk-zod-schema.js";

describe("Contract registry — 12-shape allowlist", () => {
  it("sanity: walker is callable", () => {
    expect(typeof assertOnlyAllowlistShapes).toBe("function");
  });

  it("API_CONTRACTS_ORDERED contains only allowlist-shape schemas", () => {
    // Each contract runs through assertOnlyAllowlistShapes, which throws
    // on any forbidden Zod shape.
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
