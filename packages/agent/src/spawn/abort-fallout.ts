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
}

/** Statuses from which a run can still be cancelled. */
const CANCELLABLE_STATUSES: ReadonlySet<string> = new Set(["running", "queued"]);

/**
 * Child runs to cancel when `parentRunId` reaches a terminal state.
 *
 * A parent that ends abnormally can never consume what its children return, so
 * every still-live child is burning tokens for a result with no reader. In the
 * incident one such orphan ran 46s past its dead parent and spent $1.80.
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
  return liveChildRunIds(parentRunId, runs);
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
 * The unbranched hint names the timeout knob for every timeout. When the run was
 * blocked on children that were themselves doomed, raising that knob buys more
 * waiting — and its "reduce the task scope" clause is a diagnosis the agent then
 * relays to the user as its own, which is how a tool-reachability failure got
 * reported as "the scope was too broad for one run".
 *
 * @param evidence - Delegation state at the deadline; undefined when unknown
 * @returns The hint text for the prompt_timeout classification
 */
export function promptTimeoutHint(evidence: AbortEvidence | undefined): string {
  const awaited = evidence?.awaitedChildRunIds ?? [];
  if (awaited.length > 0) {
    const first = awaited[0] as string;
    return `This run timed out while awaiting ${awaited.length} delegated `
      + `${awaited.length === 1 ? "child" : "children"}, so its own deadline is not the `
      + "binding constraint — the children are. Inspect them first "
      + `(comis explain "${first}") and fix their abort reason; raising the parent timeout `
      + "only buys more waiting.";
  }

  return TIMEOUT_KNOB_HINT;
}

/**
 * Hard bound on parent-chain walks. Depth is already limited by maxSpawnDepth;
 * this is the backstop that keeps a corrupt or cyclic parent link from spinning.
 */
export const MAX_SPAWN_TREE_WALK = 64;
