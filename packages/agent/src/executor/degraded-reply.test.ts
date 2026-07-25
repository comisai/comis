// SPDX-License-Identifier: Apache-2.0
//
// Pure-builder unit tests for degraded-reply.ts.
//
// These tests assert that:
//   - buildDegradedReply is deterministic (same input → same output)
//   - output_starved → returns a non-empty annotation string
//   - context_exhausted → returns a non-empty synthesized reply
//   - healthy finishReasons (stop/end_turn/error) → returns undefined (strict no-op)
//   - vocabulary alignment: output_starved annotation contains "output limit" or "cut off"
//   - vocabulary alignment: context_exhausted reply contains "context window"
//   - security: context_exhausted reply does NOT contain "[Stopped:" (operator redirect leak)
//   - security: context_exhausted reply does NOT contain "too large" (must not read like the generic message-size rejection)

import { describe, it, expect } from "vitest";
import {
  buildOutputStarvedAnnotation,
  buildContextExhaustedReply,
  buildLoopDetectedReply,
  buildDegradedReply,
} from "./degraded-reply.js";
import {
  selectOutputStarvedAnnotation,
  selectContextExhaustedReply,
  selectLoopDetectedReply,
} from "./degraded-reply-i18n.js";

describe("buildDegradedReply — deterministic per endReason", () => {
  it("output_starved → returns the annotation string (non-empty)", () => {
    const annotation = buildDegradedReply("output_starved");
    expect(annotation).toBeDefined();
    expect(annotation!.length).toBeGreaterThan(0);
  });

  it("output_starved → same input → same output (deterministic, no LLM)", () => {
    const a1 = buildDegradedReply("output_starved");
    const a2 = buildDegradedReply("output_starved");
    expect(a1).toBe(a2);
  });

  it("context_exhausted → returns the synthesized reply (non-empty)", () => {
    const reply = buildDegradedReply("context_exhausted");
    expect(reply).toBeDefined();
    expect(reply!.length).toBeGreaterThan(0);
  });

  it("context_exhausted → same input → same output (deterministic, no LLM)", () => {
    const r1 = buildDegradedReply("context_exhausted");
    const r2 = buildDegradedReply("context_exhausted");
    expect(r1).toBe(r2);
  });

  it("healthy cause (stop) → returns undefined (strict no-op)", () => {
    expect(buildDegradedReply("stop")).toBeUndefined();
  });

  it("healthy cause (end_turn) → returns undefined (strict no-op)", () => {
    expect(buildDegradedReply("end_turn")).toBeUndefined();
  });

  it("healthy cause (error) → returns undefined (strict no-op)", () => {
    expect(buildDegradedReply("error")).toBeUndefined();
  });
});

describe("buildOutputStarvedAnnotation — vocabulary + content invariants", () => {
  it("returns a non-empty annotation string", () => {
    const annotation = buildOutputStarvedAnnotation();
    expect(typeof annotation).toBe("string");
    expect(annotation.length).toBeGreaterThan(0);
  });

  it("contains vocabulary aligned with obs-explain-heuristics ('output limit' or 'cut off')", () => {
    const annotation = buildOutputStarvedAnnotation();
    const hasVocab =
      annotation.toLowerCase().includes("output limit") ||
      annotation.toLowerCase().includes("cut off");
    expect(hasVocab).toBe(true);
  });

  it("called twice → same string (deterministic)", () => {
    expect(buildOutputStarvedAnnotation()).toBe(buildOutputStarvedAnnotation());
  });
});

describe("buildContextExhaustedReply — vocabulary + security invariants", () => {
  it("returns a non-empty synthesized reply string", () => {
    const reply = buildContextExhaustedReply();
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
  });

  it("contains vocabulary aligned with obs-explain-heuristics ('context window')", () => {
    const reply = buildContextExhaustedReply();
    expect(reply.toLowerCase()).toContain("context window");
  });

  it("does NOT contain '[Stopped:' (must not leak operator redirect text)", () => {
    const reply = buildContextExhaustedReply();
    expect(reply).not.toContain("[Stopped:");
  });

  it("does NOT contain 'too large' (must not read like the generic message-size rejection)", () => {
    const reply = buildContextExhaustedReply();
    expect(reply.toLowerCase()).not.toContain("too large");
  });

  it("called twice → same string (deterministic)", () => {
    expect(buildContextExhaustedReply()).toBe(buildContextExhaustedReply());
  });
});

// ---------------------------------------------------------------------------
// Failed turns must give users actionable recovery guidance without exposing
// internal configuration paths. Incident references remain available for
// operator correlation.
// ---------------------------------------------------------------------------

describe("buildContextExhaustedReply — recovery guidance + incident ref", () => {
  it("uses user-facing recovery guidance without raw configuration paths", () => {
    const reply = buildContextExhaustedReply({ capabilityClass: "small" });
    expect(reply).not.toContain("contextEngine.");
    expect(reply).not.toContain("0 = uncapped");
    expect(reply).not.toContain("context engine settings");
    expect(reply).toMatch(/disable tools|larger context window|new session/i);
  });

  it("small capability class keeps internal tuning details out of chat", () => {
    const reply = buildContextExhaustedReply({ capabilityClass: "small" });
    expect(reply).not.toContain("contextEngine.");
    expect(reply).not.toContain("uncapped");
    expect(reply.toLowerCase()).toContain("context window");
    expect(reply.toLowerCase()).toContain("disable tools");
    expect(reply).not.toContain("[Stopped:");
    expect(reply.toLowerCase()).not.toContain("too large");
  });

  it("nano capability class also uses user-facing recovery guidance", () => {
    const reply = buildContextExhaustedReply({ capabilityClass: "nano" });
    expect(reply).not.toContain("effectiveContextCap");
    expect(reply).toContain("larger context window");
  });

  it("frontier class uses the same user-facing vocabulary", () => {
    const reply = buildContextExhaustedReply({ capabilityClass: "frontier" });
    expect(reply).not.toContain("effectiveContextCap");
    expect(reply.toLowerCase()).toContain("context window");
  });

  it("a no-opts call returns the canonical user-facing reply", () => {
    const reply = buildContextExhaustedReply();
    expect(reply).toBe(
      "I couldn't complete that request because this conversation exceeded the model's context limit. " +
        "Try a more focused request, disable tools this agent does not need, or choose a model with a larger context window.",
    );
  });

  it("appends the full incident traceId so the operator can run comis explain on it", () => {
    const reply = buildContextExhaustedReply({ traceId: "ea72ef66-9497-46c2-a7bb-46f5ba92732e" });
    expect(reply).toContain("ea72ef66-9497-46c2-a7bb-46f5ba92732e");
    expect(reply.toLowerCase()).toContain("incident");
  });

  it("buildDegradedReply threads the incident reference without leaking profile tuning", () => {
    const reply = buildDegradedReply("context_exhausted", {
      capabilityClass: "small",
      traceId: "abc-123",
    });
    expect(reply).not.toContain("effectiveContextCapSmall");
    expect(reply).toContain("abc-123");
  });

  // The advice must name the remedy
  // that actually applies. When a persisted oversized message in history is the
  // offender, a tiny follow-up would otherwise get
  // "…or narrow the ask." — but the ask WAS tiny; the history message was the problem.
  describe("cause-branched advice (the remedy names the actual offender)", () => {
    it("oversized_input: tells the user their MESSAGE is too large — shortening/splitting applies", () => {
      const reply = buildContextExhaustedReply({ capabilityClass: "small", cause: "oversized_input" });
      expect(reply.toLowerCase()).toContain("this message");
      expect(reply.toLowerCase()).toContain("shorten");
    });

    it("oversized_history_message: names the persisted history message + reset remedy, and does NOT say 'narrowing the ask'", () => {
      const reply = buildContextExhaustedReply({
        capabilityClass: "small",
        cause: "oversized_history_message",
      });
      expect(reply.toLowerCase()).toContain("earlier message");
      expect(reply.toLowerCase()).toContain("start a new session");
      expect(reply).not.toContain("effectiveContextCapSmall");
    });

    it("aggregate / omitted cause: byte-identical to the baseline reply", () => {
      const explicit = buildContextExhaustedReply({ capabilityClass: "small", cause: "aggregate" });
      const omitted = buildContextExhaustedReply({ capabilityClass: "small" });
      expect(explicit).toBe(omitted);
      expect(omitted).toContain("more focused request");
    });

    it("the three causes produce three DISTINCT replies", () => {
      const replies = new Set([
        buildContextExhaustedReply({ cause: "oversized_input" }),
        buildContextExhaustedReply({ cause: "oversized_history_message" }),
        buildContextExhaustedReply({ cause: "aggregate" }),
      ]);
      expect(replies.size).toBe(3);
    });

    it("cause-branched replies keep internal stop and configuration details out of chat", () => {
      for (const cause of ["oversized_input", "oversized_history_message"] as const) {
        const reply = buildContextExhaustedReply({ cause });
        expect(reply).not.toContain("[Stopped:");
        expect(reply).not.toContain("contextEngine.");
      }
    });
  });

  // loop_detected must yield an HONEST reply (not a silent
  // empty) when the loop-guard halts a no-progress repeat.
  describe("loop_detected yields an honest reply", () => {
    it("returns a non-empty honest reply naming the no-progress/looping cause", () => {
      const reply = buildDegradedReply("loop_detected");
      expect(reply).toBeDefined();
      expect(reply!.length).toBeGreaterThan(0);
      expect(reply!.toLowerCase()).toMatch(/repeat|loop|progress/);
    });

    it("appends the incident traceId when provided", () => {
      const reply = buildDegradedReply("loop_detected", { traceId: "abc-123" });
      expect(reply).toContain("incident abc-123");
    });

    it("is deterministic (same endReason → byte-identical reply)", () => {
      expect(buildDegradedReply("loop_detected")).toBe(buildDegradedReply("loop_detected"));
    });
  });
});

// ---------------------------------------------------------------------------
// The builders take an optional canonical locale tag and delegate string
// selection to the locale catalog. Missing packs fall back to English.
// ---------------------------------------------------------------------------
describe("builders consume the resolved language tag (delegate to i18n)", () => {
  // The warning marker (U+26A0 U+FE0F) — referenced via codepoints, never pasted.
  const WARNING_MARKER = String.fromCodePoint(0x26a0, 0xfe0f);

  it("buildContextExhaustedReply delegates an open locale to the selector", () => {
    const opts = { cause: "oversized_input", capabilityClass: "small", traceId: "t" } as const;
    expect(buildContextExhaustedReply({ ...opts, language: "fr-CA" })).toBe(
      selectContextExhaustedReply("fr-CA", opts),
    );
  });

  it("buildOutputStarvedAnnotation delegates the locale and carries the warning marker", () => {
    const annotation = buildOutputStarvedAnnotation("sr-Latn-RS");
    expect(annotation).toBe(selectOutputStarvedAnnotation("sr-Latn-RS"));
    expect(annotation).toContain(WARNING_MARKER);
  });

  it("buildLoopDetectedReply delegates an open locale to the selector", () => {
    expect(buildLoopDetectedReply({ language: "de-DE", traceId: "x" })).toBe(
      selectLoopDetectedReply("de-DE", { traceId: "x" }),
    );
  });

  it("a locale-selected context-exhausted reply omits raw configuration paths", () => {
    const reply = buildContextExhaustedReply({ capabilityClass: "small", language: "fr-CA" });
    expect(reply).not.toContain("contextEngine.");
    expect(reply).not.toContain("uncapped");
  });

  it("no language arg returns the English string byte-identical — context_exhausted", () => {
    // The canonical English reply, pinned literally (the byte-identical guard).
    expect(buildContextExhaustedReply()).toBe(
      "I couldn't complete that request because this conversation exceeded the model's context limit. " +
        "Try a more focused request, disable tools this agent does not need, or choose a model with a larger context window.",
    );
    // …and equals the en selector (single-sourced).
    expect(buildContextExhaustedReply()).toBe(selectContextExhaustedReply("en", {}));
  });

  it("no language arg returns the English string byte-identical — output_starved + loop_detected", () => {
    expect(buildOutputStarvedAnnotation()).toBe(selectOutputStarvedAnnotation("en"));
    expect(buildLoopDetectedReply()).toBe(selectLoopDetectedReply("en", {}));
  });

  it("buildDegradedReply forwards the language tag to all three endReasons", () => {
    expect(buildDegradedReply("output_starved", { language: "he" })).toBe(
      selectOutputStarvedAnnotation("he"),
    );
    expect(buildDegradedReply("context_exhausted", { language: "ar", capabilityClass: "nano" })).toBe(
      selectContextExhaustedReply("ar", { capabilityClass: "nano" }),
    );
    expect(buildDegradedReply("loop_detected", { language: "ru", traceId: "z" })).toBe(
      selectLoopDetectedReply("ru", { traceId: "z" }),
    );
  });
});
