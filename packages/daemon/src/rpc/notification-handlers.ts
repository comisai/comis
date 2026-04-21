// SPDX-License-Identifier: Apache-2.0
/**
 * Notification RPC handler module.
 * Provides the notification.send handler that bridges the agent tool
 * to the notification service. Extracts _agentId from RPC params
 * (injected by per-agent rpcCall in setup-tools.ts) and maps
 * tool param names to NotifyUserOptions.
 * Includes chain-depth guard: rejects calls where
 * origin === "notification" to prevent recursive notification chains.
 * This is the enforcement side -- origin metadata is set on
 * enqueued entries, and this handler prevents re-entry.
 * Tool and programmatic notification dispatch.
 * @module
 */

import type { NotificationService } from "../notification/notification-service.js";
import type { RpcHandler } from "./types.js";

/** Dependencies required by notification RPC handlers. */
export interface NotificationHandlerDeps {
  notificationService: NotificationService;
}

/**
 * Create notification RPC handlers.
 * @param deps - Notification service dependency
 * @returns Record mapping "notification.send" to its handler function
 */
export function createNotificationHandlers(
  deps: NotificationHandlerDeps,
): Record<string, RpcHandler> {
  return {
    "notification.send": async (params) => {
      const agentId = (params._agentId as string) ?? "default";
      const message = params.message as string;

      // Validate required parameter -- return structured error, not exception
      if (!message) {
        return { success: false, error: "Missing required parameter: message" };
      }

      // Chain-depth guard -- block notification-originated calls
      // from spawning further notifications (prevents infinite loops).
      // The origin is set to "notification" by the notification service
      // on enqueued delivery entries. If an agent execution
      // triggered by a notification delivery attempts to call notify_user,
      // the origin propagates here and we reject it.
      const callerOrigin = params.origin as string | undefined;
      if (callerOrigin === "notification") {
        return {
          success: false,
          error: "Chain-depth guard: cannot send notification from notification-originated context",
        };
      }

      const result = await deps.notificationService.notifyUser({
        agentId,
        message,
        priority: (params.priority as "low" | "normal" | "high" | "critical") ?? "normal",
        channelType: params.channel_type as string | undefined,
        channelId: params.channel_id as string | undefined,
        origin: (params.origin as string) ?? "tool",
      });

      if (!result.ok) {
        return { success: false, error: result.error.message };
      }
      return { success: true, entryId: result.value };
    },
  };
}
