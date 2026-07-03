// SPDX-License-Identifier: Apache-2.0
/**
 * Narrate-without-emit continuation nudge.
 *
 * Small models (esp. qwen3.6-class) split "intent narration" from the tool
 * call and drop the call: the turn ends on *"Now let me write the comparison
 * script:"* / *"Found the image analyze tool. Let me use it now."* with NO
 * tool call emitted — the delivered answer is mid-task narration, and the
 * platform recorded the turn as a clean success (observed live: tool
 * discovery ran 4×, the announced image-analysis call was never emitted,
 * 28 steps of flailing → starved answer marked `degraded:false`).
 *
 * This handler is the sibling of `post-batch-continuation.ts` (which covers
 * truly EMPTY final turns): when the FINAL assistant turn carries intent-
 * prelude text but NO tool call, it fires exactly ONE directive
 * `session.followUp()` telling the model to either emit the announced tool
 * call or give its final answer.
 *
 * Gating is strict — near-zero false positives is the bar:
 *  - capabilityClass `small`/`nano` ONLY (a frontier model giving a short
 *    answer ending in ":" must NOT be nudged);
 *  - the final assistant turn must have visible text and NO tool call;
 *  - the text must match the intent-prelude shape (short, AND either ends
 *    with ":" / "…" / "..." or its final sentence opens with an intent
 *    opener like "let me" / "I'll" / "let's" — with "let me know" excluded
 *    as the classic closing line);
 *  - bounded to ONE re-prompt, never a loop.
 *
 * When the nudge fails to produce a real answer, the caller marks the result
 * (`ExecutionResult.narrateNudge`) so the post-execution chokepoint promotes
 * the turn to the named degraded cause `narration_stall` — closing the
 * soft-false-clean where narration was recorded as a clean success.
 *
 * @module
 */

import { fromPromise } from "@comis/shared";
import type { ComisLogger } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Outcome of the narrate-nudge handler. */
export interface NarrateNudgeOutcome {
  /** True when the nudge followUp was actually issued. */
  fired: boolean;
  /** True when the followed-up turn produced a non-prelude visible answer. */
  recovered: boolean;
  /** Recovered visible text (only set when `recovered === true`). */
  response?: string;
  /** Terminal outcome:
   *  - `not_small_class` — capabilityClass is not small/nano (gate 1)
   *  - `no_match`        — final turn is not a narrate-without-emit shape
   *  - `recovered`       — the re-prompt produced a real answer (or tool work)
   *  - `still_narration` — the re-prompt still ended on narration / empty
   *  - `followup_error`  — session.followUp rejected (logged, never thrown) */
  outcome: "not_small_class" | "no_match" | "recovered" | "still_narration" | "followup_error";
}

/** Dependencies passed in by the executor wire-in site. */
export interface RunNarrateNudgeDeps {
  /** Live session — invoked via `followUp(text)` to issue the directive. */
  session: { followUp(text: string): Promise<unknown> };
  /** Session messages — the canonical `(session as any).messages ?? []` slice. */
  messages: unknown[];
  /** The resolved ModelProfile capabilityClass (gate 1: small/nano only). */
  capabilityClass: string | undefined;
  logger: ComisLogger;
  agentId?: string;
  /** Read visible text from the latest assistant turn (post-followUp). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getVisibleAssistantText: (session: any) => string;
}

// ---------------------------------------------------------------------------
// Intent-prelude predicate
// ---------------------------------------------------------------------------

/** Narration is SHORT by construction — a real answer this small that also
 *  matches the opener/colon shape is vanishingly rare, and the cap keeps a
 *  long legitimate answer that happens to end in ":" out of scope. */
const INTENT_PRELUDE_MAX_CHARS = 300;

/** Ends on a colon / ellipsis — the "about to do it" cliff-hanger shape. */
const TRAILING_PRELUDE_RE = /[:：…]\s*$|\.{3}\s*$/;

/**
 * Final-sentence intent openers. The apostrophe in "I'll" is REQUIRED (plain
 * "Ill …" is a legitimate sentence opener) and "let me know" is excluded (the
 * classic closing line of a real answer).
 */
const INTENT_OPENER_RE =
  /^(?:(?:now|next|first|okay|ok|alright|then)[,!]?\s+)?(?:let me(?!\s+(?:know|us)\b)|let['’]s|i['’]ll|i will|i['’]m going to|i am going to)\b/i;

/**
 * True when `text` is an intent-prelude — mid-task narration announcing an
 * action rather than delivering a result. Pure.
 */
export function isIntentPrelude(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > INTENT_PRELUDE_MAX_CHARS) return false;
  if (TRAILING_PRELUDE_RE.test(trimmed)) return true;
  // Final sentence opener: "Found the tool. Let me use it now."
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  const lastSentence = (sentences[sentences.length - 1] ?? "").trim();
  return INTENT_OPENER_RE.test(lastSentence);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SUBMODULE = "executor.narrate-nudge";

/* eslint-disable @typescript-eslint/no-explicit-any */
function hasToolCallBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block: any) => block?.type === "toolCall" || block?.type === "tool_use",
  );
}

function visibleTextOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return (content as any[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join(" ");
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const NUDGE_DIRECTIVE =
  "[comis: continuation — you announced an action but did not call a tool]\n" +
  "Your last message ended with intent narration but contained NO tool call, so " +
  "nothing was executed. You MUST either:\n" +
  "  (a) emit the tool call you announced RIGHT NOW, or\n" +
  "  (b) give your final answer with the results you already have.\n" +
  "Never narrate an action without calling the tool in the same turn.";

/**
 * Run the narrate-without-emit nudge. Never throws — a `followUp` rejection
 * is logged (WARN, hint + errorKind) and returned as `followup_error` so the
 * turn's existing response is preserved.
 *
 * Detection (pure inspection):
 *  1. capabilityClass gate — small/nano only.
 *  2. The LAST session message is an assistant turn with visible text and NO
 *     tool-call block.
 *  3. That text matches {@link isIntentPrelude}.
 * Fire: ONE directive followUp; recovered iff the new visible text is
 * non-empty AND not itself an intent prelude.
 */
export async function runNarrateNudge(deps: RunNarrateNudgeDeps): Promise<NarrateNudgeOutcome> {
  const { session, messages, capabilityClass, logger, agentId, getVisibleAssistantText } = deps;

  // Gate 1: capability class. Frontier/mid (or unknown) never nudge.
  if (capabilityClass !== "small" && capabilityClass !== "nano") {
    return { fired: false, recovered: false, outcome: "not_small_class" };
  }

  // Gate 2: final assistant turn with text but no tool call.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const msgs = messages as any[];
  const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (last?.role !== "assistant" || hasToolCallBlock(last.content)) {
    return { fired: false, recovered: false, outcome: "no_match" };
  }
  const lastText = visibleTextOf(last.content);

  // Gate 3: the delivered text is an intent prelude (mid-task narration).
  if (!isIntentPrelude(lastText)) {
    return { fired: false, recovered: false, outcome: "no_match" };
  }

  logger.info(
    {
      submodule: SUBMODULE,
      agentId,
      decision: "fire",
      reason: "narrate_without_emit",
      capabilityClass,
      narrationChars: lastText.trim().length,
    },
    "Narrate-without-emit nudge firing",
  );

  // ONE bounded re-prompt — never a loop.
  const followUpResult = await fromPromise(session.followUp(NUDGE_DIRECTIVE));
  if (!followUpResult.ok) {
    logger.warn(
      {
        submodule: SUBMODULE,
        agentId,
        err: followUpResult.error,
        hint: "Narrate-nudge followUp failed; preserving the narration response collected so far",
        errorKind: "internal" as const,
      },
      "Narrate-without-emit nudge error",
    );
    return { fired: true, recovered: false, outcome: "followup_error" };
  }

  const newText = getVisibleAssistantText(session);
  const recovered = newText.trim().length > 0 && !isIntentPrelude(newText);
  logger.info(
    {
      submodule: SUBMODULE,
      agentId,
      outcome: recovered ? "recovered" : "still_narration",
      recoveredChars: newText.trim().length,
    },
    "Narrate-without-emit nudge attempt",
  );
  if (recovered) {
    return { fired: true, recovered: true, response: newText, outcome: "recovered" };
  }
  return { fired: true, recovered: false, outcome: "still_narration" };
}
