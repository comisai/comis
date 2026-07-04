// SPDX-License-Identifier: Apache-2.0
/**
 * Cron wake-gate EFFICIENCY slice — the cross-session reducer for the `comis
 * fleet` report, a sibling of `fleet-autonomy.ts`. Reduces the content-free
 * `cron_wake_gate` DiagnosticRows (one per gated cron fire, written by
 * `wakeGateEventToRow`) into a per-agent skip-rate + turns-saved + tool-call
 * cost slice.
 *
 * ONE pure export over the already-read rows (NO clock, NO I/O, NO re-derivation
 * over raw session rows):
 *   - {@link computeCronWakeGateSlice} — the structured `cronWakeGate` block
 *     (window totals + per-agent counts), or `undefined` when no gated fire is in
 *     the window (honest omit — the `computeAutonomySlice` mold).
 *
 * The two legibility properties the slice carries:
 *   - SUPPRESSION: a per-agent `skipRate == 1.0` is a gate that NEVER wakes the
 *     model — visible whether it is working (savings) or silently poisoned.
 *   - NET COST: `toolCalls` (the gate's cap-call cost) beside `turnsSaved` (the
 *     avoided model turns) makes a gate that costs more than it saves legible.
 *
 * SECURITY INVARIANT (the digest-only report schema): counts + agent ids ONLY.
 * Every `details` field is parsed via the defensive reader below, which reads
 * ONLY the `wake` verdict + the `estTurnsSaved`/`toolCalls` counts — NEVER the
 * gate's gathered payload, script source, or a secret. Safe to paste into a review.
 *
 * @module
 */

import type { DiagnosticRow } from "@comis/memory";
import type { FleetHealthReport } from "@comis/core";

/** The assembled wake-gate block (shape-identical to FleetHealthReport.cronWakeGate). */
export type CronWakeGateSlice = NonNullable<FleetHealthReport["cronWakeGate"]>;

/** Per-agent running totals during the single reduce pass. */
interface AgentAccumulator {
  fires: number;
  skipped: number;
  failedOpen: number;
  turnsSaved: number;
  toolCalls: number;
}

/**
 * Defensive reader for the counts/verdict off a `cron_wake_gate` row's `details`
 * — reads ONLY `wake`/`estTurnsSaved`/`toolCalls`/`failedOpen` (malformed/missing
 * folds to a safe default, never throws, NEVER echoes a body). A row with an
 * undefined `wake` still represents a fire; it is simply not counted as a skip.
 * `failedOpen` defaults `false` (a row from a build before the field is a normal
 * fire, never counted as a break).
 */
function readGateCounts(details: string | undefined): {
  wake: boolean | undefined;
  estTurnsSaved: number;
  toolCalls: number;
  failedOpen: boolean;
} {
  if (details === undefined) return { wake: undefined, estTurnsSaved: 0, toolCalls: 0, failedOpen: false };
  try {
    const parsed = JSON.parse(details) as {
      wake?: unknown;
      estTurnsSaved?: unknown;
      toolCalls?: unknown;
      failedOpen?: unknown;
    };
    return {
      wake: typeof parsed.wake === "boolean" ? parsed.wake : undefined,
      estTurnsSaved: typeof parsed.estTurnsSaved === "number" ? parsed.estTurnsSaved : 0,
      toolCalls: typeof parsed.toolCalls === "number" ? parsed.toolCalls : 0,
      failedOpen: parsed.failedOpen === true,
    };
  } catch {
    return { wake: undefined, estTurnsSaved: 0, toolCalls: 0, failedOpen: false };
  }
}

/**
 * Reduce the windowed `cron_wake_gate` rows into the per-agent efficiency slice.
 * Returns `undefined` (block OMITTED) when there is NO gated fire in the window —
 * the honest-degradation case (no cron ran a wake-gate, or the store is unwired).
 *
 * - `fires.total` = the gated fire count; `fires.skipped` = fires with
 *   `wake === false`; `fires.skipRate` = skipped / total (0 when total is 0).
 * - `turnsSaved` = summed `estTurnsSaved` (the avoided model turns).
 * - `toolCalls` = summed cap-call cost (the net-cost numerator).
 * - `perAgent[]` = the same counts keyed by `agentId`, so a 100%-skip gate
 *   (`skipRate == 1`) and an uneconomic gate (`toolCalls > turnsSaved`) are both
 *   legible per agent. Ordered highest-fires-first, then agentId asc (deterministic).
 *
 * PURE — keys only on its argument; NO clock, NO I/O. Foreign-category rows are
 * ignored so the reducer is safe over a mixed row set.
 */
export function computeCronWakeGateSlice(
  rows: readonly DiagnosticRow[],
): CronWakeGateSlice | undefined {
  const perAgent = new Map<string, AgentAccumulator>();
  let total = 0;
  let skipped = 0;
  let failedOpen = 0;
  let turnsSaved = 0;
  let toolCalls = 0;

  for (const row of rows) {
    if (row.category !== "cron_wake_gate") continue;
    const counts = readGateCounts(row.details);
    const isSkip = counts.wake === false;
    const agentId = row.agentId ?? "unknown";
    const bucket = perAgent.get(agentId) ?? { fires: 0, skipped: 0, failedOpen: 0, turnsSaved: 0, toolCalls: 0 };
    bucket.fires += 1;
    if (isSkip) bucket.skipped += 1;
    if (counts.failedOpen) bucket.failedOpen += 1;
    bucket.turnsSaved += counts.estTurnsSaved;
    bucket.toolCalls += counts.toolCalls;
    perAgent.set(agentId, bucket);

    total += 1;
    if (isSkip) skipped += 1;
    if (counts.failedOpen) failedOpen += 1;
    turnsSaved += counts.estTurnsSaved;
    toolCalls += counts.toolCalls;
  }

  // Honest degradation: no gated fire in the window → omit the block.
  if (total === 0) return undefined;

  return {
    // `failedOpen`/`failOpenRate` distinguish a BROKEN gate (fails open every
    // fire — saves nothing, costs its cap-calls) from a healthy monitor that
    // legitimately always wakes; both otherwise read skipRate 0. It is the
    // signal symmetric to a 100% skipRate (a poisoned suppress).
    fires: {
      total,
      skipped,
      skipRate: total > 0 ? skipped / total : 0,
      failedOpen,
      failOpenRate: total > 0 ? failedOpen / total : 0,
    },
    turnsSaved,
    toolCalls,
    perAgent: [...perAgent.entries()]
      .map(([agentId, b]) => ({
        agentId,
        fires: b.fires,
        skipped: b.skipped,
        skipRate: b.fires > 0 ? b.skipped / b.fires : 0,
        failedOpen: b.failedOpen,
        failOpenRate: b.fires > 0 ? b.failedOpen / b.fires : 0,
        turnsSaved: b.turnsSaved,
        toolCalls: b.toolCalls,
      }))
      .sort((a, b) => b.fires - a.fires || a.agentId.localeCompare(b.agentId)),
  };
}
