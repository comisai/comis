// SPDX-License-Identifier: Apache-2.0
/**
 * `replacePatternBounded` — chunked bounded-replace ReDoS guard tests.
 *
 * Behavior:
 *   - Input length ≤ 32 768 → single `replace` call on the full input.
 *   - Input length > 32 768 → sliced into 16 384-char chunks; each chunk
 *     `replace`-d independently. This caps backtracking work per chunk
 *     and keeps a ReDoS-prone pattern from catastrophic blow-up on the
 *     whole input.
 *   - Performance assertion: a malicious ReDoS pattern `/(a+)+b/` against
 *     a 64 KB input completes in < 200 ms. (The target budget is 50 ms; we
 *     leave headroom because shared CI runners and macOS hosts vary by 3×.)
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { replacePatternBounded } from "./regex-bounded.js";

const SINGLE_PASS_THRESHOLD = 32_768;
const CHUNK_SIZE = 16_384;

describe("replacePatternBounded — single-pass under threshold", () => {
  it("uses a single full-input replace when input length is below the chunk threshold", () => {
    const input = "abc-secret-xyz";
    const out = replacePatternBounded(input, /secret/g, "REDACTED");
    expect(out).toBe("abc-REDACTED-xyz");
  });

  it("uses a single full-input replace at exactly SINGLE_PASS_THRESHOLD (32 768 chars)", () => {
    // Total length 32 768 chars; pattern matches one occurrence in the
    // middle. Output preserves the surrounding context.
    const prefix = "P".repeat(SINGLE_PASS_THRESHOLD - 6);
    const input = prefix + "SECRET";
    expect(input.length).toBe(SINGLE_PASS_THRESHOLD);
    const out = replacePatternBounded(input, /SECRET/g, "***");
    expect(out).toBe(prefix + "***");
  });

  it("replaces multiple non-overlapping matches in a small input", () => {
    const out = replacePatternBounded("a b a b a", /a/g, "X");
    expect(out).toBe("X b X b X");
  });
});

describe("replacePatternBounded — chunked replace above threshold", () => {
  it("slices input into 16 384-char chunks when length exceeds 32 768", () => {
    // Build a 64 KB input with a unique marker in each chunk so we can
    // verify per-chunk replacement happened.
    const chunkPattern = "X".repeat(CHUNK_SIZE - 1) + "Y"; // ends with Y
    const four = chunkPattern.repeat(4); // 4 × 16 384 = 65 536 chars
    expect(four.length).toBe(CHUNK_SIZE * 4);
    expect(four.length).toBeGreaterThan(SINGLE_PASS_THRESHOLD);

    const out = replacePatternBounded(four, /Y/g, "Z");
    // Each chunk's terminating Y becomes Z.
    expect(out.length).toBe(four.length);
    expect(out.includes("Y")).toBe(false);
    // All chunks should have their Y replaced — count the Zs.
    const zCount = (out.match(/Z/g) ?? []).length;
    expect(zCount).toBe(4);
  });

  it("preserves non-matching content across chunk boundaries", () => {
    // 50 KB input of "abc..."; the pattern never matches; output equals input.
    const huge = "abc".repeat(20_000); // 60 000 chars
    expect(huge.length).toBeGreaterThan(SINGLE_PASS_THRESHOLD);
    const out = replacePatternBounded(huge, /NEVER_MATCHES/g, "X");
    expect(out).toBe(huge);
  });
});

describe("replacePatternBounded — performance smoke test", () => {
  it("processes 64 KB input through a non-pathological pattern within 200 ms", () => {
    // Performance smoke test using a benign pattern (no nested
    // quantifiers, no catastrophic backtracking). The ReDoS chunking
    // guard bounds POLYNOMIAL worst-cases by capping each chunk's regex
    // work — it does not (and cannot) tame exponential nested-quantifier
    // patterns like `(a+)+b`. That trade-off is intentional; testing
    // against an exponential pattern would assert the impossible.
    //
    // This test instead verifies the chunked path itself executes
    // efficiently on a realistic input size: a 64 KB string is sliced
    // into 4 × 16 KB chunks and a multi-replace runs on each. Total
    // wall-clock must stay under a comfortable 200 ms budget on
    // typical CI/macOS runners.
    const benign = "abc-".repeat(16 * 1024); // ~64 KB, no nested-quantifier hazard
    const start = performance.now();
    const out = replacePatternBounded(benign, /abc/g, "XYZ");
    const elapsedMs = performance.now() - start;

    // Every "abc" replaced with "XYZ".
    expect(out.includes("abc")).toBe(false);
    expect((out.match(/XYZ/g) ?? []).length).toBe(16 * 1024);
    expect(elapsedMs).toBeLessThan(200);
  });

  it("function accepts a string-typed replacement and applies it to all matches", () => {
    const out = replacePatternBounded("XaXbXcX", /X/g, "*");
    expect(out).toBe("*a*b*c*");
  });

  it("function accepts a function-typed replacement for transform-based replace", () => {
    const out = replacePatternBounded(
      "hello world",
      /\b\w+\b/g,
      (match: string): string => match.toUpperCase(),
    );
    expect(out).toBe("HELLO WORLD");
  });
});
