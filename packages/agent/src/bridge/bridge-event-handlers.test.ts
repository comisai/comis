// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located tests for bridge-event-handlers helpers.
 *
 * Covers the bounded extractErrorText contract: the raw tool result
 * (potentially a 53 KB body) is capped at MAX_ERROR_TEXT_CHARS and replaced
 * with a non-reversible 12-hex fingerprint() digest suffix, so neither the
 * tool-retry breaker's lastError nor the WARN log ever ingests an unbounded
 * body (an information-disclosure and context-bloat DoS threat).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { extractErrorText } from "./bridge-event-handlers.js";

const MAX_ERROR_TEXT_CHARS = 2000;

describe("extractErrorText -- bounded output", () => {
  it("caps a 53 KB input at MAX_ERROR_TEXT_CHARS + suffix overhead", () => {
    const big = "x".repeat(53_000);
    const result = extractErrorText(big);
    // cap (2000) + the digest suffix overhead (`…[+NNNNN chars, digest:<12hex>]`)
    expect(result.length).toBeLessThanOrEqual(MAX_ERROR_TEXT_CHARS + 60);
  });

  it("appends the digest suffix on overflow", () => {
    const big = "x".repeat(53_000);
    const result = extractErrorText(big);
    expect(result).toMatch(/…\[\+\d+ chars, digest:[0-9a-f]{12}\]$/);
  });

  it("returns a short input UNCHANGED (no suffix)", () => {
    const short = "Network unreachable: connection refused";
    expect(extractErrorText(short)).toBe(short);
    expect(extractErrorText(short)).not.toMatch(/digest:/);
  });

  it("returns an exactly-at-cap input UNCHANGED (no suffix at the boundary)", () => {
    const atCap = "y".repeat(MAX_ERROR_TEXT_CHARS);
    const result = extractErrorText(atCap);
    expect(result).toBe(atCap);
    expect(result).not.toMatch(/digest:/);
  });

  it("produces a stable digest suffix for the same oversized input", () => {
    const big = "z".repeat(53_000);
    const a = extractErrorText(big);
    const b = extractErrorText(big);
    expect(a).toBe(b);
    // The reported overflow count is deterministic too.
    expect(a).toContain(`[+${53_000 - MAX_ERROR_TEXT_CHARS} chars, digest:`);
  });

  it("caps a large object result (JSON.stringify path) too", () => {
    const huge = { error: "x".repeat(60_000) };
    const result = extractErrorText(huge);
    expect(result.length).toBeLessThanOrEqual(MAX_ERROR_TEXT_CHARS + 60);
    expect(result).toMatch(/…\[\+\d+ chars, digest:[0-9a-f]{12}\]$/);
  });
});
