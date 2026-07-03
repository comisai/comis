// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram callback_data budget tests.
 *
 * Truncating a signed `callback_data` corrupts its HMAC, so
 * `validateCallbackDataWithinBudget` MUST refuse loud (`err`) on overflow
 * rather than silently cut bytes. These tests pin:
 *   - <=64-byte data returns `ok(data)` unchanged,
 *   - >64-byte data returns `err({kind:"callback_data_overflow", bytes, maxBytes})`,
 *   - the byte length (UTF-8), not the char length, is what is measured,
 *   - every payload the real signer (`renderCallbackData`) emits survives the budget
 *     (worst case is ~40 bytes, well under 64) — corruption can never reach the wire.
 */
import { describe, it, expect } from "vitest";
import { renderCallbackData } from "@comis/core";
import { validateCallbackDataWithinBudget } from "../rich-renderer.js";

// A representative signed payload: v1.<choice>.<12-char shortId>.<16-char base64url hmac> = 40 bytes.
const SIGNED_40_BYTE = "v1.approve.ABCDEFGHJKLM.abcdABCD1234_-XY";
// Neutral test secret + a valid base62/12 shortId for the real-signer survival cases.
const SECRET = "test-callback-signing-secret";
const SHORT_ID = "ABCDEFGHJKLM";

describe("validateCallbackDataWithinBudget", () => {
  it("returns ok with the unchanged data for a 40-byte signed payload", () => {
    const result = validateCallbackDataWithinBudget(SIGNED_40_BYTE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(SIGNED_40_BYTE);
    }
  });

  it("returns ok for data that is exactly 64 bytes (the budget boundary)", () => {
    const exactly64 = "a".repeat(64);
    expect(new TextEncoder().encode(exactly64).length).toBe(64);
    const result = validateCallbackDataWithinBudget(exactly64);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(exactly64);
    }
  });

  it("returns a callback_data_overflow err for a 65-byte string without truncating", () => {
    const overBudget = "a".repeat(65);
    const result = validateCallbackDataWithinBudget(overBudget);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "callback_data_overflow",
        bytes: 65,
        maxBytes: 64,
      });
    }
  });

  it("measures UTF-8 byte length, not char length, so a 33-char multi-byte string overflows", () => {
    // 33 × 2-byte chars = 66 bytes, but only 33 characters (<= 64 chars).
    const multiByte = "é".repeat(33);
    expect([...multiByte].length).toBe(33);
    expect(new TextEncoder().encode(multiByte).length).toBe(66);
    const result = validateCallbackDataWithinBudget(multiByte);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "callback_data_overflow",
        bytes: 66,
        maxBytes: 64,
      });
    }
  });

  it("never truncates: an over-budget input is rejected, not returned shortened", () => {
    const overBudget = "v1.approve.ABCDEFGHJKLM." + "x".repeat(80);
    const result = validateCallbackDataWithinBudget(overBudget);
    // The old truncateCallbackData would have returned a 64-byte prefix here,
    // silently corrupting the signature. The new contract is a hard err.
    expect(result.ok).toBe(false);
  });

  it("passes every signed callback the real renderCallbackData emits within budget", () => {
    // The CallbackChoice union (core/security/callback-signing.ts) is exactly these three.
    for (const choice of ["approve", "deny", "details"] as const) {
      const signed = renderCallbackData(SECRET, choice, SHORT_ID);
      expect(signed.ok).toBe(true);
      if (!signed.ok) continue;
      const within = validateCallbackDataWithinBudget(signed.value);
      expect(within.ok).toBe(true);
      if (within.ok) {
        expect(within.value).toBe(signed.value);
      }
    }
  });
});
