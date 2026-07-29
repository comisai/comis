// SPDX-License-Identifier: Apache-2.0
/** Reconcile a final response with an exact-route outbound tool delivery. */

import { isSilentResponse } from "@comis/shared";
import type { RunPromptParams } from "./prompt-runner-types.js";

export function suppressRedundantFinalAfterOutboundDelivery(
  params: RunPromptParams,
): void {
  const target = params.executionOverrides
    ?.suppressFinalResponseAfterOutboundDelivery;
  if (
    target === undefined
    || isSilentResponse(params.result.response)
    || !params.bridge.hasOutboundDelivery(target)
  ) {
    return;
  }

  params.result.response = "NO_REPLY";
  params.result.finalResponseSuppressedBy = "outbound_delivery";
  params.deps.logger.info(
    {
      step: "outbound-delivery-reconciliation",
      channelType: target.channelType,
      exactRouteMatched: true,
    },
    "Redundant final response suppressed after successful outbound delivery",
  );
}
