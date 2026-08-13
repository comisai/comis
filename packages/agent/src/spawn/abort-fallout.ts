// SPDX-License-Identifier: Apache-2.0
/**
 * Fallout of an abnormal sub-agent termination: which delegated children are
 * left without a consumer, and what the abort hint should say when a run spent
 * its budget waiting on delegation rather than working.
 *
 * Both answers depend on the spawn tree at abort time, and both were wrong in
 * the same incident — a parent that timed out while awaiting three children
 * neither cancelled them nor reported why it had been waiting.
 *
 * PURE — no clock, no I/O, no runner state. The runner supplies the run
 * snapshot and consumes the returned ids.
 * @module
 */

/** The run fields orphan selection needs; a structural subset of SubAgentRun. */
export interface OrphanCandidateRun {
  readonly runId: string;
  readonly status: string;
  readonly parentRunId?: string;
  readonly announceChannelType?: string;
  readonly announceChannelId?: string;
}

/** Statuses from which a run can still be cancelled. */
const CANCELLABLE_STATUSES: ReadonlySet<string> = new Set(["running", "queued"]);

/**
 * Child runs to cancel when `parentRunId` reaches a terminal state.
 *
 * A parent that ends abnormally cannot consume an unrouted child's result, so
 * that child would continue working without a reader. A child with a complete
 * announcement route still has an independently authenticated consumer and is
 * not an orphan merely because its parent ended.
 *
 * A parent that completes CLEANLY is left alone: background delegation is a
 * legitimate pattern, and a child announcing to its own channel is expected to
 * outlive a parent that finished its turn.
 *
 * @param parentRunId - The run that just terminalized
 * @param parentEndReason - Its completion endReason ("completed" = clean)
 * @param runs - Snapshot of all tracked runs
 * @returns Run ids to cancel (empty when the parent completed cleanly)
 */
export function selectOrphanedChildRuns(
  parentRunId: string,
  parentEndReason: string,
  runs: Iterable<OrphanCandidateRun>,
): string[] {
  if (parentEndReason === "completed") return [];
  const orphaned: string[] = [];
  for (const run of runs) {
    if (run.parentRunId !== parentRunId) continue;
    if (!CANCELLABLE_STATUSES.has(run.status)) continue;
    if (run.announceChannelType && run.announceChannelId) continue;
    orphaned.push(run.runId);
  }
  return orphaned;
}

/**
 * Children of `parentRunId` that have not reached a terminal state.
 *
 * At the moment a parent aborts, this set is exactly what it was still waiting
 * on — so the same computation answers both "what should be cancelled" and
 * "what was this run blocked on".
 *
 * @param parentRunId - The parent whose children to list
 * @param runs - Snapshot of all tracked runs
 * @returns Run ids still running or queued under that parent
 */
export function liveChildRunIds(
  parentRunId: string,
  runs: Iterable<OrphanCandidateRun>,
): string[] {
  const live: string[] = [];
  for (const run of runs) {
    if (run.parentRunId !== parentRunId) continue;
    if (!CANCELLABLE_STATUSES.has(run.status)) continue;
    live.push(run.runId);
  }
  return live;
}

/** Authoritative runtime facts that choose an abort's remediation hint. */
export interface AbortEvidence {
  /** Child runs still being awaited at the deadline. */
  readonly awaitedChildRunIds?: readonly string[];
  /** Awaited children that retain an authenticated independent announcement route. */
  readonly routedChildRunIds?: readonly string[];
  /** Authoritative step ceiling retained by the executor on a max-steps halt. */
  readonly stepLimit?: {
    readonly bindingKnob: string;
    readonly stepsExecuted: number;
    readonly cap: number;
  };
}

const TIMEOUT_KNOB_HINT =
  "Increase agents.<id>.operationModels.subagent.timeout or reduce the task scope; "
  + "the subagent operation timeout overrides agents.<id>.promptTimeout.promptTimeoutMs";

/**
 * Remediation hint for a `prompt_timeout` abort, branched by what the run was
 * actually doing when the clock ran out.
 *
 * A wait may overlap the parent deadline even when a routed child can continue
 * independently. The hint distinguishes that case from a run whose own model
 * execution simply exceeded its operation timeout.
 *
 * @param evidence - Delegation state at the deadline; undefined when unknown
 * @returns The hint text for the prompt_timeout classification
 */
export function promptTimeoutHint(evidence: AbortEvidence | undefined): string {
  const awaited = evidence?.awaitedChildRunIds ?? [];
  if (awaited.length > 0) {
    const first = awaited[0] as string;
    const routed = evidence?.routedChildRunIds ?? [];
    const routedGuidance = routed.length > 0
      ? ` ${routed.length === 1 ? "The routed child will" : "The routed children will"} `
        + "continue and announce independently."
      : " Children without an independent announcement route are cancelled with the parent.";
    return `This run timed out while awaiting ${awaited.length} delegated `
      + `${awaited.length === 1 ? "child" : "children"}; the parent deadline was binding.`
      + routedGuidance
      + ` Inspect the first child (comis explain "${first}") and keep each wait interval `
      + "below the prompt progress budget so the parent can process the result.";
  }

  return TIMEOUT_KNOB_HINT;
}

/**
 * Hard bound on parent-chain walks. Depth is already limited by maxSpawnDepth;
 * this is the backstop that keeps a corrupt or cyclic parent link from spinning.
 */
export const MAX_SPAWN_TREE_WALK = 64;
