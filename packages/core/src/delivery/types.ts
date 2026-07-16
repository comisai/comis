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
import { ok, type Result } from "@comis/shared";

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
  /** Adapter instance identity used by retry observability when available. */
  readonly channelId?: string;
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

/** Durable queue state transitions performed around a platform send. */
export type DeliveryQueueTransition = "enqueue_in_flight" | "ack" | "nack" | "fail";

/**
 * One failed delivery-queue state transition.
 *
 * `deliveryId` is null only when the initial enqueue failed before the queue
 * could assign an entry ID. Queue failures are dependency-boundary failures;
 * the fixed classification keeps both logs and events closed and filterable.
 */
export interface DeliveryQueueTransitionFailure {
  readonly transition: DeliveryQueueTransition;
  readonly deliveryId: string | null;
  readonly errorKind: "dependency";
  readonly cause: Error;
}

/**
 * The platform send completed, but one or more durability transitions failed.
 *
 * The actual platform result is retained so callers can distinguish "sent but
 * not durably acknowledged" from "not sent and not durably rescheduled". The
 * outer Result exposes the durability ambiguity. Platform-truth consumers may
 * use the retained result, but the queue remains at-least-once: an unacknowledged
 * in-flight row can still be retried after restart.
 */
export class DeliveryQueueTransitionError extends Error {
  readonly kind = "queue_transition_failed" as const;
  readonly failures: readonly DeliveryQueueTransitionFailure[];
  readonly platformResult: DeliveryResult;

  constructor(
    failures: readonly DeliveryQueueTransitionFailure[],
    platformResult: DeliveryResult,
  ) {
    const transitions = [...new Set(failures.map((failure) => failure.transition))].join(",");
    super(`Delivery queue transition failed: ${transitions}`);
    this.name = "DeliveryQueueTransitionError";
    const failureClones = failures.map((failure) => Object.freeze({ ...failure }));
    Object.freeze(failureClones);
    this.failures = failureClones;
    const chunks = platformResult.chunks.map((chunk) => Object.freeze({ ...chunk }));
    Object.freeze(chunks);
    this.platformResult = Object.freeze({
      ...platformResult,
      chunks,
    });
  }
}

/**
 * Resolve the platform-send truth from a DeliveryService Result.
 *
 * Queue transition errors retain a complete platform result. Consumers that
 * decide whether the user received a message or whether an outward-send ledger
 * should commit must use that embedded truth; the service has already emitted
 * the separate durability warning and health event.
 */
export function resolvePlatformDeliveryResult(
  result: Result<DeliveryResult, Error>,
): Result<DeliveryResult, Error> {
  if (!result.ok && result.error instanceof DeliveryQueueTransitionError) {
    return ok(result.error.platformResult);
  }
  return result;
}
