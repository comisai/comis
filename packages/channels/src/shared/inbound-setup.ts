/**
 * Inbound Pipeline Phase 5: Pre-Execution Setup.
 *
 * Handles ack reaction delivery, typing controller creation, and
 * priority lane assignment before message routing/execution.
 *
 * @module
 */

import type { ChannelPort, NormalizedMessage, SessionKey, PerChannelStreamingConfig } from "@comis/core";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import { createTypingController } from "./typing-controller.js";
import type { TypingController } from "./typing-controller.js";
import { createTypingLifecycleController } from "./typing-lifecycle-controller.js";
import type { TypingLifecycleController } from "./typing-lifecycle-controller.js";
import { isGroupMessage, isBotMentioned } from "./auto-reply-engine.js";
import { REPLY_TO_META_KEY } from "./execution-pipeline.js";

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
};

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for the pre-execution setup phase. */
export type SetupDeps = Pick<
  InboundPipelineDeps,
  | "logger"
  | "eventBus"
  | "channelRegistry"
  | "ackReactionConfig"
  | "lifecycleReactionsEnabled"
  | "streamingConfig"
>;

// ---------------------------------------------------------------------------
// Setup result
// ---------------------------------------------------------------------------

/** Result of pre-execution setup. */
export interface SetupResult {
  /** Typing lifecycle controller (undefined if typing disabled). */
  typingLifecycle: TypingLifecycleController | undefined;
  /** Resolved per-channel streaming config. */
  streamCfg: PerChannelStreamingConfig;
}

// ---------------------------------------------------------------------------
// Helper functions
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

import { resolveStreamingConfig } from "./execution-pipeline.js";

/**
 * Send ack reaction and create typing controller for the inbound message.
 *
 * Returns the typing lifecycle controller and resolved streaming config.
 */
export function setupInboundExecution(
  deps: SetupDeps,
  adapter: ChannelPort,
  processedMsg: NormalizedMessage,
  originalMsg: NormalizedMessage,
  _sessionKey: SessionKey,
): SetupResult {
  // -------------------------------------------------------------------
  // ACK REACTION -- fire-and-forget after activation
  // -------------------------------------------------------------------
  if (deps.ackReactionConfig?.enabled && !deps.lifecycleReactionsEnabled) {
    const caps = deps.channelRegistry?.getCapabilities(adapter.channelType);
    const supportsReactions = caps?.features?.reactions ?? false;
    if (supportsReactions) {
      const metaKey = caps?.replyToMetaKey ?? REPLY_TO_META_KEY[adapter.channelType];
      const platformMsgId = metaKey ? String(processedMsg.metadata?.[metaKey] ?? "") : "";
      if (platformMsgId) {
        adapter.reactToMessage(processedMsg.channelId, platformMsgId, deps.ackReactionConfig.emoji)
          .then((result) => {
            if (result.ok) {
              deps.eventBus.emit("ack:reaction_sent", {
                channelId: processedMsg.channelId,
                channelType: adapter.channelType,
                messageId: platformMsgId,
                emoji: deps.ackReactionConfig!.emoji,
                timestamp: Date.now(),
              });
            } else {
              deps.logger.warn({
                channelType: adapter.channelType,
                chatId: processedMsg.channelId,
                err: result.error,
                hint: "Platform may not support reactions or message may be too old",
                errorKind: "platform" as const,
              }, "Ack reaction failed");
            }
          })
          .catch((error: unknown) => {
            deps.logger.warn({
              channelType: adapter.channelType,
              chatId: processedMsg.channelId,
              err: error instanceof Error ? error : new Error(String(error)),
              hint: "Unexpected error in ack reaction handler",
              errorKind: "platform" as const,
            }, "Ack reaction error");
          });
      }
    }
  }

  // -------------------------------------------------------------------
  // Resolve streaming config and typing controller
  // -------------------------------------------------------------------
  const streamCfg = resolveStreamingConfig(adapter.channelType, deps.streamingConfig);

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
        timestamp: Date.now(),
      });
    }
  }

  return { typingLifecycle, streamCfg };
}
