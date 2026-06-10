// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { buildDepthAwareInstructions } from "./summarize-prompt-style.js";

describe("buildDepthAwareInstructions — SUM-01 depth-keyed prompt styles", () => {
  describe("d0 (leaf extractive) — depth <= 0", () => {
    it("d0 non-aggressive instruction contains file paths and decisions", () => {
      const result = buildDepthAwareInstructions(0, false);
      expect(result).toContain("file paths");
      expect(result).toContain("decisions");
    });

    it("d0 non-aggressive instruction contains faithful and factual constraint", () => {
      const result = buildDepthAwareInstructions(0, false);
      expect(result.toLowerCase()).toContain("faithful");
    });

    it("d0 aggressive instruction is shorter or similar and contains terse keyword", () => {
      const nonAggressive = buildDepthAwareInstructions(0, false);
      const aggressive = buildDepthAwareInstructions(0, true);
      // Aggressive must contain the terse directive
      expect(aggressive.toLowerCase()).toContain("terse");
      // Aggressive length is within 20 chars of non-aggressive or longer (suffix added)
      expect(aggressive.length).toBeGreaterThanOrEqual(nonAggressive.length - 20);
    });

    it("d0 negative depth uses same extractive instruction as depth === 0", () => {
      expect(buildDepthAwareInstructions(-1, false)).toBe(buildDepthAwareInstructions(0, false));
    });
  });

  describe("d1 (chronological timeline) — depth === 1", () => {
    it("d1 instruction contains timeline and superseded markers", () => {
      const result = buildDepthAwareInstructions(1, false);
      expect(result.toLowerCase()).toContain("timeline");
      expect(result.toLowerCase()).toContain("superseded");
    });

    it("d1 instruction contains open questions reference for completeness", () => {
      const result = buildDepthAwareInstructions(1, false);
      // d1 should mention outcomes or open questions
      expect(result.toLowerCase()).toMatch(/outcome|open question/);
    });
  });

  describe("d2 (trajectory summary) — depth === 2", () => {
    it("d2 instruction contains trajectory keyword", () => {
      const result = buildDepthAwareInstructions(2, false);
      expect(result.toLowerCase()).toContain("trajectory");
    });

    it("d2 instruction references dropping minutiae or per-session detail", () => {
      const result = buildDepthAwareInstructions(2, false);
      expect(result.toLowerCase()).toMatch(/minutiae|per-session/);
    });
  });

  describe("d3+ (durable memory node) — depth >= 3", () => {
    it("d3 instruction contains memory and milestone keywords", () => {
      const result = buildDepthAwareInstructions(3, false);
      expect(result.toLowerCase()).toContain("memory");
      expect(result.toLowerCase()).toContain("milestone");
    });

    it("depth > 3 uses same d3+ instruction as depth === 3", () => {
      expect(buildDepthAwareInstructions(4, false)).toBe(buildDepthAwareInstructions(3, false));
      expect(buildDepthAwareInstructions(10, false)).toBe(buildDepthAwareInstructions(3, false));
    });
  });

  describe("depth axis — condense path gets a different prompt", () => {
    it("condense path depth 1 instruction differs from depth 0 leaf instruction", () => {
      const leaf = buildDepthAwareInstructions(0, false);
      const condensed = buildDepthAwareInstructions(1, false);
      expect(condensed).not.toBe(leaf);
    });

    it("each depth level produces a distinct instruction string", () => {
      const d0 = buildDepthAwareInstructions(0, false);
      const d1 = buildDepthAwareInstructions(1, false);
      const d2 = buildDepthAwareInstructions(2, false);
      const d3 = buildDepthAwareInstructions(3, false);
      const instructions = new Set([d0, d1, d2, d3]);
      expect(instructions.size).toBe(4);
    });
  });
});
