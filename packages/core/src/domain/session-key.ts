// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * SessionKey: Uniquely identifies a conversation context.
 *
 * This is a human-readable projection only. Durable authority uses
 * ConversationScope + ConversationRef.
 * Optional peerId and guildId support group/thread scenarios.
 * Optional threadId enables forum/thread session isolation.
 * Used by MemoryPort to scope memory retrieval and by the agent to
 * maintain per-conversation state.
 */
export const SessionKeySchema = z.strictObject({
    tenantId: z.string().min(1),
    agentId: z.string().min(1),
    userId: z.string().min(1),
    channelId: z.string().min(1),
    peerId: z.string().optional(),
    guildId: z.string().optional(),
    threadId: z.string().optional(),
  });

export type SessionKey = z.infer<typeof SessionKeySchema>;

/**
 * Parse unknown input into a SessionKey, returning Result<T, ZodError>.
 */
export function parseSessionKey(raw: unknown): Result<SessionKey, z.ZodError> {
  const result = SessionKeySchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}

/**
 * Format a SessionKey into a deterministic string for use as a cache/lookup key.
 *
 * Format: `{tenantId}:agent:{agentId}:{userId}:{channelId}[:peer:{peerId}][:guild:{guildId}][:thread:{threadId}]`
 * where each tagged suffix is emitted only when the corresponding optional
 * field is set. Symmetric with `parseFormattedSessionKey`.
 *
 * The required agent segment keeps display/cache labels collision-free across
 * agents. It does not make this string an authorization credential.
 */
export function formatSessionKey(key: SessionKey): string {
  let formatted = `${key.tenantId}:agent:${key.agentId}:${key.userId}:${key.channelId}`;
  if (key.peerId !== undefined) {
    formatted += `:peer:${key.peerId}`;
  }
  if (key.guildId !== undefined) {
    formatted += `:guild:${key.guildId}`;
  }
  if (key.threadId !== undefined) {
    formatted += `:thread:${key.threadId}`;
  }
  return formatted;
}

/**
 * Parse a formatted session key string back into a SessionKey object.
 * Symmetric inverse of `formatSessionKey`.
 *
 * Accepted format: `{tenantId}:agent:{agentId}:{userId}:{channelId}[:peer:{peerId}][:guild:{guildId}][:thread:{threadId}]`
 * The leading unescaped segments are tenantId, the `agent` marker, agentId,
 * and userId. channelId
 * may contain colons and consumes segments before the first reserved suffix
 * marker. Suffix markers are unique and ordered peer → guild → thread; each
 * value consumes colon-bearing segments until the next marker. Those marker
 * words are therefore reserved when they occur as whole colon-delimited
 * segments inside channel or suffix values.
 *
 * Because the wire format is unescaped, a producer that embeds a colon in
 * tenantId, agentId, or userId cannot be inverted unambiguously. Such producers
 * must keep their structured identity outside these required leading fields.
 *
 * @returns SessionKey if the format is valid, undefined otherwise
 */
export function parseFormattedSessionKey(formatted: string): SessionKey | undefined {
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

  // Suffix marker tokens are reserved after tenant/user. A marker before any
  // channel segment therefore fails the required non-empty channel invariant.
  let suffixStart = parts.length;
  for (let i = 4; i < parts.length; i++) {
    if (suffixOrder(parts.at(i)!) !== undefined) {
      suffixStart = i;
      break;
    }
  }

  const channelId = parts.slice(4, suffixStart).join(":");
  if (channelId.length === 0) return undefined;

  const key: SessionKey = { tenantId, agentId, userId, channelId };

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
      nextMarker++;
    }
    if (nextMarker === cursor + 1) return undefined;

    const value = parts.slice(cursor + 1, nextMarker).join(":");
    if (value.length === 0) return undefined;
    if (marker === "peer") key.peerId = value;
    else if (marker === "guild") key.guildId = value;
    else key.threadId = value;
    previousOrder = order;
    cursor = nextMarker;
  }

  const parsed = parseSessionKey(key);
  if (!parsed.ok || formatSessionKey(parsed.value) !== formatted) return undefined;
  return parsed.value;
}
