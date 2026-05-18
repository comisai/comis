// SPDX-License-Identifier: Apache-2.0
/**
 * Edge-keeping mask tests (design §5.5 + §2.4).
 *
 * Behavioral cases:
 *   - `maskToken("sk-1234567890abcdef")` → "sk-123…cdef"
 *   - boundary: `"a".repeat(18)` returns an edge-keeping mask shape
 *   - boundary: `"a".repeat(17)` returns the "***" short-token sentinel
 *   - explicit option overrides (MIN_LENGTH=10, KEEP_START=3)
 *   - `maskPemBlock` preserves first+last BEGIN/END line and middle is
 *     replaced with `…redacted…`
 *
 * **Codepoint assertion is load-bearing**: the ellipsis MUST be U+2026
 * (`…`). Tests pin `codePointAt(0) === 0x2026` so a literal-substitution
 * regression cannot pass.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { maskToken, maskPemBlock, REDACT_DEFAULTS } from "./edge-keeping.js";

describe("REDACT_DEFAULTS", () => {
  it("uses U+2026 ELLIPSIS (one Unicode character, not three dots)", () => {
    // The default ellipsis is the single Unicode HORIZONTAL ELLIPSIS code
    // point (U+2026, "…"), not the ASCII three-dot sequence "...". Tests
    // pin the codepoint to prevent silent regression to "...".
    const ellipsis = REDACT_DEFAULTS.ELLIPSIS;
    expect(ellipsis.length).toBe(1);
    expect(ellipsis.codePointAt(0)).toBe(0x2026);
  });

  it("exposes default MIN_LENGTH (18), KEEP_START (6), KEEP_END (4)", () => {
    expect(REDACT_DEFAULTS.MIN_LENGTH).toBe(18);
    expect(REDACT_DEFAULTS.KEEP_START).toBe(6);
    expect(REDACT_DEFAULTS.KEEP_END).toBe(4);
  });
});

describe("maskToken — edge-keeping mask for long tokens", () => {
  it("masks a 19-char token preserving 6 head + 4 tail with ellipsis between", () => {
    // "sk-1234567890abcdef" length 19 — first 6 chars ("sk-123"), last 4
    // chars ("cdef"), middle replaced with the U+2026 single-codepoint
    // ellipsis. Total output: "sk-123…cdef".
    const out = maskToken("sk-1234567890abcdef");
    expect(out).toBe("sk-123…cdef");
  });

  it("returns an edge-keeping mask at exactly the MIN_LENGTH boundary (18 chars)", () => {
    // 18 chars passes the threshold (input.length >= MIN_LENGTH).
    const out = maskToken("a".repeat(18));
    // first 6 'a' + ellipsis + last 4 'a' = "aaaaaa…aaaa" (length 11).
    expect(out).toBe("aaaaaa…aaaa");
    expect(out.includes("…")).toBe(true);
  });

  it("returns the '***' short-token sentinel for inputs below MIN_LENGTH (17 chars)", () => {
    // 17 chars is one below the 18-char threshold; the mask collapses to
    // a fixed "***" sentinel so very short tokens do not surface a
    // partial preview that would re-leak the secret.
    const out = maskToken("a".repeat(17));
    expect(out).toBe("***");
  });

  it("returns '***' for empty string input", () => {
    expect(maskToken("")).toBe("***");
  });

  it("respects explicit option overrides (minLength=10, keepStart=3, keepEnd=2)", () => {
    // 10-char input with options minLength=10 keepStart=3 keepEnd=2 →
    // first 3 + ellipsis + last 2 = "abc…ij".
    const out = maskToken("abcdefghij", {
      minLength: 10,
      keepStart: 3,
      keepEnd: 2,
    });
    expect(out).toBe("abc…ij");
  });

  it("uses explicit ellipsis override when supplied", () => {
    const out = maskToken("abcdefghijklmnopqr", {
      minLength: 10,
      keepStart: 3,
      keepEnd: 2,
      ellipsis: "***",
    });
    expect(out).toBe("abc***qr");
  });
});

describe("maskPemBlock — preserves BEGIN/END, redacts middle", () => {
  it("preserves the BEGIN/END lines and replaces the body with …redacted…", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDuY/",
      "WhO5C2hCT4DMUJZ8GgK8t2dVIfQrYwzBO5C2hCT4DMUJZ8GgK8t2dV",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const out = maskPemBlock(input);
    expect(out).toBe(
      "-----BEGIN PRIVATE KEY-----\n…redacted…\n-----END PRIVATE KEY-----",
    );
  });

  it("returns the input unchanged when no BEGIN line is present", () => {
    const input = "no pem here";
    expect(maskPemBlock(input)).toBe(input);
  });

  it("handles RSA PRIVATE KEY label", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "BODY1",
      "BODY2",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = maskPemBlock(input);
    expect(out).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\n…redacted…\n-----END RSA PRIVATE KEY-----",
    );
  });
});
