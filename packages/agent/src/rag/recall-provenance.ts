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
 * it stays accessible, just ranked lower. CR-01 (Phase 173-05): the demotion RE-SORTS the
 * returned array by descending score (STABLE — index tiebreaker) so it is observable in
 * RANK, not merely in the `score` field — nothing downstream re-sorts (deduplicateResults
 * preserves order; the hybrid injector consumes the array in order), so without the re-sort
 * a halved row kept its exact slot and the demotion was a no-op for ranking.
 *
 * The CALLER (memory-recall.ts) owns the precondition gate (`deps.provenanceStore != null`)
 * and the NON-FATAL try/catch — this helper assumes an active provenance store and is pure.
 *
 * DEFAULT-OFF BYTE-IDENTITY: no `lcd_distilled` entry in `ranked` → returns the input
 * array reference unchanged and never queries the store; an empty down-weight set → also
 * returns `ranked` unchanged (NO re-sort). The re-sort runs ONLY when ≥1 row was actually
 * down-weighted, so a no-op pass never perturbs the established rank.
 *
 * Architecture cut (agent↛memory): TYPE-only imports from @comis/core. This file NEVER
 * imports @comis/memory.
 *
 * LIVE AS OF PHASE 173 (C2): the caller's `provenanceStore` is now injected at the
 * composition root (setup-memory builds the concrete LcdProvenanceReadStore and threads it
 * to createMemoryRecall) and the distillation runner stamps the `summary:<id>` tag, so the
 * PROVENANCE-PRECISE branch is the primary selector. The helper itself is UNCHANGED — it
 * remains a byte-identical no-op when no lcd_distilled result is present.
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
 *     PRIMARY as of 173-04 (the distillation runner stamps the tag).
 *  2. SESSION HEURISTIC (FALLBACK ONLY — IN-03, Phase 173-05): down-weight every
 *     NON-distilled candidate sharing the distilled summary's `source.sessionKey`. This is
 *     over-broad (it cannot distinguish a legitimately-distinct same-session memory from a
 *     genuinely-subsumed one — neither MemorySource nor the provenance row carries the
 *     covered time range), so it is GATED behind the ABSENCE of a usable `summary:<id>` tag:
 *     when branch (1) can select precisely it OWNS the selection and branch (2) is SKIPPED;
 *     the heuristic fires only for a distilled row that has no precise tag (older rows / a
 *     write that skipped it). This stops the now-effective re-sort (CR-01) from suppressing
 *     legitimately-distinct same-session recall.
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
    //     This is the PRIMARY selector as of 173-04: the distillation runner now stamps
    //     `summary:<id>`, so a precise provenance read links the EXACT subsumed rows.
    const summaryTag = (summary.entry.tags ?? []).find((t) => t.startsWith(SUMMARY_TAG_PREFIX));
    const summaryId = summaryTag !== undefined ? summaryTag.slice(SUMMARY_TAG_PREFIX.length) : "";
    const hasUsablePreciseTag = summaryId.length > 0;
    if (hasUsablePreciseTag) {
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

    // (2) SESSION HEURISTIC — same-conversation paired rows (the covered conversation).
    //     IN-03 SCOPING (Phase 173-05): this branch down-weights EVERY non-distilled
    //     candidate sharing the summary's sessionKey, which over-demotes a long-lived
    //     session (it cannot tell a legitimately-distinct same-session memory from a
    //     genuinely-subsumed one — neither the MemorySource nor the provenance row
    //     carries the summary's covered time range to scope it precisely). Now that the
    //     pass is EFFECTIVE (CR-01 re-sort below makes the demotion change rank), that
    //     over-reach would suppress relevant recall. So branch (2) is GATED behind the
    //     ABSENCE of a usable `summary:<id>` tag: when branch (1) can select precisely it
    //     OWNS the selection; the heuristic only fires as the fallback for a distilled
    //     row that carries no precise tag (older rows / a write that skipped the tag).
    if (hasUsablePreciseTag) continue; // branch (1) is authoritative for this summary
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
  const downweighted = ranked.map((r) =>
    downweightSet.has(r.entry.id)
      ? { ...r, score: (r.score ?? 1.0) * PROVENANCE_DOWNWEIGHT_FACTOR }
      : r,
  );

  // CR-01 (Phase 173-05): the demotion must be observable in RANK, not just the `score`
  // field. The down-weighting previously changed `score` but PRESERVED array position,
  // and nothing downstream re-sorts (deduplicateResults preserves order; the hybrid
  // injector consumes the array IN ORDER) — so a halved row kept its exact slot and the
  // "don't double-count the lossy summary" intent was a no-op for ranking. Re-sort by
  // DESCENDING score so the demoted rows actually sink. The sort is STABLE (index
  // tiebreaker) — it mirrors how scoreWithBreakdown/fuse establish rank and keeps the
  // relative order of equal-scored (incl. non-down-weighted) rows identical to the input.
  return downweighted
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.score ?? 0) - (a.r.score ?? 0) || a.i - b.i)
    .map((x) => x.r);
}
