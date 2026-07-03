// SPDX-License-Identifier: Apache-2.0
/**
 * In-process recall counter registry.
 *
 * A process-lifetime GAUGE that accumulates lane usage, rerank
 * runs/fallbacks, consolidation throughput, and recall hit-rate inputs.
 *
 * RESET-ON-RESTART SEMANTIC: the counters live in plain
 * closed-over numeric accumulators with NO persistence. A process restart
 * resets every counter to zero — this is intentional. These are
 * health/metrics gauges (mirroring the in-process side of `comis cache
 * stats`), not durable accounting; the requirement explicitly calls for
 * "in-process counters," and a durable SQLite table would add a schema
 * migration + write path for no operational gain.
 *
 * Each `createRecallCounters()` call owns its OWN accumulators — there is no
 * module-global state, so two registries are fully independent. `snapshot()`
 * returns a fresh defensive copy (including a fresh `laneUsage` object) so a
 * caller mutating the snapshot can never corrupt the internal state.
 *
 * Pure module — NO clock, NO I/O, NO fs, NO env, NO module-global mutable
 * state. (The `globals` architecture test forbids Date.now / new Date /
 * process.env / fs in leaf modules; this module touches none of them.)
 *
 * @module
 */

import type {
  ConsolidatedCounterInput,
  RecallCounters,
  RecallCountersSnapshot,
  RecalledCounterInput,
  RerankedCounterInput,
} from "./types.js";

/**
 * Construct a fresh in-process recall counter registry. All counters start
 * at zero and accumulate for the lifetime of this registry object.
 */
export function createRecallCounters(): RecallCounters {
  // Per-registry closed-over accumulators. NOT module-global — each call
  // gets its own, so two registries never share state.
  const laneUsage = { fts: 0, vector: 0, entity: 0 };
  let rerankRuns = 0;
  let rerankFallbacks = 0;
  let consolidationClusters = 0;
  let observationsCreated = 0;
  let recalls = 0;
  let recallsWithHits = 0;

  return {
    onRecalled(input: RecalledCounterInput): void {
      // Lane-usage semantic: accumulate the CANDIDATE COUNT per lane (not a
      // mere presence flag) — the operator wants total candidates fetched
      // per lane across the process lifetime, so a recall that fetched 5 FTS
      // candidates contributes 5 to laneUsage.fts.
      laneUsage.fts += input.lanes.fts;
      laneUsage.vector += input.lanes.vector;
      laneUsage.entity += input.lanes.entity;
      recalls += 1;
      if (input.finalCount > 0) {
        recallsWithHits += 1;
      }
    },

    onReranked(input: RerankedCounterInput): void {
      rerankRuns += 1;
      // A fallback is EITHER an err-fallback OR a timeout — both end with the
      // recall using the fusion order (fallback-rate = fallbacks / runs).
      if (input.fellBack || input.timedOut) {
        rerankFallbacks += 1;
      }
    },

    onConsolidated(input: ConsolidatedCounterInput): void {
      consolidationClusters += input.clustersProcessed;
      observationsCreated += input.observationsCreated;
    },

    snapshot(): RecallCountersSnapshot {
      // Defensive copy — never hand out a reference to the internal mutable
      // state (the nested laneUsage object is freshly allocated too).
      return {
        laneUsage: { fts: laneUsage.fts, vector: laneUsage.vector, entity: laneUsage.entity },
        rerankRuns,
        rerankFallbacks,
        consolidationClusters,
        observationsCreated,
        recalls,
        recallsWithHits,
      };
    },
  };
}
