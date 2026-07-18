// SPDX-License-Identifier: Apache-2.0
/**
 * Autonomy slice + findings — all the cross-run
 * AUTONOMY-health logic for the `comis system-health` report, extracted into this sibling
 * module to keep `system-health.ts` + `system-findings.ts` under the obs-handlers
 * per-subdirectory 500-line cap (the `obs-autonomy-rows.ts` / `system-findings-
 * extractors.ts` file-size-extraction precedent). No behavior change — both the
 * reducer and the three findings relocate byte-identically; the callers import them
 * back.
 *
 * Two pure exports over the already-read sources (NO clock, NO I/O, NO re-derivation
 * over raw session rows):
 *   - {@link computeAutonomySlice} — the structured `autonomy` block (run counts +
 *     degradedRate from `DurableRunPort.countByStatus`, resumed/killed/worst-run id
 *     from the event-sourced `health_signal` rows, breaker/cost read back from the
 *     synthetic-excluded `reduceSystemWindow`), including the worst rootRunId.
 *   - {@link buildAutonomyFindings} — the three dedicated findings (durable_orphaned
 *     / autonomy_revoked / autonomy_killed; kill separable from revoke).
 *
 * SECURITY INVARIANT (the digest-only report schema): counts + closed enums + the
 * worst rootRunId (an id) ONLY — NEVER the engine's free-text orphan reason (mapped
 * to a closed enum at the source), a lease bearer/selector,
 * or any body. Every `details` field is parsed via the defensive
 * `*FromRow` extractors that never echo a body. Safe to paste into a review.
 *
 * @module
 */

import type { DiagnosticRow } from "@comis/memory";
import {
  autonomyDenialBreakerFromRow,
  autonomyKilledFromRow,
  autonomyRevokedFromRow,
  durableOrphanedFromRow,
  durableResumedFromRow,
  nodeBudgetExceededFromRow,
  type Finding,
} from "./system-findings-extractors.js";

/** The crash-surviving windowed status counts (DurableRunPort.countByStatus). */
export type DurableStatusCounts = {
  orphaned: number;
  revoked: number;
  running: number;
  completed: number;
};

/** The assembled autonomy block (shape-identical to SystemHealthReport.autonomy). */
export interface AutonomySlice {
  runs: { total: number; degraded: number; degradedRate: number };
  orphaned: number;
  resumed: number;
  revoked: number;
  killed: number;
  breakerTrips: number;
  /** The capability-DENIAL breaker trip count (event-sourced
   *  from the `autonomy_denial_breaker` rows) — SEPARABLE from `breakerTrips` (the
   *  tool-failure breaker read-back). The two are distinct mechanisms. */
  denialBreakerTrips: number;
  budgetBreaches: number;
  costUsd: number;
  worstRootRunId?: string;
}

/**
 * Severity rank for the worst-rootRunId pick: an ORPHANED run (died on
 * restart, did not recover) outranks a DENIAL-BREAKER-aborted run (the
 * run burned its denial budget and was force-aborted, a robustness fault) outranks
 * a KILLED run (operator-intentional forced teardown) outranks a REVOKED run
 * (cooperative authority revoke). Higher = worse. Deterministic, no clock — the
 * rank + a lexicographic tie-break fully order the candidates.
 */
const AUTONOMY_SIGNAL_SEVERITY: Readonly<Record<string, number>> = {
  durable_orphaned: 4,
  autonomy_denial_breaker: 3,
  autonomy_killed: 2,
  autonomy_revoked: 1,
};

/**
 * Defensive extractor for ONLY the `rootRunId` off an `autonomy_revoked` row (the
 * worst-run candidate scan). The revoked COUNT is durable-table-sourced; this reads
 * just the id, folding malformed/missing to `null` (the *FromRow mold). Local here
 * (the count-bearing `autonomyRevokedFromRow` is not needed for the slice).
 */
function autonomyRevokedRootRunId(row: DiagnosticRow): string | null {
  if (row.details === undefined) return null;
  try {
    const parsed = JSON.parse(row.details) as { signal?: unknown; rootRunId?: unknown };
    if (parsed.signal !== "autonomy_revoked") return null;
    return typeof parsed.rootRunId === "string" && parsed.rootRunId.length > 0 ? parsed.rootRunId : null;
  } catch {
    return null;
  }
}

/**
 * Reduce the durable counts + the autonomy `health_signal` rows into the autonomy
 * block. Returns `undefined` (block OMITTED) when there is NO durable store edge AND
 * no autonomy rows — the honest-degradation case (offline CLI / non-durability boot).
 *
 * - `orphaned`/`revoked` come from the crash-surviving `countByStatus` (kill folds
 *   into the table's `revoked` status, so `revoked` is the cooperative+hard total in
 *   the durable table — but the `killed` COUNT is recovered separately from the
 *   event-sourced `autonomy_killed` rows, the only count separator available).
 * - `resumed` = the count of `durable_resumed` rows (healthy recovery — event-sourced).
 * - `killed` = the SUM of the `autonomy_killed` row counts (event-sourced).
 * - `total` = running + completed + orphaned + revoked; `degraded` = orphaned + revoked
 *   (the degraded outcomes); `degradedRate` = degraded / total (0 when total is 0).
 * - `worstRootRunId` = the rootRunId of the highest-severity autonomy row (orphaned >
 *   killed > revoked), lexicographic tie-break — NO clock.
 *
 * PURE — keys only on its arguments; the breaker/cost values are passed in already
 * read back from the synthetic-excluded `reduceSystemWindow` (NEVER re-derived here).
 */
export function computeAutonomySlice(input: {
  durableCounts: DurableStatusCounts | undefined;
  healthSignals: readonly DiagnosticRow[];
  breakerTrips: number;
  costUsd: number;
}): AutonomySlice | undefined {
  const { durableCounts, healthSignals, breakerTrips, costUsd } = input;

  // Event-sourced counts + the worst-run candidate scan (one pass over the rows).
  let resumed = 0;
  let killed = 0;
  let denialBreakerTrips = 0;
  let budgetBreaches = 0;
  let worstRootRunId: string | undefined;
  let worstSeverity = 0;
  const considerWorst = (signal: string, rootRunId: string | undefined): void => {
    if (rootRunId === undefined) return;
    const sev = AUTONOMY_SIGNAL_SEVERITY[signal] ?? 0;
    if (sev === 0) return;
    if (
      sev > worstSeverity ||
      (sev === worstSeverity && worstRootRunId !== undefined && rootRunId.localeCompare(worstRootRunId) < 0)
    ) {
      worstSeverity = sev;
      worstRootRunId = rootRunId;
    }
  };
  let sawAutonomyRow = false;
  for (const row of healthSignals) {
    const orphaned = durableOrphanedFromRow(row);
    if (orphaned !== null) {
      sawAutonomyRow = true;
      considerWorst("durable_orphaned", orphaned.rootRunId);
      continue;
    }
    const res = durableResumedFromRow(row);
    if (res !== null) {
      sawAutonomyRow = true;
      resumed += 1;
      continue;
    }
    const kill = autonomyKilledFromRow(row);
    if (kill !== null) {
      sawAutonomyRow = true;
      killed += kill.killed;
      considerWorst("autonomy_killed", kill.rootRunId);
      continue;
    }
    // The capability-denial breaker trip — SEPARABLE from
    // both the tool-failure breaker (breakerTrips read-back) and kill/revoke. Each
    // row is one trip (the count defaults to 1); the worst-run pick CAN promote it
    // (rank 3, above killed) since a denial-breaker abort is a robustness fault.
    const denial = autonomyDenialBreakerFromRow(row);
    if (denial !== null) {
      sawAutonomyRow = true;
      denialBreakerTrips += denial.denialBreakerTrips;
      considerWorst("autonomy_denial_breaker", denial.rootRunId);
      continue;
    }
    if (nodeBudgetExceededFromRow(row) !== null) {
      budgetBreaches += 1;
      continue;
    }
    // Revoked rows: parse defensively for the rootRunId only (count is durable-sourced).
    const revokedRoot = autonomyRevokedRootRunId(row);
    if (revokedRoot !== null) {
      sawAutonomyRow = true;
      considerWorst("autonomy_revoked", revokedRoot);
    }
  }

  // Honest degradation: no durable store edge AND no autonomy rows → omit the block.
  if (durableCounts === undefined && !sawAutonomyRow) return undefined;

  const orphaned = durableCounts?.orphaned ?? 0;
  const revoked = durableCounts?.revoked ?? 0;
  const running = durableCounts?.running ?? 0;
  const completed = durableCounts?.completed ?? 0;
  const total = running + completed + orphaned + revoked;
  const degraded = orphaned + revoked;
  const degradedRate = total > 0 ? degraded / total : 0;

  return {
    runs: { total, degraded, degradedRate },
    orphaned,
    resumed,
    revoked,
    killed,
    breakerTrips,
    denialBreakerTrips,
    budgetBreaches,
    costUsd,
    ...(worstRootRunId !== undefined ? { worstRootRunId } : {}),
  };
}

/**
 * The three dedicated autonomy findings over the `health_signal` rows (the
 * node_budget_exceeded mold): durable_orphaned (reason-grouped), autonomy_revoked
 * and autonomy_killed (SEPARATE — kill and revoke are distinct events). Each
 * has a zero-traffic guard, counts + a STATIC knob-naming hint ONLY. Returned as a
 * `Finding[]` the caller pushes into the report's findings (inheriting the
 * SYSTEM_FINDINGS_CAP bound + the highest-count-first sort).
 */
export function buildAutonomyFindings(healthSignals: readonly DiagnosticRow[]): Finding[] {
  const findings: Finding[] = [];

  // durable_orphaned — the count of cron-fired/in-flight runs that did NOT resume
  // after a restart + the DOMINANT closed orphan reason (which un-resumable class).
  // Counts + the closed reason enum + a STATIC hint naming `comis explain <rootRunId>`
  // + the heartbeat knob ONLY — NEVER the engine's free-text orphan reason (mapped to
  // a closed enum at the source). Zero-traffic guard.
  let orphanedCount = 0;
  const byReason = new Map<string, number>();
  for (const row of healthSignals) {
    const parsed = durableOrphanedFromRow(row);
    if (parsed === null) continue;
    orphanedCount += 1;
    byReason.set(parsed.reason, (byReason.get(parsed.reason) ?? 0) + 1);
  }
  if (orphanedCount > 0) {
    const topReason = [...byReason.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    findings.push({
      code: "durable_orphaned",
      detail:
        topReason !== undefined
          ? `${orphanedCount} run(s) orphaned on restart (top reason: ${topReason})`
          : `${orphanedCount} run(s) orphaned on restart`,
      count: orphanedCount,
      hint: "a cron-fired/in-flight run did not resume after a restart; run `comis explain <rootRunId>` on the worst run and check the durable checkpoint + lease heartbeat (autonomy.durability.heartbeatStaleMs)",
    });
  }

  // autonomy_revoked — the SUM of the per-row revoked counts (a cooperative lease/tree
  // revoke an admin must see). SEPARATE from autonomy_killed below — the runtime emits
  // DISTINCT events because a kill and a revoke both flip the durable status to
  // 'revoked' in the table, so the EVENT is the only count separator (kill≠revoke).
  // Counts + a STATIC hint ONLY — never a lease bearer/selector.
  let revokedSum = 0;
  for (const row of healthSignals) {
    const parsed = autonomyRevokedFromRow(row);
    if (parsed === null) continue;
    revokedSum += parsed.revoked;
  }
  if (revokedSum > 0) {
    findings.push({
      code: "autonomy_revoked",
      detail: `${revokedSum} lease(s)/run(s) revoked (cooperative authority revoke)`,
      count: revokedSum,
      hint: "an operator revoked a lease/run tree's authority; run `comis explain <rootRunId>` on the affected run, and confirm the revoke was intended (otherwise check the cap/lease config that triggered it)",
    });
  }

  // autonomy_killed — the SUM of the per-row killed counts (a hard run.kill that tore
  // down a spawn tree). SEPARATE from autonomy_revoked above (the kill≠revoke
  // separation — same terminal table status, distinct event). Counts + STATIC hint.
  let killedSum = 0;
  for (const row of healthSignals) {
    const parsed = autonomyKilledFromRow(row);
    if (parsed === null) continue;
    killedSum += parsed.killed;
  }
  if (killedSum > 0) {
    findings.push({
      code: "autonomy_killed",
      detail: `${killedSum} spawn tree(s)/run(s) hard-killed (run.kill)`,
      count: killedSum,
      hint: "a run tree was hard-killed (run.kill) — a forced teardown, not a cooperative revoke; run `comis explain <rootRunId>` on the killed run to see why it was terminated",
    });
  }

  // autonomy_denial_breaker — the SUM of the per-row
  // denial-breaker trip counts (the capability-denial breaker aborted +
  // killed a run tree after N consecutive floor-blocks). DISTINCT from the
  // tool-failure breaker (breakerTripTotal) and from kill/revoke — this is the
  // capability-denial breaker, the only system-visible signal that an unattended run
  // burned its denial budget in a deny loop. Counts + a STATIC hint naming the knob
  // (autonomy.denialBreakerN) + `comis explain <rootRunId>` ONLY — never the
  // engine's free-text deny reason (the row never carried it). Zero-traffic guard.
  let denialBreakerSum = 0;
  for (const row of healthSignals) {
    const parsed = autonomyDenialBreakerFromRow(row);
    if (parsed === null) continue;
    denialBreakerSum += parsed.denialBreakerTrips;
  }
  if (denialBreakerSum > 0) {
    findings.push({
      code: "autonomy_denial_breaker",
      detail: `${denialBreakerSum} run(s) aborted by the capability-denial breaker (consecutive floor-blocks)`,
      count: denialBreakerSum,
      hint: "an unattended run hit N consecutive capability/quota denials and the denial breaker aborted the tree to avoid burning the budget on a deny loop; run `comis explain <rootRunId>` on the aborted run, then raise the run's autonomy ceiling or tune autonomy.denialBreakerN if the denials were expected",
    });
  }

  return findings;
}
