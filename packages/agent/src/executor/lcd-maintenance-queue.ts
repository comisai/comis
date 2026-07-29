// SPDX-License-Identifier: Apache-2.0
/**
 * Per-conversation queue for slow LCD maintenance.
 *
 * Summarization may await an external model for minutes. It must serialize with
 * other compaction passes for the same conversation, but it must not occupy the
 * short store mutation queue used by live ingest. Otherwise the next turn can
 * finish its model call and still wait minutes before its reply is delivered.
 */

type MaintenanceTask = () => Promise<void>;

const tails = new Map<string, Promise<void>>();

/**
 * Enqueue one slow maintenance task behind prior maintenance for the same
 * conversation. Different conversations remain concurrent. Rejection is
 * returned to the caller while the internal tail settles successfully so one
 * failed pass cannot wedge later maintenance.
 */
export function enqueueContextMaintenance(
  conversationRef: string,
  task: MaintenanceTask,
): Promise<void> {
  const previous = tails.get(conversationRef);
  const run = previous === undefined
    ? Promise.resolve().then(task)
    : previous.then(task, task);

  const clearIfCurrent = (): void => {
    if (tails.get(conversationRef) === settled) tails.delete(conversationRef);
  };
  const settled = run.then(clearIfCurrent, clearIfCurrent);
  tails.set(conversationRef, settled);
  return run;
}
