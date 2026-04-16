/**
 * Delivery bridge: Routes heartbeat notifications to chat channels with
 * gating pipeline (adapter resolution, DM policy, readiness, visibility,
 * dedup) and structured event emission.
 *
 */

import type { ChannelPort, TypedEventBus } from "@comis/core";
import type { HeartbeatNotification } from "./heartbeat-runner.js";
import type { DuplicateDetector } from "./duplicate-detector.js";
import type { SchedulerLogger } from "../shared-types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Target channel for heartbeat notification delivery. */
export interface DeliveryTarget {
  channelType: string;
  channelId: string;
  chatId: string;
}

/** Per-channel visibility configuration for heartbeat notifications. */
export interface ChannelVisibilityConfig {
  showOk?: boolean;
  showAlerts?: boolean;
  useIndicator?: boolean;
}

/** Dependencies injected into the delivery bridge function. */
export interface DeliveryBridgeDeps {
  adaptersByType: ReadonlyMap<string, ChannelPort>;
  duplicateDetector: DuplicateDetector;
  eventBus: TypedEventBus;
  logger: SchedulerLogger;
}

/** Discriminated union result of a delivery attempt. */
export type DeliveryOutcome =
  | { status: "delivered"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/** Options controlling delivery behavior. */
export interface DeliveryOptions {
  agentId?: string;
  visibility?: ChannelVisibilityConfig;
  allowDm?: boolean;
  isDm?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Deliver a heartbeat notification to a specific channel, applying the
 * full gating pipeline. Cheapest checks run first to minimize wasted work.
 *
 * Pipeline order:
 * 1. Adapter resolution (no-adapter)
 * 2. DM policy (dm-blocked)
 * 3. Channel readiness (channel-not-ready)
 * 4. Visibility filter (visibility-filtered)
 * 5. Duplicate detection (duplicate)
 * 6. Send message
 * 7. Emit event + log
 */
export async function deliverHeartbeatNotification(
  deps: DeliveryBridgeDeps,
  target: DeliveryTarget,
  notification: HeartbeatNotification,
  options?: DeliveryOptions,
): Promise<DeliveryOutcome> {
  const { adaptersByType, duplicateDetector, eventBus, logger } = deps;
  const agentId = options?.agentId ?? "unknown";
  const startMs = Date.now();

  // Helper to emit event and return outcome
  function emitAndReturn(outcome: DeliveryOutcome): DeliveryOutcome {
    const durationMs = Date.now() - startMs;
    eventBus.emit("scheduler:heartbeat_delivered", {
      agentId,
      channelType: target.channelType,
      channelId: target.channelId,
      chatId: target.chatId,
      level: notification.level,
      outcome: outcome.status,
      reason: outcome.status === "skipped" ? outcome.reason : outcome.status === "failed" ? outcome.error : undefined,
      durationMs,
      timestamp: Date.now(),
    });
    return outcome;
  }

  // Resolve adapter
  const adapter = adaptersByType.get(target.channelType);
  if (!adapter) {
    logger.warn(
      {
        agentId,
        channelType: target.channelType,
        hint: `No adapter registered for channel type '${target.channelType}'; check channel configuration`,
        errorKind: "config" as const,
      },
      "Heartbeat delivery skipped: no adapter",
    );
    return emitAndReturn({ status: "skipped", reason: "no-adapter" });
  }

  // DM policy gate
  if (options?.isDm === true && options?.allowDm === false) {
    logger.debug(
      { agentId, channelType: target.channelType, chatId: target.chatId },
      "Heartbeat delivery skipped: DM blocked by policy",
    );
    return emitAndReturn({ status: "skipped", reason: "dm-blocked" });
  }

  // Channel readiness gate
  if (typeof adapter.getStatus === "function") {
    const status = adapter.getStatus();
    if (!status.connected) {
      logger.debug(
        { agentId, channelType: target.channelType, channelId: target.channelId },
        "Heartbeat delivery skipped: channel not ready",
      );
      return emitAndReturn({ status: "skipped", reason: "channel-not-ready" });
    }
  }

  // Visibility filter
  const visibility = options?.visibility;
  if (visibility) {
    if (notification.level === "ok" && visibility.showOk === false) {
      logger.debug(
        { agentId, level: notification.level },
        "Heartbeat delivery skipped: visibility filtered",
      );
      return emitAndReturn({ status: "skipped", reason: "visibility-filtered" });
    }
    if (notification.level === "alert" && visibility.showAlerts === false) {
      logger.debug(
        { agentId, level: notification.level },
        "Heartbeat delivery skipped: visibility filtered",
      );
      return emitAndReturn({ status: "skipped", reason: "visibility-filtered" });
    }
  }

  // Duplicate suppression
  const dedupKey = `${agentId}:${target.channelType}:${target.chatId}`;
  if (duplicateDetector.isDuplicate(dedupKey, notification.text)) {
    logger.debug(
      { agentId, channelType: target.channelType, chatId: target.chatId },
      "Heartbeat delivery skipped: duplicate suppressed",
    );
    return emitAndReturn({ status: "skipped", reason: "duplicate" });
  }

  // Send via adapter
  const sendResult = await adapter.sendMessage(target.chatId, notification.text);

  if (!sendResult.ok) {
    const errorMsg = sendResult.error instanceof Error ? sendResult.error.message : String(sendResult.error);
    logger.warn(
      {
        agentId,
        channelType: target.channelType,
        chatId: target.chatId,
        err: errorMsg,
        hint: "Check channel adapter connectivity and permissions",
        errorKind: "network" as const,
      },
      "Heartbeat delivery failed",
    );
    return emitAndReturn({ status: "failed", error: errorMsg });
  }

  // Success log
  const messageId = sendResult.value;
  logger.info(
    {
      agentId,
      channelType: target.channelType,
      chatId: target.chatId,
      level: notification.level,
      durationMs: Date.now() - startMs,
    },
    "Heartbeat notification delivered",
  );

  return emitAndReturn({ status: "delivered", messageId });
}
