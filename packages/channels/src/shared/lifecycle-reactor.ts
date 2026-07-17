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
  EventMap,
  TypedEventBus,
  SessionKey,
  LifecycleReactionsConfig,
} from "@comis/core";
import type { ComisLogger } from "@comis/core";
import { suppressError, tryCatch } from "@comis/shared";

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
import { emitObservationalEventSafely, systemClearTimeout, systemNowMs, systemSetTimeout, toSafeErrorLogString, tryGetContext } from "@comis/core";
import { parseFormattedSessionKey } from "@comis/core";

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
  sourceKeys: Set<string>;
  traceKeys: Set<string>;
  phaseEnteredAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract channelId from either a formatted string sessionKey or a SessionKey object.
 *
 * - SessionKey object: direct `.channelId` property access
 * - Formatted string: use the canonical session-key parser so channel IDs
 *   containing `:` remain round-trip safe and tagged suffixes are excluded.
 */
export function extractChannelId(sessionKey: string | SessionKey | undefined): string | undefined {
  if (sessionKey == null) return undefined;
  if (typeof sessionKey === "object" && sessionKey !== null) {
    return sessionKey.channelId;
  }
  return parseFormattedSessionKey(sessionKey)?.channelId;
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

  // Construction-time invariant: the reactor is created only for
  // adapters whose capability gate says `features.reactions: true` (see
  // setup-channels-runtime.ts). ChannelPort.reactToMessage/removeReaction are
  // optional on the port, so narrow the adapter shape locally so the body can
  // call the methods directly. If a caller bypasses the gate the constructor
  // surfaces it loudly here instead of `TypeError` later inside the
  // fire-and-forget path.
  // @allow-throw: Construction-time invariant — capability-gate misconfiguration
  // is a developer/composition-root bug that must surface loudly at startup, not
  // be swallowed into Result.err. The caller (setup-channels-runtime.ts) creates
  // reactors only when `caps.supportsReactions` is true; reaching here means the
  // capability metadata claims support but the adapter omits the method.
  if (typeof adapter.reactToMessage !== "function" || typeof adapter.removeReaction !== "function") {
    throw new Error(
      `lifecycle-reactor: channel "${channelType}" lacks reactToMessage/removeReaction — capability gate (features.reactions) must be enforced before createLifecycleReactor()`,
    );
  }
  const reactToMessage = adapter.reactToMessage.bind(adapter);
  const removeReaction = adapter.removeReaction.bind(adapter);

  // JSON tuple keys cannot alias when a platform id itself contains `:`.
  const messageStates = new Map<string, ReactorState>();
  const messageKeyBySource = new Map<string, string>();
  const messageKeyByTrace = new Map<string, string>();

  type ReactionEventName =
    | "reaction:cleanup"
    | "reaction:terminal"
    | "reaction:phase_changed"
    | "reaction:stall_detected";

  function emitReactionEvent<K extends ReactionEventName>(
    eventName: K,
    payload: EventMap[K],
  ): void {
    emitObservationalEventSafely({ eventBus, logger }, eventName, payload);
  }

  function runPlatformReaction(
    operation: () => Promise<unknown>,
    action: string,
    suppressedReason: string,
  ): void {
    const started = tryCatch(operation);
    if (!started.ok) {
      void tryCatch(() => logger.warn({
        channelType,
        action,
        err: toSafeErrorLogString(started.error),
        hint: "Inspect the channel reaction adapter; lifecycle state and cleanup continued",
        errorKind: "platform" as const,
      }, "Lifecycle platform reaction failed synchronously"));
      return;
    }
    suppressError(started.value, suppressedReason);
  }

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
      runPlatformReaction(
        () => removeReaction(state.channelId, state.platformMessageId, state.currentEmoji),
        "remove_previous",
        "lifecycle-reactor: platform may have already removed old reaction",
      );
    }

    // Update tracking immediately (before async platform call)
    const previousEmoji = state.currentEmoji;
    state.currentEmoji = emoji;

    const reactWithFallback = deps.reactWithFallback;
    if (channelType === "telegram" && reactWithFallback) {
      // Telegram: use fallback chain for REACTION_INVALID errors
      runPlatformReaction(
        () => reactWithFallback(adapter, state.channelId, state.platformMessageId, emoji),
        "apply_fallback",
        "lifecycle-reactor: telegram reaction fallback fire-and-forget",
      );
    } else if (channelType === "slack") {
      // Slack: convert Unicode emoji to Slack shortname
      const slackName = toSlackShortname(emoji);
      runPlatformReaction(
        () => reactToMessage(state.channelId, state.platformMessageId, slackName),
        "apply",
        "lifecycle-reactor: slack reaction fire-and-forget",
      );
    } else {
      // All other platforms: use emoji directly
      runPlatformReaction(
        () => reactToMessage(state.channelId, state.platformMessageId, emoji),
        "apply",
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
      systemClearTimeout(state.stallTimer);
      state.stallTimer = null;
    }
    if (state.holdTimer) {
      systemClearTimeout(state.holdTimer);
      state.holdTimer = null;
    }

    // Remove from maps
    messageStates.delete(messageKey);
    for (const sourceKey of state.sourceKeys) {
      if (messageKeyBySource.get(sourceKey) === messageKey) {
        messageKeyBySource.delete(sourceKey);
      }
    }
    for (const traceKey of state.traceKeys) {
      if (messageKeyByTrace.get(traceKey) === messageKey) {
        messageKeyByTrace.delete(traceKey);
      }
    }

    // Emit cleanup event
    emitReactionEvent("reaction:cleanup", {
      messageId: state.platformMessageId,
      channelType,
      channelId: state.channelId,
      chatId: state.channelId,
      removedEmoji: state.currentEmoji,
      timestamp: systemNowMs(),
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
        systemClearTimeout(state.stallTimer);
        state.stallTimer = null;
      }

      // Apply reaction immediately
      state.phase = newPhase;
      state.phaseEnteredAt = systemNowMs();
      applyReaction(state, newPhase);

      // Emit terminal event
      const emoji = getEmojiForPhase(newPhase, effectiveTier) ?? "";
      emitReactionEvent("reaction:terminal", {
        messageId: state.platformMessageId,
        channelType,
        channelId: state.channelId,
        chatId: state.channelId,
        phase: newPhase as "done" | "error",
        emoji,
        timestamp: systemNowMs(),
      });

      // Determine hold duration
      const holdMs = newPhase === "error"
        ? config.timing.holdErrorMs
        : config.timing.holdDoneMs;

      // Start hold timer: after hold, remove reaction and clean up
      state.holdTimer = systemSetTimeout(() => {
        // Remove the terminal emoji
        runPlatformReaction(
          () => removeReaction(state.channelId, state.platformMessageId, state.currentEmoji),
          "hold_cleanup",
          "lifecycle-reactor: hold timer cleanup fire-and-forget",
        );
        cleanupMessage(messageKey);
      }, holdMs);

      // Emit phase_changed
      emitReactionEvent("reaction:phase_changed", {
        messageId: state.platformMessageId,
        channelType,
        channelId: state.channelId,
        chatId: state.channelId,
        phase: newPhase,
        emoji,
        previousPhase,
        timestamp: systemNowMs(),
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
    state.phaseEnteredAt = systemNowMs();

    // Set debounce timeout
    const debounceTimer = systemSetTimeout(() => {
      if (controller.signal.aborted) return;
      applyReaction(state, newPhase);
    }, config.timing.debounceMs);

    // Wire abort to cancel the debounce timer
    controller.signal.addEventListener("abort", () => {
      systemClearTimeout(debounceTimer);
    }, { once: true });

    // Update stall detection
    if (state.stallTimer) {
      systemClearTimeout(state.stallTimer);
      state.stallTimer = null;
    }

    const thresholds = computeStallThresholds(newPhase, config.timing);

    // Set stall timer for soft threshold
    state.stallTimer = systemSetTimeout(() => {
      // Verify still in same phase (timer may be stale)
      if (state.phase !== newPhase) return;

      const stallMs = systemNowMs() - state.phaseEnteredAt;

      // Determine severity
      if (stallMs >= thresholds.hardMs) {
        // Hard stall
        transitionPhase(messageKey, "stall_hard");
        emitReactionEvent("reaction:stall_detected", {
          messageId: state.platformMessageId,
          channelType,
          channelId: state.channelId,
          chatId: state.channelId,
          phase: newPhase,
          severity: "hard",
          stallMs,
          timestamp: systemNowMs(),
        });
      } else {
        // Soft stall
        transitionPhase(messageKey, "stall_soft");
        emitReactionEvent("reaction:stall_detected", {
          messageId: state.platformMessageId,
          channelType,
          channelId: state.channelId,
          chatId: state.channelId,
          phase: newPhase,
          severity: "soft",
          stallMs,
          timestamp: systemNowMs(),
        });

        // Schedule hard stall check
        const remainingHardMs = thresholds.hardMs - stallMs;
        if (remainingHardMs > 0) {
          state.stallTimer = systemSetTimeout(() => {
            if (state.phase !== "stall_soft") return;
            const hardStallMs = systemNowMs() - state.phaseEnteredAt;
            transitionPhase(messageKey, "stall_hard");
            emitReactionEvent("reaction:stall_detected", {
              messageId: state.platformMessageId,
              channelType,
              channelId: state.channelId,
              chatId: state.channelId,
              phase: newPhase,
              severity: "hard",
              stallMs: hardStallMs,
              timestamp: systemNowMs(),
            });
          }, remainingHardMs);
        }
      }
    }, thresholds.softMs);

    // Emit phase_changed
    const emoji = getEmojiForPhase(newPhase, effectiveTier) ?? "";
    emitReactionEvent("reaction:phase_changed", {
      messageId: state.platformMessageId,
      channelType,
      channelId: state.channelId,
      chatId: state.channelId,
      phase: newPhase,
      emoji,
      previousPhase,
      timestamp: systemNowMs(),
    });
  }

  // ------------------------------------------------------------------
  // Event handlers
  // ------------------------------------------------------------------

  function onMessageReceived(event: EventMap["message:received"]): void {
    // Only process messages for this adapter's channel type
    if (event.message.channelType !== channelType) return;

    // Extract platform message ID from metadata
    const platformMessageId = event.message.metadata?.[replyToMetaKey];
    if (!platformMessageId) return; // Graceful degradation

    const messageId = String(platformMessageId);
    const channelId = event.message.channelId;
    const messageKey = JSON.stringify([channelType, channelId, messageId]);
    const contextualTraceId = tryGetContext()?.traceId;
    const metadataTraceId = event.message.metadata?.traceId;
    const traceId = typeof metadataTraceId === "string" && metadataTraceId.length > 0
      ? metadataTraceId
      : contextualTraceId;
    const sourceKey = JSON.stringify([
      channelType,
      channelId,
      event.message.id,
    ]);
    const traceKey = traceId === undefined
      ? undefined
      : JSON.stringify([channelType, traceId]);
    const sourceOwnerKey = messageKeyBySource.get(sourceKey);
    if (sourceOwnerKey !== undefined && sourceOwnerKey !== messageKey) {
      const sourceOwner = messageStates.get(sourceOwnerKey);
      if (sourceOwner !== undefined) {
        if (traceKey !== undefined) {
          sourceOwner.traceKeys.add(traceKey);
          messageKeyByTrace.set(traceKey, sourceOwnerKey);
        }
        logger.debug({
          channelType,
          chatId: channelId,
          messageId,
        }, "Repeated source identity retained its first platform lifecycle");
        return;
      }
      messageKeyBySource.delete(sourceKey);
    }
    const existingState = messageStates.get(messageKey);
    if (existingState !== undefined) {
      const isKnownSource = existingState.sourceKeys.has(sourceKey);
      if (!isTerminal(existingState.phase) || isKnownSource) {
        existingState.sourceKeys.add(sourceKey);
        messageKeyBySource.set(sourceKey, messageKey);
        if (traceKey !== undefined) {
          existingState.traceKeys.add(traceKey);
          messageKeyByTrace.set(traceKey, messageKey);
        }
        logger.debug({
          channelType,
          chatId: channelId,
          messageId,
        }, "Repeated platform message attached to existing lifecycle state");
        return;
      }

      // A new normalized source can legitimately reuse a platform message ID
      // after the prior lifecycle reached terminal. Cancel the old hold before
      // replacing the state so its timer cannot remove the new lifecycle.
      if (existingState.currentEmoji) {
        runPlatformReaction(
          () => removeReaction(
            existingState.channelId,
            existingState.platformMessageId,
            existingState.currentEmoji,
          ),
          "terminal_replacement",
          "lifecycle-reactor: terminal replacement removes prior reaction",
        );
      }
      cleanupMessage(messageKey);
      logger.debug({
        channelType,
        chatId: channelId,
        messageId,
      }, "Terminal lifecycle replaced for a new source message");
    }

    // Create reactor state
    const state: ReactorState = {
      phase: "idle",
      currentEmoji: "",
      debounceController: null,
      stallTimer: null,
      holdTimer: null,
      channelId,
      platformMessageId: messageId,
      sourceKeys: new Set([sourceKey]),
      traceKeys: new Set(traceKey === undefined ? [] : [traceKey]),
      phaseEnteredAt: systemNowMs(),
    };

    messageStates.set(messageKey, state);
    messageKeyBySource.set(sourceKey, messageKey);
    if (traceKey !== undefined) messageKeyByTrace.set(traceKey, messageKey);

    // Transition to "queued" phase
    transitionPhase(messageKey, "queued");
  }

  function onToolStarted(event: EventMap["tool:started"]): void {
    if (event.traceId === undefined) return;
    const messageKey = messageKeyByTrace.get(JSON.stringify([channelType, event.traceId]));
    if (!messageKey) return;
    const state = messageStates.get(messageKey);
    const eventChannelId = extractChannelId(event.sessionKey);
    if (state === undefined || (eventChannelId !== undefined && eventChannelId !== state.channelId)) return;

    const targetPhase = classifyToolPhase(event.toolName);
    transitionPhase(messageKey, targetPhase);
  }

  function onToolExecuted(event: EventMap["tool:executed"]): void {
    if (event.traceId === undefined) return;
    const messageKey = messageKeyByTrace.get(JSON.stringify([channelType, event.traceId]));
    if (!messageKey) return;
    const state = messageStates.get(messageKey);
    const eventChannelId = extractChannelId(event.sessionKey);
    if (state === undefined || (eventChannelId !== undefined && eventChannelId !== state.channelId)) return;

    // Tool completed -- transition back to thinking (LLM is generating again)
    transitionPhase(messageKey, "thinking");
  }

  function onQueueDequeued(event: EventMap["queue:dequeued"]): void {
    if (event.channelType !== channelType) return;
    const channelId = extractChannelId(event.sessionKey);
    if (!channelId) return;

    const traceId = tryGetContext()?.traceId;
    let messageKey = traceId === undefined
      ? undefined
      : messageKeyByTrace.get(JSON.stringify([channelType, traceId]));
    if (messageKey === undefined) {
      const candidates = [...messageStates.entries()].filter(([, state]) =>
        state.channelId === channelId && !isTerminal(state.phase));
      if (candidates.length === 1) messageKey = candidates[0]![0];
    }
    if (!messageKey) return;
    if (messageStates.get(messageKey)?.channelId !== channelId) return;

    transitionPhase(messageKey, "thinking");
  }

  function onMessageTerminal(event: EventMap["message:terminal"]): void {
    if (event.channelType !== channelType) return;
    const messageKey = messageKeyBySource.get(
      JSON.stringify([channelType, event.channelId, event.sourceMessageId]),
    );
    if (!messageKey) return;
    if (messageStates.get(messageKey)?.channelId !== event.channelId) return;

    switch (event.outcome) {
      case "success":
      case "filtered":
        transitionPhase(messageKey, "done");
        return;
      case "error":
      case "timeout":
      case "aborted":
        transitionPhase(messageKey, "error");
        return;
      default: {
        const _exhaustive: never = event.outcome;
        return _exhaustive;
      }
    }
  }

  // ------------------------------------------------------------------
  // Subscribe to events
  // ------------------------------------------------------------------

  eventBus.on("message:received", onMessageReceived);
  eventBus.on("tool:started", onToolStarted);
  eventBus.on("tool:executed", onToolExecuted);
  eventBus.on("queue:dequeued", onQueueDequeued);
  eventBus.on("message:terminal", onMessageTerminal);

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
          systemClearTimeout(state.stallTimer);
          state.stallTimer = null;
        }
        if (state.holdTimer) {
          systemClearTimeout(state.holdTimer);
          state.holdTimer = null;
        }
      }

      // Clear maps
      messageStates.clear();
      messageKeyBySource.clear();
      messageKeyByTrace.clear();

      // Unsubscribe from all events
      eventBus.off("message:received", onMessageReceived);
      eventBus.off("tool:started", onToolStarted);
      eventBus.off("tool:executed", onToolExecuted);
      eventBus.off("queue:dequeued", onQueueDequeued);
      eventBus.off("message:terminal", onMessageTerminal);
    },
  };
}
