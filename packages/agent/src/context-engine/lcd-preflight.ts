// SPDX-License-Identifier: Apache-2.0
// @allow-throw: ContextExhaustionError is a control-flow signal caught by handleEnvelopeException and mapped to finishReason:context_exhausted (design Fix 3/5)
/**
 * Pre-flight fit check for the LCD dag assembler (Phase 166 CWF-02).
 *
 * Enforces the invariant: assembledInputTokens ≤ effectiveWindow − outputHeadroom.
 * Security-pinned messages (T-S4) are NEVER evicted in the harder-eviction pass.
 *
 * Escalation ladder:
 *  (a) Evict harder with security-pinned messages excluded.
 *  (c) Down-shift thinkingLevel via downshiftThinkingLevel() when reasoningStyle="native".
 *  (d) Throw ContextExhaustionError when infeasible even at the floor level.
 *
 * Separated from lcd-assembler.ts to keep that file ≤ 820 lines.
 *
 * Root-cause context-exhaustion guard (2026-06-22): the NON-EVICTABLE fixed
 * overhead S (system prompt + tool schemas) is the dominant term on small
 * windows. The window-aware tool-budget fit pass (executor-tool-assembly.ts
 * `enforceToolBudgetFit`) defers tools so S fits BEFORE this pre-flight runs,
 * which keeps a `nano`-class model (~16K window) from throwing on every turn. The
 * only residual infeasible case is window < system-prompt-alone — genuinely
 * unusable. This pass throws `fixed_overhead_exceeds_window` there (honest), and
 * the degraded reply names the window / tool footprint / a larger model — never
 * the misleading "your message is too big".
 *
 * TODO(2026-Q3): a minimal-system-prompt fallback (drop verbose bootstrap/tooling
 * guidance, keep identity + essential behavior) would let the agent still reply
 * on a window < full-prompt. Deferred: it is deeply invasive in the 1954-line
 * prompt-assembly.ts (per-session bootstrap snapshot + once-per-session
 * systemPromptOverride). Tracked against the codex nano-window context-exhaustion
 * incident. Until then the degenerate case fails honestly (above).
 *
 * @module
 */

import { scriptTokenFactor } from "@comis/core";
import { computeOutputHeadroom, downshiftThinkingLevel } from "./output-headroom.js";
import {
  ContextExhaustionError,
  describeWindowCap,
  type ContextExhaustionCause,
} from "./errors.js";
import { isSecurityRelevantMessage } from "./security-context-pinner.js";
import { evictHistoryUnderBudget, type BudgetItem } from "./lcd-budget-eviction.js";
import { CHARS_PER_TOKEN_RATIO } from "./constants.js";
import type { ContextEngineDeps, ContextWindowCapInfo } from "./types.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Valid thinking-level union (mirrors output-headroom.ts). */
type TLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const VALID_LEVELS: readonly TLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Run the CWF-02 pre-flight fit check.
 *
 * @param deps              - ContextEngineDeps (reads securityPinMarkers, callbacks, logger).
 * @param effectiveWindow   - budget.windowTokens for this turn.
 * @param evictable         - The full BudgetItem evictable array (before any pre-flight eviction).
 *                            Used to compute kept-token sums because evictHistoryUnderBudget
 *                            returns AgentMessage[] (strips token metadata).
 * @param keptCount         - Number of BudgetItems kept by the normal budget eviction pass.
 *                            The NEWEST keptCount items from evictable were kept.
 * @param freshTail         - The unconditional fresh-tail messages.
 * @param reasoningStyle    - profile.reasoningStyle ("none" | "native").
 * @param capInfo           - W1 cap provenance (budget.rawContextWindowTokens +
 *                            budget.windowCapSource). When the effective window was
 *                            clamped by a capability-class cap, the exhaustion throw
 *                            and WARN name the raw window and the exact config knob.
 *
 * Throws ContextExhaustionError if infeasible even at the thinking-level floor.
 * Emits onEffectiveWindow, onThinkingDownshifted, onAssembledInputTokens callbacks as side effects.
 * Returns the ORIGINAL assembled input token count (CR-03 — what is actually
 * dispatched) so the assembler's INFO line can log the budget equation (W5).
 */
export function runPreflightFitCheck(
  deps: ContextEngineDeps,
  effectiveWindow: number,
  evictable: BudgetItem[],
  keptCount: number,
  freshTail: AgentMessage[],
  reasoningStyle: "none" | "native",
  capInfo?: ContextWindowCapInfo,
): number {
  // Emit effectiveWindow callback so Plan 04 can clamp max_tokens dynamically.
  deps.onEffectiveWindow?.(effectiveWindow);

  const rawThinkingLevel = deps.getThinkingLevel?.() ?? "medium";
  const thinkingLevelInput: TLevel = (VALID_LEVELS as readonly string[]).includes(rawThinkingLevel)
    ? (rawThinkingLevel as TLevel)
    : "medium";

  // WR-02: use the operator-configurable floor (from contextEngine.budget.minVisibleOutputTokens)
  // when provided; otherwise fall back to the compile-time constant (768). Frontier/mid:
  // default 768 → byte-identical result.
  const minVisibleFloor = deps.minVisibleOutputTokens;

  let effectiveThinkingLevel: TLevel = thinkingLevelInput;
  let outputHeadroom = computeOutputHeadroom(reasoningStyle, effectiveThinkingLevel, minVisibleFloor);
  const headroomBound = effectiveWindow - outputHeadroom;

  // Compute budgetedTokens: the NEWEST keptCount items in evictable were kept by the normal
  // budget eviction (evictHistoryUnderBudget keeps the newest items, drops the oldest).
  const keptStart = Math.max(0, evictable.length - keptCount);
  const budgetedTokens = evictable.slice(keptStart).reduce((s, b) => s + b.tokens, 0);

  // Estimate fresh tail token count from char lengths (CHARS_PER_TOKEN_RATIO heuristic).
  // IN-01 fix: count chars from both string and array (multi-part/tool-result) content.
  // TOK-01 (Phase 179): the divisor is modulated by scriptTokenFactor over the
  // message's OWN extracted text (dense scripts carry ~2-3× tokens per char; ASCII
  // factor 1.0 → byte-identical). messageTextChars delegates to messageText, so the
  // counted length and the factor input can never diverge.
  // Per-message counts are kept (not just the sum) so the Issue-6 cause classifier
  // below can tell a single-oversized-message failure from an aggregate overflow.
  const freshTailMsgTokens = freshTail.map((m) =>
    Math.ceil(messageTextChars(m) / (CHARS_PER_TOKEN_RATIO * scriptTokenFactor(messageText(m)))),
  );
  const freshTailTokens = freshTailMsgTokens.reduce((s, t) => s + t, 0);
  // OF-01 (v2.19): count the FULL SDK prompt, not just history+freshTail. The
  // dominant term is the system prompt + tool schemas (S = getSystemTokensEstimate)
  // — the SAME value the eviction budget subtracts (lcd-assembler `S`). The
  // fit-check previously OMITTED it, so a real ~31.5K prompt (S≈25584 + history +
  // freshTail) looked like ~6.5K, passed the check, and the model truncated
  // silently at stopReason:length — the governor / clamp / context-exhausted
  // ladder never engaged. S is non-evictable (system+tools), so it also enters
  // the harder-eviction budget below and the reported assembled count.
  // See design/small-model-orchestration-fidelity.md §6 Fix 1.
  const systemTokens = deps.getSystemTokensEstimate?.() ?? 0;
  // CR-03: save the ORIGINAL assembled count (what is actually dispatched to the LLM)
  // BEFORE any simulation in step (a). onAssembledInputTokens must always report this
  // value — NOT the simulated undercount from the security-pin harder-eviction pass.
  const originalAssembledInputTokens = systemTokens + budgetedTokens + freshTailTokens;
  let assembledInputTokens = originalAssembledInputTokens;

  // W2 (obs-llm-troubleshooting): emit the budget equation once per fit check —
  // "fits"/"downshifted" at the end, "exhausted" right before the throw — so the
  // trajectory carries the numbers obs.explain needs to explain a degraded turn
  // (they previously existed only as daemon-log DEBUG lines).
  let governorFired = false;
  const emitBudgetComputed = (
    verdict: "fits" | "downshifted" | "exhausted",
    assembled: number,
    headroom: number,
  ): void => {
    deps.eventBus?.emit("context:budget_computed", {
      agentId: deps.agentId ?? "",
      sessionKey: deps.sessionKey ?? "",
      windowTokens: effectiveWindow,
      rawContextWindowTokens: capInfo?.rawContextWindowTokens ?? effectiveWindow,
      windowCapSource: capInfo?.windowCapSource ?? "none",
      systemTokens,
      freshTailTokens,
      budgetedHistoryTokens: budgetedTokens,
      keptCount,
      assembledInputTokens: assembled,
      outputHeadroom: headroom,
      verdict,
    });
  };

  if (assembledInputTokens > headroomBound) {
    // (a) Evict harder with security-pinned messages excluded (T-S4).
    const markers = deps.securityPinMarkers;
    if (markers) {
      const pinnedItems = evictable.filter((item) =>
        isSecurityRelevantMessage(item.msg as { content?: unknown; role?: string }, markers),
      );
      const nonPinnedItems = evictable.filter((item) =>
        !isSecurityRelevantMessage(item.msg as { content?: unknown; role?: string }, markers),
      );
      const pinnedTokens = pinnedItems.reduce((s, b) => s + b.tokens, 0);
      // OF-01: S (system+tools) is non-evictable — reserve it in the harder-eviction
      // budget so history is evicted against the room that ACTUALLY remains.
      const tighterBudget = Math.max(0, headroomBound - systemTokens - pinnedTokens - freshTailTokens);
      const hardEvictedMsgs = evictHistoryUnderBudget(nonPinnedItems, tighterBudget);
      // Recompute kept tokens: the hardEvictedMsgs count tells us how many nonPinned items
      // were kept (newest keptNonPinned items from nonPinnedItems).
      const keptNonPinned = hardEvictedMsgs.length;
      const keptNonPinnedStart = Math.max(0, nonPinnedItems.length - keptNonPinned);
      const keptNonPinnedTokens = nonPinnedItems.slice(keptNonPinnedStart).reduce((s, b) => s + b.tokens, 0);
      assembledInputTokens = systemTokens + keptNonPinnedTokens + pinnedTokens + freshTailTokens;
    }

    // (c) Down-shift thinking level if reasoningStyle === "native" and still over headroomBound.
    if (assembledInputTokens > headroomBound && reasoningStyle === "native") {
      let downshifted = downshiftThinkingLevel(effectiveThinkingLevel);
      while (downshifted !== undefined) {
        effectiveThinkingLevel = downshifted;
        outputHeadroom = computeOutputHeadroom(reasoningStyle, effectiveThinkingLevel, minVisibleFloor);
        const newBound = effectiveWindow - outputHeadroom;
        if (assembledInputTokens <= newBound) {
          // Governor fired — emit WARN + signal caller.
          deps.logger.warn(
            {
              step: "lcd-pre-flight",
              errorKind: "resource" as const,
              hint: `thinking down-shifted to fit window: ${thinkingLevelInput} → ${effectiveThinkingLevel}`,
              agentId: deps.agentId,
              sessionKey: deps.sessionKey,
              assembledInputTokens,
              effectiveWindow,
              outputHeadroom,
            },
            "thinking-effort governor fired",
          );
          deps.eventBus?.emit("context:thinking_downshifted", {
            agentId: deps.agentId ?? "",
            effectiveThinkingLevel,
            originalThinkingLevel: thinkingLevelInput,
          });
          deps.onThinkingDownshifted?.(effectiveThinkingLevel);
          governorFired = true;
          break;
        }
        downshifted = downshiftThinkingLevel(effectiveThinkingLevel);
      }
    }

    // (d) If still infeasible after all down-shifts → ContextExhaustionError.
    const finalHeadroom = computeOutputHeadroom(reasoningStyle, effectiveThinkingLevel, minVisibleFloor);
    const finalBound = effectiveWindow - finalHeadroom;
    if (assembledInputTokens > finalBound) {
      // Issue-6: classify WHY. A single item whose tokens alone (on top of the
      // non-evictable S) exceed the bound is an oversized-MESSAGE failure —
      // eviction/narrowing other content can never fix it, so the generic
      // "narrow the ask" advice would mislead. Distinguish the current input
      // (the LAST user message in the fresh tail — "shorten your message" is
      // actionable) from an earlier message (only a session reset helps).
      // Everything else is the historical aggregate overflow.
      //
      // ROOT-CAUSE fix (2026-06-22): the FIXED overhead S (system prompt + tool
      // schemas) is NON-EVICTABLE. When S alone exceeds the bound, the turn is
      // infeasible regardless of history/thinking/message — so this must be
      // classified FIRST, before the message/history branches. Pre-fix this fell
      // through to oversized_input because `singleItemBound = finalBound − S`
      // goes NEGATIVE (any message token count > a negative number), producing
      // the misleading "your message alone is larger than this model's context
      // window" reply for a 10-token "What is the capital of France?". The remedy
      // is the WINDOW or the agent's tool/prompt footprint — never the message.
      const singleItemBound = finalBound - systemTokens;
      const lastUserIdx = findLastUserIndex(freshTail);
      const cause: ContextExhaustionCause =
        systemTokens > finalBound
          ? "fixed_overhead_exceeds_window"
          : lastUserIdx >= 0 && (freshTailMsgTokens[lastUserIdx] ?? 0) > singleItemBound
            ? "oversized_input"
            : freshTailMsgTokens.some((t) => t > singleItemBound) ||
                evictable.some((b) => b.tokens > singleItemBound)
              ? "oversized_history_message"
              : "aggregate";
      deps.logger.warn(
        {
          step: "lcd-pre-flight",
          errorKind: "resource" as const,
          hint:
            "context exhausted: assembled input exceeds effective window minus headroom even at minimal thinking" +
            describeWindowCap(effectiveWindow, capInfo),
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
          assembledInputTokens,
          effectiveWindow,
          exhaustionCause: cause,
          ...(capInfo !== undefined && {
            rawContextWindowTokens: capInfo.rawContextWindowTokens,
            windowCapSource: capInfo.windowCapSource,
          }),
        },
        "pre-flight fit check: context exhausted",
      );
      emitBudgetComputed("exhausted", assembledInputTokens, finalHeadroom);
      throw new ContextExhaustionError(effectiveWindow, assembledInputTokens, capInfo, cause);
    }
  }

  // CR-03: always report the ORIGINAL assembled count (what is actually dispatched).
  // The simulated harder-eviction in step (a) only measures feasibility; it does NOT
  // change the actual context array dispatched (that is built from `repaired` in
  // lcd-assembler.ts). Reporting the simulated count would give config-resolver a
  // stale undercount → dynamicMax set too high → silent LLM truncation.
  deps.onAssembledInputTokens?.(originalAssembledInputTokens);

  // W2: the non-throw outcomes. `outputHeadroom` holds the downshifted value when
  // the governor fired (the loop reassigns it), so the event reports the headroom
  // the dispatch will actually run with.
  emitBudgetComputed(governorFired ? "downshifted" : "fits", originalAssembledInputTokens, outputHeadroom);

  return originalAssembledInputTokens;
}

/** The exact text of one message that the fresh-tail estimate counts: string
 *  content, or the text/content fields of array blocks (the IN-01 multi-part/
 *  tool-result shape). Per object block the fallback chain is `text ?? content`
 *  — mirroring the historical `b.text?.length ?? b.content?.length ?? 0`
 *  exactly (NOT text+content summed). TOK-01: this concatenation feeds
 *  scriptTokenFactor so the factor is computed over precisely the chars whose
 *  length is divided. */
function messageText(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") {
      out += block;
    } else if (block !== null && typeof block === "object") {
      const b = block as { text?: string; content?: string };
      out += b.text ?? b.content ?? "";
    }
  }
  return out;
}

/** Total text chars of one message — delegates to messageText so the counted
 *  length and the TOK-01 factor input can NEVER diverge (identity by construction). */
function messageTextChars(m: AgentMessage): number {
  return messageText(m).length;
}

/** Index of the LAST user-role message in the fresh tail (the current input), or -1. */
function findLastUserIndex(freshTail: AgentMessage[]): number {
  for (let i = freshTail.length - 1; i >= 0; i--) {
    if ((freshTail[i] as { role?: string }).role === "user") return i;
  }
  return -1;
}
