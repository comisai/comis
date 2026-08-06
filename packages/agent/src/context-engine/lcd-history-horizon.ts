// SPDX-License-Identifier: Apache-2.0
/**
 * History-horizon quantization — hold the evicted prefix's left edge still.
 *
 * The assembler evicts the history prefix to fit `shipHistoryBudget`, keeping
 * whole steps newest→oldest. That budget is derived per call from the system
 * token estimate and the fresh-tail preamble, so it JITTERS by a few hundred
 * tokens between calls of one conversation. Every distinct value can pick a
 * different oldest-kept step, and the oldest kept step is message[0] of the
 * shipped prompt.
 *
 * A provider prefix cache keys on a byte-stable left edge, so moving message[0]
 * invalidates the ENTIRE cached prefix. Measured live: `cacheRead: 0` with a full
 * cold write on the first call of every turn, up to 131,616 tokens re-written for
 * one turn, while the calls WITHIN a turn hit at 100%. The horizon was also seen
 * moving BACKWARD (kept 211 → 213, re-including a step dropped one turn earlier),
 * which writes the same prefix, discards it, and writes it again.
 *
 * Quantizing the budget onto a coarse grid removes the jitter at its source: the
 * sub-quantum wobble no longer changes the budget at all, so the same steps are
 * kept and the left edge stays byte-identical. The horizon then advances only when
 * the conversation genuinely consumes a whole grid cell — rare and large instead of
 * every turn.
 *
 * The grid FLOORS, never raises, so the quantized budget remains a ceiling and the
 * shipped history can never overflow the window. The cost is up to one quantum of
 * history retained less than the budget strictly allows; the oldest steps at the
 * eviction boundary are the ones forgone, and LCD keeps digests of dropped content.
 * A stable prefix is worth far more than those steps.
 *
 * @module
 */

/**
 * Grid the history budget is floored onto.
 *
 * Wide enough to swallow the observed per-call jitter (hundreds of tokens) and to
 * make a horizon advance span many turns, small enough that at most this much
 * history room goes unused.
 */
export const HISTORY_BUDGET_QUANTUM_TOKENS = 8192;

/**
 * Floor a history budget onto the quantization grid.
 *
 * Non-positive budgets pass through unchanged: the eviction unit treats `<= 0` as
 * "drop the whole prefix", and that decision must not be perturbed. A budget
 * below one quantum also passes through — flooring it would drop all history on
 * every small-window turn, a worse regression than the churn this prevents.
 *
 * @param budgetTokens - History budget the assembler computed for this call
 * @returns The budget floored to the grid, never greater than the input
 */
export function quantizeHistoryBudget(budgetTokens: number): number {
  if (budgetTokens < HISTORY_BUDGET_QUANTUM_TOKENS) return budgetTokens;
  return Math.floor(budgetTokens / HISTORY_BUDGET_QUANTUM_TOKENS) * HISTORY_BUDGET_QUANTUM_TOKENS;
}
