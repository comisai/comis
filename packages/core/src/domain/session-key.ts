import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * SessionKey: Uniquely identifies a conversation context.
 *
 * The combination of tenantId + userId + channelId locates the session.
 * Optional peerId and guildId support group/thread scenarios.
 * Optional agentId enables multi-agent session isolation.
 * Optional threadId enables forum/thread session isolation.
 * Used by MemoryPort to scope memory retrieval and by the agent to
 * maintain per-conversation state.
 */
export const SessionKeySchema = z.strictObject({
    tenantId: z.string().min(1).default("default"),
    userId: z.string().min(1),
    channelId: z.string().min(1),
    peerId: z.string().optional(),
    guildId: z.string().optional(),
    agentId: z.string().optional(),
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
 * Format: `[agent:{agentId}:]{tenantId}:{userId}:{channelId}[:peer:{peerId}][:guild:{guildId}][:thread:{threadId}]`
 *
 * When agentId/threadId are absent, output is identical to the original format
 * for backward compatibility.
 */
export function formatSessionKey(key: SessionKey): string {
  let formatted = "";
  if (key.agentId !== undefined) {
    formatted += `agent:${key.agentId}:`;
  }
  formatted += `${key.tenantId}:${key.userId}:${key.channelId}`;
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
 * Reverses the output of formatSessionKey().
 *
 * Format: `[agent:{agentId}:]{tenantId}:{userId}:{channelId}[:peer:{peerId}][:guild:{guildId}][:thread:{threadId}]`
 *
 * Old format keys (no agent prefix, no thread suffix) parse identically
 * to the original behavior for backward compatibility.
 *
 * @returns SessionKey if the format is valid, undefined otherwise
 */
export function parseFormattedSessionKey(formatted: string): SessionKey | undefined {
  if (!formatted || typeof formatted !== "string") return undefined;
  let parts = formatted.split(":");

  // Detect and strip agent: prefix
  let agentId: string | undefined;
  if (parts[0] === "agent" && parts.length >= 5) {
    agentId = parts[1];
    parts = parts.slice(2);
  }

  if (parts.length < 3) return undefined;

  // channelId may itself contain ":" (e.g. sub-agent runner emits
  // "sub-agent:<uuid>"). formatSessionKey puts channelId in parts[2+] before
  // any peer/guild/thread markers, so we greedily join consecutive parts into
  // channelId until we hit a known marker or run out. This makes the format
  // round-trip-safe when channelId has colons; for simple channelIds (no
  // colons) the behaviour is identical to the old one-index-takes-all path.
  let idx = 2;
  const channelIdParts: string[] = [];
  while (
    idx < parts.length &&
    parts[idx] !== "peer" &&
    parts[idx] !== "guild" &&
    parts[idx] !== "thread"
  ) {
    channelIdParts.push(parts[idx]!);
    idx++;
  }
  if (channelIdParts.length === 0) return undefined;

  const key: SessionKey = {
    tenantId: parts[0]!,
    userId: parts[1]!,
    channelId: channelIdParts.join(":"),
  };

  if (agentId !== undefined) {
    key.agentId = agentId;
  }

  // Parse optional peer:, guild:, and thread: segments starting where
  // channelId ended.
  for (let i = idx; i < parts.length; i++) {
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
