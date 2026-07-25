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

export const backgroundRecoveryVerdict = (
  signals: IncidentSignals,
): BackgroundPendingVerdict | null => {
  const recovery = signals.backgroundRecovery;
  if (recovery === undefined || recovery.unresolvedCount === 0) return null;
  const task = recovery.lastTaskId ?? "unknown";
  const tool = recovery.lastToolName ?? "unknown";
  return {
    code: "background_recovery_retry_required",
    detail:
      `protected background completion recovery could not durably reset ${String(recovery.retryRequiredCount)} task lifecycle transition(s) ` +
      `(last task=${task}, tool=${tool}); retry and reconciliation authority were retained`,
    suggestedNextSteps: [
      "repair the protected background-task store and restart recovery",
      "inspect health_signal:background_task_recovery_failed in system-health",
      "obs.explain depth=full",
    ],
  };
};
