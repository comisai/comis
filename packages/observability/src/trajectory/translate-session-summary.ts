// SPDX-License-Identifier: Apache-2.0
/** Content-free trajectory projection for the per-execution session summary. */

import { ResponseLocaleRepairSkippedSchema } from "@comis/core";

export function translateSessionSummaryPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const repairSkipRaw = payload.responseLocaleRepairSkipped;
  const repairSkip = (
    typeof repairSkipRaw === "object"
    && repairSkipRaw !== null
    && !Array.isArray(repairSkipRaw)
  )
    ? repairSkipRaw as Record<string, unknown>
    : {};
  const parsedRepairSkip = ResponseLocaleRepairSkippedSchema.safeParse(
    {
      reason: repairSkip.reason,
      expectedScript: repairSkip.expectedScript,
      actualScript: repairSkip.actualScript,
      unrecoveredToolFailureCount: repairSkip.unrecoveredToolFailureCount,
    },
  );
  return {
    degraded: payload.degraded,
    turnCount: payload.turnCount,
    costUsd: payload.costUsd,
    toolStats: payload.toolStats,
    breakerTripCount: payload.breakerTripCount,
    topErrorKinds: payload.topErrorKinds,
    source: payload.source,
    endReason: payload.endReason,
    ...(parsedRepairSkip.success
      ? { responseLocaleRepairSkipped: parsedRepairSkip.data }
      : {}),
  };
}
