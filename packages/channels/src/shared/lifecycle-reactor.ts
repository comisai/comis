// SPDX-License-Identifier: Apache-2.0
/**
 * Lifecycle reactor: subscribes to TypedEventBus events and manages per-message
 * emoji reactions through lifecycle phases with debounce, stall detection,
 * and auto-cleanup.
 *
 * Each reactor instance is bound to a single channel adapter. The daemon creates
 * one reactor per eligible adapter (gated on features.reactions capability).
 *
 * @module
 */

import type {
  ChannelPort,
  TypedEventBus,
  SessionKey,
  LifecycleReactionsConfig,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { suppressError } from "@comis/shared";

import {
  isValidTransition,
  isTerminal,
  type LifecyclePhase,
} from "./lifecycle-state-machine.js";
import {
  getEmojiForPhase,
  classifyToolPhase,
  type EmojiTier,
} from "./emoji-tier-map.js";
import { toSlackShortname } from "./slack-emoji-map.js";
import { computeStallThresholds } from "./stall-detector.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependencies for creating a lifecycle reactor. */
export interface LifecycleReactorDeps {
  eventBus: TypedEventBus;
  adapter: ChannelPort;
  channelType: string;
  replyToMetaKey: string;
  config: LifecycleReactionsConfig;
  logger: ComisLogger;
  /** Optional Telegram emoji fallback function. Injected by daemon wiring for Telegram adapters. */
  reactWithFallback?: (
    adapter: ChannelPort,
    channelId: string,
    messageId: string,
    primaryEmoji: string,
  ) => Promise<unknown>;
}

/** Lifecycle reactor handle returned by the factory. */
export interface LifecycleReactor {
  /** Unsubscribe from all events, clear all timers and per-message state. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Per-message reactor state tracked in the messageStates map. */
interface ReactorState {
  phase: LifecyclePhase;
  currentEmoji: string;
  debounceController: AbortController | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  channelId: string;
  platformMessageId: string;
  phaseEnteredAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract channelId from either a formatted string sessionKey or a SessionKey object.
 *
 * - SessionKey object: direct `.channelId` property access
 * - Formatted string: `[agent:X:]tenantId:userId:channelId[:peer:...]`
 *   Parse by splitting on ":" -- channelId is at index 2 (or 4 if agent prefix present)
 */
export function extractChannelId(sessionKey: string | SessionKey | undefined): string | undefined {
  if (sessionKey == null) return undefined;
  if (typeof sessionKey === "object" && sessionKey !== null) {
    return sessionKey.channelId;
  }
  const parts = sessionKey.split(":");
  if (parts[0] === "agent") {
    return parts.length >= 5 ? parts[4] : undefined;
  }
  return parts.length >= 3 ? parts[2] : undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a lifecycle reactor for a single channel adapter.
 *
 * The reactor subscribes to event bus events and manages per-message emoji
 * reactions through lifecycle phases with debounce, stall detection, and
 * auto-cleanup.
 */
export function createLifecycleReactor(deps: LifecycleReactorDeps): LifecycleReactor {
  const { eventBus, adapter, channelType, replyToMetaKey, config, logger } = deps;

  // Per-message state: key is `${channelId}:${platformMessageId}`
  const messageStates = new Map<string, ReactorState>();

  // Secondary index: channelId -> most recent active messageKey
  const activeMessageByChannel = new Map<string, string>();

  // Effective emoji tier (per-channel override or global)
  const perChannelConfig = Object.hasOwn(config.perChannel, channelType)
    ? config.perChannel[channelType as keyof typeof config.perChannel]
    : undefined;
  const effectiveTier: EmojiTier =
    (perChannelConfig?.emojiTier as EmojiTier | undefined) ?? config.emojiTier as EmojiTier;

  // ------------------------------------------------------------------
  // Core logic
  // ------------------------------------------------------------------

  function applyReaction(state: ReactorState, phase: LifecyclePhase): void {
    const emoji = getEmojiForPhase(phase, effectiveTier);
    if (!emoji) return;
    if (emoji === state.currentEmoji) return; // No-op: same emoji already displayed

    // Remove old emoji fire-and-forget (non-blocking)
    if (state.currentEmoji) {
      suppressError(
        adapter.removeReaction(state.channelId, state.platformMessageId, state.currentEmoji),
        "lifecycle-reactor: platform may have already removed old reaction",
      );
    }

    // Update tracking immediately (before async platform call)
    const previousEmoji = state.currentEmoji;
    state.currentEmoji = emoji;

    if (channelType === "telegram" && deps.reactWithFallback) {
      // Telegram: use fallback chain for REACTION_INVALID errors
      suppressError(
        deps.reactWithFallback(adapter, state.channelId, state.platformMessageId, emoji),
        "lifecycle-reactor: telegram reaction fallback fire-and-forget",
      );
    } else if (channelType === "slack") {
      // Slack: convert Unicode emoji to Slack shortname
      const slackName = toSlackShortname(emoji);
      suppressError(
        adapter.reactToMessage(state.channelId, state.platformMessageId, slackName),
        "lifecycle-reactor: slack reaction fire-and-forget",
      );
    } else {
      // All other platforms: use emoji directly
      suppressError(
        adapter.reactToMessage(state.channelId, state.platformMessageId, emoji),
        "lifecycle-reactor: platform reaction fire-and-forget",
      );
    }

    // Log the transition at DEBUG
    logger.debug({
      channelType,
      chatId: state.channelId,
      messageId: state.platformMessageId,
      phase,
      emoji,
      previousEmoji: previousEmoji || undefined,
    }, "Lifecycle reaction applied");
  }

  function cleanupMessage(messageKey: string): void {
    const state = messageStates.get(messageKey);
    if (!state) return;

    // Clear all timers
    if (state.debounceController) {
      state.debounceController.abort();
      state.debounceController = null;
    }
    if (state.stallTimer) {
      clearTimeout(state.stallTimer);
      state.stallTimer = null;
    }
    if (state.holdTimer) {
      clearTimeout(state.holdTimer);
      state.holdTimer = null;
    }

    // Remove from maps
    messageStates.delete(messageKey);

    // Remove from secondary index (find matching value)
    for (const [chId, mk] of activeMessageByChannel) {
      if (mk === messageKey) {
        activeMessageByChannel.delete(chId);
        break;
      }
    }

    // Emit cleanup event
    eventBus.emit("reaction:cleanup", {
      messageId: state.platformMessageId,
      channelType,
      channelId: state.channelId,
      chatId: state.channelId,
      removedEmoji: state.currentEmoji,
      timestamp: Date.now(),
    });
  }

  function transitionPhase(messageKey: string, newPhase: LifecyclePhase): void {
    const state = messageStates.get(messageKey);
    if (!state) return; // Message already cleaned up

    // Validate transition
    if (!isValidTransition(state.phase, newPhase)) {
      logger.debug({
        channelType,
        messageId: state.platformMessageId,
        from: state.phase,
        to: newPhase,
      }, "Invalid lifecycle transition ignored");
      return;
    }

    const previousPhase = state.phase;

    if (isTerminal(newPhase)) {
      // Terminal states bypass debounce
      // Cancel pending debounce
      if (state.debounceController) {
        state.debounceController.abort();
        state.debounceController = null;
      }
      // Clear stall timer
      if (state.stallTimer) {
        clearTimeout(state.stallTimer);
        state.stallTimer = null;
      }

      // Apply reaction immediately
      state.phase = newPhase;
      state.phaseEnteredAt = Date.now();
      applyReaction(state, newPhase);

      // Emit terminal event
      const emoji = getEmojiForPhase(newPhase, effectiveTier) ?? "";
      eventBus.emit("reaction:terminal", {
        messageId: state.platformMessageId,
        channelType,
        channelId: state.channelId,
        chatId: state.channelId,
        phase: newPhase as "done" | "error",
        emoji,
        timestamp: Date.now(),
      });

      // Determine hold duration
      const holdMs = newPhase === "error"
        ? config.timing.holdErrorMs
        : config.timing.holdDoneMs;

      // Start hold timer: after hold, remove reaction and clean up
      state.holdTimer = setTimeout(() => {
        // Remove the terminal emoji
        suppressError(
          adapter.removeReaction(state.channelId, state.platformMessageId, state.currentEmoji),
          "lifecycle-reactor: hold timer cleanup fire-and-forget",
        );
        cleanupMessage(messageKey);
      }, holdMs);

      // Emit phase_changed
      eventBus.emit("reaction:phase_changed", {
        messageId: state.platformMessageId,
        channelType,
        channelId: state.channelId,
        chatId: state.channelId,
        phase: newPhase,
        emoji,
        previousPhase,
        timestamp: Date.now(),
      });

      return;
    }

    // Intermediate phases with debounce
    // Cancel previous debounce
    if (state.debounceController) {
      state.debounceController.abort();
    }

    // Create new AbortController for this debounce
    const controller = new AbortController();
    state.debounceController = controller;

    // Update state immediately (even if emoji update is debounced)
    state.phase = newPhase;
    state.phaseEnteredAt = Date.now();

    // Set debounce timeout
    const debounceTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      applyReaction(state, newPhase);
    }, config.timing.debounceMs);

    // Wire abort to cancel the debounce timer
    controller.signal.addEventListener("abort", () => {
      clearTimeout(debounceTimer);
    }, { once: true });

    // Update stall detection
    if (state.stallTimer) {
      clearTimeout(state.stallTimer);
      state.stallTimer = null;
    }

    const thresholds = computeStallThresholds(newPhase, config.timing);

    // Set stall timer for soft threshold
    state.stallTimer = setTimeout(() => {
      // Verify still in same phase (timer may be stale)
      if (state.phase !== newPhase) return;

      const stallMs = Date.now() - state.phaseEnteredAt;

      // Determine severity
      if (stallMs >= thresholds.hardMs) {
        // Hard stall
        transitionPhase(messageKey, "stall_hard");
        eventBus.emit("reaction:stall_detected", {
          messageId: state.platformMessageId,
          channelType,
          channelId: state.channelId,
          chatId: state.channelId,
          phase: newPhase,
          severity: "hard",
          stallMs,
          timestamp: Date.now(),
        });
      } else {
        // Soft stall
        transitionPhase(messageKey, "stall_soft");
        eventBus.emit("reaction:stall_detected", {
          messageId: state.platformMessageId,
          channelType,
          channelId: state.channelId,
          chatId: state.channelId,
          phase: newPhase,
          severity: "soft",
          stallMs,
          timestamp: Date.now(),
        });

        // Schedule hard stall check
        const remainingHardMs = thresholds.hardMs - stallMs;
        if (remainingHardMs > 0) {
          state.stallTimer = setTimeout(() => {
            if (state.phase !== "stall_soft") return;
            const hardStallMs = Date.now() - state.phaseEnteredAt;
            transitionPhase(messageKey, "stall_hard");
            eventBus.emit("reaction:stall_detected", {
              messageId: state.platformMessageId,
              channelType,
              channelId: state.channelId,
              chatId: state.channelId,
              phase: newPhase,
              severity: "hard",
              stallMs: hardStallMs,
              timestamp: Date.now(),
            });
          }, remainingHardMs);
        }
      }
    }, thresholds.softMs);

    // Emit phase_changed
    const emoji = getEmojiForPhase(newPhase, effectiveTier) ?? "";
    eventBus.emit("reaction:phase_changed", {
      messageId: state.platformMessageId,
      channelType,
      channelId: state.channelId,
      chatId: state.channelId,
      phase: newPhase,
      emoji,
      previousPhase,
      timestamp: Date.now(),
    });
  }

  // ------------------------------------------------------------------
  // Event handlers
  // ------------------------------------------------------------------

  function onMessageReceived(event: { message: { channelType: string; channelId: string; metadata?: Record<string, unknown> }; sessionKey: SessionKey }): void {
    // Only process messages for this adapter's channel type
    if (event.message.channelType !== channelType) return;

    // Extract platform message ID from metadata
    const platformMessageId = event.message.metadata?.[replyToMetaKey];
    if (!platformMessageId) return; // Graceful degradation

    const messageId = String(platformMessageId);
    const channelId = event.message.channelId;
    const messageKey = `${channelId}:${messageId}`;

    // Create reactor state
    const state: ReactorState = {
      phase: "idle",
      currentEmoji: "",
      debounceController: null,
      stallTimer: null,
      holdTimer: null,
      channelId,
      platformMessageId: messageId,
      phaseEnteredAt: Date.now(),
    };

    messageStates.set(messageKey, state);
    activeMessageByChannel.set(channelId, messageKey);

    // Transition to "queued" phase
    transitionPhase(messageKey, "queued");
  }

  function onToolStarted(event: { toolName: string; sessionKey?: string }): void {
    const channelId = extractChannelId(event.sessionKey);
    if (!channelId) return;

    const messageKey = activeMessageByChannel.get(channelId);
    if (!messageKey) return;

    const targetPhase = classifyToolPhase(event.toolName);
    transitionPhase(messageKey, targetPhase);
  }

  function onToolExecuted(event: { sessionKey?: string }): void {
    const channelId = extractChannelId(event.sessionKey);
    if (!channelId) return;

    const messageKey = activeMessageByChannel.get(channelId);
    if (!messageKey) return;

    // Tool completed -- transition back to thinking (LLM is generating again)
    transitionPhase(messageKey, "thinking");
  }

  function onQueueDequeued(event: { sessionKey: SessionKey }): void {
    const channelId = extractChannelId(event.sessionKey);
    if (!channelId) return;

    const messageKey = activeMessageByChannel.get(channelId);
    if (!messageKey) return;

    transitionPhase(messageKey, "thinking");
  }

  function onMessageSent(event: { channelId: string }): void {
    const messageKey = activeMessageByChannel.get(event.channelId);
    if (!messageKey) return;

    transitionPhase(messageKey, "done");
  }

  function onExecutionAborted(event: { sessionKey: SessionKey }): void {
    const channelId = extractChannelId(event.sessionKey);
    if (!channelId) return;

    const messageKey = activeMessageByChannel.get(channelId);
    if (!messageKey) return;

    transitionPhase(messageKey, "error");
  }

  function onResponseFiltered(event: { channelId: string }): void {
    const messageKey = activeMessageByChannel.get(event.channelId);
    if (!messageKey) return;

    // Response was suppressed but execution succeeded
    transitionPhase(messageKey, "done");
  }

  // ------------------------------------------------------------------
  // Subscribe to events
  // ------------------------------------------------------------------

  eventBus.on("message:received", onMessageReceived);
  eventBus.on("tool:started", onToolStarted);
  eventBus.on("tool:executed", onToolExecuted);
  eventBus.on("queue:dequeued", onQueueDequeued);
  eventBus.on("message:sent", onMessageSent);
  eventBus.on("execution:aborted", onExecutionAborted);
  eventBus.on("response:filtered", onResponseFiltered);

  // ------------------------------------------------------------------
  // Return handle
  // ------------------------------------------------------------------

  return {
    destroy(): void {
      // Clear all timers for all messages
      for (const state of messageStates.values()) {
        if (state.debounceController) {
          state.debounceController.abort();
          state.debounceController = null;
        }
        if (state.stallTimer) {
          clearTimeout(state.stallTimer);
          state.stallTimer = null;
        }
        if (state.holdTimer) {
          clearTimeout(state.holdTimer);
          state.holdTimer = null;
        }
      }

      // Clear maps
      messageStates.clear();
      activeMessageByChannel.clear();

      // Unsubscribe from all events
      eventBus.off("message:received", onMessageReceived);
      eventBus.off("tool:started", onToolStarted);
      eventBus.off("tool:executed", onToolExecuted);
      eventBus.off("queue:dequeued", onQueueDequeued);
      eventBus.off("message:sent", onMessageSent);
      eventBus.off("execution:aborted", onExecutionAborted);
      eventBus.off("response:filtered", onResponseFiltered);
    },
  };
}
