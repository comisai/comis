// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for api-contracts/internals.ts (COV-03 / Plan 40-11).
 *
 * Closes the 2 missing branch-paths in stripInternalFields():
 *   - INTERNAL_SET.has(k) === true (key dropped)
 *   - INTERNAL_SET.has(k) === false (key kept)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { INTERNAL_FIELD_NAMES, stripInternalFields } from "./internals.js";

describe("stripInternalFields()", () => {
  it("drops every internal `_X` key listed in INTERNAL_FIELD_NAMES", () => {
    const params: Record<string, unknown> = {};
    for (const name of INTERNAL_FIELD_NAMES) {
      params[name] = "internal-value";
    }
    params.publicField = "kept";

    const result = stripInternalFields(params);
    for (const name of INTERNAL_FIELD_NAMES) {
      expect(result[name]).toBeUndefined();
    }
    expect(result.publicField).toBe("kept");
  });

  it("preserves every non-internal field with its original value", () => {
    const params = {
      message: "hello",
      channelId: "ch-1",
      count: 42,
      flag: true,
    };
    const result = stripInternalFields(params);
    expect(result).toEqual(params);
  });

  it("returns a fresh object without mutating the input", () => {
    const params = { _trustLevel: "high", publicField: "value" };
    const result = stripInternalFields(params);
    expect(result).not.toBe(params);
    expect(params._trustLevel).toBe("high"); // original untouched
  });

  it("returns an empty object when input has only internal fields", () => {
    const params: Record<string, unknown> = {
      _agentId: "a",
      _userId: "u",
      _tenantId: "t",
    };
    const result = stripInternalFields(params);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("exposes 15 dispatcher-injected internal field names in sorted order", () => {
    expect(INTERNAL_FIELD_NAMES).toHaveLength(15);
    const sorted = [...INTERNAL_FIELD_NAMES].sort();
    expect([...INTERNAL_FIELD_NAMES]).toEqual(sorted);
  });
});
