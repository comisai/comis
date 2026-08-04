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
  buildBackgroundTaskFailedNotice,
  buildToolFailureNotice,
  buildPromptTimeoutReply,
  buildToolFailureNoticeUnnamed,
  buildContextExhaustedReply,
  buildLoopDetectedReply,
  buildDegradedReply,
  buildProviderRequiresModelReply,
  buildOngoingWorkEvidenceMissingReply,
  buildSenderAuthorityOverclaimReply,
  catalogFromLocalePacks,
  LOCALE_MESSAGE_IDS,
} from "./degraded-reply.js";
import * as degradedReply from "./degraded-reply.js";
import {
  selectOutputStarvedAnnotation,
  selectContextExhaustedReply,
  selectLoopDetectedReply,
} from "./degraded-reply-i18n.js";
import { NO_PROGRESS_LOOP_THRESHOLD } from "./turn-loop-detector.js";

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

describe("destructive action evidence reply", () => {
  it("is deterministic and can be replaced by an operator locale pack", () => {
    const candidate = (degradedReply as Record<string, unknown>)
      .buildDestructiveActionNotVerifiedReply;
    expect(candidate).toBeTypeOf("function");
    const build = candidate as (
      language?: string,
      catalog?: ReturnType<typeof catalogFromLocalePacks>,
    ) => string;
    const catalog = catalogFromLocalePacks({
      he: {
        destructive_action_not_verified:
          "לא ניתן לאמת שנמחק משהו; לפעולה לא הייתה השפעה נצפית.",
      },
    });

    expect(build()).toContain("could not verify");
    expect(build("he", catalog)).toBe(
      "לא ניתן לאמת שנמחק משהו; לפעולה לא הייתה השפעה נצפית.",
    );
    expect(LOCALE_MESSAGE_IDS).toContain("destructive_action_not_verified");
  });
});

describe("persistent action evidence reply", () => {
  it("is deterministic and can be replaced by an operator locale pack", () => {
    const candidate = (degradedReply as Record<string, unknown>)
      .buildPersistentActionEvidenceMissingReply;
    expect(candidate).toBeTypeOf("function");
    const build = candidate as (
      language?: string,
      catalog?: ReturnType<typeof catalogFromLocalePacks>,
    ) => string;
    const catalog = catalogFromLocalePacks({
      he: {
        persistent_action_evidence_missing:
          "לא ביצעתי או אימתתי את הפעולה החוזרת בתור הנוכחי.",
      },
    });

    expect(build()).toContain("did not perform or verify");
    expect(build("he", catalog)).toBe(
      "לא ביצעתי או אימתתי את הפעולה החוזרת בתור הנוכחי.",
    );
    expect(LOCALE_MESSAGE_IDS).toContain("persistent_action_evidence_missing");
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
      expect(reply).toContain(`${NO_PROGRESS_LOOP_THRESHOLD} consecutive`);
      expect(reply).toMatch(/successful|unchanged/i);
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

describe("buildProviderRequiresModelReply", () => {
  it("states that configuration was unchanged and requires an exact model", () => {
    const reply = buildProviderRequiresModelReply();

    expect(reply).toContain("did not change the agent");
    expect(reply).toContain("provider");
    expect(reply).toContain("exact model");
    expect(LOCALE_MESSAGE_IDS).toContain("provider_requires_model");
  });

  it("uses the operator locale pack without embedding a preferred language", () => {
    const catalog = catalogFromLocalePacks({
      he: {
        provider_requires_model:
          "הסוכן לא שונה כי הערך הוא ספק ולא מזהה מודל מדויק",
      },
    });

    expect(buildProviderRequiresModelReply("he", catalog)).toBe(
      "הסוכן לא שונה כי הערך הוא ספק ולא מזהה מודל מדויק",
    );
  });
});

describe("buildAgentUpdateNoOpReply", () => {
  it("names the unchanged runtime binding and supports operator locale packs", () => {
    const candidate = (degradedReply as Record<string, unknown>)
      .buildAgentUpdateNoOpReply;
    expect(candidate).toBeTypeOf("function");
    const build = candidate as (
      language: string | undefined,
      provider: string,
      modelId: string,
      catalog?: ReturnType<typeof catalogFromLocalePacks>,
    ) => string;
    const catalog = catalogFromLocalePacks({
      he: {
        agent_update_noop: "לא נדרש שינוי. הסוכן כבר משתמש ב",
      },
    });

    expect(build(undefined, "provider_a", "model_a")).toBe(
      "No configuration change was needed. This agent already uses provider_a / model_a.",
    );
    expect(build("he", "provider_a", "model_a", catalog)).toBe(
      "לא נדרש שינוי. הסוכן כבר משתמש ב provider_a / model_a.",
    );
    expect(LOCALE_MESSAGE_IDS).toContain("agent_update_noop");
  });
});

describe("buildSenderAuthorityOverclaimReply", () => {
  it("returns a below-admin boundary that cannot grant admin authority", () => {
    const reply = buildSenderAuthorityOverclaimReply();

    expect(reply).toMatch(/current trust.*admin-only/iu);
    expect(reply).toMatch(/your approval cannot grant admin access/iu);
    expect(reply).toMatch(/authorized administrator/iu);
    expect(reply).toMatch(/cannot.*raise.*own trust/iu);
    expect(LOCALE_MESSAGE_IDS).toContain("sender_authority_overclaim");
  });

  it("uses an operator-provided open-locale message", () => {
    const catalog = catalogFromLocalePacks({
      "en-x-agent": {
        sender_authority_overclaim: "localized authority boundary",
      },
    });

    expect(buildSenderAuthorityOverclaimReply("en-x-agent", catalog))
      .toBe("localized authority boundary");
  });
});

describe("buildOngoingWorkEvidenceMissingReply", () => {
  it("states that no background result remains pending", () => {
    const reply = buildOngoingWorkEvidenceMissingReply();

    expect(reply).toMatch(/did not start ongoing work/iu);
    expect(reply).toMatch(/no background task running/iu);
    expect(LOCALE_MESSAGE_IDS).toContain("ongoing_work_evidence_missing");
  });
});

// ---------------------------------------------------------------------------
// Nameless tool-failure notice
// ---------------------------------------------------------------------------

/**
 * The named notice ends with an em-dash because the caller appends the failing
 * tool's name verbatim. When the only unrecovered failure is the background
 * poller — which must never be named as the culprit, since it merely relays
 * another tool's failure — there is no name to append, and the reply ended in a
 * dangling "incomplete — " with nothing after it.
 *
 * Seen live at the end of a Hebrew answer about a timed-out report tool.
 */
describe("buildToolFailureNoticeUnnamed", () => {
  it("ends as a complete sentence with no dangling dash", () => {
    const text = buildToolFailureNoticeUnnamed();
    expect(text.trimEnd()).not.toMatch(/[—-]$/);
    expect(text.trimEnd()).toMatch(/\.$/);
  });

  it("still separates itself from the preceding reply", () => {
    expect(buildToolFailureNoticeUnnamed().startsWith("\n\n")).toBe(true);
  });

  it("differs from the named variant", () => {
    expect(buildToolFailureNoticeUnnamed()).not.toBe(buildToolFailureNotice());
  });
});

// ---------------------------------------------------------------------------
// Prompt-timeout reply
// ---------------------------------------------------------------------------

/**
 * The whole-turn / stall-budget timeout reply was a hard-coded English literal
 * in error-classifier.ts, delivered verbatim regardless of the conversation's
 * language — the same gap already closed for pipeline_timeout. A stalled turn is
 * one of the few messages a user is guaranteed to see, so it is exactly the one
 * that must live inside the localizable platform-reply set.
 *
 * Observed live: a Hebrew conversation whose 404s stall produced
 * "The request took too long to process. Please try again with a simpler message."
 */
describe("buildPromptTimeoutReply", () => {
  it("returns the canonical English text with no locale configured", () => {
    expect(buildPromptTimeoutReply()).toContain("took too long");
  });

  it("is a member of the locale message set", () => {
    expect(LOCALE_MESSAGE_IDS).toContain("prompt_timeout");
  });

  it("uses an operator-supplied pack for the resolved locale", () => {
    const catalog = catalogFromLocalePacks({ he: { prompt_timeout: "לקח יותר מדי זמן" } });
    expect(buildPromptTimeoutReply("he", catalog)).toBe("לקח יותר מדי זמן");
  });

  it("falls back to English for a locale with no pack", () => {
    const catalog = catalogFromLocalePacks({ he: { prompt_timeout: "x" } });
    expect(buildPromptTimeoutReply("fr", catalog)).toContain("took too long");
  });
});

describe("buildBackgroundTaskFailedNotice", () => {
  it("is a member of the operator-localizable platform reply set", () => {
    expect(LOCALE_MESSAGE_IDS).toContain("background_task_failed_notice");
  });

  it("uses the resolved locale pack instead of hard-coding English", () => {
    const catalog = catalogFromLocalePacks({
      he: { background_task_failed_notice: "⚠️ משימת הרקע נכשלה ולכן התוצאה עלולה להיות חלקית." },
    });

    expect(buildBackgroundTaskFailedNotice("he", catalog))
      .toBe("⚠️ משימת הרקע נכשלה ולכן התוצאה עלולה להיות חלקית.");
  });
});

describe("unavailable vision response honesty", () => {
  type VisionHonestyExports = {
    buildVisionUnavailableReply?: (
      agentId: string,
      language?: string,
      localeCatalog?: ReturnType<typeof catalogFromLocalePacks>,
    ) => string;
    hasUnavailableVisionFailure?: (
      records?: ReadonlyArray<{
        toolName: string;
        success: boolean;
        errorText?: string;
      }>,
    ) => boolean;
    groundedVisionFallbackTool?: (
      response: string,
      messages: ReadonlyArray<unknown>,
    ) => string | undefined;
  };

  async function loadVisionHonestyExports(): Promise<VisionHonestyExports> {
    return await import("./degraded-reply.js") as unknown as VisionHonestyExports;
  }

  it("recognizes the actionable unavailable-vision tool receipt", async () => {
    const { hasUnavailableVisionFailure } = await loadVisionHonestyExports();
    expect(hasUnavailableVisionFailure).toBeTypeOf("function");
    if (hasUnavailableVisionFailure === undefined) return;

    expect(hasUnavailableVisionFailure([
      {
        toolName: "image_analyze",
        success: false,
        errorText:
          '{"content":[{"type":"text","text":"No vision provider available for image analysis. '
          + 'Active model \\"text-only-model\\" is configured at agents.default.model. '
          + "Select a vision-capable model, or configure integrations.media.vision.providers and "
          + "integrations.media.vision.defaultProvider with an available credential. "
          + 'Re-uploading will not help until that configuration changes."}]}',
      },
    ])).toBe(true);
    expect(hasUnavailableVisionFailure([
      {
        toolName: "image_analyze",
        success: false,
        errorText: "Failed to resolve attachment.",
      },
    ])).toBe(false);
  });

  it("replaces model recovery advice with the exact vision configuration truth", async () => {
    const { buildVisionUnavailableReply } = await loadVisionHonestyExports();
    expect(buildVisionUnavailableReply).toBeTypeOf("function");
    if (buildVisionUnavailableReply === undefined) return;

    const reply = buildVisionUnavailableReply("default");
    expect(reply).toContain("Re-uploading the same image will not help");
    expect(reply).toContain("agents.default.model");
    expect(reply).toContain("integrations.media.vision.providers");
    expect(reply).toContain("integrations.media.vision.defaultProvider");
    expect(reply).not.toMatch(/please re-upload/i);
  });

  it("uses the resolved locale pack for the deterministic correction", async () => {
    const { buildVisionUnavailableReply } = await loadVisionHonestyExports();
    expect(buildVisionUnavailableReply).toBeTypeOf("function");
    if (buildVisionUnavailableReply === undefined) return;

    const catalog = catalogFromLocalePacks({
      he: { vision_unavailable: "לא ניתן לנתח את התמונה כרגע." },
    });
    expect(buildVisionUnavailableReply("default", "he", catalog))
      .toMatch(/^לא ניתן לנתח את התמונה כרגע\./);
  });

  const source = "photos/fixture-image.png";
  const unavailable =
    "No vision provider available for image analysis. "
    + "Active model \"text-only-model\" is configured at agents.default.model. "
    + "Select a vision-capable model, or configure integrations.media.vision.providers and "
    + "integrations.media.vision.defaultProvider with an available credential. "
    + "Re-uploading will not help until that configuration changes.";
  const response =
    "GREEN FORK CAFE, 28 JUL 2026. FALAFEL BOWL 42.50 ILS. "
    + "TOTAL 42.50 ILS. PAID CARD.";
  const ocrOutput =
    "GREEN FORK CAFE\n28 JUL 2026\nFALAFEL BOWL 42.50 ILS\n"
    + "TOTAL 42.50 ILS\nPAID CARD\n";

  function assistantCall(id: string, name: string, args: Record<string, unknown>): unknown {
    return {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
    };
  }

  function toolResult(
    id: string,
    name: string,
    text: string,
    options: { isError?: boolean; stdout?: string; exitCode?: number } = {},
  ): unknown {
    return {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text }],
      details: {
        ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
        ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
      },
      isError: options.isError ?? false,
    };
  }

  it("preserves a response grounded by a later tool over the exact same image", async () => {
    const { groundedVisionFallbackTool } = await loadVisionHonestyExports();
    expect(groundedVisionFallbackTool).toBeTypeOf("function");
    if (groundedVisionFallbackTool === undefined) return;

    expect(groundedVisionFallbackTool(response, [
      assistantCall("vision", "image_analyze", {
        action: "analyze",
        source_type: "file",
        source,
      }),
      toolResult("vision", "image_analyze", unavailable, { isError: true }),
      assistantCall("ocr", "exec", {
        command: `tesseract ${source} stdout -l eng`,
      }),
      toolResult("ocr", "exec", JSON.stringify({ exitCode: 0, stdout: ocrOutput }), {
        stdout: ocrOutput,
        exitCode: 0,
      }),
    ])).toBe("exec");
  });

  it("does not treat an availability probe as grounded image recovery", async () => {
    const { groundedVisionFallbackTool } = await loadVisionHonestyExports();
    expect(groundedVisionFallbackTool).toBeTypeOf("function");
    if (groundedVisionFallbackTool === undefined) return;

    expect(groundedVisionFallbackTool(response, [
      assistantCall("vision", "image_analyze", { source_type: "file", source }),
      toolResult("vision", "image_analyze", unavailable, { isError: true }),
      assistantCall("probe", "exec", { command: "which tesseract" }),
      toolResult("probe", "exec", "/usr/bin/tesseract", {
        stdout: "/usr/bin/tesseract",
        exitCode: 0,
      }),
    ])).toBeUndefined();
  });

  it("requires the successful tool output to substantively overlap the final answer", async () => {
    const { groundedVisionFallbackTool } = await loadVisionHonestyExports();
    expect(groundedVisionFallbackTool).toBeTypeOf("function");
    if (groundedVisionFallbackTool === undefined) return;

    expect(groundedVisionFallbackTool(response, [
      assistantCall("vision", "image_analyze", { source_type: "file", source }),
      toolResult("vision", "image_analyze", unavailable, { isError: true }),
      assistantCall("inspect", "exec", { command: `identify ${source}` }),
      toolResult("inspect", "exec", "width 1024 height 768 color rgb", {
        stdout: "width 1024 height 768 color rgb",
        exitCode: 0,
      }),
    ])).toBeUndefined();
  });

  it("does not recognize fallback recovery after an ordinary vision failure", async () => {
    const { groundedVisionFallbackTool } = await loadVisionHonestyExports();
    expect(groundedVisionFallbackTool).toBeTypeOf("function");
    if (groundedVisionFallbackTool === undefined) return;

    expect(groundedVisionFallbackTool(response, [
      assistantCall("vision", "image_analyze", { source_type: "file", source }),
      toolResult("vision", "image_analyze", "Failed to resolve attachment.", { isError: true }),
      assistantCall("ocr", "exec", { command: `tesseract ${source} stdout` }),
      toolResult("ocr", "exec", ocrOutput, { stdout: ocrOutput, exitCode: 0 }),
    ])).toBeUndefined();
  });
});
