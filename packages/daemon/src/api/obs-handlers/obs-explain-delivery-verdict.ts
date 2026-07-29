// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic terminal delivery verdict for `obs.explain`.
 *
 * The model and tool execution may succeed before the channel send settles.
 * A failed or partial dispatch is therefore the authoritative user-visible
 * outcome even when the earlier execution summary was clean.
 */
import type { IncidentSignals } from "@comis/core";

type DeliveryVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/** Name a failed or partial final dispatch; clean delivery returns no verdict. */
export function deliveryFailedVerdict(s: IncidentSignals): DeliveryVerdict | null {
  const delivery = s.deliveryDispatch;
  if (delivery === undefined || delivery.status === "success") return null;
  const failed = delivery.status === "failure";
  const errorKind = delivery.errorKind === undefined
    ? ""
    : `; errorKind=${delivery.errorKind}`;
  return {
    code: failed ? "delivery_failed" : "delivery_partial",
    detail:
      `outbound delivery ${failed ? "failed" : "was partial"}: `
      + `${String(delivery.deliveredChunks)} of ${String(delivery.totalChunks)} chunk(s) reached `
      + `${delivery.channelType}; ${String(delivery.failedChunks)} failed${errorKind}. `
      + "The execution may have succeeded, but the user did not receive the complete response.",
    suggestedNextSteps: [
      `verify destination access and channel credentials for ${delivery.channelType}`,
      "inspect the delivery queue status before retrying; an uncertain outcome must not be duplicated",
      "obs.explain depth=full for the delivery and activity-finalize records",
    ],
  };
}
