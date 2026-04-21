// SPDX-License-Identifier: Apache-2.0
/**
 * Channel management RPC handler module.
 * Handles all channel management RPC methods:
 *   channels.list, channels.get, channels.enable,
 *   channels.disable, channels.restart
 * Extracted into its own module following the factory pattern from
 * memory-handlers.ts for independent testability.
 * @module
 */

import type { ChannelPort, DeliveryQueuePort, ChannelPluginPort } from "@comis/core";
import type { ChannelHealthMonitor } from "@comis/channels";
import { persistToConfig, type PersistToConfigDeps } from "./persist-to-config.js";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by channel management RPC handlers. */
export interface ChannelHandlerDeps {
  /** Live adapter registry mapping channel type to adapter instance. */
  adaptersByType: Map<string, ChannelPort>;
  /** Simplified channel config indicating which channels are configured. */
  channelConfig: Record<string, { enabled: boolean }>;
  /** Optional persistence deps for writing changes to config.yaml. When omitted, changes are memory-only. */
  persistDeps?: PersistToConfigDeps;
  /** Optional channel health monitor for health RPC and dynamic registration */
  healthMonitor?: ChannelHealthMonitor;
  /** Optional delivery queue for per-status count queries */
  deliveryQueue?: DeliveryQueuePort;
  /** Optional channel plugins map for capabilities queries */
  channelPlugins?: Map<string, ChannelPluginPort>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of channel management RPC handlers bound to the given deps.
 */
export function createChannelHandlers(deps: ChannelHandlerDeps): Record<string, RpcHandler> {
  return {
    // Channel health summary (read-only observability -- no admin required)
    "channels.health": async () => {
      if (!deps.healthMonitor) {
        return { channels: [], timestamp: Date.now(), enabled: false };
      }
      const summary = deps.healthMonitor.getHealthSummary();
      const channels = Array.from(summary.entries()).map(([channelType, entry]) => ({
        channelType,
        state: entry.state,
        connectionMode: entry.connectionMode,
        lastCheckedAt: entry.lastCheckedAt,
        lastMessageAt: entry.lastMessageAt,
        error: entry.error,
        stateChangedAt: entry.stateChangedAt,
        consecutiveFailures: entry.consecutiveFailures,
        activeRuns: entry.activeRuns,
        restartAttempts: entry.restartAttempts,
        uptimeMs: Date.now() - entry.adapterStartedAt,
      }));
      return { channels, timestamp: Date.now(), enabled: true };
    },

    // Delivery queue per-status counts
    "delivery.queue.status": async (params) => {
      if (!deps.deliveryQueue) {
        return { pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 };
      }
      const channelType = params.channel_type as string | undefined;
      const result = await deps.deliveryQueue.statusCounts(channelType);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },

    // Platform capabilities features
    "channels.capabilities": async (params) => {
      const channelType = params.channel_type as string;
      if (!channelType) throw new Error("Missing required parameter: channel_type");
      const plugin = deps.channelPlugins?.get(channelType);
      if (!plugin) throw new Error(`Channel type not found: ${channelType}`);
      return { channelType, features: plugin.capabilities.features };
    },

    // List all channel adapters with status
    "channels.list": async () => {
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

      return { channels, total: channels.length };
    },

    // Get detailed info for a single channel adapter
    "channels.get": async (params) => {
      const channelType = params.channel_type as string;
      if (!channelType) {
        throw new Error("Missing required parameter: channel_type");
      }

      const adapter = deps.adaptersByType.get(channelType);
      if (adapter) {
        return {
          channelType,
          channelId: adapter.channelId,
          status: "running" as const,
        };
      }

      const cfg = deps.channelConfig[channelType];
      if (cfg) {
        return {
          channelType,
          status: "stopped" as const,
          configured: true,
        };
      }

      throw new Error("Channel type not found");
    },

    // Enable (start) a channel adapter
    "channels.enable": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for channel management");
      }

      const channelType = params.channel_type as string;
      if (!channelType) {
        throw new Error("Missing required parameter: channel_type");
      }

      const adapter = deps.adaptersByType.get(channelType);
      if (!adapter) {
        throw new Error("Channel type not found or not configured");
      }

      const result = await adapter.start();
      if (!result.ok) {
        throw new Error(result.error.message);
      }

      // Notify health monitor of newly enabled adapter
      deps.healthMonitor?.addAdapter(channelType, adapter);

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = params._context as { userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { channels: { [channelType]: { enabled: true } } },
          actionType: "channels.enable",
          entityId: channelType,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "channels.enable", channelType, err: persistResult.error, hint: "Channel enabled in memory but config persistence failed", errorKind: "config" as const },
            "Channel config persistence failed",
          );
        }
      }

      return {
        channelType,
        status: "running",
        message: "Channel adapter started",
      };
    },

    // Disable (stop) a channel adapter
    "channels.disable": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for channel management");
      }

      const channelType = params.channel_type as string;
      if (!channelType) {
        throw new Error("Missing required parameter: channel_type");
      }

      const adapter = deps.adaptersByType.get(channelType);
      if (!adapter) {
        throw new Error("Channel type not found or not configured");
      }

      const result = await adapter.stop();
      if (!result.ok) {
        throw new Error(result.error.message);
      }

      // Notify health monitor of disabled adapter
      deps.healthMonitor?.removeAdapter(channelType);

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = params._context as { userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { channels: { [channelType]: { enabled: false } } },
          actionType: "channels.disable",
          entityId: channelType,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "channels.disable", channelType, err: persistResult.error, hint: "Channel disabled in memory but config persistence failed", errorKind: "config" as const },
            "Channel config persistence failed",
          );
        }
      }

      return {
        channelType,
        status: "stopped",
        message: "Channel adapter stopped",
      };
    },

    // Restart a channel adapter (stop then start)
    "channels.restart": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for channel management");
      }

      const channelType = params.channel_type as string;
      if (!channelType) {
        throw new Error("Missing required parameter: channel_type");
      }

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

      return {
        channelType,
        status: "running",
        message: "Channel adapter restarted",
      };
    },
  };
}
