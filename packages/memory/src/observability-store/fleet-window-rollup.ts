// SPDX-License-Identifier: Apache-2.0
/**
 * `reduceFleetWindow` — the PURE cross-session window-rollup reducer.
 *
 * Folds the per-session rollups (`SessionSummaryRollup[]`, produced by
 * `ObservabilityStore.aggregateSessionsInWindow`) into ONE fleet
 * aggregate: session count, degraded rate, merged + capped top errorKinds,
 * breaker-trip total, per-tool ok/failed, and cost. This is the cross-session
 * reduce that `obs.explain` structurally cannot produce — it sees a single
 * session, this sees the whole window.
 *
 * THE LOAD-BEARING REQUIREMENT — real synthetic exclusion (not a no-op): when
 * `excludeSynthetic` is set, the reducer drops every row whose
 * `source` is not `"runtime"` BEFORE reducing, so test/bench sessions cannot
 * inflate the operator-facing fleet metric. The filter acts on the REAL
 * `SessionSummaryRollup.source` field threaded onto the row's
 * `details` JSON; a bare exclusion would be a no-op if the field did not exist.
 * The companion test pins
 * this by asserting the two `excludeSynthetic` branches produce DIFFERENT counts.
 *
 * Purity + bounding (AGENTS §2.5 determinism; §2.7 bounded-payload): no clock, no
 * I/O, no throw — same input rows always yield deeply-equal output. The merged
 * errorKinds map is hard-capped at {@link FLEET_TOP_ERROR_KINDS_CAP}, sorted by
 * count descending with the kind name as a deterministic tie-break; per-tool keys
 * are bounded by the distinct tool set. Counts only — no free text concatenated.
 *
 * @module
 */
import type { SessionSummaryRollup } from "./observability-store-types.js";

/**
 * How many merged ErrorKinds the fleet rollup keeps — hard cap, DoS-bounded.
 * Mirrors the per-session `TOP_ERROR_KINDS_CAP` (session-health-rollup.ts) so the
 * fleet aggregate cannot grow with failure volume across sessions.
 */
const FLEET_TOP_ERROR_KINDS_CAP = 3;

/**
 * How many distinct degradation CAUSES (`endReason` buckets) the fleet rollup's
 * `degradedByCause` keeps — hard cap, DoS-bounded. Sized to cover the FULL closed
 * degraded-cause union so a real cause can NEVER be silently dropped: the
 * reachable causes are the 9 non-`"success"` members of the `sessionEnd.endReason`
 * union (error, timeout, budget_exceeded, budget_exhausted, circuit_open,
 * provider_degraded, completed_with_tool_errors, context_exhausted,
 * output_starved) PLUS the defensive {@link UNKNOWN_CAUSE} fold = 10. Because the
 * union is CLOSED, covering it fully preserves the DoS bound while removing the
 * silent-drop hole the prior cap of 5 left (a 6+-cause window would shed the
 * lowest-count tail with no `truncations[]` breadcrumb, understating
 * `sum(degradedByCause)` vs `sessions.degraded`). Higher than the errorKinds cap
 * because the named causes are the headline of the fleet detector ("N degraded by
 * context_exhausted, M by output_starved") and an operator wants the full spread.
 */
const FLEET_DEGRADED_BY_CAUSE_CAP = 10;

/** The stable bucket for a degraded row whose endReason is missing/blank. */
const UNKNOWN_CAUSE = "unknown";

/**
 * The cross-session fleet aggregate produced by {@link reduceFleetWindow}.
 *
 * All fields are reduced over the KEPT sessions (synthetic rows excluded when
 * `excludeSynthetic` is set). `degradedRate` is `0` when `sessionCount` is `0`
 * (no divide-by-zero). `topErrorKinds` is the merged map capped at
 * {@link FLEET_TOP_ERROR_KINDS_CAP}; `toolStats` sums each tool's ok/failed
 * across sessions.
 */
export interface FleetWindowRollup {
  /** Number of sessions folded into the aggregate (after synthetic exclusion). */
  sessionCount: number;
  /**
   * Absolute count of degraded sessions over the KEPT (synthetic-excluded) rows —
   * the numerator of {@link degradedRate}. Exposed so the fleet handler's
   * `sessions.degraded` shares ONE synthetic-excluded population with `total`
   * (`sessionCount`) and `degradedRate`, rather than re-deriving the count from
   * the unfiltered rows (which would double-count a synthetic degraded row and
   * make `sessions.degraded` exceed `total` / disagree with `degradedRate` and
   * `sum(degradedByCause)`). Equals `sum(Object.values(degradedByCause))`
   * before the cap (the cap only trims the cause SPREAD, not this total).
   */
  degradedCount: number;
  /** Degraded sessions / sessionCount in 0..1; `0` when sessionCount is 0. */
  degradedRate: number;
  /** Merged per-kind failure counts, capped to the top-N by summed count. */
  topErrorKinds: Record<string, number>;
  /**
   * Degraded session COUNTS bucketed by the named `endReason` cause
   * (the fleet-level degradation detector: "N degraded by context_exhausted, M
   * by output_starved"). ONLY degraded rows contribute; a missing/blank cause
   * folds into `"unknown"`. Capped at {@link FLEET_DEGRADED_BY_CAUSE_CAP},
   * top-count-first with name-asc tie-break (deterministic, DoS-bounded).
   */
  degradedByCause: Record<string, number>;
  /** Sum of per-session breaker-trip counts. */
  breakerTripTotal: number;
  /** Per-tool {ok, failed} summed across sessions; keys bounded by the tool set. */
  toolStats: Record<string, { ok: number; failed: number }>;
  /** Sum of per-session USD cost. */
  costUsd: number;
}

/**
 * Reduce per-session A1 rollups into the fleet window aggregate.
 *
 * @param rows - the per-session rollups (A1 output). Treated read-only.
 * @param opts.excludeSynthetic - when `true`, drop rows whose `source !== "runtime"`
 *   (test/bench provenance) before reducing — the metric-integrity filter.
 * @returns the bounded, deterministic {@link FleetWindowRollup}.
 */
export function reduceFleetWindow(
  rows: readonly SessionSummaryRollup[],
  opts: { excludeSynthetic: boolean },
): FleetWindowRollup {
  // The load-bearing filter: act on the REAL source field threaded onto the rollup row.
  // `source === "runtime"` is a genuine predicate (the row carries the value),
  // NOT the 158-gate no-op (which filtered a field that did not exist).
  const kept = opts.excludeSynthetic ? rows.filter((r) => r.source === "runtime") : rows;

  let degradedCount = 0;
  let breakerTripTotal = 0;
  let costUsd = 0;
  const mergedKinds = new Map<string, number>();
  const mergedTools = new Map<string, { ok: number; failed: number }>();
  // Degraded-session counts bucketed by named endReason cause.
  const causeCounts = new Map<string, number>();

  for (const r of kept) {
    if (r.degraded) {
      degradedCount += 1;
      // Bucket the named degradation cause. A missing/blank endReason (a row
      // that bypassed the query-layer default, or a malformed value) folds into
      // the stable UNKNOWN_CAUSE — the reducer is a public export and must not
      // trust its caller, so a degraded row is ALWAYS counted somewhere.
      const cause =
        typeof r.endReason === "string" && r.endReason.length > 0 ? r.endReason : UNKNOWN_CAUSE;
      causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
    }
    breakerTripTotal += r.breakerTripCount;
    costUsd += r.costUsd;
    for (const [kind, n] of Object.entries(r.topErrorKinds)) {
      // Defensive coercion: the reducer is a public export reachable directly by
      // the fleet handler, so it must not assume its caller validated. A
      // non-finite/non-number count contributes 0 rather than producing "05"
      // (string concat) or NaN — keeping the `number` output contract honest
      // regardless of caller hygiene (mirrors the session reader's Number.isFinite).
      const inc = typeof n === "number" && Number.isFinite(n) ? n : 0;
      mergedKinds.set(kind, (mergedKinds.get(kind) ?? 0) + inc);
    }
    for (const [tool, s] of Object.entries(r.toolStats)) {
      const acc = mergedTools.get(tool) ?? { ok: 0, failed: 0 };
      // Same input-trust gap as the kinds above: a malformed `{ok,failed}` (a
      // bare number, an undefined field) contributes finite zeros, never NaN.
      const ok = typeof s?.ok === "number" && Number.isFinite(s.ok) ? s.ok : 0;
      const failed = typeof s?.failed === "number" && Number.isFinite(s.failed) ? s.failed : 0;
      acc.ok += ok;
      acc.failed += failed;
      mergedTools.set(tool, acc);
    }
  }

  // Deterministic top-N: sort by count desc, then kind name asc to break ties so
  // the capped output is independent of input/insertion order.
  const topErrorKinds: Record<string, number> = Object.fromEntries(
    [...mergedKinds.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, FLEET_TOP_ERROR_KINDS_CAP),
  );

  // Same deterministic top-N discipline as topErrorKinds: count desc, then cause
  // name asc tie-break, capped — so degradedByCause is byte-stable across input
  // permutations and DoS-bounded.
  const degradedByCause: Record<string, number> = Object.fromEntries(
    [...causeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, FLEET_DEGRADED_BY_CAUSE_CAP),
  );

  const sessionCount = kept.length;
  return {
    sessionCount,
    // The absolute degraded count over the kept rows — the fleet handler
    // reads this back so `sessions.degraded` shares the synthetic-excluded
    // population with `total`/`degradedRate` instead of counting unfiltered rows.
    degradedCount,
    degradedRate: sessionCount === 0 ? 0 : degradedCount / sessionCount,
    topErrorKinds,
    degradedByCause,
    breakerTripTotal,
    // Deterministic key enumeration: sort merged tool names ASC before
    // re-objectifying so the output is byte-stable across input permutations
    // (a `Map` preserves insertion = input-traversal order). The summed VALUES
    // are already order-independent; this pins the KEY order for any consumer
    // that serializes the rollup (cache key / wire digest / snapshot) — the same
    // discipline already applied to topErrorKinds and the A3 reader's histograms.
    toolStats: Object.fromEntries(
      [...mergedTools.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
    costUsd,
  };
}
