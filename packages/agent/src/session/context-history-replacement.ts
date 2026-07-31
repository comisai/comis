// SPDX-License-Identifier: Apache-2.0
/** Strict, crash-reconcilable replacement of one canonical LCD history. */
import type {
  ComisLogger,
  ContextStorePort,
  ContextStoreScope,
  ErrorKind,
} from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import {
  ingestTurnGuarded,
  isScopeSafeForIngest,
  messageEpochAnchor,
} from "../executor/lcd-ingest.js";

export interface ContextHistoryReplacementError {
  errorKind: ErrorKind;
  message: string;
}

export interface ProjectedConversationIngestArgs {
  store: ContextStorePort;
  scope: ContextStoreScope;
  /** Unmodified SDK history retained only to identify an already-stored rendered epoch. */
  sourceMessages: AgentMessage[];
  /** Canonical history reconstructed from structured physical inbound provenance. */
  projectedMessages: AgentMessage[];
  now: number;
  logger: ComisLogger;
  onFailClosed?: (reason: string) => void;
  onDivergence?: (reason: string) => void;
  onRebase?: (reason: string) => void;
}

export interface ProjectedConversationIngestOutcome {
  mode: "steady" | "replaced_dirty_epoch";
  deletedMessages: number;
}

function replaceHistoryWithinSerializer(
  store: ContextStorePort,
  scope: ContextStoreScope,
  history: AgentMessage[],
  nowMs: number,
  logger: ComisLogger,
): boolean {
  store.deleteConversationLcd(scope);
  ingestTurnGuarded(store, scope, history, nowMs, logger);
  const retainedMessages = store.getMessages(scope).length;
  const cursor = store.getIngestCursor(scope);
  const cursorComplete = history.length === 0
    ? cursor === null
    : cursor?.epochAnchor === messageEpochAnchor(history[0]!)
      && cursor.ingestedLiveLen === history.length;
  return retainedMessages === history.length && cursorComplete;
}

export function replaceContextStoreHistory(
  store: ContextStorePort,
  scope: ContextStoreScope,
  history: AgentMessage[],
  nowMs: number,
  logger: ComisLogger,
): Promise<Result<{ retainedMessages: number }, ContextHistoryReplacementError>> {
  return replace();

  async function replace(): Promise<Result<{ retainedMessages: number }, ContextHistoryReplacementError>> {
    const serialized = await fromPromise(store.runOnConversation(scope.conversationRef, () => {
      const replaced = tryCatch(() => {
        return replaceHistoryWithinSerializer(store, scope, history, nowMs, logger);
      });
      return replaced.ok && replaced.value;
    }));
    if (!serialized.ok) {
      return err({
        errorKind: "resource",
        message: "Canonical history replacement serializer rejected",
      });
    }
    if (!serialized.value) {
      return err({
        errorKind: "resource",
        message: "Canonical history replacement was incomplete",
      });
    }
    return ok({ retainedMessages: history.length });
  }
}

/**
 * Ingest canonical projected history and repair one precisely identified
 * rendered-prompt epoch.
 *
 * The replacement is deliberately narrow: the stored cursor must match the
 * first unmodified SDK message, the canonical projection must have a distinct
 * anchor, and the SDK source may not have shrunk behind its cursor. A cursor
 * belonging to any unrelated epoch follows the normal append-only rebase path.
 * This keeps genuine session continuity while removing runtime prompt wrappers
 * and generated locale-repair turns that were previously persisted as user
 * conversation.
 */
export async function ingestProjectedConversationHistory(
  args: ProjectedConversationIngestArgs,
): Promise<Result<ProjectedConversationIngestOutcome, ContextHistoryReplacementError>> {
  const {
    store,
    scope,
    sourceMessages,
    projectedMessages,
    now,
    logger,
    onFailClosed,
    onDivergence,
    onRebase,
  } = args;
  const serialized = await fromPromise(store.runOnConversation(scope.conversationRef, () => {
    const attempted = tryCatch((): ProjectedConversationIngestOutcome | undefined => {
      const safe = isScopeSafeForIngest(scope);
      const cursor = safe.ok ? store.getIngestCursor(scope) : null;
      const sourceAnchor = sourceMessages[0] === undefined
        ? undefined
        : messageEpochAnchor(sourceMessages[0]);
      const projectedAnchor = projectedMessages[0] === undefined
        ? undefined
        : messageEpochAnchor(projectedMessages[0]);
      const matchesRenderedEpoch = cursor !== null
        && sourceAnchor !== undefined
        && projectedAnchor !== undefined
        && sourceAnchor !== projectedAnchor
        && cursor.epochAnchor === sourceAnchor
        && cursor.ingestedLiveLen <= sourceMessages.length;

      if (matchesRenderedEpoch) {
        const deletedMessages = store.getMessages(scope).length;
        const complete = replaceHistoryWithinSerializer(
          store,
          scope,
          projectedMessages,
          now,
          logger,
        );
        return complete
          ? { mode: "replaced_dirty_epoch", deletedMessages }
          : undefined;
      }

      ingestTurnGuarded(
        store,
        scope,
        projectedMessages,
        now,
        logger,
        onFailClosed,
        onDivergence,
        onRebase,
      );
      return { mode: "steady", deletedMessages: 0 };
    });
    return attempted.ok ? attempted.value : undefined;
  }));

  if (!serialized.ok) {
    return err({
      errorKind: "resource",
      message: "Projected conversation ingest serializer rejected",
    });
  }
  if (serialized.value === undefined) {
    return err({
      errorKind: "resource",
      message: "Projected conversation history replacement was incomplete",
    });
  }
  return ok(serialized.value);
}
