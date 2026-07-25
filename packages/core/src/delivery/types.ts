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
import type { ChannelEndpoint } from "../domain/conversation-scope.js";
import type { DeliveryAuthority } from "../ports/delivery-queue.js";
import type { ErrorKind } from "../logging/log-fields.js";
import type { PlatformDeliveryOutcome } from "./platform-delivery-outcome.js";
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
  readonly channelId: string;
  readonly channelType: string;
  sendMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Result<string, Error>>;
}

// -------------------------------------------------------------------------
// Per-call options
// -------------------------------------------------------------------------

/** Options for a single delivery call. */
// @optional-field-count: 13 conditional per-call overrides; absence delegates to resolved-turn authority and service policy.
export interface DeliverToChannelOptions {
  /** Selects the sole owner of any future queue retry for this call. */
  completionMode: "settled" | "deferred_retry";
  /** Explicit authority for deliveries created outside an active resolved turn. */
  authority?: DeliveryAuthority;
  /** Immutable destination endpoint captured when the delivery is created. */
  destinationEndpoint?: ChannelEndpoint;
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

/** Per-chunk platform truth. */
export type ChunkDeliveryResult =
  | {
      status: "accepted";
      messageId?: string;
      error?: never;
      errorKind?: never;
      charCount: number;
      retried: boolean;
    }
  | {
      status: "rejected" | "unknown";
      messageId?: never;
      error: Error;
      errorKind: ErrorKind;
      charCount: number;
      retried: boolean;
    };

export type DeliveryQueueDisposition = "settled" | "retry_pending" | "transition_failed";

/** Overall delivery result. */
export interface DeliveryResult {
  /** Per-chunk results in original send order. */
  chunks: readonly ChunkDeliveryResult[];
  /** Total character count across all chunks. */
  totalChars: number;
  /** Single aggregate platform truth derived from chunks. */
  platform: PlatformDeliveryOutcome;
  /** Durable retry ownership after all queue transitions settle. */
  queueDisposition: DeliveryQueueDisposition;
}

export class DeliveryNotAttemptedError extends Error {
  readonly kind = "delivery_not_attempted" as const;

  constructor(readonly reason: "empty_text" | "hook_cancelled") {
    super(reason === "empty_text" ? "Delivery text is empty" : "Delivery was cancelled by policy hook");
    this.name = "DeliveryNotAttemptedError";
  }
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
 * interrupted in-flight rows are recovered to terminal uncertain state.
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
      platform: Object.freeze({ ...platformResult.platform }),
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
