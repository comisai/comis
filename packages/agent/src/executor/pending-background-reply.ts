// SPDX-License-Identifier: Apache-2.0
import {
  isClosedBackgroundTask,
  type BackgroundTask,
} from "../background/background-task-types.js";
import { backgroundToolLabel } from "../background/background-tool-label.js";
import { DEFAULT_LOCALE_CATALOG, type LocaleCatalog } from "./degraded-reply-i18n.js";

export interface PendingBackgroundTurnInput {
  response: string;
  executionId: string | undefined;
  tasks: ReadonlyArray<BackgroundTask>;
  /** Resolved response locale, so the notice matches the language of the answer it replaces. */
  locale?: string;
  /** Operator locale packs; defaults to the English platform pack. */
  localeCatalog?: LocaleCatalog;
}

/**
 * Substitute the task list into a localized notice.
 *
 * `{labels}` is the positional token — a placeholder rather than caller-side concatenation because
 * word order does not survive translation (Hebrew is RTL, so "prose: list" is not a safe universal
 * shape). A pack that omits the token is not an error: the labels are appended so an incomplete
 * operator pack degrades to a readable sentence instead of dropping the task ids the user needs.
 */
function withLabels(template: string, labels: string): string {
  return template.includes("{labels}")
    ? template.replaceAll("{labels}", labels)
    : `${template} ${labels}`;
}

export interface PendingBackgroundTurnResult {
  response: string;
  finishReason: "background_pending" | undefined;
  pendingCount: number;
}

/**
 * Prevent a foreground turn from presenting unrelated terminal text while a
 * tool promoted by that same request still owns an undelivered continuation.
 * This includes the race where the tool finishes before the originating turn
 * settles: completion delivery waits for that turn to end, so painting the
 * origin as successful would precede the actual result. The persisted task
 * origin provides the ownership boundary; tasks from other requests do not
 * affect this turn.
 */
export function reconcilePendingBackgroundTurn(
  input: PendingBackgroundTurnInput,
): PendingBackgroundTurnResult {
  if (input.executionId === undefined) {
    return { response: input.response, finishReason: undefined, pendingCount: 0 };
  }
  const pending = input.tasks.filter(
    (task) => (
      task.origin.traceId === input.executionId
      && !isClosedBackgroundTask(task)
    ),
  );
  if (pending.length === 0) {
    return { response: input.response, finishReason: undefined, pendingCount: 0 };
  }
  const labels = pending
    .map((task) => `${backgroundToolLabel(task.toolName)} (${task.id})`)
    .join(", ");
  const runningCount = pending.filter((task) => task.status === "running").length;
  // This notice is the AGENT'S OWN user-facing sentence, so it must speak the language of the answer
  // it replaces. Under an enforced non-Latin response locale it previously stayed English and a
  // Hebrew conversation received a mixed reply — measured live at 0 Hebrew characters across every
  // runtime card, on sessions whose model output was 87-100% Hebrew.
  const catalog = input.localeCatalog ?? DEFAULT_LOCALE_CATALOG;
  const messageId = runningCount === pending.length
    ? "background_pending_running" as const
    : runningCount === 0
      ? "background_pending_ready" as const
      : "background_pending_updates" as const;
  const response = withLabels(catalog.resolve(input.locale, messageId), labels);
  return {
    response,
    finishReason: "background_pending",
    pendingCount: pending.length,
  };
}
