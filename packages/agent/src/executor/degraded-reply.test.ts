// SPDX-License-Identifier: Apache-2.0
//
// Pure-builder unit tests for degraded-reply.ts (CWF-05-D, CWF-05-E).
//
// These tests assert that:
//   - buildDegradedReply is deterministic (same input → same output)
//   - output_starved → returns a non-empty annotation string
//   - context_exhausted → returns a non-empty synthesized reply
//   - healthy finishReasons (stop/end_turn/error) → returns undefined (strict no-op)
//   - vocabulary alignment: output_starved annotation contains "output limit" or "cut off"
//   - vocabulary alignment: context_exhausted reply contains "context window"
//   - security: context_exhausted reply does NOT contain "[Stopped:" (operator redirect leak)
//   - security: context_exhausted reply does NOT contain "too large" (Phase-166 placeholder echo)

import { describe, it, expect } from "vitest";
import {
  buildOutputStarvedAnnotation,
  buildContextExhaustedReply,
  buildDegradedReply,
} from "./degraded-reply.js";

describe("buildDegradedReply — deterministic per endReason (CWF-05-D, CWF-05-E)", () => {
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

  it("does NOT contain 'too large' (must not echo Phase-166 placeholder)", () => {
    const reply = buildContextExhaustedReply();
    expect(reply.toLowerCase()).not.toContain("too large");
  });

  it("called twice → same string (deterministic)", () => {
    expect(buildContextExhaustedReply()).toBe(buildContextExhaustedReply());
  });
});

// ---------------------------------------------------------------------------
// W4 (obs-llm-troubleshooting): the reply must name the exact cap knob for
// small/nano models and carry an incident ref. The live incident's reply said
// "raise the agent's context engine settings" — no knob, no pointer — so
// root-causing started from a chat message with zero handles.
// ---------------------------------------------------------------------------

describe("buildContextExhaustedReply — knob naming + incident ref (W4)", () => {
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

  // Issue-6 (small-model e2e 2026-06-12 UC-3): the advice must name the remedy
  // that actually applies. After the Issue-1 brick, a tiny follow-up got
  // "…or narrow the ask." — but the ask WAS tiny; the offender was a persisted
  // oversized message in history.
  describe("cause-branched advice (Issue 6)", () => {
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
      // The misleading clause from the live incident must be gone for this cause.
      expect(reply.toLowerCase()).not.toContain("narrow");
      // The knob is still named as the alternative lever.
      expect(reply).toContain("effectiveContextCapSmall");
    });

    it("aggregate / omitted cause: byte-identical to the historical reply", () => {
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

  // F-15 (live 2026-06-12): loop_detected must yield an HONEST reply (not a silent
  // empty) when the loop-guard halts a no-progress repeat.
  describe("loop_detected (F-15)", () => {
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
