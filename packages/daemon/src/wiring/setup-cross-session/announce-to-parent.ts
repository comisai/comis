// SPDX-License-Identifier: Apache-2.0
/**
 * Parent-session announcement rewrite.
 *
 * Runs the parent agent over a finished background result to produce the text
 * the user actually sees, and returns `undefined` when the parent decides the
 * result is not worth announcing.
 *
 * The turn is deliberately capability-free: it rewrites evidence, so it must
 * not act on it. That is expressed as `noToolCalls` rather than an empty tool
 * array, because tools are the first element of the provider cache key and
 * emptying them rewrites the cached prefix on the way in and again on the way
 * out. Proxy typing brackets the delivery itself, not spawn time, so the
 * indicator tracks the wait the user is actually experiencing.
 *
 * @module
 */
import {
  createConversationRef,
  systemNowMs,
  type CitationEvidence,
  type ConversationLocator,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/** The session-execution boundary this rewrite runs through. */
export type AnnounceExecuteInSession = (
  agentId: string,
  sessionKey: SessionKey,
  conversation: ConversationLocator,
  text: string,
  fixedTools?: undefined,
  resolvedLanguage?: string,
  runtimeActionEvidence?: { kind: "background_completion" },
  citationEvidence?: CitationEvidence,
  noToolCalls?: boolean,
) => Promise<{ response: string; tokensUsed: { total: number }; cost: { total: number } }>;

export type AnnounceToParent = (
  callerAgentId: string,
  callerSessionKey: SessionKey,
  callerConversation: ConversationLocator,
  text: string,
  channelType: string,
  channelId: string,
  options?: {
    threadId?: string;
    resolvedLanguage?: string;
    citationEvidence?: CitationEvidence;
  },
) => Promise<string | undefined>;

export function createAnnounceToParent(deps: {
  eventBus: TypedEventBus;
  executeInSession: AnnounceExecuteInSession;
  logger?: Pick<ComisLogger, "debug" | "warn">;
}): AnnounceToParent {
  return async (
    callerAgentId,
    callerSessionKey,
    callerConversation,
    text,
    channelType,
    channelId,
    options,
  ) => {
    deps.logger?.debug({
      callerAgentId,
      channelId: callerSessionKey.channelId,
      textLength: text.length,
      channelType,
      targetChannelId: channelId,
      resolvedLanguage: options?.resolvedLanguage ?? "unset",
    }, "announceToParent invoked");

    const proxyId = `announce-${systemNowMs()}-${Math.random().toString(36).slice(2, 8)}`;
    deps.eventBus.emit("typing:proxy_start", {
      runId: proxyId,
      channelType,
      channelId,
      parentSessionKey: typeof callerSessionKey === "string"
        ? callerSessionKey
        : `${callerSessionKey.channelId}:${callerSessionKey.userId}:${callerSessionKey.tenantId}`,
      agentId: callerAgentId,
      timestamp: systemNowMs(),
    });
    try {
      if (
        callerConversation.conversationScope.tenantId !== callerSessionKey.tenantId
        || callerConversation.conversationScope.agentId !== callerAgentId
      ) {
        deps.logger?.warn({
          callerAgentId,
          hint: "repair the captured parent conversation authority before retrying the announcement",
          errorKind: "precondition" as const,
        }, "Parent announcement conversation authority is inconsistent");
        return undefined;
      }
      const callerRef = createConversationRef(callerConversation.conversationScope);
      if (!callerRef.ok || callerRef.value !== callerConversation.conversationRef) return undefined;
      const result = await deps.executeInSession(
        callerAgentId,
        callerSessionKey,
        callerConversation,
        text,
        undefined,
        options?.resolvedLanguage,
        { kind: "background_completion" },
        options?.citationEvidence,
        true,
      );
      const trimmed = result.response.trim();
      const isNoReply = !trimmed || trimmed === "NO_REPLY" || trimmed.startsWith("NO_REPLY");
      deps.logger?.debug({
        callerAgentId,
        responseLength: trimmed.length,
        willDeliver: !isNoReply,
        isNoReply,
      }, "announceToParent execution result");
      return isNoReply ? undefined : trimmed;
    } finally {
      deps.eventBus.emit("typing:proxy_stop", {
        runId: proxyId,
        channelType,
        channelId,
        reason: "completed" as const,
        durationMs: 0,
        timestamp: systemNowMs(),
      });
    }
  };
}
