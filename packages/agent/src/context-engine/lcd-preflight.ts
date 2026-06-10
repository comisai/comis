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
 * @module
 */

import { computeOutputHeadroom, downshiftThinkingLevel } from "./output-headroom.js";
import { ContextExhaustionError, describeWindowCap } from "./errors.js";
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
 */
export function runPreflightFitCheck(
  deps: ContextEngineDeps,
  effectiveWindow: number,
  evictable: BudgetItem[],
  keptCount: number,
  freshTail: AgentMessage[],
  reasoningStyle: "none" | "native",
  capInfo?: ContextWindowCapInfo,
): void {
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
  const freshTailChars = freshTail.reduce((s, m) => {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") return s + content.length;
    if (Array.isArray(content)) {
      return s + content.reduce((acc: number, block: unknown) => {
        if (typeof block === "string") return acc + block.length;
        if (block !== null && typeof block === "object") {
          const b = block as { text?: string; content?: string };
          return acc + (b.text?.length ?? b.content?.length ?? 0);
        }
        return acc;
      }, 0);
    }
    return s;
  }, 0);
  const freshTailTokens = Math.ceil(freshTailChars / CHARS_PER_TOKEN_RATIO);
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
          ...(capInfo !== undefined && {
            rawContextWindowTokens: capInfo.rawContextWindowTokens,
            windowCapSource: capInfo.windowCapSource,
          }),
        },
        "pre-flight fit check: context exhausted",
      );
      emitBudgetComputed("exhausted", assembledInputTokens, finalHeadroom);
      throw new ContextExhaustionError(effectiveWindow, assembledInputTokens, capInfo);
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
}
