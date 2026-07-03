// SPDX-License-Identifier: Apache-2.0
/**
 * Unit coverage for the capability primitive.
 *
 * Proves the single authority predicate has NO wildcard branch (unlike
 * `checkScope`'s `*`) and that the handler-boundary gate throws a typed,
 * discriminated `CapabilityDeniedError` when the required cap is absent.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  AGENT_CAPABILITIES,
  checkCapability,
  requireCapability,
  CapabilityDeniedError,
} from "./capability.js";

describe("AGENT_CAPABILITIES", () => {
  it("is a non-empty readonly tuple of orch:* string literals", () => {
    expect(AGENT_CAPABILITIES.length).toBeGreaterThan(0);
    for (const cap of AGENT_CAPABILITIES) {
      expect(cap).toMatch(/^orch:[a-z]+$/);
    }
  });
});

describe("checkCapability (no wildcard branch)", () => {
  it("returns false when the held set does not contain the required cap", () => {
    expect(checkCapability(["orch:read"], "orch:spawn")).toBe(false);
  });

  it("returns true when the held set contains the required cap", () => {
    expect(checkCapability(["orch:spawn"], "orch:spawn")).toBe(true);
  });

  it("treats a literal `*` as an ordinary (absent) member — NO wildcard authority", () => {
    // checkScope's `*` implies-all branch must NOT exist here.
    expect(checkCapability(["*"], "orch:spawn")).toBe(false);
  });

  it("returns false for an empty held set", () => {
    expect(checkCapability([], "orch:spawn")).toBe(false);
  });
});

describe("requireCapability (handler-boundary gate)", () => {
  it("throws CapabilityDeniedError when held is undefined", () => {
    expect(() => requireCapability(undefined, "orch:spawn")).toThrow(
      CapabilityDeniedError,
    );
  });

  it("throws CapabilityDeniedError when the held set is empty", () => {
    expect(() => requireCapability([], "orch:spawn")).toThrow(
      CapabilityDeniedError,
    );
  });

  it("throws CapabilityDeniedError when the held set lacks the required cap", () => {
    expect(() => requireCapability(["orch:read"], "orch:spawn")).toThrow(
      CapabilityDeniedError,
    );
  });

  it("does NOT throw when the held set contains the required cap", () => {
    expect(() => requireCapability(["orch:spawn"], "orch:spawn")).not.toThrow();
  });

  it("the thrown error carries kind === 'capability_denied' and the required cap", () => {
    try {
      requireCapability(["orch:read"], "orch:spawn");
      expect.unreachable("requireCapability should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityDeniedError);
      const denied = err as CapabilityDeniedError;
      expect(denied.kind).toBe("capability_denied");
      expect(denied.required).toBe("orch:spawn");
      expect(denied.name).toBe("CapabilityDeniedError");
    }
  });
});
