// SPDX-License-Identifier: Apache-2.0
/**
 * The single authoritative sub-agent terminal-outcome decision.
 *
 * A clean model stop is NOT the same as doing the job. When a spawn declares
 * `expected_outputs`, the child is told in its own prompt that those paths are
 * validated and that "an alternate filename or directory is treated as missing"
 * — so a run that stops without producing them has not satisfied the contract it
 * was given, and the parent must not be told otherwise.
 *
 * Live incident: a child collected every page of a paginated report over 8.5
 * minutes, wrote no file, and stopped normally. `finishReason: "stop"` alone
 * made it `completed`; the output validation ran, logged a WARN about the
 * missing file, and changed nothing. The parent believed the work was done,
 * abandoned it, and re-ran a narrower version — while the collected data sat
 * unused on disk.
 *
 * PURE: no I/O, no clock, no globals — same inputs ⇒ same outcome forever. It
 * exists as its own module so the decision is made ONCE and every consumer
 * (announcement status, terminal endReason, proxy stop, lifecycle hook, the
 * condensed result's `taskComplete`) reads the same verdict and they cannot
 * disagree.
 *
 * @module
 */

/**
 * Why a run ended the way it did.
 *
 * - `completed` — stopped cleanly and produced every contracted output.
 * - `model_halted` — the model did not stop cleanly (timeout, step ceiling,
 *   error). Outranks a missing contract because it EXPLAINS the missing files.
 * - `contract_unsatisfied` — stopped cleanly but did not write what it promised.
 */
export type SubAgentOutcomeReason = "completed" | "model_halted" | "contract_unsatisfied";

export interface SubAgentOutcome {
  /** Whether the parent may treat this run as having done its job. */
  readonly success: boolean;
  readonly reason: SubAgentOutcomeReason;
  /** Contracted paths that do not exist. Empty unless `contract_unsatisfied`. */
  readonly missingOutputs: readonly string[];
}

export interface ResolveSubAgentOutcomeInput {
  /** Whether the model's finish reason was a clean stop. */
  readonly modelStoppedCleanly: boolean;
  /** Declared `expected_outputs` that post-run validation did not find. */
  readonly missingContractedOutputs: readonly string[];
}

/** Resolve the terminal outcome from the model's stop and the output contract. */
export function resolveSubAgentOutcome(input: ResolveSubAgentOutcomeInput): SubAgentOutcome {
  if (!input.modelStoppedCleanly) {
    return { success: false, reason: "model_halted", missingOutputs: [] };
  }
  if (input.missingContractedOutputs.length > 0) {
    return {
      success: false,
      reason: "contract_unsatisfied",
      missingOutputs: [...input.missingContractedOutputs],
    };
  }
  return { success: true, reason: "completed", missingOutputs: [] };
}
