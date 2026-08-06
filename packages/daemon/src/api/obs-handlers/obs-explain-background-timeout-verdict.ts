// SPDX-License-Identifier: Apache-2.0
/** Deterministic verdict for the runtime-owned hard limit on a background task. */
import type { IncidentSignals } from "@comis/core";

type BackgroundTimeoutVerdict = {
  code: string;
  detail: string;
  suggestedNextSteps: string[];
};

const BACKGROUND_LIMIT = /^(agents\.[^.\s]+\.backgroundTasks\.maxBackgroundDurationMs)=([0-9]+)ms$/;

export const backgroundHardTimeoutVerdict = (
  signals: IncidentSignals,
): BackgroundTimeoutVerdict | null => {
  const failure = signals.failures.find(
    (candidate) => candidate.failureCode === "background_hard_timeout_exceeded",
  );
  if (failure === undefined) return null;
  const match = BACKGROUND_LIMIT.exec(failure.errorPreview);
  const configuredLimit = match?.[0] ?? "the configured background hard-runtime limit";
  const configKey = match?.[1] ?? "agents.<id>.backgroundTasks.maxBackgroundDurationMs";
  return {
    code: "background_hard_timeout",
    detail: `${failure.toolName} was aborted after reaching ${configuredLimit}`,
    suggestedNextSteps: [
      `narrow or split the work so each background task finishes within ${configuredLimit}`,
      `if the work genuinely needs longer, an operator can raise \`${configKey}\` and restart the daemon`,
      "obs.explain depth=full",
    ],
  };
};
