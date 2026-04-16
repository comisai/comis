/**
 * Approval Notifier: Forwards approval:requested events to the user's chat channel.
 *
 * When an agent tool triggers an approval gate, the user currently only sees
 * the request in the web UI (via SSE). This module bridges the gap by
 * listening for approval:requested events and sending a notification message
 * to the originating chat channel.
 *
 * @module
 */

import type { TypedEventBus, ChannelPort, EventMap, DeliveryQueuePort } from "@comis/core";
import { parseFormattedSessionKey } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { deliverToChannel } from "./deliver-to-channel.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApprovalNotifierDeps {
  eventBus: TypedEventBus;
  /** Lookup adapter by channel type string (e.g., "telegram", "discord"). */
  getAdapter: (channelType: string) => ChannelPort | undefined;
  logger: ComisLogger;
  /** Delivery queue for crash-safe persistence. */
  deliveryQueue?: DeliveryQueuePort;
}

export interface ApprovalNotifier {
  /** Start listening for approval events. Call once after adapters are started. */
  start(): void;
  /** Stop listening (cleanup). */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an approval notifier that forwards approval:requested events
 * to the user's originating chat channel.
 */
export function createApprovalNotifier(deps: ApprovalNotifierDeps): ApprovalNotifier {
  let requestedHandler: ((event: EventMap["approval:requested"]) => void) | undefined;

  function start(): void {
    requestedHandler = (event) => {
      // Require channelType to know which adapter to use
      if (!event.channelType) {
        deps.logger.debug(
          { requestId: event.requestId, action: event.action },
          "No channelType on approval request, skipping channel notification",
        );
        return;
      }

      const adapter = deps.getAdapter(event.channelType);
      if (!adapter) {
        deps.logger.debug(
          { channelType: event.channelType, requestId: event.requestId },
          "No adapter found for approval notification channel type",
        );
        return;
      }

      // Parse sessionKey to extract channelId for message delivery
      const sessionKey = parseFormattedSessionKey(event.sessionKey);
      if (!sessionKey) {
        deps.logger.debug(
          { sessionKey: event.sessionKey, requestId: event.requestId },
          "Could not parse sessionKey for approval notification",
        );
        return;
      }

      const chatId = sessionKey.channelId;
      const requestIdShort = event.requestId.slice(0, 8);
      const timeoutSec = Math.round(event.timeoutMs / 1000);

      const text = [
        `Action requires approval: ${event.action}`,
        `Agent: ${event.agentId}`,
        `Tool: ${event.toolName}`,
        `Timeout: ${timeoutSec}s`,
        "",
        `Approve or deny via web console, or reply: /approve ${requestIdShort} or /deny ${requestIdShort}`,
      ].join("\n");

      // Fire-and-forget: don't block the event bus
      deliverToChannel(adapter, chatId, text, { skipChunking: true },
        deps.deliveryQueue ? { deliveryQueue: deps.deliveryQueue } : undefined,
      ).then((result) => {
        if (!result.ok || !result.value.ok) {
          deps.logger.warn(
            {
              err: result.ok ? undefined : result.error,
              channelType: event.channelType,
              chatId,
              hint: "Approval notification delivery failed; user may not see the pending request on their channel",
              errorKind: "platform" as const,
            },
            "Failed to send approval notification to channel",
          );
        }
      }).catch((err) => {
        deps.logger.warn(
          {
            err: err instanceof Error ? err : new Error(String(err)),
            channelType: event.channelType,
            chatId,
            hint: "Approval notification delivery failed; user may not see the pending request on their channel",
            errorKind: "platform" as const,
          },
          "Failed to send approval notification to channel",
        );
      });
    };

    deps.eventBus.on("approval:requested", requestedHandler);
  }

  function stop(): void {
    if (requestedHandler) {
      deps.eventBus.off("approval:requested", requestedHandler);
      requestedHandler = undefined;
    }
  }

  return { start, stop };
}
