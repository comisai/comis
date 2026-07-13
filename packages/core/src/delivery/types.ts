// SPDX-License-Identifier: Apache-2.0
/**
 * Core-owned delivery types.
 *
 * These types live in core/src/delivery/ so createDeliveryService can be
 * defined in core without a core → channels back-edge. The delivery
 * pipeline itself lives in delivery-service.ts; the value-level helpers
 * (QUEUE_BACKOFF_SCHEDULE_MS, computeQueueBackoff, resolveChunkLimit)
 * live in queue-backoff.ts.
 */

import type { SendMessageOptions } from "../ports/channel.js";
import type { Result } from "@comis/shared";

// -------------------------------------------------------------------------
// Delivery strategy + adapter
// -------------------------------------------------------------------------

/**
 * Delivery strategy for multi-chunk messages.
 *
 * - `"all-or-abort"` (default): Stops on first chunk failure -- remaining chunks are not sent.
 * - `"best-effort"`: Continues past failures -- delivers as many chunks as possible.
 */
export type DeliveryStrategy = "all-or-abort" | "best-effort";

/** Minimal adapter interface required by deliverToChannel. */
export interface DeliveryAdapter {
  sendMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>>;
  channelType: string;
}

// -------------------------------------------------------------------------
// Per-call options
// -------------------------------------------------------------------------

/** Options for a single delivery call. */
export interface DeliverToChannelOptions {
  /** Reply-to message ID (platform-specific). Applied to first chunk only. */
  replyTo?: string;
  /** Reply subject (email forms a "Re: <subject>" reply subject from this).
   *  Applied to all chunks; channels without a subject concept ignore it. */
  subject?: string;
  /** Target thread ID for threaded delivery. Applied to all chunks. */
  threadId?: string;
  /** Extra platform-specific options. Applied to all chunks. */
  extra?: Record<string, unknown>;
  /** Skip format conversion (caller already converted). */
  skipFormat?: boolean;
  /** Skip chunking (caller guarantees text fits platform limit). */
  skipChunking?: boolean;
  /** Origin identifier for observability events. */
  origin?: string;
  /** Whether this is a system message (compaction, system) -- always threads without consuming first slot. */
  isSystemMessage?: boolean;
  /** Delivery strategy. "all-or-abort" (default) stops on first failure. "best-effort" continues past failures. */
  strategy?: DeliveryStrategy;
  /** Called per failed chunk in best-effort mode. Not called in all-or-abort. */
  onChunkError?: (error: Error, chunkIndex: number, totalChunks: number) => void;
  /**
   * Reply-mode override for this single call. When provided, supersedes the
   * service-wide `DeliveryServiceDeps.replyMode` closure default. Callers
   * that need per-channel/per-chat-type variance (e.g. execution-deliver.ts
   * resolving replyMode from streamingConfig) pass it through here instead
   * of relying on the closure default.
   */
  replyMode?: "off" | "first" | "all";
}

// -------------------------------------------------------------------------
// Result shapes
// -------------------------------------------------------------------------

/** Per-chunk delivery result. */
export interface ChunkDeliveryResult {
  /** Whether this chunk was sent successfully. */
  ok: boolean;
  /** Platform message ID if available. */
  messageId?: string;
  /** Error if send failed. */
  error?: Error;
  /** Character count of the chunk. */
  charCount: number;
  /** Whether retry was used for this chunk. */
  retried: boolean;
}

/** Overall delivery result. */
export interface DeliveryResult {
  /** Whether all chunks were delivered. */
  ok: boolean;
  /** Total chunks attempted. */
  totalChunks: number;
  /** Successfully delivered chunks. */
  deliveredChunks: number;
  /** Failed chunks. */
  failedChunks: number;
  /** Per-chunk results. */
  chunks: ChunkDeliveryResult[];
  /** Total character count across all chunks. */
  totalChars: number;
}
