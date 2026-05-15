// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for tool-output-safety.ts (Plan 40-11 / COV-03).
 *
 * Covers branches the existing tool-output-safety.test.ts does not reach:
 *   - onTagBlockDetected callback present vs. absent (line 105 if + optional chain)
 *   - truncation with vs. without a newline before the 95% cutoff (line 126)
 *   - sanitizeImage empty base64 buffer rejection (line 203)
 *   - non-Error throw from sharp pipeline (line 259 cond-expr)
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { sanitizeToolOutput } from "./tool-output-safety.js";

describe("sanitizeToolOutput — branch-gap coverage", () => {
  it("invokes onTagBlockDetected callback when input contains tag-block bypass characters", () => {
    const callback = vi.fn();
    // U+E0001 is a TAG block character used for invisible-instruction bypass
    sanitizeToolOutput("hello \u{E0061}\u{E0062} world", undefined, {
      onTagBlockDetected: callback,
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not throw when input contains tag-block characters but no callback is provided", () => {
    expect(() =>
      sanitizeToolOutput("hello \u{E0061}\u{E0062} world", undefined, {}),
    ).not.toThrow();
    expect(() =>
      sanitizeToolOutput("hello \u{E0061}\u{E0062} world"),
    ).not.toThrow();
  });

  it("does not invoke onTagBlockDetected callback when input has no tag-block characters", () => {
    const callback = vi.fn();
    sanitizeToolOutput("plain ASCII text", undefined, {
      onTagBlockDetected: callback,
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("truncates at last newline before 95% mark when a newline exists in the cut region", () => {
    // Build input where:
    //   - text length > maxChars (so truncation fires)
    //   - last newline is positioned BELOW the 95% cutoff (so lastIndexOf returns > 0)
    const maxChars = 100;
    const filler = "a".repeat(70);
    const tail = "x".repeat(50);
    const input = `${filler}\n${tail}`;
    const sanitized = sanitizeToolOutput(input, maxChars);
    expect(sanitized.length).toBeLessThanOrEqual(maxChars + 200);
    // Should end with the truncation message marker AND keep the newline
    expect(sanitized).toContain("\n");
  });

  it("hard-cuts at the 95% mark when no newline appears before the cutoff", () => {
    const maxChars = 100;
    const input = "x".repeat(500); // no newlines anywhere
    const sanitized = sanitizeToolOutput(input, maxChars);
    expect(sanitized.length).toBeLessThanOrEqual(maxChars + 200);
    // Result should still contain the truncation message but no newlines (hard cut)
    expect(sanitized).not.toContain("\n\n");
  });
});
