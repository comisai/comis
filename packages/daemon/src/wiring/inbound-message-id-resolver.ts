// SPDX-License-Identifier: Apache-2.0
/**
 * Resolves daemon-internal `NormalizedMessage.id` UUIDs to platform-native
 * message ids (e.g. Telegram's integer `message_id`) for inbound messages.
 *
 * The agent's tools see `message_id` as the daemon UUID (from session
 * preamble metadata), but channel adapters need the platform-native id when
 * calling APIs like `bot.api.deleteMessage`. Without translation, those calls
 * fail with `400: Bad Request: message identifier is not specified` (Telegram
 * rejects `Number("e60f9634-...")` → `NaN`).
 *
 * Populated lazily on inbound via `record(msg, channelType)`. The native id
 * is read from `msg.metadata[metaKey]` where metaKey comes from the
 * per-channel `replyToMetaKey` capability. Backed by a TTL cache so stale
 * entries don't accumulate.
 *
 * @module
 */

import { createTTLCache, type TTLCache } from "@comis/shared";
import type { NormalizedMessage } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single resolved inbound message record. */
export interface InboundIdRecord {
  channelType: string;
  channelId: string;
  nativeId: string;
}

/** UUID → native message-id resolver for cross-channel inbound messages. */
export interface InboundMessageIdResolver {
  /** Record an inbound message's UUID → native id mapping. No-op if the
   *  channel has no registered metadata key or the metadata is missing. */
  record(msg: NormalizedMessage, channelType: string): void;
  /** Look up native id by daemon UUID. Returns undefined if not found. */
  resolve(uuid: string): InboundIdRecord | undefined;
}

/** Options for the resolver factory. */
export interface InboundMessageIdResolverOpts {
  /** Per-channel metadata key carrying the native id, e.g. {"telegram": "telegramMessageId"}. */
  metaKeyByChannel: Map<string, string>;
  /** Time-to-live in ms for cached entries. Defaults to 1 h. */
  ttlMs?: number;
  /** Max entries before LRU eviction. Defaults to 10_000. */
  maxEntries?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an inbound-message-id resolver backed by a TTL cache.
 *
 * @param opts Configuration including the per-channel metadata key map.
 * @returns A resolver that records on inbound and resolves UUIDs on lookup.
 */
export function createInboundMessageIdResolver(
  opts: InboundMessageIdResolverOpts,
): InboundMessageIdResolver {
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  const maxEntries = opts.maxEntries ?? 10_000;
  const cache: TTLCache<InboundIdRecord> = createTTLCache({ ttlMs, maxEntries });

  return {
    record(msg, channelType) {
      const metaKey = opts.metaKeyByChannel.get(channelType);
      if (!metaKey) return;
      const meta = msg.metadata as Record<string, unknown> | undefined;
      // metaKey comes from our internal channelCapabilities map (set at adapter
      // bootstrap, not user-controlled), so dynamic access is safe.
      // eslint-disable-next-line security/detect-object-injection
      const raw = meta?.[metaKey];
      if (raw == null) return;
      const nativeId = typeof raw === "number"
        ? String(raw)
        : typeof raw === "string"
          ? raw
          : null;
      if (nativeId == null || nativeId.length === 0) return;
      cache.set(msg.id, { channelType, channelId: msg.channelId, nativeId });
    },

    resolve(uuid) {
      return cache.get(uuid);
    },
  };
}
