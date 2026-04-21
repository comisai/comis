// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  detectBrokenFollowThrough,
  FOLLOW_THROUGH_PATTERNS,
  POST_COMPACTION_SAFETY_RULES,
  buildPostCompactionSafetyMessage,
} from "./response-safety-checks.js";

describe("response-safety-checks", () => {
  // ---------------------------------------------------------------------------
  // Follow-through detection (formerly follow-through-detector.test.ts)
  // ---------------------------------------------------------------------------

  describe("follow-through detection", () => {
    describe("detectBrokenFollowThrough", () => {
      it("returns broken: false when hasToolCalls is true", () => {
        const result = detectBrokenFollowThrough("Let me run that command now", true);
        expect(result.broken).toBe(false);
        expect(result.matchedPhrase).toBeUndefined();
        expect(result.correctiveMessage).toBeUndefined();
      });

      it("returns broken: false for empty response", () => {
        const result = detectBrokenFollowThrough("", false);
        expect(result.broken).toBe(false);
      });

      it("returns broken: false for whitespace-only response", () => {
        const result = detectBrokenFollowThrough("   \n  ", false);
        expect(result.broken).toBe(false);
      });

      it("returns broken: false for narrative text without promises", () => {
        const result = detectBrokenFollowThrough(
          "I searched for that earlier and found the results you wanted. The data shows a clear trend.",
          false,
        );
        expect(result.broken).toBe(false);
      });

      it("returns broken: false for past-tense descriptions", () => {
        const result = detectBrokenFollowThrough(
          "I ran the analysis yesterday and the results were positive.",
          false,
        );
        expect(result.broken).toBe(false);
      });

      // HIGH confidence patterns
      describe("high confidence patterns", () => {
        const highCases = [
          "Let me run that command for you",
          "Let me search for the file",
          "Let me check the database",
          "Let me look into that issue",
          "Let me fetch the latest data",
          "I'll run the query now",
          "I'll execute the script",
          "I'll search for those results",
          "I'll read the file contents",
          "Let me use the tool to check",
          "I'll call the API endpoint",
          "Let me pull up that information",
          "I'll open the file for you",
        ];

        for (const text of highCases) {
          it(`detects: "${text}"`, () => {
            const result = detectBrokenFollowThrough(text, false);
            expect(result.broken).toBe(true);
            expect(result.matchedPhrase).toBeTruthy();
            expect(result.correctiveMessage).toContain("didn't make any tool calls");
          });
        }
      });

      // MEDIUM confidence patterns
      describe("medium confidence patterns", () => {
        const mediumCases = [
          "I will run the analysis",
          "I will now search for the answer",
          "I will check the status",
          "I'm going to search the database",
          "I'm going to run that query",
          "I need to check the logs first",
          "I want to fetch the data first",
        ];

        for (const text of mediumCases) {
          it(`detects: "${text}"`, () => {
            const result = detectBrokenFollowThrough(text, false);
            expect(result.broken).toBe(true);
            expect(result.matchedPhrase).toBeTruthy();
          });
        }
      });

      it("generates correct corrective message", () => {
        const result = detectBrokenFollowThrough("Let me search for that file", false);
        expect(result.broken).toBe(true);
        expect(result.correctiveMessage).toBe(
          'You said you would "Let me search" but didn\'t make any tool calls. Please either perform the action now using the appropriate tool, or explain why you cannot.',
        );
      });

      it("is case-insensitive", () => {
        const result = detectBrokenFollowThrough("LET ME RUN THE COMMAND", false);
        expect(result.broken).toBe(true);
      });

      it("does not flag questions about tools", () => {
        const result = detectBrokenFollowThrough(
          "Would you like me to run the command? Just say the word.",
          false,
        );
        expect(result.broken).toBe(false);
      });

      it("does not flag conditional statements", () => {
        const result = detectBrokenFollowThrough(
          "If you need me to, I could search for that information.",
          false,
        );
        expect(result.broken).toBe(false);
      });
    });

    describe("FOLLOW_THROUGH_PATTERNS", () => {
      it("has at least 10 patterns", () => {
        expect(FOLLOW_THROUGH_PATTERNS.length).toBeGreaterThanOrEqual(10);
      });

      it("includes both high and medium confidence patterns", () => {
        const high = FOLLOW_THROUGH_PATTERNS.filter((p) => p.confidence === "high");
        const medium = FOLLOW_THROUGH_PATTERNS.filter((p) => p.confidence === "medium");
        expect(high.length).toBeGreaterThan(0);
        expect(medium.length).toBeGreaterThan(0);
      });

      it("all patterns have unique labels", () => {
        const labels = FOLLOW_THROUGH_PATTERNS.map((p) => p.label);
        expect(new Set(labels).size).toBe(labels.length);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Post-compaction safety (formerly post-compaction-safety.test.ts)
  // ---------------------------------------------------------------------------

  describe("post-compaction safety", () => {
    describe("POST_COMPACTION_SAFETY_RULES", () => {
      it("is a non-empty array", () => {
        expect(POST_COMPACTION_SAFETY_RULES.length).toBeGreaterThan(0);
      });

      it("contains critical safety rules", () => {
        const rulesText = POST_COMPACTION_SAFETY_RULES.join(" ");
        expect(rulesText).toContain("exfiltrate");
        expect(rulesText).toContain("reversible");
        expect(rulesText).toContain("external actions");
        expect(rulesText).toContain("untrusted");
        expect(rulesText).toContain("safeguards");
        expect(rulesText.toLowerCase()).toContain("comply");
      });

      it("has at least 5 rules", () => {
        expect(POST_COMPACTION_SAFETY_RULES.length).toBeGreaterThanOrEqual(5);
      });
    });

    describe("buildPostCompactionSafetyMessage", () => {
      it("starts with system note header", () => {
        const msg = buildPostCompactionSafetyMessage();
        expect(msg).toMatch(/^\[System note: Context was compacted/);
      });

      it("ends with system note footer", () => {
        const msg = buildPostCompactionSafetyMessage();
        expect(msg).toMatch(/\[End system note\]$/);
      });

      it("contains all safety rules as bullet points", () => {
        const msg = buildPostCompactionSafetyMessage();
        for (const rule of POST_COMPACTION_SAFETY_RULES) {
          expect(msg).toContain(`- ${rule}`);
        }
      });

      it("produces consistent output (pure function)", () => {
        const msg1 = buildPostCompactionSafetyMessage();
        const msg2 = buildPostCompactionSafetyMessage();
        expect(msg1).toBe(msg2);
      });

      it("is a well-formed multi-line string without personaReminder", () => {
        const msg = buildPostCompactionSafetyMessage();
        const lines = msg.split("\n");
        // Header + N rules + footer
        expect(lines.length).toBe(POST_COMPACTION_SAFETY_RULES.length + 2);
      });

      it("with no args produces same output as before (backward compat)", () => {
        const msg = buildPostCompactionSafetyMessage();
        expect(msg).toMatch(/^\[System note:/);
        expect(msg).not.toContain("[Persona reminder:");
      });

      it("with personaReminder prepends persona line before system note", () => {
        const msg = buildPostCompactionSafetyMessage("Be cheerful and witty");
        expect(msg).toMatch(/^\[Persona reminder: Be cheerful and witty\]/);
        expect(msg).toContain("[System note: Context was compacted");
        // Persona reminder appears before system note
        const personaIdx = msg.indexOf("[Persona reminder:");
        const systemIdx = msg.indexOf("[System note:");
        expect(personaIdx).toBeLessThan(systemIdx);
      });

      it("with empty string personaReminder is identical to no-arg call", () => {
        const noArg = buildPostCompactionSafetyMessage();
        const empty = buildPostCompactionSafetyMessage("");
        expect(empty).toBe(noArg);
      });

      it("with whitespace-only personaReminder is identical to no-arg call", () => {
        const noArg = buildPostCompactionSafetyMessage();
        const whitespace = buildPostCompactionSafetyMessage("   ");
        expect(whitespace).toBe(noArg);
      });

      it("with personaReminder has one extra line", () => {
        const noArg = buildPostCompactionSafetyMessage();
        const withPersona = buildPostCompactionSafetyMessage("Be fun");
        const noArgLines = noArg.split("\n").length;
        const withPersonaLines = withPersona.split("\n").length;
        expect(withPersonaLines).toBe(noArgLines + 1);
      });
    });
  });
});
