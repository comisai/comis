// SPDX-License-Identifier: Apache-2.0
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
import { ContextExhaustionError } from "./errors.js";
import { isSecurityRelevantMessage } from "./security-context-pinner.js";
import { evictHistoryUnderBudget, type BudgetItem } from "./lcd-budget-eviction.js";
import { CHARS_PER_TOKEN_RATIO } from "./constants.js";
import type { ContextEngineDeps } from "./types.js";
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
): void {
  // Emit effectiveWindow callback so Plan 04 can clamp max_tokens dynamically.
  deps.onEffectiveWindow?.(effectiveWindow);

  const rawThinkingLevel = deps.getThinkingLevel?.() ?? "medium";
  const thinkingLevelInput: TLevel = (VALID_LEVELS as readonly string[]).includes(rawThinkingLevel)
    ? (rawThinkingLevel as TLevel)
    : "medium";

  let effectiveThinkingLevel: TLevel = thinkingLevelInput;
  let outputHeadroom = computeOutputHeadroom(reasoningStyle, effectiveThinkingLevel);
  const headroomBound = effectiveWindow - outputHeadroom;

  // Compute budgetedTokens: the NEWEST keptCount items in evictable were kept by the normal
  // budget eviction (evictHistoryUnderBudget keeps the newest items, drops the oldest).
  const keptStart = Math.max(0, evictable.length - keptCount);
  const budgetedTokens = evictable.slice(keptStart).reduce((s, b) => s + b.tokens, 0);

  // Estimate fresh tail token count from char lengths (CHARS_PER_TOKEN_RATIO heuristic).
  const freshTailChars = freshTail.reduce(
    (s, m) =>
      s + (typeof (m as { content?: unknown }).content === "string"
        ? ((m as { content: string }).content).length
        : 0),
    0,
  );
  const freshTailTokens = Math.ceil(freshTailChars / CHARS_PER_TOKEN_RATIO);
  let assembledInputTokens = budgetedTokens + freshTailTokens;

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
      const tighterBudget = Math.max(0, headroomBound - pinnedTokens - freshTailTokens);
      const hardEvictedMsgs = evictHistoryUnderBudget(nonPinnedItems, tighterBudget);
      // Recompute kept tokens: the hardEvictedMsgs count tells us how many nonPinned items
      // were kept (newest keptNonPinned items from nonPinnedItems).
      const keptNonPinned = hardEvictedMsgs.length;
      const keptNonPinnedStart = Math.max(0, nonPinnedItems.length - keptNonPinned);
      const keptNonPinnedTokens = nonPinnedItems.slice(keptNonPinnedStart).reduce((s, b) => s + b.tokens, 0);
      assembledInputTokens = keptNonPinnedTokens + pinnedTokens + freshTailTokens;
    }

    // (c) Down-shift thinking level if reasoningStyle === "native" and still over headroomBound.
    if (assembledInputTokens > headroomBound && reasoningStyle === "native") {
      let downshifted = downshiftThinkingLevel(effectiveThinkingLevel);
      while (downshifted !== undefined) {
        effectiveThinkingLevel = downshifted;
        outputHeadroom = computeOutputHeadroom(reasoningStyle, effectiveThinkingLevel);
        const newBound = effectiveWindow - outputHeadroom;
        if (assembledInputTokens <= newBound) {
          // Governor fired — emit WARN + signal caller.
          deps.logger.warn(
            {
              step: "lcd-pre-flight",
              errorKind: "capacity" as const,
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
          break;
        }
        downshifted = downshiftThinkingLevel(effectiveThinkingLevel);
      }
    }

    // (d) If still infeasible after all down-shifts → ContextExhaustionError.
    const finalHeadroom = computeOutputHeadroom(reasoningStyle, effectiveThinkingLevel);
    const finalBound = effectiveWindow - finalHeadroom;
    if (assembledInputTokens > finalBound) {
      deps.logger.warn(
        {
          step: "lcd-pre-flight",
          errorKind: "capacity" as const,
          hint: "context exhausted: assembled input exceeds effective window minus headroom even at minimal thinking",
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
          assembledInputTokens,
          effectiveWindow,
        },
        "pre-flight fit check: context exhausted",
      );
      throw new ContextExhaustionError(effectiveWindow, assembledInputTokens);
    }
  }

  // Expose assembledInputTokens for dynamic max_tokens clamping (Plan 04).
  deps.onAssembledInputTokens?.(assembledInputTokens);
}
