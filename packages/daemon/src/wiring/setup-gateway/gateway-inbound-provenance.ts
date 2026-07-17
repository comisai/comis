// SPDX-License-Identifier: Apache-2.0
import type {
  ComisLogger,
  NormalizedMessage,
  SessionKey,
  TypedEventBus,
} from "@comis/core";
import { toSafeErrorLogString } from "@comis/core";
import { emitObservationalEventSafely } from "@comis/core";
import type { ComisSessionManager } from "@comis/agent";
import { err, ok, type Result } from "@comis/shared";

export type GatewaySessionAdapter = Pick<
  ComisSessionManager,
  "destroySession" | "getSessionStats" | "persistInboundMessage"
>;

interface GatewayInboundProvenanceError {
  error: Error;
  errorKind: "validation" | "precondition" | "resource" | "config";
}

/** Commit one gateway-origin message before announcing or processing it. */
export async function persistGatewayInboundMessage(deps: {
  agentId: string;
  defaultAgentId: string;
  message: NormalizedMessage;
  sessionKey: SessionKey;
  recordedAt: number;
  sessionAdapters?: Map<string, GatewaySessionAdapter>;
  eventBus: TypedEventBus;
  logger: ComisLogger;
}): Promise<Result<void, GatewayInboundProvenanceError>> {
  const sessionAdapter = deps.sessionAdapters?.get(deps.agentId)
    ?? deps.sessionAdapters?.get(deps.defaultAgentId);
  const persisted = sessionAdapter === undefined
    ? err({
        error: new Error(`No session adapter is registered for resolved agent '${deps.agentId}'`),
        errorKind: "config" as const,
      })
    : await sessionAdapter.persistInboundMessage(
        deps.sessionKey,
        deps.message,
        deps.recordedAt,
      );

  if (!persisted.ok) {
    deps.logger.error(
      {
        step: "session-provenance",
        agentId: deps.agentId,
        channelType: deps.message.channelType,
        err: toSafeErrorLogString(persisted.error.error),
        hint: "Check session storage ownership, free space, and lock health, then resend the message.",
        errorKind: persisted.error.errorKind,
      },
      "Gateway inbound message provenance persistence failed",
    );
    emitObservationalEventSafely(deps, "message:terminal", {
      channelType: deps.message.channelType,
      channelId: deps.message.channelId,
      sourceMessageId: deps.message.id,
      outcome: "error",
      reason: "inbound_rejected",
      timestamp: deps.recordedAt,
    });
    emitObservationalEventSafely(deps, "system:error", {
      error: persisted.error.error,
      source: "gateway-session-provenance",
    });
    return persisted;
  }

  emitObservationalEventSafely(deps, "message:received", {
    message: deps.message,
    sessionKey: deps.sessionKey,
  });
  return ok(undefined);
}
