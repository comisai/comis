// SPDX-License-Identifier: Apache-2.0
import type { NormalizedMessage, SessionKey } from "@comis/core";

/**
 * DM scope modes controlling session isolation granularity for direct messages.
 */
export type DmScopeMode = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";

/**
 * Parameters for building a scoped session key.
 */
export interface ScopedSessionKeyParams {
  /** The incoming normalized message */
  msg: NormalizedMessage;
  /** Agent identifier for multi-agent setups */
  agentId: string;
  /** ChannelPort.channelId — bot account identifier */
  adapterChannelId: string;
  /** Tenant identifier (defaults to "default") */
  tenantId?: string;
  /** DM scope mode (defaults to "per-channel-peer") */
  dmScopeMode?: DmScopeMode;
  /** Whether to prepend agent:<agentId>: to the session key */
  agentPrefixEnabled?: boolean;
  /** Thread ID for forum/thread isolation */
  threadId?: string;
}

/**
 * Detect whether a message originates from a group context.
 *
 * A message is a group message if any of:
 * - msg.metadata.guildId is defined (Discord server)
 * - msg.metadata.isGroup is true (generic group flag)
 * - msg.metadata.telegramChatType is "group" or "supergroup"
 */
function isGroupMessage(msg: NormalizedMessage): boolean {
  const meta = msg.metadata;
  if (meta.guildId !== undefined) return true;
  if (meta.isGroup === true) return true;
  const chatType = meta.telegramChatType;
  if (chatType === "group" || chatType === "supergroup") return true;
  return false;
}

/**
 * Build a scoped session key based on DM scope mode, agent prefix, and thread isolation.
 *
 * Group messages always use per-channel-peer behavior regardless of dmScopeMode.
 * DM messages apply the configured scope mode:
 * - "main": single shared session (userId="main", channelId="dm")
 * - "per-peer": per-peer sessions across all channels
 * - "per-channel-peer": per-channel per-peer sessions (default)
 * - "per-account-channel-peer": includes adapter channel ID for multi-bot isolation
 */
export function buildScopedSessionKey(params: ScopedSessionKeyParams): SessionKey {
  const {
    msg,
    agentId,
    adapterChannelId,
    tenantId = "default",
    dmScopeMode = "per-channel-peer",
    agentPrefixEnabled = false,
    threadId,
  } = params;

  const key: SessionKey = {
    tenantId,
    userId: msg.senderId,
    channelId: msg.channelId,
  };

  if (isGroupMessage(msg)) {
    // Group messages: always per-channel-peer behavior
    key.userId = msg.senderId;
    key.channelId = msg.channelId;
    key.peerId = msg.senderId;
    if (msg.metadata.guildId !== undefined) {
      key.guildId = String(msg.metadata.guildId);
    }
  } else {
    // DM messages: apply scope mode
    switch (dmScopeMode) {
      case "main":
        key.userId = "main";
        key.channelId = "dm";
        // No peerId for main scope
        break;
      case "per-peer":
        key.userId = msg.senderId;
        key.channelId = "dm";
        key.peerId = msg.senderId;
        break;
      case "per-channel-peer":
        key.userId = msg.senderId;
        key.channelId = msg.channelId;
        key.peerId = msg.senderId;
        break;
      case "per-account-channel-peer":
        key.userId = msg.senderId;
        key.channelId = `${adapterChannelId}:${msg.channelId}`;
        key.peerId = msg.senderId;
        break;
    }
  }

  if (agentPrefixEnabled) {
    key.agentId = agentId;
  }

  if (threadId !== undefined) {
    key.threadId = threadId;
  }

  return key;
}

/**
 * Extract a thread ID from platform-specific message metadata.
 *
 * Supports:
 * - Discord: parentChannelId present -> return msg.channelId (thread channel)
 * - Slack: slackThreadTs present -> return its string value
 * - Telegram: telegramThreadId present -> return its string value
 *
 * @returns Thread ID string or undefined if not in a thread context
 */
export function extractThreadId(msg: NormalizedMessage): string | undefined {
  if (msg.metadata.parentChannelId !== undefined) {
    return msg.channelId;
  }
  if (msg.metadata.slackThreadTs !== undefined) {
    return String(msg.metadata.slackThreadTs);
  }
  if (msg.metadata.telegramThreadId !== undefined) {
    return String(msg.metadata.telegramThreadId);
  }
  return undefined;
}
