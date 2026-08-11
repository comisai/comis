// SPDX-License-Identifier: Apache-2.0
/**
 * The model-facing hint returned by a successful `graph.execute` dispatch.
 *
 * One pure function keeps each completion-route branch executable and tested
 * instead of burying the model-facing contract in the handler. The successful
 * route must tell the caller to stop duplicating delegated work, while routes
 * without governed completion delivery must not promise a notification.
 *
 * @module
 */

/** Which completion path the dispatched pipeline actually has. */
export interface GraphDispatchHintInput {
  /** The resolved announcement channel type, absent when no route exists. */
  readonly announceChannelType?: string;
  /** The resolved announcement conversation id, absent when no route exists. */
  readonly announceChannelId?: string;
  /** Whether retained (durable) completion delivery is available. */
  readonly durableDeliveryEnabled: boolean;
}

const NO_AUTOMATIC_NOTIFICATION =
  "Tell the caller it is running and include the graphId; do not promise an "
  + "automatic notification. The caller can inspect graph status later.";

/** Build the dispatch hint for the completion path this graph actually has. */
export function graphDispatchHint(input: GraphDispatchHintInput): string {
  if (input.announceChannelType === undefined || input.announceChannelId === undefined) {
    return `Pipeline launched, but no completion channel is available. ${NO_AUTOMATIC_NOTIFICATION}`;
  }
  if (!input.durableDeliveryEnabled) {
    // The store is daemon-wide: it is built from the autonomy-bearing agent's
    // knob, which is not necessarily the agent dispatching this pipeline.
    return "Pipeline launched, but retained completion delivery is disabled "
      + "(autonomy.durability.enabled on the autonomy-bearing agent). "
      + NO_AUTOMATIC_NOTIFICATION;
  }
  return "Pipeline launched — your job is now DONE. Tell the user the pipeline is running "
    + "(and what it will produce), then STOP. Do NOT research this topic yourself, do NOT "
    + "call more tools, and do NOT poll with status/cron: the sub-agents are doing the work "
    + "in isolated contexts and you will be notified automatically with results when it "
    + "completes. Duplicating their research here only exhausts your own context window.";
}
