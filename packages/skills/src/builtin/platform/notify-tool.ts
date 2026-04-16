/**
 * Notify User tool: proactive notification delivery.
 *
 * Allows agents to send notifications to users outside of the
 * normal request-response flow. Delegates to the daemon-side
 * notification.send RPC handler which applies rate limiting,
 * dedup, quiet hours, and channel resolution guards.
 *
 * @module
 */

import { Type } from "@sinclair/typebox";
import { createRpcDispatchTool } from "./messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

const NotifyToolParams = Type.Object({
  message: Type.String({
    description: "Notification text to send to the user.",
  }),
  priority: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("normal"),
      Type.Literal("high"),
      Type.Literal("critical"),
    ], {
      description:
        "Notification priority. 'critical' bypasses quiet hours. Default: 'normal'.",
    }),
  ),
  channel_type: Type.Optional(
    Type.String({
      description:
        "Target channel type (e.g., 'telegram', 'discord'). Omit for auto-resolution.",
    }),
  ),
  channel_id: Type.Optional(
    Type.String({
      description:
        "Target channel/chat ID. Required when channel_type is specified.",
    }),
  ),
});

/**
 * Create the notify_user tool for proactive notification delivery.
 *
 * Uses the createRpcDispatchTool factory to dispatch to the daemon-side
 * notification.send RPC handler. The RPC handler applies the full guard
 * pipeline (config, channel resolution, quiet hours, rate limiting, dedup)
 * before enqueuing the notification for delivery.
 *
 * @param rpcCall - RPC call function for delegating to the daemon
 * @returns AgentTool that dispatches to notification.send
 */
export function createNotifyTool(rpcCall: RpcCall) {
  return createRpcDispatchTool({
    name: "notify_user",
    label: "Notify User",
    description:
      "Send a proactive notification to the user. Use for alerts, reminders, " +
      "task completion notices, or any agent-initiated communication outside the " +
      "current conversation. Supports priority levels and automatic channel resolution.",
    parameters: NotifyToolParams,
    rpcMethod: "notification.send",
  }, rpcCall);
}
