// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the shared `fingerprint(s)` digest util.
 *
 * Pins the contract the bounded `extractErrorText` suffix + `resultDigest`,
 * the `setup-gateway-admin` messageHash, and `withDedup` all converge on:
 *   - deterministic (same input → same output)
 *   - exactly 12 lowercase-hex chars (a sha256 prefix)
 *   - 1-byte input difference changes the output
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { fingerprint } from "./fingerprint.js";

describe("fingerprint", () => {
  it("returns a 12-character lowercase-hex string and is deterministic", () => {
    const a = fingerprint("hello");
    const b = fingerprint("hello");
    expect(a).toHaveLength(12);
    expect(a).toBe(b);
  });

  it("changes when the input differs by one byte", () => {
    expect(fingerprint("hello")).not.toBe(fingerprint("hellox"));
  });

  it("matches the exact 12-hex contract", () => {
    expect(fingerprint("hello")).toMatch(/^[0-9a-f]{12}$/);
  });
});
