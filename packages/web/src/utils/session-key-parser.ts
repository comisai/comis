// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-safe session key parser.
 *
 * Ports the session key parsing logic from `@comis/core` domain/session-key.ts
 * as pure functions without Zod/Result dependencies. Used by ic-session-row
 * session row component and session list views to display human-readable session labels.
 *
 * Session key format:
 *   {tenantId}:agent:{agentId}:{userId}:{channelId}[:peer:{peerId}][:guild:{guildId}][:thread:{threadId}]
 */

/** Parsed fields from a formatted session key string. */
import { systemNowMs } from "@comis/core";
export interface ParsedSessionKey {
  tenantId: string;
  agentId: string;
  userId: string;
  channelId: string;
  peerId?: string;
  guildId?: string;
  threadId?: string;
}

/** Session activity status derived from lastActiveAt timestamp. */
export type SessionStatus = "active" | "idle" | "expired";

/** Threshold in ms: active if last activity within 5 minutes. */
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;

/** Threshold in ms: idle if last activity within 1 hour. */
const IDLE_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Parse a formatted session key string into its constituent parts.
 *
 * Handles keys with optional `peer:`, `guild:`, `thread:` tagged segments.
 *
 * @param formatted - Full session key string from the daemon.
 * @returns Parsed key object, or undefined if the format is invalid.
 */
export function parseSessionKeyString(formatted: string): ParsedSessionKey | undefined {
  if (!formatted || typeof formatted !== "string") return undefined;
  const parts = formatted.split(":");
  if (parts.length < 5 || parts.at(1) !== "agent") return undefined;
  const tenantId = parts.at(0);
  const agentId = parts.at(2);
  const userId = parts.at(3);
  if (!tenantId || !agentId || !userId) return undefined;

  const suffixOrder = (part: string): 0 | 1 | 2 | undefined => {
    if (part === "peer") return 0;
    if (part === "guild") return 1;
    if (part === "thread") return 2;
    return undefined;
  };

  let suffixStart = parts.length;
  for (let index = 4; index < parts.length; index += 1) {
    if (suffixOrder(parts.at(index)!) !== undefined) {
      suffixStart = index;
      break;
    }
  }
  const channelId = parts.slice(4, suffixStart).join(":");
  if (!channelId) return undefined;

  const key: ParsedSessionKey = { tenantId, agentId, userId, channelId };
  let cursor = suffixStart;
  let previousOrder = -1;
  while (cursor < parts.length) {
    const marker = parts.at(cursor)!;
    const order = suffixOrder(marker);
    if (order === undefined || order <= previousOrder) return undefined;
    let nextMarker = cursor + 1;
    while (
      nextMarker < parts.length
      && suffixOrder(parts.at(nextMarker)!) === undefined
    ) {
      nextMarker += 1;
    }
    if (nextMarker === cursor + 1) return undefined;
    const value = parts.slice(cursor + 1, nextMarker).join(":");
    if (!value) return undefined;
    if (marker === "peer") key.peerId = value;
    else if (marker === "guild") key.guildId = value;
    else key.threadId = value;
    previousOrder = order;
    cursor = nextMarker;
  }

  return key;
}

/**
 * Generate a human-readable display name from a parsed session key.
 *
 * Returns the userId, truncated to 14 chars + "..." if longer than 16 characters.
 *
 * @param key - Parsed session key object.
 * @returns Display-friendly user label.
 */
export function formatSessionDisplayName(key: ParsedSessionKey): string {
  if (key.userId.length > 16) {
    return key.userId.slice(0, 14) + "...";
  }
  return key.userId;
}

/**
 * Compute session activity status from the last-active timestamp.
 *
 * - "active": last activity within 5 minutes
 * - "idle": last activity within 1 hour
 * - "expired": last activity 1 hour or more ago
 *
 * @param lastActiveAt - Epoch milliseconds of last session activity.
 * @returns Computed session status.
 */
export function computeSessionStatus(lastActiveAt: number): SessionStatus {
  const elapsed = systemNowMs() - lastActiveAt;
  if (elapsed < ACTIVE_THRESHOLD_MS) return "active";
  if (elapsed < IDLE_THRESHOLD_MS) return "idle";
  return "expired";
}
