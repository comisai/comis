// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
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
 *
 * Uses the `@comis/core` contract registry. Method key is a computed-property
 * name (`[NotificationSendContract.method]:`) so the bidirectional 1:1
 * architecture test resolves it through `defineContract({ method, ... })`
 * declarations in `packages/core/src/api-contracts/workspace.ts` (the
 * workspace umbrella file groups all 5 handlers that share the
 * `WorkspaceApiDeps` slice). The dispatcher-injected `_X` internal fields
 * are stripped via `stripInternalFields` BEFORE `contract.request.parse(...)`.
 * The `_agentId` fallback is resolved from RAW params BEFORE the strip
 * step (handler identity flows from internals, not user params).
 *
 * The structured-error returns (not exception throws) for missing
 * `message` + chain-depth-guard rejection are preserved verbatim —
 * the existing notification-handlers.test.ts assertions verify the
 * `{ success: false, error: "..." }` shape.
 * @module
 */

import {
  NotificationSendContract,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";

import type { RpcHandler } from "./types.js";

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: WorkspaceApiDeps (shared with workspace, browser,
// approval, mcp, skill handlers). The dispatcher constructs this handler only
// inside the `deps.notificationService ? ...` truthy branch, so the alias
// narrows `notificationService` to required (matching the handler body's
// direct `deps.notificationService.x` access).
import type { WorkspaceApiDeps } from "./types.js";
export type NotificationHandlerDeps = WorkspaceApiDeps & {
  notificationService: import("../notification/notification-service.js").NotificationService;
};

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

/**
 * Create notification RPC handlers.
 * @param deps - Notification service dependency
 * @returns Record mapping "notification.send" to its handler function
 */
export function createNotificationHandlers(
  deps: NotificationHandlerDeps,
): Record<string, RpcHandler> {
  return {
    [NotificationSendContract.method]: async (rawParams) => {
      // Resolve agent identity from RAW params BEFORE stripping internals.
      const agentId = (rawParams._agentId as string) ?? "default";

      const userParams = stripInternalFields(rawParams);
      const params = NotificationSendContract.request.parse(userParams);

      // Validate required parameter -- return structured error, not exception
      if (!params.message) {
        const result = { success: false, error: "Missing required parameter: message" };
        if (IS_DEV) NotificationSendContract.response.parse(result);
        return result;
      }

      // Chain-depth guard -- block notification-originated calls
      // from spawning further notifications (prevents infinite loops).
      // The origin is set to "notification" by the notification service
      // on enqueued delivery entries. If an agent execution
      // triggered by a notification delivery attempts to call notify_user,
      // the origin propagates here and we reject it.
      if (params.origin === "notification") {
        const result = {
          success: false,
          error: "Chain-depth guard: cannot send notification from notification-originated context",
        };
        if (IS_DEV) NotificationSendContract.response.parse(result);
        return result;
      }

      // Internal boundary: mint the delivery authority + destination endpoint the
      // notifyUser guard requires, from this agent's tenant + the requested (or
      // resolved) channel. notifyUser re-runs the same resolution and cross-checks
      // the minted endpoint against it, so a mismatch is still rejected there.
      const destination = deps.notificationService.resolveDestination({
        agentId,
        channelType: params.channel_type,
        channelId: params.channel_id,
      });
      if (!destination.ok) {
        const result = { success: false, error: destination.error.message };
        if (IS_DEV) NotificationSendContract.response.parse(result);
        return result;
      }

      const sendResult = await deps.notificationService.notifyUser({
        agentId,
        message: params.message,
        priority: params.priority ?? "normal",
        channelType: params.channel_type,
        channelId: params.channel_id,
        origin: params.origin ?? "tool",
        authority: destination.value.authority,
        destinationEndpoint: destination.value.destinationEndpoint,
      });

      if (!sendResult.ok) {
        const result = { success: false, error: sendResult.error.message };
        if (IS_DEV) NotificationSendContract.response.parse(result);
        return result;
      }

      const result = { success: true, entryId: sendResult.value };
      if (IS_DEV) NotificationSendContract.response.parse(result);
      return result;
    },
  };
}
