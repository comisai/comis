// SPDX-License-Identifier: Apache-2.0
/** Persist gateway attachment markers under explicit conversation authority. */

import {
  createConversationRef,
  type ClockPort,
  type ComisLogger,
  type ConversationScope,
  type SessionStorePort,
} from "@comis/core";

export type GatewayAttachmentPersister = (scope: ConversationScope, marker: string) => void;

export function createGatewayAttachmentPersister(deps: {
  sessionStore: Pick<SessionStorePort, "load" | "save">;
  clock: ClockPort;
  logger: ComisLogger;
  emitSystemError: (payload: { error: Error; source: string }) => void;
}): GatewayAttachmentPersister {
  return (scope, marker) => {
    const existing = deps.sessionStore.load(scope);
    if (!existing.ok) {
      const reference = createConversationRef(scope);
      deps.logger.warn({
        conversationRef: reference.ok ? reference.value : undefined,
        hint: "Check SQLite session storage integrity and available disk space.",
        errorKind: existing.error.errorKind,
      }, "Gateway attachment history persistence failed");
      deps.emitSystemError({
        error: new Error("Gateway attachment history persistence failed"),
        source: "gateway-attachment-history",
      });
      return;
    }
    const messages: unknown[] = [...(existing.value?.messages ?? [])];
    messages.push({ role: "assistant", content: marker, timestamp: deps.clock.now() });
    const saved = deps.sessionStore.save(scope, messages, existing.value?.metadata);
    if (!saved.ok) {
      const reference = createConversationRef(scope);
      deps.logger.warn({
        conversationRef: reference.ok ? reference.value : undefined,
        hint: "Check SQLite session storage integrity and available disk space.",
        errorKind: saved.error.errorKind,
      }, "Gateway attachment history persistence failed");
      deps.emitSystemError({
        error: new Error("Gateway attachment history persistence failed"),
        source: "gateway-attachment-history",
      });
    }
  };
}
