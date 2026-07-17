// SPDX-License-Identifier: Apache-2.0
import type {
  DeliveryFailureReceipt,
  DeliveryStageResult,
} from "@comis/core";
import { systemNowMs } from "@comis/core";
import type { MediaDeliveryOutcome } from "./execution-filter.js";

/** Build one content-free failure receipt spanning media and later delivery. */
export function createMediaDeliveryFailureReceipt(
  mediaDelivery: MediaDeliveryOutcome,
  laterDelivery?: DeliveryStageResult,
  additionalDeliveredChunks = 0,
): DeliveryFailureReceipt {
  let deliveredChunks = mediaDelivery.delivered + additionalDeliveredChunks;
  let failedChunks = mediaDelivery.failed;
  if (laterDelivery !== undefined) {
    if (laterDelivery.ok) {
      deliveredChunks += laterDelivery.value.deliveredChunks;
    } else {
      deliveredChunks += laterDelivery.error.deliveredChunks;
      failedChunks += laterDelivery.error.failedChunks;
    }
  }
  return {
    ok: false,
    totalChunks: deliveredChunks + failedChunks,
    deliveredChunks,
    failedChunks,
    errorKind: "platform",
    lastError: "Outbound media delivery failed",
    failedAtMs: mediaDelivery.failedAtMs ?? systemNowMs(),
  };
}
