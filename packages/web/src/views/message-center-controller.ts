// SPDX-License-Identifier: Apache-2.0
/**
 * Message center controller.
 *
 * Thin RPC façade for the multi-channel inbox view: channels.list,
 * channels.capabilities, channels.get, obs.channels.all, message.fetch,
 * session.list, session.history, message.{send,reply,edit,delete,react,attach},
 * plus per-platform action RPCs (discord.action, telegram.action, etc.).
 * The view still owns @state because most interactions are tightly
 * DOM-coupled (emoji picker, inline edit, multi-confirmation dialogs).
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import type { FetchedMessage, PlatformCapabilities } from "../api/types/index.js";

export interface ChannelListEntry {
  channelType: string;
  channelId?: string;
  status: string;
}

export interface ObsChannelEntry {
  channelId: string;
  channelType: string;
  messagesSent: number;
  messagesReceived: number;
  lastActiveAt: number;
}

export interface SessionListEntry {
  sessionKey: string;
  channelId: string;
  updatedAt: number;
}

export interface SessionHistoryMessage {
  role: string;
  content: string;
  timestamp: number;
}

export interface MessageCenterController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  listChannels(): Promise<ChannelListEntry[]>;
  getChannelCapabilities(channelType: string): Promise<PlatformCapabilities | null>;
  getChannelConfig(channelType: string): Promise<Record<string, unknown> | null>;
  listObsChannels(): Promise<ObsChannelEntry[]>;
  fetchMessages(params: { channel_type: string; channel_id: string; limit: number }): Promise<FetchedMessage[]>;
  listSessions(params: { kind: string }): Promise<SessionListEntry[]>;
  loadSessionHistory(params: { session_key: string; limit: number }): Promise<SessionHistoryMessage[]>;
  sendMessage(params: { channel_type: string; channel_id: string; text: string }): Promise<void>;
  replyMessage(params: { channel_type: string; channel_id: string; text: string; message_id: string }): Promise<void>;
  editMessage(params: { channel_type: string; channel_id: string; message_id: string; text: string }): Promise<void>;
  deleteMessage(params: { channel_type: string; channel_id: string; message_id: string }): Promise<void>;
  reactMessage(params: { channel_type: string; channel_id: string; message_id: string; emoji: string }): Promise<void>;
  attachMessage(params: { channel_type: string; channel_id: string; attachment_url: string; attachment_type: string; caption?: string }): Promise<void>;
  invokePlatformAction(rpcMethod: string, params: Record<string, unknown>): Promise<unknown>;
}

export function createMessageCenterController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): MessageCenterController {
  const controller: MessageCenterController = {
    hostConnected(): void { /* no-op */ },
    hostDisconnected(): void { /* no-op */ },

    // Read-path passthroughs use .then(...) rather than async/await so the
    // unpacked-field transformation does not introduce an extra microtask
    // boundary (matches scheduler-controller's non-async listJobs/getStatus
    // pattern).
    listChannels(): Promise<ChannelListEntry[]> {
      return rpcClient
        .call<{ channels: ChannelListEntry[]; total: number }>("channels.list")
        .then((result) => result?.channels ?? []);
    },

    getChannelCapabilities(channelType: string): Promise<PlatformCapabilities | null> {
      return rpcClient
        .call<{ channelType: string; features: PlatformCapabilities }>(
          "channels.capabilities",
          { channel_type: channelType },
        )
        .then((result) => result?.features ?? null);
    },

    getChannelConfig(channelType: string): Promise<Record<string, unknown> | null> {
      return rpcClient
        .call<Record<string, unknown>>("channels.get", { channel_type: channelType })
        .then((result) => result ?? null);
    },

    listObsChannels(): Promise<ObsChannelEntry[]> {
      return rpcClient
        .call<{ channels: ObsChannelEntry[] }>("obs.channels.all")
        .then((result) => result?.channels ?? []);
    },

    fetchMessages(params): Promise<FetchedMessage[]> {
      return rpcClient
        .call<{ messages: FetchedMessage[]; channelId: string }>("message.fetch", params)
        .then((result) => result?.messages ?? []);
    },

    listSessions(params): Promise<SessionListEntry[]> {
      return rpcClient
        .call<{ sessions: SessionListEntry[] }>("session.list", params)
        .then((result) => result?.sessions ?? []);
    },

    loadSessionHistory(params): Promise<SessionHistoryMessage[]> {
      return rpcClient
        .call<{ messages: SessionHistoryMessage[]; total: number }>("session.history", params)
        .then((result) => result?.messages ?? []);
    },

    async sendMessage(params): Promise<void> {
      await rpcClient.call("message.send", params);
    },

    async replyMessage(params): Promise<void> {
      await rpcClient.call("message.reply", params);
    },

    async editMessage(params): Promise<void> {
      await rpcClient.call("message.edit", params);
    },

    async deleteMessage(params): Promise<void> {
      await rpcClient.call("message.delete", params);
    },

    async reactMessage(params): Promise<void> {
      await rpcClient.call("message.react", params);
    },

    async attachMessage(params): Promise<void> {
      await rpcClient.call("message.attach", params);
    },

    async invokePlatformAction(rpcMethod, params): Promise<unknown> {
      return rpcClient.call(rpcMethod, params);
    },
  };

  host.addController(controller);
  return controller;
}
