// SPDX-License-Identifier: Apache-2.0
/**
 * Branch coverage for api-contracts/internals.ts stripInternalFields():
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

  it("exposes every dispatcher-injected internal field name in sorted order", () => {
    expect(INTERNAL_FIELD_NAMES).toHaveLength(24);
    const sorted = [...INTERNAL_FIELD_NAMES].sort();
    expect([...INTERNAL_FIELD_NAMES]).toEqual(sorted);
  });

  it("includes `_capabilities` and projects it away from external callers", () => {
    // An external WS/REST caller must NOT be able to forge orchestration caps:
    // `_capabilities` is dispatcher-injected, so the strip drops it.
    expect(INTERNAL_FIELD_NAMES as readonly string[]).toContain("_capabilities");
    const result = stripInternalFields({ _capabilities: ["orch:spawn"], foo: 1 });
    expect(result).toEqual({ foo: 1 });
    expect(result._capabilities).toBeUndefined();
  });

  it("includes `_outwardStepIndex` and strips a forged inbound value", () => {
    // A jailed script must NOT be able to forge the outward-send index to
    // self-collide its own send (defeating the outward-send ledger's
    // idempotency-key dedup) or perturb ordering. The
    // strip drops any inbound `_outwardStepIndex` BEFORE the trusted cap
    // chokepoint re-injects the allocated one (strip-then-inject, like _agentId).
    expect(INTERNAL_FIELD_NAMES as readonly string[]).toContain("_outwardStepIndex");
    const result = stripInternalFields({ _outwardStepIndex: 999, foo: 1 });
    expect(result).toEqual({ foo: 1 });
    expect(result._outwardStepIndex).toBeUndefined();
  });

  it("includes `_outwardOperationId` and strips a forged inbound value", () => {
    expect(INTERNAL_FIELD_NAMES as readonly string[]).toContain("_outwardOperationId");
    const result = stripInternalFields({ _outwardOperationId: "forged-operation", foo: 1 });
    expect(result).toEqual({ foo: 1 });
    expect(result._outwardOperationId).toBeUndefined();
  });

  it("includes `_autonomyMode` and strips a forged inbound value", () => {
    // A jailed/external caller must NOT be able to forge `_autonomyMode: "max"`
    // to perturb the chokepoint's deny-vs-escalate decision. The strip drops any
    // inbound `_autonomyMode` BEFORE the chokepoint reads it; the trusted in-process
    // leg re-injects the server-resolved mode (strip-then-inject, like _agentId).
    expect(INTERNAL_FIELD_NAMES as readonly string[]).toContain("_autonomyMode");
    const result = stripInternalFields({ _autonomyMode: "max", foo: 1 });
    expect(result).toEqual({ foo: 1 });
    expect(result._autonomyMode).toBeUndefined();
  });

  it("places `_autonomyMode` immediately after `_agentId` (the canonical sort order)", () => {
    // The array is maintained in JS `.sort()`/localeCompare alphabetical order
    // (asserted by the sorted-order test above). "_agentId" < "_autonomyMode"
    // (2nd char 'g' < 'u'), so `_autonomyMode` is index 1, right after `_agentId`.
    // Catches an accidental mis-insertion of the new entry.
    expect(INTERNAL_FIELD_NAMES[0]).toBe("_agentId");
    expect(INTERNAL_FIELD_NAMES[1]).toBe("_autonomyMode");
  });
});
