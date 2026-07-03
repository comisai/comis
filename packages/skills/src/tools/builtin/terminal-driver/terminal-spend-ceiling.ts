// SPDX-License-Identifier: Apache-2.0
/**
 * The pure spend-ceiling check.
 *
 * `checkSpendCeiling(costUsd, maxCostUsd)` answers ONE question over a drive journal's
 * accumulated run-total cost: has the drive spent MORE than its optional per-drive spend
 * ceiling (`drive.maxCostUsd`)? On a breach it returns the typed discriminant
 * `{ breach: "spend_ceiling" }`; the CALLER (the wake-turn driver) escalates or
 * stops with the figure. This bounds runaway cost — escalate or stop on breach, never a
 * silent overspend: a thrashing misclassification loop cannot burn cost unbounded over a
 * 40h drive, because every woken turn re-asks this question and the breach is never silent.
 *
 * PREDICATE-ONLY. This module reads the journal's
 * existing `costUsd` field (terminal-drive-journal.ts:153) and makes ONLY the decision —
 * it adds NO cost PRODUCER. `costUsd` is honestly hardcoded `0` at the canned-keystroke
 * woken-turn seam (no LLM spend there; the comment at terminal-wake-turn.ts:222-225
 * already names this spend ceiling as the consumer of that reserved field), and it
 * stays that way — a FABRICATED cost would violate the predicate-only contract. The check
 * becomes load-bearing the day a real LLM-in-the-loop turn writes a non-zero `costUsd`;
 * until then it is unit-tested over seeded journal values. A real producer is explicit
 * FUTURE work. The existing loop guard still catches tight loops independently.
 *
 * The breach discriminant is LOCAL: a spend-ceiling breach is a DISTINCT escalate/stop
 * path, so it deliberately does NOT extend `terminal-caps.ts`'s `CapBreach`
 * (`max_requests`/`max_interactions`/`wall_clock` — those drive a reject/evict) and does
 * NOT route through the reaper's `EvictReason` (session-count/idle evictions). It mirrors
 * the SHAPE of `checkWallClock` (terminal-caps.ts:144-157): the `null = uncapped` member
 * mirrors `cap === undefined ⇒ undefined`, and the strict `>` boundary means AT the cap
 * the budget is not yet spent.
 *
 * Architecture invariants (binding — AGENTS.md; mirrors
 * `terminal-caps.ts` / `terminal-dialog-detector.ts` / `terminal-drive-journal.ts`):
 *   - PURE: a free function, NOT a factory. NO module-global mutable state. NO clock/timer
 *     reads — the cost is the journal's accumulated run-total passed in by the caller (this
 *     module never reads a wall-clock global; there is no time in a spend check at all).
 *   - NEVER throws: a degenerate input (a NaN/negative/Infinity cost or cap) yields
 *     `undefined` — the SAFE direction. A forged/garbage cost must never cause a SPURIOUS
 *     breach that kills a healthy drive, and a degenerate cap is treated as uncapped.
 *   - Infra-free: value-imports NOTHING (node builtins only if ever needed) — no platform
 *     runtime packages, no observability egress (the infra-runtime-scope architecture
 *     gate; this file names none of them, and worker ↛ infra/observability).
 *
 * @module
 */

/**
 * A typed spend-ceiling breach discriminant — a DISTINCT escalate/stop path, deliberately
 * separate from `terminal-caps.ts`'s `CapBreach` (reject/evict) and the reaper's
 * `EvictReason` (session-count/idle). The caller maps it to an escalate/stop with the
 * figure (never a silent overspend).
 */
export type SpendBreach = "spend_ceiling";

/**
 * Has the drive spent MORE than its optional spend ceiling?
 *
 * Returns `{ breach: "spend_ceiling" }` iff `costUsd > maxCostUsd` (strict `>`: at the cap
 * the budget is not yet over), else `undefined`. Pure + total: a `null`/degenerate cap is
 * uncapped (safe) and a degenerate cost never produces a spurious breach; never
 * throws. PREDICATE-ONLY — it reads the journal's honest `costUsd` (see @module) and
 * adds no cost producer.
 *
 * @param costUsd - The drive journal's accumulated run-total spend, in USD
 *   (terminal-drive-journal.ts `costUsd` — honestly `0` at the canned-keystroke seam).
 * @param maxCostUsd - The operator's per-drive spend ceiling (`drive.maxCostUsd`), or
 *   `null` for uncapped (the default).
 * @returns `{ breach: "spend_ceiling" }` on an overspend, else `undefined`.
 */
export function checkSpendCeiling(
  costUsd: number,
  maxCostUsd: number | null,
): { breach: SpendBreach } | undefined {
  // null / degenerate cap ⇒ uncapped → no breach (safe). Mirrors checkWallClock's
  // `cap === undefined ⇒ undefined`; a NaN/negative/Infinity cap is treated as no cap
  // rather than a meaningful bound (a malformed cap must not kill a drive).
  if (maxCostUsd === null || !Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    return undefined;
  }
  // A degenerate cost (NaN / negative / Infinity) ⇒ no SPURIOUS breach — the safe
  // direction is never to kill a healthy drive on a garbage/forged figure.
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    return undefined;
  }
  // Strict `>`: at the exact cap the budget is not yet over (mirror checkWallClock).
  return costUsd > maxCostUsd ? { breach: "spend_ceiling" } : undefined;
}
