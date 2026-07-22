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
import { ingestTurnGuarded } from "../executor/lcd-ingest.js";

export interface ContextHistoryReplacementError {
  errorKind: ErrorKind;
  message: string;
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
        store.deleteConversationLcd(scope);
        ingestTurnGuarded(store, scope, history, nowMs, logger);
        const retainedMessages = store.getMessages(scope).length;
        const cursor = store.getIngestCursor(scope);
        const cursorComplete = history.length === 0
          ? cursor === null
          : cursor?.ingestedLiveLen === history.length;
        return retainedMessages === history.length && cursorComplete;
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
