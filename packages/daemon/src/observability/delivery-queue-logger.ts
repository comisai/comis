// SPDX-License-Identifier: Apache-2.0
/**
 * Delivery queue observability: structured logging subscriber for queue
 * lifecycle events.
 * Subscribes to all 7 delivery queue events (delivery:enqueued, delivery:acked,
 * delivery:nacked, delivery:failed, delivery:queue_drained, delivery:hook_cancelled,
 * delivery:aborted) and logs with
 * canonical fields per the project logging rules.
 * Logging levels follow the boundary-event convention:
 * - INFO for boundary events: enqueue (message enters queue), ack (delivery
 *   confirmed), queue_drained (startup drain complete).
 * - WARN for degraded states: nack (transient failure, will retry) and fail
 *   (permanent failure). WARN events include hint and errorKind as required.
 * @module
 */

import type { TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

/**
 * Subscribe to delivery queue events and log with canonical fields.
 * @param deps.eventBus - TypedEventBus to subscribe to
 * @param deps.logger - Pino logger instance (rebound to delivery-queue via child logger)
 */
export function setupDeliveryQueueLogging(deps: {
  eventBus: TypedEventBus;
  logger: ComisLogger;
}): void {
  const { eventBus, logger } = deps;
  const MODULE = "delivery-queue";
  const log = logger.child({ module: MODULE });

  // 1. Enqueue: message enters queue (boundary event -> INFO)
  eventBus.on("delivery:enqueued", (data) => {
    log.info(
      {
        entryId: data.entryId,
        channelType: data.channelType,
        channelId: data.channelId,
        origin: data.origin,
      },
      "Message enqueued for delivery",
    );
  });

  // 2. Ack: delivery confirmed (boundary event -> INFO)
  eventBus.on("delivery:acked", (data) => {
    log.info(
      {
        entryId: data.entryId,
        channelType: data.channelType,
        channelId: data.channelId,
        messageId: data.messageId,
        durationMs: data.durationMs,
      },
      "Message delivered and acked",
    );
  });

  // 3. Nack: transient failure, scheduled for retry (degraded -> WARN)
  eventBus.on("delivery:nacked", (data) => {
    log.warn(
      {
        entryId: data.entryId,
        channelType: data.channelType,
        channelId: data.channelId,
        err: data.error,
        attemptCount: data.attemptCount,
        nextRetryAt: data.nextRetryAt,
        hint: "Message will be retried on next drain cycle",
        errorKind: "transient" as const,
      },
      "Message delivery failed, scheduled for retry",
    );
  });

  // 4. Fail: permanent failure, no more retries (degraded -> WARN)
  eventBus.on("delivery:failed", (data) => {
    log.warn(
      {
        entryId: data.entryId,
        channelType: data.channelType,
        channelId: data.channelId,
        err: data.error,
        reason: data.reason,
        hint: "Message permanently failed -- check channel configuration or error patterns",
        errorKind: "permanent" as const,
      },
      "Message delivery permanently failed",
    );
  });

  // 5. Queue drained: startup drain complete (boundary event -> INFO)
  eventBus.on("delivery:queue_drained", (data) => {
    log.info(
      {
        entriesAttempted: data.entriesAttempted,
        entriesDelivered: data.entriesDelivered,
        entriesFailed: data.entriesFailed,
        durationMs: data.durationMs,
      },
      "Delivery queue startup drain complete",
    );
  });

  // 6. Hook cancelled: before_delivery hook cancelled delivery
  eventBus.on("delivery:hook_cancelled", (event) => {
    log.info(
      {
        channelId: event.channelId,
        channelType: event.channelType,
        reason: event.reason,
        origin: event.origin,
      },
      "Delivery cancelled by before_delivery hook",
    );
  });

  // 7. Aborted: delivery cancelled via abort signal
  eventBus.on("delivery:aborted", (data) => {
    log.info(
      {
        channelId: data.channelId,
        channelType: data.channelType,
        reason: data.reason,
        chunksDelivered: data.chunksDelivered,
        totalChunks: data.totalChunks,
        durationMs: data.durationMs,
        origin: data.origin,
      },
      "Delivery aborted",
    );
  });
}
