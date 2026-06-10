// SPDX-License-Identifier: Apache-2.0
/**
 * applyProvenanceDownweighting — the DIST-03 post-fusion provenance down-weighting
 * pass, extracted from memory-recall.ts (which crossed the 800-line cap when the
 * pass was added inline; mirrors the recall-causal-lane / recall-graph-spread-lane
 * extractions). PURE, synchronous, NON-DELETING helper.
 *
 * When one or more post-MMR ranked candidates carry the `lcd_distilled` tag, demote
 * (× {@link PROVENANCE_DOWNWEIGHT_FACTOR}) the same-conversation paired/source memories
 * the distilled summary subsumes — so the lossy summary does not double-count with its
 * own paired source rows in the recall budget. The memory is DEMOTED, never deleted:
 * it stays accessible, just ranked lower.
 *
 * The CALLER (memory-recall.ts) owns the precondition gate (`deps.provenanceStore != null`)
 * and the NON-FATAL try/catch — this helper assumes an active provenance store and is pure.
 *
 * DEFAULT-OFF BYTE-IDENTITY: no `lcd_distilled` entry in `ranked` → returns the input
 * array reference unchanged and never queries the store; an empty down-weight set → also
 * returns `ranked` unchanged.
 *
 * Architecture cut (agent↛memory): TYPE-only imports from @comis/core. This file NEVER
 * imports @comis/memory.
 *
 * ⚠ DORMANT IN PRODUCTION AS OF PHASE 172 (C1): the caller's `provenanceStore` is not
 * injected at the composition root and no concrete LcdProvenanceReadStore adapter exists
 * yet, so this helper is BUILT + test-pinned but never runs live. Phase 172 is
 * write-side-only with a HARD zero-assembly-path-diff guarantee; wiring this recall pass
 * is DEFERRED TO PHASE 173 (C2) per design §6.2 + the Phase-C split.
 *
 * @module
 */

import type {
  LcdProvenanceReadStore,
  ContextStoreScope,
  MemorySearchResult,
} from "@comis/core";

/** The tag a distilled episodic memory carries (written by the distillation runner). */
export const LCD_DISTILLED_TAG = "lcd_distilled";
/** Prefix of the optional `summary:<id>` tag carrying the LCD summaryId. */
export const SUMMARY_TAG_PREFIX = "summary:";
/**
 * Score multiplier applied to a paired/source memory that a selected distilled
 * summary subsumes. HALF, not zero — the row stays accessible (it is demoted, not
 * removed) so the lossy summary does not double-count with its own source rows.
 */
export const PROVENANCE_DOWNWEIGHT_FACTOR = 0.5;

/**
 * POST-FUSION PROVENANCE DOWN-WEIGHTING (DIST-03, read-side).
 *
 * Given the post-MMR ranked candidates, when one or more carries the `lcd_distilled`
 * tag, demote the same-conversation paired memories the distilled summary subsumes.
 * Selection unions two sources:
 *
 *  1. PROVENANCE-PRECISE (load-bearing `getProvenanceForSummary`): for any distilled
 *     summary that carries a `summary:<id>` tag, query the provenance read store for
 *     that summaryId and down-weight the returned `memoryId`s that appear in `ranked`.
 *  2. SESSION HEURISTIC: down-weight every NON-distilled candidate sharing the distilled
 *     summary's `source.sessionKey` (the covered conversation range).
 *
 * W6 PRECEDENCE FIX: `candidateIsDistilled` is computed as a SEPARATE boolean BEFORE
 * the `&&`-chain, so the predicate `candidate.id !== summary.id && !candidateIsDistilled`
 * is unambiguous — the distilled summary itself, and any OTHER lcd_distilled entry, are
 * NEVER added to the down-weight set (the `&&`/`||` precedence trap cannot fire).
 *
 * @param ranked          The post-MMR scored candidates (NOT mutated; a new array is
 *                        returned only when ≥1 candidate is down-weighted).
 * @param provenanceStore The injected provenance read port (the caller proved it defined).
 * @param scope           The (tenant, agent)-scoped ContextStoreScope for the R4 read.
 */
export function applyProvenanceDownweighting(
  ranked: MemorySearchResult[],
  provenanceStore: LcdProvenanceReadStore,
  scope: ContextStoreScope,
): MemorySearchResult[] {
  const isDistilled = (r: MemorySearchResult): boolean =>
    Array.isArray(r.entry.tags) && r.entry.tags.includes(LCD_DISTILLED_TAG);

  const distilledSummaries = ranked.filter(isDistilled);
  // Fast-path: nothing distilled in the ranked set → no read, no change (byte-identical).
  if (distilledSummaries.length === 0) return ranked;

  const downweightSet = new Set<string>();
  for (const summary of distilledSummaries) {
    // (1) PROVENANCE-PRECISE — only when the distilled summary carries its summaryId tag.
    const summaryTag = (summary.entry.tags ?? []).find((t) => t.startsWith(SUMMARY_TAG_PREFIX));
    if (summaryTag !== undefined) {
      const summaryId = summaryTag.slice(SUMMARY_TAG_PREFIX.length);
      if (summaryId.length > 0) {
        const rows = provenanceStore.getProvenanceForSummary(scope, summaryId);
        const linkedMemoryIds = new Set(rows.map((row) => row.memoryId));
        for (const candidate of ranked) {
          const candidateIsDistilled = isDistilled(candidate);
          // Same W6-safe predicate: never the summary itself, never another distilled row.
          if (
            candidate.entry.id !== summary.entry.id &&
            !candidateIsDistilled &&
            linkedMemoryIds.has(candidate.entry.id)
          ) {
            downweightSet.add(candidate.entry.id);
          }
        }
      }
    }

    // (2) SESSION HEURISTIC — same-conversation paired rows (the covered range).
    const sourceSessionKey = summary.entry.source?.sessionKey;
    if (sourceSessionKey !== undefined && sourceSessionKey.length > 0) {
      for (const candidate of ranked) {
        // W6 FIX: compute candidateIsDistilled as a SEPARATE boolean first, then the
        // fully-parenthesized predicate — the distilled summary itself (and any other
        // lcd_distilled entry) is excluded unambiguously.
        const candidateIsDistilled = isDistilled(candidate);
        if (candidate.entry.id !== summary.entry.id && !candidateIsDistilled) {
          const candidateKey = candidate.entry.source?.sessionKey;
          if (candidateKey === sourceSessionKey) {
            downweightSet.add(candidate.entry.id);
          }
        }
      }
    }
  }

  // Empty set → no change (byte-identical to the no-pass path).
  if (downweightSet.size === 0) return ranked;

  // Apply the multiplier — NEVER delete. A row with no score defaults to 1.0 first.
  return ranked.map((r) =>
    downweightSet.has(r.entry.id)
      ? { ...r, score: (r.score ?? 1.0) * PROVENANCE_DOWNWEIGHT_FACTOR }
      : r,
  );
}
