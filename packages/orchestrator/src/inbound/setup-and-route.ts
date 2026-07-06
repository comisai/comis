// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound Pipeline Phase 3: Pre-Execution Setup + Message Routing.
 *
 * Resolves typing lifecycle + streaming config, then routes through
 * steer/followup, queue, or direct execution.
 *
 * @module
 */

import type {
  ChannelPort,
  NormalizedMessage,
  SessionKey,
  PerChannelStreamingConfig,
} from "@comis/core";
import { formatSessionKey, systemNowMs } from "@comis/core";
import type { AgentExecutor } from "@comis/agent";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import {
  createTypingController,
  createTypingLifecycleController,
  isGroupMessage,
  isBotMentioned,
} from "@comis/channels";
import type {
  TypingController,
  TypingLifecycleController,
  BlockPacer,
  SendOverrideStore,
} from "@comis/channels";
import { resolveStreamingConfig, executeAndDeliver } from "../execution/execution-pipeline.js";

// ---------------------------------------------------------------------------
// Per-platform typing refresh defaults
// ---------------------------------------------------------------------------

/**
 * Optimal typing indicator refresh intervals per platform.
 * Each value is set with margin before the platform's natural expiry.
 * IRC and Echo are intentionally omitted -- they default to typingMode "never".
 */
export const PLATFORM_TYPING_DEFAULTS: Record<string, number> = {
  telegram: 4000,   // 1s margin before 5s expiry
  discord:  8000,   // 2s margin before 10s expiry
  whatsapp: 8000,   // ~10s expiry
  signal:   4000,   // ~5s expiry
  line:     15000,  // 20s expiry (showLoadingAnimation)
  imessage: 4000,   // ~5s process-based expiry
  matrix:   25000,  // 5s margin before the 30s /typing timeout the adapter sends
};

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/**
 * Minimal deps for the setup-and-route phase.
 *
 * 23 unique fields: 4 shared between the former setup + route Pick<>s
 * (logger / eventBus / channelRegistry / streamingConfig), 1 unique to setup
 * (lifecycleReactionsEnabled), and 18 unique to route (the route set gained
 * the activityStreamPort + coordinatorFactory pass-through to execDeps).
 */
export type SetupAndRouteDeps = Pick<
  InboundPipelineDeps,
  // From inbound-setup.ts (5 fields; 4 shared with route):
  | "logger"
  | "eventBus"
  | "channelRegistry"
  | "lifecycleReactionsEnabled"
  | "streamingConfig"
  // From inbound-route.ts (22 fields; 4 shared with setup):
  | "commandQueue"
  | "queueConfig"
  | "activeRunRegistry"
  | "sessionResolver"
  | "sendPolicyConfig"
  | "getElevatedReplyConfig"
  | "retryEngine"
  | "deliveryQueue"
  | "deliveryService"
  | "assembleToolsForAgent"
  | "voiceResponsePipeline"
  | "parseOutboundMedia"
  | "outboundMediaFetch"
  | "responsePrefixConfig"
  | "buildTemplateContext"
  | "getEnforceFinalTag"
  // Propagated onto execDeps for the pipeline gate (see execution-pipeline.ts).
  | "activityStreamPort"
  | "coordinatorFactory"
>;

// ---------------------------------------------------------------------------
// Helper functions (lifted verbatim from inbound-setup.ts:79-87)
// ---------------------------------------------------------------------------

/**
 * Determine if typing indicators should be shown in the current context.
 *
 * In DMs, always show typing. In group chats, only show typing when the
 * bot was mentioned or replied to (prevents unnecessary typing noise).
 */
function shouldShowTypingInGroup(msg: NormalizedMessage): boolean {
  if (!isGroupMessage(msg)) return true; // Not a group -- show typing
  return isBotMentioned(msg); // In group -- only if mentioned
}

/** Check if this execution was triggered by a heartbeat (suppress typing). */
function isHeartbeatExecution(msg: NormalizedMessage): boolean {
  return msg.metadata?.isHeartbeat === true;
}

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/**
 * Resolve typing lifecycle + streaming config, then route the inbound message
 * through steer/followup, queue, or direct execution.
 *
 * This function is Phase 3 of the inbound pipeline. The two sub-phases are
 * sequential: Phase 3A computes streamCfg + typingLifecycle from the
 * processed message; Phase 3B uses both to route through the appropriate
 * execution path.
 */
export async function setupAndRoute(
  deps: SetupAndRouteDeps,
  adapter: ChannelPort,
  processedMsg: NormalizedMessage,
  originalMsg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  executor: AgentExecutor,
  activePacers: Set<BlockPacer>,
  sendOverrides: SendOverrideStore,
  directives: Record<string, unknown> | undefined,
): Promise<void> {
  // ===== Phase 3A: Resolve typing lifecycle + streaming config =====
  // The local vars `streamCfg` and `typingLifecycle` flow into Phase 3B below
  // instead of being returned.
  //
  // Ack reactions are handled by the lifecycle reactor (when enabled); the
  // ackReactionConfig deps slot was removed since no ack reactions were sent
  // through this stage in production.

  const streamCfg: PerChannelStreamingConfig = resolveStreamingConfig(
    adapter.channelType,
    deps.streamingConfig,
  );

  // IRC and Echo default to typingMode "never" (no typing API) unless explicitly overridden
  const effectiveTypingMode =
    (adapter.channelType === "irc" || adapter.channelType === "echo") && streamCfg.typingMode === "thinking"
      ? "never" as const
      : streamCfg.typingMode;

  // Determine if typing indicators should activate
  let typingCtrl: TypingController | undefined;
  const shouldType =
    effectiveTypingMode !== "never" &&
    !isHeartbeatExecution(processedMsg) &&
    shouldShowTypingInGroup(originalMsg);

  if (shouldType) {
    const threadIdForTyping = processedMsg.metadata?.telegramThreadId != null
      ? String(processedMsg.metadata.telegramThreadId)
      : undefined;

    // Resolve per-platform refresh interval, falling back to per-channel config
    const refreshMs = PLATFORM_TYPING_DEFAULTS[adapter.channelType] ?? streamCfg.typingRefreshMs;

    typingCtrl = createTypingController(
      {
        mode: effectiveTypingMode,
        refreshMs,
        circuitBreakerThreshold: streamCfg.typingCircuitBreakerThreshold,
        ttlMs: streamCfg.typingTtlMs,
      },
      async (chatId: string) => {
        await adapter.platformAction("sendTyping", { chatId, threadId: threadIdForTyping });
      },
      { warn: (obj, message) => deps.logger.warn(obj, message) },
    );
  }

  // Wrap the raw TypingController in a lifecycle controller
  let typingLifecycle: TypingLifecycleController | undefined;
  if (typingCtrl) {
    typingLifecycle = createTypingLifecycleController(typingCtrl, {
      graceMs: 10_000,
      logger: { warn: (obj, message) => deps.logger.warn(obj, message) },
    });

    // 'instant' mode: start typing immediately before queue/execution
    if (streamCfg.typingMode === "instant") {
      typingLifecycle.controller.start(processedMsg.channelId);
      deps.eventBus.emit("typing:started", {
        channelId: adapter.channelId,
        chatId: processedMsg.channelId,
        mode: streamCfg.typingMode,
        timestamp: systemNowMs(),
      });
    }
  }

  // ===== Phase 3B: Route via steer/followup, queue, or direct execution =====
  // The parameters `streamCfg` and `typingLifecycle` are locals from Phase 3A
  // above instead of incoming function parameters.

  const msg = processedMsg;

  // Debounce buffer + group history injection deps slots (debounceBuffer,
  // groupHistoryBuffer, sessionLabelStore) were never wired by the daemon;
  // their absent-mode (direct routing without coalescing or history injection)
  // IS the production code path. They have been removed.

  // Build narrow execution pipeline deps from the inbound pipeline deps
  const execDeps = {
    eventBus: deps.eventBus,
    logger: deps.logger,
    streamingConfig: deps.streamingConfig,
    sendPolicyConfig: deps.sendPolicyConfig,
    getElevatedReplyConfig: deps.getElevatedReplyConfig,
    channelRegistry: deps.channelRegistry,
    retryEngine: deps.retryEngine,
    deliveryQueue: deps.deliveryQueue,
    deliveryService: deps.deliveryService,
    commandQueue: deps.commandQueue,
    assembleToolsForAgent: deps.assembleToolsForAgent,
    voiceResponsePipeline: deps.voiceResponsePipeline,
    parseOutboundMedia: deps.parseOutboundMedia,
    outboundMediaFetch: deps.outboundMediaFetch,
    responsePrefixConfig: deps.responsePrefixConfig,
    buildTemplateContext: deps.buildTemplateContext,
    enforceFinalTag: deps.getEnforceFinalTag?.(agentId),
    activityStreamPort: deps.activityStreamPort,
    coordinatorFactory: deps.coordinatorFactory,
  };

  // -------------------------------------------------------------------
  // STEER+FOLLOWUP ROUTING
  // -------------------------------------------------------------------
  // Active-session lookup goes through BackgroundSessionResolver:
  // composite (agentId, channelType, channelId) supersedes the single-arg
  // formatted-key lookup so multi-agent / multi-channel sessions are
  // distinguishable. The original
  // `formattedKey = formatSessionKey(sessionKey)` is retained ONLY for
  // diagnostic log fields (the SessionKey may itself be richer than the
  // resolver's composite triple).
  if (deps.sessionResolver && deps.queueConfig) {
    const channelQueueConfig = deps.queueConfig.perChannel[adapter.channelType];
    const effectiveMode = channelQueueConfig?.mode ?? deps.queueConfig.defaultMode;

    if (effectiveMode === "steer+followup") {
      const formattedKey = formatSessionKey(sessionKey);
      const runHandle = deps.sessionResolver.resolveActiveSession({
        agentId,
        channelType: adapter.channelType,
        channelId: msg.channelId,
      });

      if (runHandle) {
        const messageText = msg.text ?? "";

        if (runHandle.isStreaming() && !runHandle.isCompacting()) {
          // Session is streaming -- inject via SDK steer
          try {
            await runHandle.steer(messageText);
            deps.eventBus.emit("steer:injected", {
              sessionKey,
              channelType: adapter.channelType,
              agentId,
              timestamp: systemNowMs(),
            });
            deps.logger.debug(
              { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
              "Steer message injected into active session",
            );
            return; // Message handled via steer -- do not enqueue
          } catch (steerErr) {
            deps.logger.warn(
              {
                agentId,
                err: steerErr instanceof Error ? steerErr : new Error(String(steerErr)),
                hint: "SDK session.steer() failed; message will be queued as follow-up",
                errorKind: "internal" as const,
              },
              "Steer injection failed",
            );
            // Fall through to follow-up below
          }
        }

        if (runHandle.isCompacting()) {
          deps.eventBus.emit("steer:rejected", {
            sessionKey,
            channelType: adapter.channelType,
            agentId,
            reason: "compacting",
            timestamp: systemNowMs(),
          });
          deps.logger.debug(
            { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
            "Steer rejected: session compacting",
          );
        } else {
          deps.eventBus.emit("steer:rejected", {
            sessionKey,
            channelType: adapter.channelType,
            agentId,
            reason: "not_streaming",
            timestamp: systemNowMs(),
          });
          deps.logger.debug(
            { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
            "Steer rejected: session not streaming",
          );
        }

        // Queue as follow-up (session exists but steer not possible)
        try {
          await runHandle.followUp(messageText);
          deps.eventBus.emit("steer:followup_queued", {
            sessionKey,
            channelType: adapter.channelType,
            agentId,
            reason: runHandle.isCompacting() ? "compacting" : "not_streaming",
            timestamp: systemNowMs(),
          });
          deps.logger.debug(
            { agentId, channelType: adapter.channelType, sessionKey: formattedKey },
            "Message queued as follow-up via SDK",
          );
          return; // Message handled via follow-up -- do not enqueue
        } catch (followUpErr) {
          deps.logger.warn(
            {
              agentId,
              err: followUpErr instanceof Error ? followUpErr : new Error(String(followUpErr)),
              hint: "SDK session.followUp() failed; falling through to CommandQueue",
              errorKind: "internal" as const,
            },
            "Follow-up queue failed",
          );
          // Fall through to normal CommandQueue routing
        }
      }
      // No active run -- fall through to CommandQueue (first message for session)
    }
  }

  // -----------------------------------------------------------------------
  // Queue-mediated path: route through CommandQueue for serialization
  // -----------------------------------------------------------------------
  if (deps.commandQueue) {
    const enqueueResult = await deps.commandQueue.enqueue(sessionKey, msg, adapter.channelType, async (messages) => {
      const effectiveMsg = messages[0]!;
      await executeAndDeliver(execDeps, adapter, effectiveMsg, originalMsg, executor, sessionKey, agentId, streamCfg, activePacers, sendOverrides, typingLifecycle, directives);
    });
    if (!enqueueResult.ok) {
      deps.logger.warn({
        err: enqueueResult.error.message,
        hint: "Check if command queue is shut down or overflow policy rejected the message",
        errorKind: "resource" as const,
        channelType: adapter.channelType,
      }, "Message enqueue failed");
    }

    return;
  }

  // -----------------------------------------------------------------------
  // Direct execution path (fallback when commandQueue is not provided)
  // -----------------------------------------------------------------------
  await executeAndDeliver(execDeps, adapter, msg, originalMsg, executor, sessionKey, agentId, streamCfg, activePacers, sendOverrides, typingLifecycle, directives);
}
