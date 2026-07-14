// SPDX-License-Identifier: Apache-2.0
/**
 * Persist gateway attachment markers under the exact request session key.
 *
 * The channel ID alone is not a session identity: SessionStorePort keys also
 * include tenant and user identity. The caller therefore supplies the
 * request-scoped SessionKey resolved by the message handler.
 */

import {
  formatSessionKey,
  sanitizeLogString,
  type ClockPort,
  type ComisLogger,
  type SessionKey,
  type SessionStorePort,
} from "@comis/core";

export type GatewayAttachmentPersister = (sessionKey: SessionKey, marker: string) => void;

export function createGatewayAttachmentPersister(deps: {
  sessionStore: Pick<SessionStorePort, "load" | "save">;
  clock: ClockPort;
  logger: ComisLogger;
  emitSystemError: (payload: { error: Error; source: string }) => void;
}): GatewayAttachmentPersister {
  return (sessionKey, marker) => {
    try {
      const existing = deps.sessionStore.load(sessionKey);
      const messages: unknown[] = [...(existing?.messages ?? [])];

      messages.push({ role: "assistant", content: marker, timestamp: deps.clock.now() });
      deps.sessionStore.save(sessionKey, messages, existing?.metadata);
    } catch (error) {
      const errorMessage = sanitizeLogString(error instanceof Error ? error.message : String(error));
      deps.logger.warn({
        err: errorMessage,
        sessionKey: formatSessionKey(sessionKey),
        hint: "Check SQLite session storage health and available disk space",
        errorKind: "resource" as const,
      }, "Gateway attachment history persistence failed");
      deps.emitSystemError({
        error: new Error("Gateway attachment history persistence failed"),
        source: "gateway-attachment-history",
      });
    }
  };
}
