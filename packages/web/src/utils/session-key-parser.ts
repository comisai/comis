// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-safe session key parser.
 *
 * Ports the session key parsing logic from `@comis/core` domain/session-key.ts
 * as pure functions without Zod/Result dependencies. Used by ic-session-row
 * session row component and session list views to display human-readable session labels.
 *
 * Session key format:
 *   [agent:{agentId}:]{tenantId}:{userId}:{channelId}[:peer:{peerId}][:guild:{guildId}][:thread:{threadId}]
 */

/** Parsed fields from a formatted session key string. */
export interface ParsedSessionKey {
  agentId?: string;
  tenantId: string;
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
 * Handles keys with or without the `agent:` prefix and optional
 * `peer:`, `guild:`, `thread:` tagged segments.
 *
 * @param formatted - Full session key string from the daemon.
 * @returns Parsed key object, or undefined if the format is invalid.
 */
export function parseSessionKeyString(formatted: string): ParsedSessionKey | undefined {
  if (!formatted || typeof formatted !== "string") return undefined;
  let parts = formatted.split(":");

  // Detect and strip agent: prefix
  let agentId: string | undefined;
  if (parts[0] === "agent" && parts.length >= 5) {
    agentId = parts[1];
    parts = parts.slice(2);
  }

  if (parts.length < 3) return undefined;

  const key: ParsedSessionKey = {
    tenantId: parts[0]!,
    userId: parts[1]!,
    channelId: parts[2]!,
  };

  if (agentId !== undefined) {
    key.agentId = agentId;
  }

  // Parse optional peer:, guild:, thread: segments
  for (let i = 3; i < parts.length; i++) {
    if (parts[i] === "peer" && i + 1 < parts.length) {
      key.peerId = parts[++i];
    } else if (parts[i] === "guild" && i + 1 < parts.length) {
      key.guildId = parts[++i];
    } else if (parts[i] === "thread" && i + 1 < parts.length) {
      key.threadId = parts[++i];
    }
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
  const elapsed = Date.now() - lastActiveAt;
  if (elapsed < ACTIVE_THRESHOLD_MS) return "active";
  if (elapsed < IDLE_THRESHOLD_MS) return "idle";
  return "expired";
}
