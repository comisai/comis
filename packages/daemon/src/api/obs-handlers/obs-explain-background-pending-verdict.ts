// SPDX-License-Identifier: Apache-2.0
/** Deterministic verdict for a foreground turn deferred to background work. */
import type { IncidentSignals } from "@comis/core";

type BackgroundPendingVerdict = {
  code: string;
  detail: string;
  suggestedNextSteps: string[];
};

export const backgroundPendingVerdict = (
  signals: IncidentSignals,
): BackgroundPendingVerdict | null => {
  if (signals.endReason !== "background_pending") return null;
  return {
    code: "background_pending",
    detail:
      "the foreground turn ended with promoted work still pending; the terminal user outcome belongs to the background completion and exact-origin delivery lifecycle",
    suggestedNextSteps: [
      "inspect background_task.promoted → background_task.completed → background_task.reentered and the subsequent delivery.dispatched records",
      "if completion exists without accepted delivery, inspect the exact originating channel adapter and delivery queue",
      "obs.explain depth=full",
    ],
  };
};
