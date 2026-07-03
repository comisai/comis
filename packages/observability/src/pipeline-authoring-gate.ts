// SPDX-License-Identifier: Apache-2.0
/**
 * The pre-committed, PURE, deterministic pipeline-authoring decision rule.
 *
 * The RULE is the deliverable, not a live verdict. Given the small-vs-frontier
 * authoring aggregate (counts + rates), `pipelineAuthoringGate` returns
 * `{ buildAuthor, reason }` — it is PURE (no I/O, no clock, no globals; the
 * `test/architecture/globals.test.ts` gate enforces this repo-wide), so the same
 * aggregate reproduces the same verdict forever (determinism makes the decision
 * reproducible and non-repudiable). It mirrors the ordered first-match-wins
 * determinism of `fleetRootCause` / `likelyRootCause`.
 *
 * The pre-committed thresholds (committed BEFORE the data exists — the
 * measure-first discipline):
 *   - non-trivial sample  := smallTierInvocations >= {@link MIN_SMALL_TIER_SAMPLE} (20)
 *   - materially below    := (frontierValidRate - smallTierValidRate) >= {@link MATERIAL_GAP_PP} (15) percentage points
 * Build the author pipeline ONLY when BOTH hold. No data / below either
 * threshold -> defer.
 *
 * With no production telemetry the aggregate is `{0,0,0}` and the rule returns
 * `defer` — the author pipeline stays gated-off until real data justifies it.
 *
 * LEAF ISOLATION (`test/architecture/observability-package-isolation.test.ts`):
 * this file imports NOTHING — not the daemon, agent, cli, orchestrator, or
 * memory packages, not even core — it is a pure function over a plain counts
 * interface (no DiagnosticRow, no store).
 *
 * INFO-DISCLOSURE: the `reason` carries ONLY counts + the pp gap — no agent ids,
 * no body, no secret.
 *
 * @module
 */

/** "Non-trivial" small-tier invocations over the window (the committed sample floor). */
export const MIN_SMALL_TIER_SAMPLE = 20;

/** "Materially below frontier" — the committed validity gap, in percentage points. */
export const MATERIAL_GAP_PP = 15;

/**
 * The small-vs-frontier pipeline-authoring aggregate the gate consumes. This is
 * the CANONICAL home of this type — the reducer in fleet-findings.ts imports it
 * from here, so `@comis/observability` is the single source. Field names + order
 * are load-bearing (the reducer returns this exact shape):
 * `smallTierInvocations`, `smallTierValidRate`, `frontierValidRate`.
 */
export interface PipelineAuthoringAggregate {
  /** Count of small|nano rows over the window. */
  smallTierInvocations: number;
  /** (small|nano rows where schemaValid===true) / smallTierInvocations; 0 when none. 0..1. */
  smallTierValidRate: number;
  /** (frontier rows where schemaValid===true) / frontier total; 0 when none. 0..1. */
  frontierValidRate: number;
}

/** The gate verdict — a boolean decision + a counts-only audit reason. */
export interface PipelineAuthoringVerdict {
  buildAuthor: boolean;
  reason: string;
}

/**
 * The pre-committed decision rule. PURE + deterministic (mirror `fleetRootCause`):
 * same aggregate -> the same verdict, forever. Ordered first-match-wins —
 * insufficient sample defers before the gap is even considered.
 */
export function pipelineAuthoringGate(
  agg: PipelineAuthoringAggregate,
): PipelineAuthoringVerdict {
  // 1) Non-trivial sample. Below the floor -> defer (no-data lands here too).
  if (agg.smallTierInvocations < MIN_SMALL_TIER_SAMPLE) {
    return {
      buildAuthor: false,
      reason: `defer: insufficient telemetry (${agg.smallTierInvocations} small-tier invocations < ${MIN_SMALL_TIER_SAMPLE})`,
    };
  }
  // Fail-safe on a non-finite rate. The sole production feeder
  // (pipelineAuthoringAggregateFromRows) guards division-by-zero and can only
  // ever produce finite 0..1 rates, so this is unreachable today — but the gate
  // is an exported pure function on the package's public API, and
  // `NaN < MATERIAL_GAP_PP` / `Infinity < ...` both evaluate false, which would
  // otherwise fall through to a WRONG buildAuthor: true. A non-finite aggregate
  // defers (fail-safe), never builds. Pure: no I/O, no clock, no globals —
  // Number.isFinite is a stateless numeric predicate.
  if (!Number.isFinite(agg.smallTierValidRate) || !Number.isFinite(agg.frontierValidRate)) {
    return { buildAuthor: false, reason: "defer: non-finite validity rate (invalid aggregate)" };
  }
  // 2) Materially-below-frontier validity gap (in percentage points).
  const gapPp = (agg.frontierValidRate - agg.smallTierValidRate) * 100;
  if (gapPp < MATERIAL_GAP_PP) {
    return {
      buildAuthor: false,
      reason: `defer: small-tier validity within ${MATERIAL_GAP_PP}pp of frontier (gap ${gapPp.toFixed(1)}pp)`,
    };
  }
  // 3) Non-trivial sample materially below frontier -> build P2.
  return {
    buildAuthor: true,
    reason: `build: ${agg.smallTierInvocations} small-tier invocations, validity ${gapPp.toFixed(1)}pp below frontier (>= ${MATERIAL_GAP_PP}pp)`,
  };
}
