// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 30 — Core-owned delivery types.
 *
 * Lifted from packages/channels/src/shared/deliver-to-channel.ts (lines
 * 100-168 at plan-authoring time) to enable createDeliveryService to live
 * in core/src/delivery/ without a core → channels back-edge.
 *
 * The actual `deliverToChannel` function + value-level helpers
 * (QUEUE_BACKOFF_SCHEDULE_MS, computeQueueBackoff, resolveChunkLimit)
 * stay in channels/src/shared/deliver-to-channel.ts until plan 05/06
 * (RESEARCH.md §H.3 commit ordering). Plan 03 only moves the TYPES.
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
   * service-wide `DeliveryServiceDeps.replyMode` closure default. Phase 30
   * plan 04: this knob was previously threaded via the optional 5th-arg
   * `deps?.replyMode` on the standalone `deliverToChannel`; now that deps is
   * captured in closure, callers that need per-channel/per-chat-type variance
   * (e.g. execution-deliver.ts resolving replyMode from streamingConfig) pass
   * it through here instead.
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
