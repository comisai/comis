// SPDX-License-Identifier: Apache-2.0
/**
 * The message a background task carries when it hits its hard runtime limit.
 *
 * The limit fired with a bare `Hard timeout exceeded`, which names neither the knob that set it,
 * the value it was set to, nor the tool that was running — so nobody reading it could tell what to
 * change. Live: a 300008 ms failure carrying exactly that string, in a campaign where the stall
 * hint beside it named `agents.<id>.promptTimeout.promptTimeoutMs` AND both values, and a sibling
 * timeout named its own sub-agent budget. This path was the outlier.
 *
 * Exported so the thrown error, the log line, and the test all read the SAME text — a duplicated
 * literal is how these drift apart.
 *
 * @module
 */

/** Upper bound, so a hint can never crowd out the failure it explains. */
const HARD_TIMEOUT_HINT_MAX_CHARS = 600;

/** Facts the manager already holds at the moment the limit fires. */
export interface HardTimeoutHintInput {
  /** The tool whose background run was aborted. */
  readonly toolName: string;
  /** The owning agent, so the hint can name that agent's own knob. */
  readonly agentId: string;
  /** The resolved limit in ms — the value that actually expired, not the schema default. */
  readonly limitMs: number;
}

/**
 * Build the hard-runtime-limit message.
 *
 * Names the tool, the exact config key for the owning agent, and the value that expired, and states
 * that an unchanged retry re-expires it — the limit is per-task wall clock, so repeating the same
 * work reaches the same ceiling.
 *
 * @param input - the tool, owning agent, and resolved limit.
 * @returns the message text, used verbatim as the Error message.
 */
export function hardTimeoutHint(input: HardTimeoutHintInput): string {
  const seconds = Math.round(input.limitMs / 1000);
  const hint = (
    `Background task for tool "${input.toolName}" was aborted: it exceeded its hard runtime limit `
    + `of ${String(input.limitMs)}ms (~${String(seconds)}s), set by `
    + `\`agents.${input.agentId}.backgroundTasks.maxBackgroundDurationMs\`. This is a per-task wall `
    + "clock, so retrying the same work unchanged reaches the same ceiling: either narrow the "
    + "request so it finishes inside the limit, or an operator raises that key and restarts the "
    + "daemon. Partial work is not returned — the task was aborted, not completed."
  );
  return hint.length > HARD_TIMEOUT_HINT_MAX_CHARS
    ? hint.slice(0, HARD_TIMEOUT_HINT_MAX_CHARS).trimEnd()
    : hint;
}
