// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  buildDepthAwareInstructions,
  LANGUAGE_PRESERVATION_INSTRUCTION,
} from "./summarize-prompt-style.js";

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

  describe("WR-01: aggressive directive preserved for all depths", () => {
    it("d1 aggressive instruction differs from d1 non-aggressive — not a byte-identical wasted round-trip", () => {
      // WR-01: depth>=1 aggressive=true must differ from depth>=1 aggressive=false
      // so the Level-2 aggressive condense retry is not identical to the first pass
      const nonAggressive = buildDepthAwareInstructions(1, false);
      const aggressive = buildDepthAwareInstructions(1, true);
      expect(aggressive).not.toBe(nonAggressive);
    });

    it("d2 aggressive instruction differs from d2 non-aggressive", () => {
      const nonAggressive = buildDepthAwareInstructions(2, false);
      const aggressive = buildDepthAwareInstructions(2, true);
      expect(aggressive).not.toBe(nonAggressive);
    });

    it("d3 aggressive instruction differs from d3 non-aggressive", () => {
      const nonAggressive = buildDepthAwareInstructions(3, false);
      const aggressive = buildDepthAwareInstructions(3, true);
      expect(aggressive).not.toBe(nonAggressive);
    });

    it("aggressive directive for depth>=1 contains terse brevity hint", () => {
      // The aggressive directive should be a recognizable brevity instruction
      const aggressive1 = buildDepthAwareInstructions(1, true);
      const aggressive2 = buildDepthAwareInstructions(2, true);
      const aggressive3 = buildDepthAwareInstructions(3, true);
      // All aggressive variants must contain a brevity signal
      expect(aggressive1.toLowerCase()).toMatch(/terse|brief|concise|shorter/);
      expect(aggressive2.toLowerCase()).toMatch(/terse|brief|concise|shorter/);
      expect(aggressive3.toLowerCase()).toMatch(/terse|brief|concise|shorter/);
    });
  });

  describe("GEN-01: language-preservation sentence in every dag depth template", () => {
    // Load-bearing fragments of the single shared sentence (design §4 GEN-01, I7).
    // "never translate" pins the no-translation directive; the verbatim clause pins
    // the code-identifier carve-out — together they assert the FULL sentence is present.
    const NO_TRANSLATE_FRAGMENT = "never translate";
    const VERBATIM_FRAGMENT =
      "Keep code identifiers, file paths, tool names, and error strings verbatim.";

    // depth ∈ {0, 1, 2, 3} × aggressive ∈ {true, false} = 8 cases.
    const depths = [0, 1, 2, 3];
    const modes = [true, false];
    for (const depth of depths) {
      for (const aggressive of modes) {
        it(`depth=${depth} aggressive=${aggressive} contains the full shared language-preservation sentence`, () => {
          const result = buildDepthAwareInstructions(depth, aggressive);
          // The exported constant is the single source — the output must carry it whole.
          expect(result).toContain(LANGUAGE_PRESERVATION_INSTRUCTION);
          // Belt-and-suspenders on the two load-bearing fragments.
          expect(result).toContain(NO_TRANSLATE_FRAGMENT);
          expect(result).toContain(VERBATIM_FRAGMENT);
        });
      }
    }

    it("the exported constant itself carries both load-bearing fragments", () => {
      expect(LANGUAGE_PRESERVATION_INSTRUCTION).toContain(NO_TRANSLATE_FRAGMENT);
      expect(LANGUAGE_PRESERVATION_INSTRUCTION).toContain(VERBATIM_FRAGMENT);
      // Anchored to the dominant-language phrasing from design §4 GEN-01.
      expect(LANGUAGE_PRESERVATION_INSTRUCTION).toContain(
        "Write the summary in the dominant language of the source content",
      );
    });

    it("structural scaffolding tokens stay English — depth-0 keeps 'Files:' and 'Expand for:'", () => {
      // Regression guard: the appended sentence must not displace the existing
      // machine-parsed English scaffolding tokens (both aggressive modes).
      for (const aggressive of modes) {
        const d0 = buildDepthAwareInstructions(0, aggressive);
        expect(d0).toContain("Files:");
        expect(d0).toContain("Expand for:");
      }
    });

    it("structural scaffolding tokens stay English — depth-1 keeps '[SUPERSEDED]'", () => {
      for (const aggressive of modes) {
        const d1 = buildDepthAwareInstructions(1, aggressive);
        expect(d1).toContain("[SUPERSEDED]");
      }
    });

    it("aggressive mode still appends the terse brevity directive AFTER the shared sentence (both carried)", () => {
      // The append onto `base` precedes the aggressive ternary, so an aggressive
      // output carries BOTH the shared sentence and the terse directive.
      const aggressive = buildDepthAwareInstructions(0, true);
      expect(aggressive).toContain(LANGUAGE_PRESERVATION_INSTRUCTION);
      expect(aggressive.toLowerCase()).toContain("terse");
    });
  });
});
