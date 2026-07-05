// SPDX-License-Identifier: Apache-2.0
/**
 * Pure abort -> honest TurnOutcome mapper.
 *
 * Root-cause incident: a max_steps abort whose filtered text still delivered
 * was finalized as kind:"success" or — when a failed event reclassified it —
 * as a bare "❌ platform". Both are mislabels: no platform error occurred, the
 * run hit a resource limit. This mapper produces a TRUTHFUL
 * kind:"failure" {errorKind:"resource"} carrying a fixed one-line human reason
 * for the resource-abort finish reasons (max_steps / loop_detected /
 * spend_exceeded), and returns undefined for every other case so the normal
 * success / silent / delivery-failure branches in the pipeline are untouched.
 *
 * Pure: no I/O, no logger, no clock. The reason strings are named constants and
 * carry no raw provider/internal text — only the closed-union errorKind +
 * fixed copy reach the render path (information-disclosure guard, T-hbe-02).
 */
import type { TurnOutcome } from "@comis/core";

/** One-line human reason for a step-limit (max_steps) abort. */
const STEP_LIMIT_REASON = "stopped — hit step limit" as const;

/** One-line human reason for a repeating-tool loop abort. */
const LOOP_DETECTED_REASON = "stopped — repeating-tool loop" as const;

/** One-line human reason for a spend/budget kill (observability.spend ceiling
 *  or per-root autonomy.budget limb). Without this mapping a spend-aborted turn
 *  finalized via the success branch and the coordinator's failed-event
 *  reclassify stamped the status pill with a TRANSIENT recovered tool
 *  errorKind — a budget stop rendered as "❌ validation". */
const SPEND_EXCEEDED_REASON = "stopped — spend limit reached" as const;

/** ErrorKind for any resource abort (step limit / budget / loop). */
const RESOURCE_ERROR_KIND = "resource" as const;

/** The finish reasons that map to a truthful resource failure. */
const RESOURCE_ABORT_REASONS: Record<string, string> = {
  max_steps: STEP_LIMIT_REASON,
  loop_detected: LOOP_DETECTED_REASON,
  spend_exceeded: SPEND_EXCEEDED_REASON,
};

export interface AbortSignalInput {
  /** The executor finish reason ("max_steps" | "loop_detected" | "stop" | ...). */
  finishReason: string;
  /** True when the run aborted on a resource limit (budget / steps / loop). */
  resourceAborted: boolean;
  /** The raw abort reason if present (advisory). */
  abortReason?: string;
}

/**
 * Map a resource abort to a truthful kind:"failure" TurnOutcome.
 *
 * Returns a failure with errorKind "resource" + a fixed one-line reason for a
 * max_steps / loop_detected / spend_exceeded abort. Returns `undefined` for any
 * non-resource abort (so the caller's normal branches run): when
 * `resourceAborted` is false, or when the finish reason is not a recognized
 * resource-abort reason.
 */
export function mapAbortToTurnOutcome(input: AbortSignalInput): TurnOutcome | undefined {
  if (!input.resourceAborted) return undefined;
  // eslint-disable-next-line security/detect-object-injection -- key is the closed executor finishReason union, looked up in a fixed const map (no external input)
  const reason = RESOURCE_ABORT_REASONS[input.finishReason];
  if (reason === undefined) return undefined;
  return {
    kind: "failure",
    errorKind: RESOURCE_ERROR_KIND,
    failedEvents: [],
    reason,
  };
}
