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
// The reply must name the exact cap knob for
// small/nano models and carry an incident ref. Without them the reply says only
// "raise the agent's context engine settings" — no knob, no pointer — so
// root-causing starts from a chat message with zero handles.
// ---------------------------------------------------------------------------

describe("buildContextExhaustedReply — knob naming + incident ref", () => {
  it("small capability class names the small cap knob with the 0-uncapped hint", () => {
    const reply = buildContextExhaustedReply({ capabilityClass: "small" });
    expect(reply).toContain("contextEngine.budget.effectiveContextCapSmall");
    expect(reply).toContain("0 = uncapped");
    expect(reply.toLowerCase()).toContain("context window");
    expect(reply).not.toContain("[Stopped:");
    expect(reply.toLowerCase()).not.toContain("too large");
    expect(reply.toLowerCase()).not.toContain("session reset");
  });

  it("nano capability class names the nano cap knob", () => {
    const reply = buildContextExhaustedReply({ capabilityClass: "nano" });
    expect(reply).toContain("contextEngine.budget.effectiveContextCapNano");
  });

  it("frontier class keeps the generic settings wording without naming a cap knob", () => {
    const reply = buildContextExhaustedReply({ capabilityClass: "frontier" });
    expect(reply).not.toContain("effectiveContextCap");
    expect(reply.toLowerCase()).toContain("context window");
  });

  it("a no-opts call returns the unchanged base reply (callers without profile context)", () => {
    const reply = buildContextExhaustedReply();
    expect(reply).toBe(
      "I was unable to process your request — the context window was exhausted " +
        "before the model could run. Try raising the agent's context engine settings " +
        "or narrowing the ask.",
    );
  });

  it("appends the full incident traceId so the operator can run comis explain on it", () => {
    const reply = buildContextExhaustedReply({ traceId: "ea72ef66-9497-46c2-a7bb-46f5ba92732e" });
    expect(reply).toContain("ea72ef66-9497-46c2-a7bb-46f5ba92732e");
    expect(reply.toLowerCase()).toContain("incident");
  });

  it("buildDegradedReply threads knob + incident opts through for context_exhausted", () => {
    const reply = buildDegradedReply("context_exhausted", {
      capabilityClass: "small",
      traceId: "abc-123",
    });
    expect(reply).toContain("effectiveContextCapSmall");
    expect(reply).toContain("abc-123");
  });

  // The advice must name the remedy
  // that actually applies. When a persisted oversized message in history is the
  // offender, a tiny follow-up would otherwise get
  // "…or narrow the ask." — but the ask WAS tiny; the history message was the problem.
  describe("cause-branched advice (the remedy names the actual offender)", () => {
    it("oversized_input: tells the user their MESSAGE is too large — shortening/splitting applies", () => {
      const reply = buildContextExhaustedReply({ capabilityClass: "small", cause: "oversized_input" });
      expect(reply.toLowerCase()).toContain("your message");
      expect(reply.toLowerCase()).toContain("shorter");
    });

    it("oversized_history_message: names the persisted history message + reset remedy, and does NOT say 'narrowing the ask'", () => {
      const reply = buildContextExhaustedReply({
        capabilityClass: "small",
        cause: "oversized_history_message",
      });
      expect(reply.toLowerCase()).toContain("previous message");
      expect(reply.toLowerCase()).toContain("reset the session");
      // The misleading narrow-the-ask clause must be gone for this cause.
      expect(reply.toLowerCase()).not.toContain("narrow");
      // The knob is still named as the alternative lever.
      expect(reply).toContain("effectiveContextCapSmall");
    });

    it("aggregate / omitted cause: byte-identical to the baseline reply", () => {
      const explicit = buildContextExhaustedReply({ capabilityClass: "small", cause: "aggregate" });
      const omitted = buildContextExhaustedReply({ capabilityClass: "small" });
      expect(explicit).toBe(omitted);
      expect(omitted).toContain("narrowing the ask");
    });

    it("the three causes produce three DISTINCT replies", () => {
      const replies = new Set([
        buildContextExhaustedReply({ cause: "oversized_input" }),
        buildContextExhaustedReply({ cause: "oversized_history_message" }),
        buildContextExhaustedReply({ cause: "aggregate" }),
      ]);
      expect(replies.size).toBe(3);
    });

    it("cause-branched replies keep the security guards (no '[Stopped:', no 'too large')", () => {
      for (const cause of ["oversized_input", "oversized_history_message"] as const) {
        const reply = buildContextExhaustedReply({ cause });
        expect(reply).not.toContain("[Stopped:");
        expect(reply.toLowerCase()).not.toContain("too large");
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
// The builders take an optional `language` tag and
// DELEGATE string selection to degraded-reply-i18n.ts. A he/ar/ru tag yields
// the localized reply (deep-equal to the matching selector); NO language arg
// stays English byte-identical — the existing pins above already lock the
// English vocabulary/security invariants and must stay green.
// ---------------------------------------------------------------------------
describe("builders consume the resolved language tag (delegate to i18n)", () => {
  // The warning marker (U+26A0 U+FE0F) — referenced via codepoints, never pasted.
  const WARNING_MARKER = String.fromCodePoint(0x26a0, 0xfe0f);

  it("buildContextExhaustedReply with language:'he' equals the he selector output", () => {
    const opts = { cause: "oversized_input", capabilityClass: "small", traceId: "t" } as const;
    expect(buildContextExhaustedReply({ ...opts, language: "he" })).toBe(
      selectContextExhaustedReply("he", opts),
    );
  });

  it("buildOutputStarvedAnnotation('ar') equals the ar selector output and carries the warning marker", () => {
    const ar = buildOutputStarvedAnnotation("ar");
    expect(ar).toBe(selectOutputStarvedAnnotation("ar"));
    expect(ar).toContain(WARNING_MARKER);
  });

  it("buildLoopDetectedReply with language:'ru' equals the ru selector output", () => {
    expect(buildLoopDetectedReply({ language: "ru", traceId: "x" })).toBe(
      selectLoopDetectedReply("ru", { traceId: "x" }),
    );
  });

  it("a he context-exhausted reply still names the cap knob path + (0 = uncapped) verbatim", () => {
    const reply = buildContextExhaustedReply({ capabilityClass: "small", language: "he" });
    expect(reply).toContain("contextEngine.budget.effectiveContextCapSmall");
    expect(reply).toContain("(0 = uncapped)");
  });

  it("no language arg returns the English string byte-identical — context_exhausted", () => {
    // The canonical English reply, pinned literally (the byte-identical guard).
    expect(buildContextExhaustedReply()).toBe(
      "I was unable to process your request — the context window was exhausted " +
        "before the model could run. Try raising the agent's context engine settings " +
        "or narrowing the ask.",
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
