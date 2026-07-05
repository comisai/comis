// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Channel management RPC handler module.
 * Handles all channel management RPC methods:
 *   channels.list, channels.get, channels.enable,
 *   channels.disable, channels.restart, channels.health,
 *   channels.capabilities, delivery.queue.status
 * Extracted into its own module following the factory pattern from
 * memory-handlers.ts for independent testability.
 *
 * Handlers use computed-property keys (`[<Contract>.method]:`) so the
 * bidirectional 1:1 architecture test resolves them to the registry.
 * Per-method pipeline: bespoke pre-Zod guards FIRST (using rawParams
 * reads — preserves user-friendly error messages matching the existing
 * handler-test assertions) → stripInternalFields → request.parse →
 * existing business logic UNCHANGED → dev-mode response.parse.
 *
 * @module
 */

import { AuthorizationError } from "./errors.js";
import {
  ChannelsHealthContract,
  DeliveryQueueStatusContract,
  ChannelsCapabilitiesContract,
  ChannelsListContract,
  ChannelsGetContract,
  ChannelsEnableContract,
  ChannelsDisableContract,
  ChannelsRestartContract,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";

import { persistToConfig } from "./shared/persist-to-config.js";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Aliased from the cluster slice in api/types.ts. Single source of truth:
// ChannelsApiDeps (shared with message-handlers).
import type { ChannelsApiDeps as ChannelHandlerDeps } from "./types.js";
export type { ChannelHandlerDeps };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of channel management RPC handlers bound to the given deps.
 */
export function createChannelHandlers(deps: ChannelHandlerDeps): Record<string, RpcHandler> {
  return {
    // Channel health summary (read-only observability -- no admin required)
    [ChannelsHealthContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      ChannelsHealthContract.request.parse(userParams);

      if (!deps.healthMonitor) {
        const result = { channels: [], timestamp: systemNowMs(), enabled: false };
        if (IS_DEV) ChannelsHealthContract.response.parse(result);
        return result;
      }
      const summary = deps.healthMonitor.getHealthSummary();
      const channels = Array.from(summary.entries()).map(([channelType, entry]) => ({
        channelType,
        state: entry.state,
        connectionMode: entry.connectionMode,
        lastCheckedAt: entry.lastCheckedAt,
        lastMessageAt: entry.lastMessageAt,
        lastInboundAt: entry.lastInboundAt,
        error: entry.error,
        stateChangedAt: entry.stateChangedAt,
        consecutiveFailures: entry.consecutiveFailures,
        activeRuns: entry.activeRuns,
        restartAttempts: entry.restartAttempts,
        uptimeMs: systemNowMs() - entry.adapterStartedAt,
        // E2EE verification posture for e2ee-capable channels; absent otherwise.
        verification: entry.verification,
      }));
      const result = { channels, timestamp: systemNowMs(), enabled: true };
      if (IS_DEV) ChannelsHealthContract.response.parse(result);
      return result;
    },

    // Delivery queue per-status counts
    [DeliveryQueueStatusContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = DeliveryQueueStatusContract.request.parse(userParams);

      if (!deps.deliveryQueue) {
        const result = { pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 };
        if (IS_DEV) DeliveryQueueStatusContract.response.parse(result);
        return result;
      }
      const queueResult = await deps.deliveryQueue.statusCounts(params.channel_type);
      if (!queueResult.ok) throw new Error(queueResult.error.message);
      if (IS_DEV) DeliveryQueueStatusContract.response.parse(queueResult.value);
      return queueResult.value;
    },

    // Platform capabilities features
    [ChannelsCapabilitiesContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST (preserves user-friendly error
      // messages matching existing handler-test assertions).
      const channelType = rawParams.channel_type as string | undefined;
      if (!channelType) throw new Error("Missing required parameter: channel_type");

      const userParams = stripInternalFields(rawParams);
      ChannelsCapabilitiesContract.request.parse(userParams);

      const plugin = deps.channelPlugins.get(channelType);
      if (!plugin) throw new Error(`Channel type not found: ${channelType}`);
      const result = { channelType, features: plugin.capabilities.features };
      if (IS_DEV) ChannelsCapabilitiesContract.response.parse(result);
      return result;
    },

    // List all channel adapters with status
    [ChannelsListContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      ChannelsListContract.request.parse(userParams);

      const channels: Array<{
        channelType: string;
        channelId?: string;
        status: "running" | "stopped";
      }> = [];

      // Running adapters
      for (const [channelType, adapter] of deps.adaptersByType) {
        channels.push({
          channelType,
          channelId: adapter.channelId,
          status: "running",
        });
      }

      // Configured-but-not-running channels
      for (const [channelType, cfg] of Object.entries(deps.channelConfig)) {
        if (cfg.enabled && !deps.adaptersByType.has(channelType)) {
          channels.push({
            channelType,
            status: "stopped",
          });
        }
      }

      const result = { channels, total: channels.length };
      if (IS_DEV) ChannelsListContract.response.parse(result);
      return result;
    },

    // Get detailed info for a single channel adapter
    [ChannelsGetContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      const channelType = rawParams.channel_type as string | undefined;
      if (!channelType) {
        throw new Error("Missing required parameter: channel_type");
      }

      const userParams = stripInternalFields(rawParams);
      ChannelsGetContract.request.parse(userParams);

      const adapter = deps.adaptersByType.get(channelType);
      if (adapter) {
        const result = {
          channelType,
          channelId: adapter.channelId,
          status: "running" as const,
        };
        if (IS_DEV) ChannelsGetContract.response.parse(result);
        return result;
      }

      const cfg = deps.channelConfig[channelType];
      if (cfg) {
        const result = {
          channelType,
          status: "stopped" as const,
          configured: true,
        };
        if (IS_DEV) ChannelsGetContract.response.parse(result);
        return result;
      }

      throw new Error("Channel type not found");
    },

    // Enable (start) a channel adapter
    [ChannelsEnableContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST (admin trust + param presence).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for channel management");
      }

      const channelType = rawParams.channel_type as string | undefined;
      if (!channelType) {
        throw new Error("Missing required parameter: channel_type");
      }

      const userParams = stripInternalFields(rawParams);
      ChannelsEnableContract.request.parse(userParams);

      const adapter = deps.adaptersByType.get(channelType);
      if (!adapter) {
        throw new Error("Channel type not found or not configured");
      }

      const startResult = await adapter.start();
      if (!startResult.ok) {
        throw new Error(startResult.error.message);
      }

      // Notify health monitor of newly enabled adapter
      deps.healthMonitor?.addAdapter(channelType, adapter);

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = rawParams._context as { userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { channels: { [channelType]: { enabled: true } } },
          actionType: "channels.enable",
          entityId: channelType,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "channels.enable", channelType, err: persistResult.error, hint: "Channel enabled in memory but config persistence failed", errorKind: "config" as const },
            "Channel config persistence failed",
          );
        }
      }

      const result = {
        channelType,
        status: "running" as const,
        message: "Channel adapter started",
      };
      if (IS_DEV) ChannelsEnableContract.response.parse(result);
      return result;
    },

    // Disable (stop) a channel adapter
    [ChannelsDisableContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for channel management");
      }

      const channelType = rawParams.channel_type as string | undefined;
      if (!channelType) {
        throw new Error("Missing required parameter: channel_type");
      }

      const userParams = stripInternalFields(rawParams);
      ChannelsDisableContract.request.parse(userParams);

      const adapter = deps.adaptersByType.get(channelType);
      if (!adapter) {
        throw new Error("Channel type not found or not configured");
      }

      const stopResult = await adapter.stop();
      if (!stopResult.ok) {
        throw new Error(stopResult.error.message);
      }

      // Notify health monitor of disabled adapter
      deps.healthMonitor?.removeAdapter(channelType);

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = rawParams._context as { userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { channels: { [channelType]: { enabled: false } } },
          actionType: "channels.disable",
          entityId: channelType,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "channels.disable", channelType, err: persistResult.error, hint: "Channel disabled in memory but config persistence failed", errorKind: "config" as const },
            "Channel config persistence failed",
          );
        }
      }

      const result = {
        channelType,
        status: "stopped" as const,
        message: "Channel adapter stopped",
      };
      if (IS_DEV) ChannelsDisableContract.response.parse(result);
      return result;
    },

    // Restart a channel adapter (stop then start)
    [ChannelsRestartContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for channel management");
      }

      const channelType = rawParams.channel_type as string | undefined;
      if (!channelType) {
        throw new Error("Missing required parameter: channel_type");
      }

      const userParams = stripInternalFields(rawParams);
      ChannelsRestartContract.request.parse(userParams);

      const adapter = deps.adaptersByType.get(channelType);
      if (!adapter) {
        throw new Error("Channel type not found or not configured");
      }

      const stopResult = await adapter.stop();
      if (!stopResult.ok) {
        throw new Error(stopResult.error.message);
      }

      const startResult = await adapter.start();
      if (!startResult.ok) {
        throw new Error(startResult.error.message);
      }

      const result = {
        channelType,
        status: "running" as const,
        message: "Channel adapter restarted",
      };
      if (IS_DEV) ChannelsRestartContract.response.parse(result);
      return result;
    },
  };
}
