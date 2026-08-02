// SPDX-License-Identifier: Apache-2.0
/** Strict, crash-reconcilable replacement of one canonical LCD history. */
import type {
  ComisLogger,
  ContextStorePort,
  ContextStoreScope,
  ErrorKind,
} from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
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

function canonicalProjectionAnchor(history: AgentMessage[]): string | undefined {
  const first = history[0];
  return first === undefined
    ? undefined
    : `canonical-projection:${messageEpochAnchor(first)}`;
}

function projectionChangesHistory(
  sourceMessages: AgentMessage[],
  projectedMessages: AgentMessage[],
): boolean {
  if (sourceMessages.length !== projectedMessages.length) return true;
  return sourceMessages.some((message, index) => {
    const projected = projectedMessages[index];
    return projected === undefined
      || messageEpochAnchor(message) !== messageEpochAnchor(projected);
  });
}

function replaceHistoryWithinSerializer(
  store: ContextStorePort,
  scope: ContextStoreScope,
  history: AgentMessage[],
  nowMs: number,
  logger: ComisLogger,
  epochAnchorOverride?: string,
): boolean {
  store.deleteConversationLcd(scope);
  ingestTurnGuarded(
    store,
    scope,
    history,
    nowMs,
    logger,
    undefined,
    undefined,
    undefined,
    epochAnchorOverride,
  );
  const retainedMessages = store.getMessages(scope).length;
  const cursor = store.getIngestCursor(scope);
  const cursorComplete = history.length === 0
    ? cursor === null
    : cursor?.epochAnchor === (
      epochAnchorOverride ?? messageEpochAnchor(history[0]!)
    )
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
 * first unmodified SDK message — either directly (an epoch persisted from raw
 * rendered prompts) or through that same verbatim message's canonical
 * projection anchor (an epoch the projection persisted while it still passed
 * an unpaired first turn through untouched, before it began carving that
 * turn) — the canonical projection must have a distinct anchor, and the SDK
 * source may not have shrunk behind its cursor. A cursor belonging to any
 * unrelated epoch follows the normal append-only rebase path. This keeps
 * genuine session continuity while removing runtime prompt wrappers and
 * generated locale-repair turns that were previously persisted as user
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
  const persistenceMessages = convertToLlm(projectedMessages) as AgentMessage[];
  const serialized = await fromPromise(store.runOnConversation(scope.conversationRef, () => {
    const attempted = tryCatch((): ProjectedConversationIngestOutcome | undefined => {
      const safe = isScopeSafeForIngest(scope);
      const cursor = safe.ok ? store.getIngestCursor(scope) : null;
      const sourceAnchor = sourceMessages[0] === undefined
        ? undefined
        : messageEpochAnchor(sourceMessages[0]);
      const projectedAnchor = canonicalProjectionAnchor(persistenceMessages);
      // A dirty epoch is anchored to the verbatim source[0] in one of two
      // forms: the raw anchor (persisted from rendered prompts, pre-projection)
      // or its canonical-projection anchor (persisted by a projection that
      // still passed the unpaired first turn through verbatim). Requiring the
      // NEW projected anchor to differ from the cursor keeps steady-state
      // turns — where the stored anchor already names today's projection —
      // on the append-only path.
      const matchesRenderedEpoch = cursor !== null
        && sourceAnchor !== undefined
        && projectedAnchor !== undefined
        && projectedAnchor !== cursor.epochAnchor
        && (cursor.epochAnchor === sourceAnchor
          || cursor.epochAnchor === `canonical-projection:${sourceAnchor}`)
        && projectionChangesHistory(sourceMessages, projectedMessages);

      if (matchesRenderedEpoch) {
        const deletedMessages = store.getMessages(scope).length;
        const complete = replaceHistoryWithinSerializer(
          store,
          scope,
          persistenceMessages,
          now,
          logger,
          projectedAnchor,
        );
        return complete
          ? { mode: "replaced_dirty_epoch", deletedMessages }
          : undefined;
      }

      ingestTurnGuarded(
        store,
        scope,
        persistenceMessages,
        now,
        logger,
        onFailClosed,
        onDivergence,
        onRebase,
        projectedAnchor,
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
