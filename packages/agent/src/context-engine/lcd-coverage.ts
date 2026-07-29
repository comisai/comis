// SPDX-License-Identifier: Apache-2.0
/**
 * The LCD `dag` assembler's COVERAGE seam: `history ∪ freshTail == liveMessages`.
 *
 * History is reconstructed from the STORE, so it can never reach past the store's
 * persisted horizon; the fresh tail is sliced from the LIVE array at a boundary
 * derived from a STEP COUNT. Those two indices come from different clocks. The
 * store is written at `afterTurn`, so mid-turn the horizon is FROZEN while the
 * step boundary marches FORWARD one step per LLM call — and once a turn runs more
 * steps than `freshTailTurns`, the boundary overtakes the horizon and the messages
 * between them belong to NEITHER segment.
 *
 * The first casualty is always the user message that STARTED the turn: it sits
 * exactly at the horizon, unpersisted until the turn ends. A long tool loop then
 * silently drops the request it is still serving, and the model answers as though
 * it was never asked — while every number the engine reports says healthy
 * (`verdict:"fits"`, `droppedCount:0`, a nearly-idle window), because the message
 * was never ASSEMBLED rather than evicted.
 *
 * This module owns both halves of the fix: {@link resolveFreshTailStart} closes
 * the gap by construction, and {@link warnOnCoverageShortfall} makes any future
 * regression in the seam announce itself on the line that already rides every
 * LLM call.
 *
 * Extracted from lcd-assembler.ts to keep that file under the 800-line cap.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";

interface RepresentedCoverageItem {
  msg: unknown;
  representedMessageCount?: number;
}

/**
 * Count raw-message coverage after history eviction. Summary prompt items use
 * their descendant count, while raw/synthetic items default to one.
 */
export function measureRepresentedCoverage(
  evictable: readonly RepresentedCoverageItem[],
  keptMessages: readonly unknown[],
  freshTailCount: number,
): { assembledCoverageCount: number; droppedCoverageCount: number } {
  const kept = new Set(keptMessages);
  let keptHistoryCoverageCount = 0;
  let droppedCoverageCount = 0;
  for (const item of evictable) {
    const represented = Math.max(0, item.representedMessageCount ?? 1);
    if (kept.has(item.msg)) keptHistoryCoverageCount += represented;
    else droppedCoverageCount += represented;
  }
  return {
    assembledCoverageCount: keptHistoryCoverageCount + freshTailCount,
    droppedCoverageCount,
  };
}

/**
 * The fresh tail's slice-start index, clamped so the verbatim tail always reaches
 * back to at least the store's persisted horizon.
 *
 * `freshTailTurns` stays a FLOOR on verbatim recency (never fewer than N steps) —
 * this only ever WIDENS the tail, and only by content that exists nowhere else.
 * It also makes the mid-turn tail start STABLE (the horizon does not move until
 * `afterTurn`), so the tail grows by pure suffix-append instead of sliding its
 * prefix on every step — which is strictly kinder to the provider prompt cache.
 *
 * Gated on a COMPLETE read scope. `countMessages` answers 0 for three different
 * states — an empty store, an incomplete (fail-closed) scope, and a corrupt count
 * — and only the first means "these messages are in flight". Under the fail-closed
 * scope history is empty for an unrelated reason (cross-agent leak protection), so
 * clamping to 0 there would make the WHOLE live array unconditional and overflow a
 * tight window instead of degrading honestly to the fresh tail.
 *
 * @param stepBoundary - the step-count boundary from `freshTailBoundaryIndex`.
 * @param persistedMsgCount - the store's horizon (`countMessages`, 0 when unreadable).
 * @param scopeIsReadable - whether agentId+tenantId are both present (the store's own guard).
 * @returns the slice-start index for the fresh tail.
 */
export function resolveFreshTailStart(
  stepBoundary: number,
  persistedMsgCount: number,
  scopeIsReadable: boolean,
): number {
  return scopeIsReadable ? Math.min(stepBoundary, persistedMsgCount) : stepBoundary;
}

/**
 * Reconcile the assembled array against the live conversation and WARN when it
 * does not cover it.
 *
 * Diagnosing the original hole took hand-joining `historyCount + freshTailCount`
 * against the NEXT call's `messageCount` across two log lines, because no single
 * line carried both sides. This reconciles them at the source.
 *
 * Measured at the CONCAT seam (`budgeted ++ freshTail`), NOT on the repaired
 * output, in represented-message units, and with every DELIBERATE removal netted
 * out — otherwise the WARN cries wolf on healthy turns and gets ignored:
 *   - `droppedCoverageCount` — raw messages represented by evicted history items;
 *   - `freshTailTrimmedCount` — the residual trim dropping oldest tail steps on a
 *     tight window (honest degradation, and the pre-flight reports it);
 *   - summary compaction is not a removal: one prompt item contributes its
 *     durable descendant count to `assembledCoverageCount`;
 *   - transcript repair, excluded by measuring before it runs. Repair both ADDS
 *     synthesized results for unpaired calls and DROPS orphan/duplicate ones, so
 *     its output is not a coverage measure of this seam at all.
 *
 * @returns the shortfall (0 on every healthy call), for the caller's INFO line.
 */
export function warnOnCoverageShortfall(
  logger: ComisLogger,
  m: {
    liveCount: number;
    assembledCount: number;
    assembledCoverageCount: number;
    droppedCount: number;
    droppedCoverageCount: number;
    freshTailTrimmedCount: number;
    persistedMsgCount: number;
    stepBoundary: number;
    tailStart: number;
    historyCount: number;
    freshTailCount: number;
    agentId: string | undefined;
    sessionKey: string | undefined;
  },
): number {
  const shortfall = Math.max(
    0,
    m.liveCount
      - m.droppedCoverageCount
      - m.freshTailTrimmedCount
      - m.assembledCoverageCount,
  );
  if (shortfall === 0) return 0;
  logger.warn(
    {
      step: "lcd-assemble",
      errorKind: "internal" as const,
      liveCount: m.liveCount,
      persistedMsgCount: m.persistedMsgCount,
      stepBoundary: m.stepBoundary,
      tailStart: m.tailStart,
      historyCount: m.historyCount,
      freshTailCount: m.freshTailCount,
      assembledCount: m.assembledCount,
      assembledCoverageCount: m.assembledCoverageCount,
      droppedCount: m.droppedCount,
      droppedCoverageCount: m.droppedCoverageCount,
      freshTailTrimmedCount: m.freshTailTrimmedCount,
      coverageShortfall: shortfall,
      hint:
        "represented-message coverage is short after intentional eviction and tail trimming. Inspect lcd_context_items for dangling refs, verify summary descendant counts, and compare persistedMsgCount with stepBoundary to confirm fresh-tail clamping.",
      agentId: m.agentId,
      sessionKey: m.sessionKey,
    },
    "lcd assembled context does NOT cover the live conversation",
  );
  return shortfall;
}
