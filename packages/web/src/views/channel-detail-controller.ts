// SPDX-License-Identifier: Apache-2.0
/**
 * Channel-detail controller.
 *
 * Thin RPC façade — the channel-detail view retains @state for its
 * tabbed config dashboard (config + media-processing + delivery trace +
 * queue + capabilities + activity sparkline) because the existing
 * DOM-coupled flow (tab switching, optimistic media-toggle updates with
 * rollback, debounce on reload, SSE event subscriptions) keeps state on
 * the view. The controller's job is to keep `rpcClient.call(...)` out
 * of `channel-detail.ts` so the boundary test passes.
 * Each method mirrors a source view RPC invocation 1:1 (same method
 * name, same args, same response shape). Errors propagate verbatim
 * (callers handle).
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import type {
  DeliveryQueueStatus,
  PlatformCapabilities,
} from "../api/types/index.js";

/* ------------------------------------------------------------------ */
/*  RPC response shapes                                                 */
/* ------------------------------------------------------------------ */

export interface DeliveryTraceEntry {
  messageId?: string;
  latencyMs: number;
  timestamp?: number;
  deliveredAt?: number;
  status?: string;
  success?: boolean;
}

export interface ChannelObsRecord {
  channelId: string;
  channelType: string;
  lastActiveAt: number;
  messagesSent: number;
  messagesReceived: number;
}

export type ChannelsGetResult = Record<string, unknown>;
export type ChannelsConfigResult = Record<string, Record<string, unknown>>;

export interface DeliveryRecentResult {
  entries?: DeliveryTraceEntry[];
  // some daemon versions return `deliveries: [...]` instead of `entries`
  deliveries?: DeliveryTraceEntry[];
}

export interface ChannelObsGetResult {
  channel: ChannelObsRecord | null;
}

export interface ChannelCapabilitiesResult {
  channelType: string;
  features: PlatformCapabilities;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface ChannelDetailController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Read this channel's daemon-side config (channels.get). */
  getChannel(channelType: string): Promise<ChannelsGetResult>;
  /** Read the full channels config section (config.read[section=channels]). */
  readChannelsConfig(): Promise<ChannelsConfigResult>;
  /** Recent delivery traces for one channel (obs.delivery.recent). */
  getRecentDelivery(
    channelType: string,
    limit: number,
  ): Promise<DeliveryRecentResult>;
  /**
   * Channel-level observability stats (obs.channels.get).
   *
   * @param channelTypeOrId — daemon's obs.channels.get accepts either a
   *   channelType (e.g. "telegram" — for adapter-level overview) or a
   *   channel.channelId (for instance-level stats). The channel-detail
   *   view currently passes `this.channelType` for the overview case;
   *   the parameter is named flexibly to reflect this dual contract.
   */
  getChannelObs(channelTypeOrId: string): Promise<ChannelObsGetResult>;
  /** Current delivery-queue status (delivery.queue.status). */
  getDeliveryQueueStatus(channelType: string): Promise<DeliveryQueueStatus>;
  /** Platform capabilities for one channel (channels.capabilities). */
  getChannelCapabilities(
    channelType: string,
  ): Promise<ChannelCapabilitiesResult>;
  /** Restart one channel (channels.restart). */
  restartChannel(channelType: string): Promise<void>;
  /** Disable one channel (channels.disable). */
  disableChannel(channelType: string): Promise<void>;
  /** Enable one channel (channels.enable). */
  enableChannel(channelType: string): Promise<void>;
  /** Patch a config key (config.patch). */
  patchConfig(
    section: string,
    key: string,
    value: unknown,
  ): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createChannelDetailController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): ChannelDetailController {
  const controller: ChannelDetailController = {
    hostConnected(): void {
      /* no-op; the view drives loading + SSE via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own listeners */
    },

    getChannel(channelType: string): Promise<ChannelsGetResult> {
      return rpcClient.call<ChannelsGetResult>("channels.get", {
        channel_type: channelType,
      });
    },

    readChannelsConfig(): Promise<ChannelsConfigResult> {
      return rpcClient.call<ChannelsConfigResult>("config.read", {
        section: "channels",
      });
    },

    getRecentDelivery(
      channelType: string,
      limit: number,
    ): Promise<DeliveryRecentResult> {
      return rpcClient.call<DeliveryRecentResult>("obs.delivery.recent", {
        type: channelType,
        limit,
      });
    },

    getChannelObs(channelTypeOrId: string): Promise<ChannelObsGetResult> {
      // The daemon's obs.channels.get accepts the param under the
      // `channelId` key for both adapter-level (channelType) and
      // instance-level (channelId) lookups — the field name on the wire
      // does NOT change. Only the controller parameter name is renamed
      // here for caller clarity.
      return rpcClient.call<ChannelObsGetResult>("obs.channels.get", {
        channelId: channelTypeOrId,
      });
    },

    getDeliveryQueueStatus(channelType: string): Promise<DeliveryQueueStatus> {
      return rpcClient.call<DeliveryQueueStatus>("delivery.queue.status", {
        channel_type: channelType,
      });
    },

    getChannelCapabilities(
      channelType: string,
    ): Promise<ChannelCapabilitiesResult> {
      return rpcClient.call<ChannelCapabilitiesResult>(
        "channels.capabilities",
        { channel_type: channelType },
      );
    },

    async restartChannel(channelType: string): Promise<void> {
      await rpcClient.call("channels.restart", { channel_type: channelType });
    },

    async disableChannel(channelType: string): Promise<void> {
      await rpcClient.call("channels.disable", { channel_type: channelType });
    },

    async enableChannel(channelType: string): Promise<void> {
      await rpcClient.call("channels.enable", { channel_type: channelType });
    },

    async patchConfig(
      section: string,
      key: string,
      value: unknown,
    ): Promise<void> {
      await rpcClient.call("config.patch", { section, key, value });
    },
  };

  host.addController(controller);
  return controller;
}
