// SPDX-License-Identifier: Apache-2.0
// @allow-throw: cross-session-sender validation guards (invalid session key, session-not-found, deadlock-risk); consumed via daemon session-handlers (@allow-throw).
/**
 * Cross-session sender module.
 * Supports three messaging modes between agent sessions:
 * - fire-and-forget: inject message and return immediately
 * - wait: inject message, execute target agent, return response
 * - ping-pong: multi-turn alternating exchange between two sessions
 * Extracted from daemon.ts inline session.send handler for testability.
 */

import {
  conversationScopeToSessionKey,
  type ChannelEndpoint,
  type ConversationLocator,
  formatSessionKey,
  type ConversationRef,
  type ConversationScope,
  type SessionData,
  type SessionQueryScope,
  type SessionStoreError,
  type SessionKey,
  type TypedEventBus,
  type AgentToAgentConfig,
  type AnnouncementProducerReservation,
  type AnnouncementRetirementProducer,
  type ComisLogger,
  type RootRunIdResolver,
  createStableAnnouncementOperationId,
  systemNowMs,
  systemSetTimeout,
} from "@comis/core";
import { fromPromise, type Result } from "@comis/shared";
import {
  isGovernedAnnouncementConfirmedDelivered,
  type SendGovernedCompletionAnnouncement,
  type SendRecoverableCompletionAnnouncement,
} from "./announcement-outward-operation.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CrossSessionSenderDeps {
  sessionStore: {
    loadByRef(scope: SessionQueryScope, conversationRef: ConversationRef): Result<SessionData | undefined, SessionStoreError>;
    save(scope: ConversationScope, messages: unknown[], metadata: Record<string, unknown>): Result<void, SessionStoreError>;
  };
  executeInSession: (
    agentId: string,
    sessionKey: SessionKey,
    conversation: ConversationLocator,
    text: string,
  ) => Promise<{
    response: string;
    tokensUsed: { total: number };
    cost: { total: number };
  }>;
  sendToChannel: (channelType: string, channelId: string, text: string) => Promise<boolean>;
  eventBus: TypedEventBus;
  config: AgentToAgentConfig;
  /** Receipt-aware retained-operation boundary for completion announcements. */
  sendGovernedAnnouncement?: SendGovernedCompletionAnnouncement;
  sendRecoverableAnnouncement?: SendRecoverableCompletionAnnouncement;
  reserveAnnouncementProducer?: (
    reservation: AnnouncementProducerReservation,
  ) => Promise<Result<void, Error>>;
  releaseAnnouncementProducer?: (
    producerKey: string,
  ) => Promise<Result<void, Error>>;
  cancelAnnouncementProducer?: (
    producerKey: string,
  ) => Promise<Result<void, Error>>;
  suppressAnnouncementProducer?: (
    producerKey: string,
  ) => Promise<Result<boolean, Error>>;
  prepareAnnouncementRetirement?: (
    completionKeys: readonly string[],
    producer: AnnouncementRetirementProducer,
  ) => Promise<Result<void, Error>>;
  resolveRootRunId?: RootRunIdResolver;
  /** Logger for fail-closed durable announcement failures. */
  logger?: Pick<ComisLogger, "error">;
}

export interface CrossSessionSendParams {
  target: SessionQueryScope & { conversationRef: ConversationRef };
  text: string;
  mode: "fire-and-forget" | "wait" | "ping-pong";
  timeoutMs?: number;
  maxTurns?: number;
  caller?: SessionQueryScope & { conversationRef: ConversationRef };
  callerSessionKey?: string;
  callerConversation?: ConversationLocator;
  /** Immutable endpoint captured with the authenticated caller turn. */
  callerEndpoint?: ChannelEndpoint;
  /** Framework-authenticated agent that owns the caller session. */
  callerAgentId?: string;
  /** Stable identity of the originating sessions_send tool call. */
  announceOperationId?: string;
  announceChannelType?: string;
  announceChannelId?: string;
}

export interface CrossSessionSendResult {
  sent: boolean;
  response?: string;
  turnsCompleted?: number;
  announced?: boolean;
  stats?: { runtimeMs: number; totalTokens: number; totalCost: number };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCrossSessionSender(deps: CrossSessionSenderDeps) {
  async function announce(
    channelType: string | undefined,
    channelId: string | undefined,
    text: string,
    callerAgentId: string | undefined,
    callerSessionKey: string | undefined,
    callerConversation: ConversationLocator | undefined,
    callerEndpoint: ChannelEndpoint | undefined,
    announceOperationId: string | undefined,
  ): Promise<boolean> {
    if (!channelType || !channelId) return false;

    const sendGovernedAnnouncement = deps.sendGovernedAnnouncement;
    const sendRecoverableAnnouncement = deps.sendRecoverableAnnouncement;
    if (!sendGovernedAnnouncement && !sendRecoverableAnnouncement) {
      deps.logger?.error(
        {
          step: "completion-announcement",
          errorKind: "precondition" as const,
          hint: "wire the recoverable announcement boundary before retrying the cross-session response",
        },
        "Cross-session announcement recovery unavailable",
      );
      return false;
    }
    if (
      callerAgentId === undefined
      || callerSessionKey === undefined
      || callerConversation === undefined
      || callerEndpoint === undefined
    ) {
      deps.logger?.error(
        {
          step: "completion-announcement",
          errorKind: "precondition" as const,
          hint: "retry with the framework-authenticated caller agent and session",
        },
        "Cross-session announcement principal unavailable",
      );
      return false;
    }
    if (
      announceOperationId === undefined
      || announceOperationId.length === 0
      || announceOperationId.length > 256
    ) {
      deps.logger?.error(
        {
          step: "completion-announcement",
          errorKind: "precondition" as const,
          hint: "the announcement was blocked before channel delivery; retry with the stable originating sessions_send tool-call identity",
        },
        "Cross-session durable announcement operation identity unavailable",
      );
      return false;
    }
    const request = {
      agentId: callerAgentId,
      callerSessionKey,
      callerConversation,
      destinationEndpoint: callerEndpoint,
      runId: announceOperationId,
      channelType,
      channelId,
      text,
      completionKeys: [announceOperationId],
      ...(callerEndpoint.threadId ? { options: { threadId: callerEndpoint.threadId } } : {}),
    };
    if (sendRecoverableAnnouncement && !sendGovernedAnnouncement) {
      const recoverableBoundary = await fromPromise(sendRecoverableAnnouncement(request));
      if (!recoverableBoundary.ok || !recoverableBoundary.value.ok) {
        deps.logger?.error(
          {
            step: "completion-announcement",
            errorKind: "dependency" as const,
            hint: "inspect the recoverable announcement boundary and retry only with the same operation identity",
          },
          "Cross-session recoverable announcement failed",
        );
        return false;
      }
      const outcome = recoverableBoundary.value.value;
      return outcome.delivered
        || ("terminalDecision" in outcome && outcome.terminalDecision === "delivered");
    }
    const boundary = await fromPromise(sendGovernedAnnouncement!(request));
    if (!boundary.ok || !boundary.value.ok) {
      deps.logger?.error(
        {
          step: "completion-announcement",
          errorKind: "dependency" as const,
          hint: "inspect the governed announcement boundary and retry only with the same operation identity",
        },
        "Cross-session governed announcement failed",
      );
      return false;
    }
    return isGovernedAnnouncementConfirmedDelivered(boundary.value.value);
  }

  function stripAnnounceSkip(text: string): { stripped: string; hadSkip: boolean } {
    const hadSkip = text.includes("ANNOUNCE_SKIP");
    const stripped = hadSkip ? text.replace("ANNOUNCE_SKIP", "").trim() : text;
    return { stripped, hadSkip };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    async send(params: CrossSessionSendParams): Promise<CrossSessionSendResult> {
      const loadedTarget = deps.sessionStore.loadByRef(params.target, params.target.conversationRef);
      if (!loadedTarget.ok) throw loadedTarget.error;
      const data = loadedTarget.value;
      if (!data) throw new Error(`Target conversation not found: ${params.target.conversationRef}`);
      const projectedTarget = conversationScopeToSessionKey(data.conversationScope);
      if (!projectedTarget.ok) throw projectedTarget.error;
      const targetSessionKey = projectedTarget.value;
      const targetDisplayKey = formatSessionKey(targetSessionKey);

      if (
        params.mode !== "fire-and-forget"
        && params.caller?.tenantId === params.target.tenantId
        && params.caller.agentId === params.target.agentId
        && params.caller.conversationRef === params.target.conversationRef
      ) {
        throw new Error(
          "Cannot send to own session in wait/ping-pong mode (deadlock risk). Use fire-and-forget mode instead.",
        );
      }
      let reservedProducerKey: string | undefined;
      let producerShouldRemain = false;
      let producerOwnershipSettled = false;
      if (
        params.mode !== "fire-and-forget"
        && params.announceOperationId !== undefined
        && params.announceChannelType !== undefined
        && params.announceChannelId !== undefined
        && params.callerAgentId !== undefined
        && params.callerSessionKey !== undefined
        && params.callerConversation !== undefined
        && params.callerEndpoint !== undefined
        && deps.reserveAnnouncementProducer !== undefined
      ) {
        if (
          deps.releaseAnnouncementProducer === undefined
          || deps.cancelAnnouncementProducer === undefined
          || deps.suppressAnnouncementProducer === undefined
        ) {
          throw new Error("Announcement producer lifecycle is incomplete");
        }
        const callerSession = conversationScopeToSessionKey(
          params.callerConversation.conversationScope,
        );
        if (!callerSession.ok) throw callerSession.error;
        const resolvedRoot = deps.resolveRootRunId?.(
          params.callerAgentId,
          callerSession.value,
        );
        const operationId = createStableAnnouncementOperationId(
          params.callerAgentId,
          params.callerSessionKey,
          params.announceOperationId,
        );
        const reservation: AnnouncementProducerReservation = {
          idempotencyKey: operationId,
          agentId: params.callerAgentId,
          runId: params.announceOperationId,
          sessionKey: params.callerSessionKey,
          announcementText: "A cross-session response finished, but its notification was interrupted before delivery ownership transferred.",
          channelType: params.announceChannelType,
          channelId: params.announceChannelId,
          failedAt: systemNowMs(),
          rootRunId: resolvedRoot?.ok
            ? resolvedRoot.value
            : `announcement:${params.callerSessionKey}`,
          deliveryAuthority: {
            tenantId: params.callerConversation.conversationScope.tenantId,
            agentId: params.callerAgentId,
            conversationRef: params.callerConversation.conversationRef,
          },
          destinationEndpoint: params.callerEndpoint,
          completionKeys: [operationId, params.announceOperationId],
          retirementKeys: [params.announceOperationId],
          ...(params.callerEndpoint.threadId
            ? { threadId: params.callerEndpoint.threadId }
            : {}),
        };
        const reserved = await deps.reserveAnnouncementProducer(reservation);
        if (!reserved.ok) throw reserved.error;
        reservedProducerKey = params.announceOperationId;
      }

      const suppressAnnouncementProducer = async (): Promise<void> => {
        if (reservedProducerKey === undefined) return;
        producerOwnershipSettled = true;
        const suppress = deps.suppressAnnouncementProducer;
        if (suppress === undefined) throw new Error("Announcement producer lifecycle is incomplete");
        const suppressed = await suppress(reservedProducerKey);
        if (!suppressed.ok) throw suppressed.error;
      };

      try {
        if (
          reservedProducerKey !== undefined
          && params.callerConversation !== undefined
          && deps.prepareAnnouncementRetirement !== undefined
        ) {
          const prepared = await deps.prepareAnnouncementRetirement(
            [reservedProducerKey],
            {
              kind: "tool_result",
              tenantId: params.callerConversation.conversationScope.tenantId,
              agentId: params.callerConversation.conversationScope.agentId,
              conversationRef: params.callerConversation.conversationRef,
              toolCallId: reservedProducerKey,
            },
          );
          if (!prepared.ok) throw prepared.error;
        }

        // 3. Inject synthetic user message into target session
        const newMessage = {
          role: "user",
          content: params.text,
          timestamp: systemNowMs(),
          metadata: { crossSession: true, fromConversationRef: params.caller?.conversationRef },
        };
        const updatedMessages = [...data.messages, newMessage];
        const saved = deps.sessionStore.save(
          data.conversationScope,
          updatedMessages,
          data.metadata,
        );
        if (!saved.ok) throw saved.error;

        // 4. Emit cross-send event
        deps.eventBus.emit("session:cross_send", {
          fromSessionKey: params.callerSessionKey ?? "unknown",
          toSessionKey: targetDisplayKey,
          mode: params.mode,
          timestamp: systemNowMs(),
        });

        // 5. Fire-and-forget: return immediately
        if (params.mode === "fire-and-forget") {
          return { sent: true };
        }

        const agentId = data.conversationScope.agentId;
        const startMs = systemNowMs();
        const timeoutMs = params.timeoutMs ?? deps.config.waitTimeoutMs;

        const execResult = await Promise.race([
          deps.executeInSession(agentId, targetSessionKey, {
            conversationScope: data.conversationScope,
            conversationRef: data.conversationRef,
          }, params.text),
          new Promise<never>((_, reject) =>
            systemSetTimeout(() => reject(new Error("Cross-session wait timed out")), timeoutMs),
          ),
        ]);

        let totalTokens = execResult.tokensUsed.total;
        let totalCost = execResult.cost.total;
        let lastResponse = execResult.response;

        // 8. Wait mode: announce and return
        if (params.mode === "wait") {
          const { stripped, hadSkip } = stripAnnounceSkip(lastResponse);
          producerShouldRemain = !hadSkip;
          if (hadSkip) await suppressAnnouncementProducer();
          const announced = hadSkip
            ? false
            : await announce(params.announceChannelType, params.announceChannelId, stripped, params.callerAgentId, params.callerSessionKey, params.callerConversation, params.callerEndpoint, params.announceOperationId);
          return {
            sent: true,
            response: stripped,
            announced,
            stats: {
              runtimeMs: systemNowMs() - startMs,
              totalTokens,
              totalCost,
            },
          };
        }

        // 9. Ping-pong mode: loop alternating between sessions
        const maxTurns = params.maxTurns ?? deps.config.maxPingPongTurns;
        let turnsCompleted = 0;
        if (!params.caller) {
          throw new Error("Ping-pong mode requires explicit caller conversation authority");
        }
        let currentTarget = params.caller;
        let currentSource = params.target;

        while (turnsCompleted < maxTurns) {
          // Check for ANNOUNCE_SKIP escape in last response
          if (lastResponse.includes("ANNOUNCE_SKIP")) {
            break;
          }

          const loaded = deps.sessionStore.loadByRef(currentTarget, currentTarget.conversationRef);
          if (!loaded.ok) throw loaded.error;
          if (!loaded.value) break;
          const targetKey = conversationScopeToSessionKey(loaded.value.conversationScope);
          if (!targetKey.ok) throw targetKey.error;
          const turnAgentId = loaded.value.conversationScope.agentId;
          const turnResult = await deps.executeInSession(turnAgentId, targetKey.value, {
            conversationScope: loaded.value.conversationScope,
            conversationRef: loaded.value.conversationRef,
          }, lastResponse);

          totalTokens += turnResult.tokensUsed.total;
          totalCost += turnResult.cost.total;
          lastResponse = turnResult.response;
          turnsCompleted++;

          // Emit ping-pong turn event
          deps.eventBus.emit("session:ping_pong_turn", {
            fromSessionKey: currentSource.conversationRef,
            toSessionKey: currentTarget.conversationRef,
            turnNumber: turnsCompleted,
            totalTurns: maxTurns,
            tokensUsed: turnResult.tokensUsed.total,
            timestamp: systemNowMs(),
          });

          // Swap directions for next turn
          [currentTarget, currentSource] = [currentSource, currentTarget];
        }

        // 10. Announce final result
        const { stripped, hadSkip } = stripAnnounceSkip(lastResponse);
        producerShouldRemain = !hadSkip;
        if (hadSkip) await suppressAnnouncementProducer();
        const announced = hadSkip
          ? false
          : await announce(params.announceChannelType, params.announceChannelId, stripped, params.callerAgentId, params.callerSessionKey, params.callerConversation, params.callerEndpoint, params.announceOperationId);

        return {
          sent: true,
          response: stripped,
          turnsCompleted,
          announced,
          stats: {
            runtimeMs: systemNowMs() - startMs,
            totalTokens,
            totalCost,
          },
        };
      } finally {
        if (reservedProducerKey !== undefined && !producerOwnershipSettled) {
          if (!producerShouldRemain) {
            if (deps.cancelAnnouncementProducer) {
              await deps.cancelAnnouncementProducer(reservedProducerKey);
            }
          } else if (deps.releaseAnnouncementProducer) {
            await deps.releaseAnnouncementProducer(reservedProducerKey);
          }
        }
      }
    },
  };
}
