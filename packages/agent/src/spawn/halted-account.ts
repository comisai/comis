// SPDX-License-Identifier: Apache-2.0
/**
 * The account a halted sub-agent hands its parent in place of silence.
 *
 * Split from `sub-agent-result-processor.ts` to keep that module under its size cap.
 *
 * @module
 */

/** Upper bound on a halt account, so it cannot crowd out the parent's context. */
const HALTED_ACCOUNT_MAX_CHARS = 1000;

/** The facts a halt account is built from — all already held by the runner. */
export interface HaltedAccountInput {
  /** The run's terminal finish reason. */
  readonly finishReason: string;
  /** Steps the child completed before it was halted. */
  readonly stepsExecuted: number;
  /** Abort category from `classifyAbortReason`, when it had an opinion. */
  readonly category?: string;
  /** Remediation hint from `classifyAbortReason`, when it had one. */
  readonly hint?: string;
}

/**
 * Describe a halted run for the parent, in place of the empty string it would otherwise receive.
 *
 * A halted sub-agent returns only its final assistant text, so a child killed before composing one
 * returns nothing — and to the parent, nothing is indistinguishable from a sub-task that ran fine
 * and found nothing. Live: a child completed a full ranking (188 subjects, coverage proven, inline
 * in its context) before a sibling call timed out and the retries were cut off; its last records
 * carry thinking and no text. The parent, handed silence, reported that there were no valid results
 * — nothing had discarded the work, and the model had not declined to report it.
 *
 * Deliberately built ONLY from facts the runner holds. It does not try to salvage the child's tool
 * output: the runner does not have the child's session path, and hand-building one is the bug class
 * the data-directory guidance calls out. So this makes the loss visible and actionable rather than
 * promising a recovery it cannot honour.
 *
 * The wording is machine-facing — it is read by the parent model as a tool result, not shown to a
 * user — so it is not routed through the locale catalog, and it says outright that it is not a
 * result, because a parent relaying it as one is the exact failure being replaced.
 */
export function buildHaltedAccount(input: HaltedAccountInput): string {
  const category = input.category ?? input.finishReason;
  const parts = [
    `[halted] This sub-task did not finish: it was halted (${category}; finishReason=${input.finishReason})`,
    ` after ${String(input.stepsExecuted)} completed step(s).`,
    " Whatever it had established was NOT returned — a halted run reports only its final message,",
    " and it never wrote one.",
    " This is not a result: do not present it as findings, and do not infer that the work found",
    " nothing. To obtain the answer, run it again over a narrower scope so it completes inside its",
    " budget.",
  ];
  if (input.hint !== undefined && input.hint.trim().length > 0) {
    parts.push(` Remediation: ${input.hint.trim()}`);
  }
  const account = parts.join("");
  return account.length > HALTED_ACCOUNT_MAX_CHARS
    ? account.slice(0, HALTED_ACCOUNT_MAX_CHARS).trimEnd()
    : account;
}
