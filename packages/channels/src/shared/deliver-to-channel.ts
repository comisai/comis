// SPDX-License-Identifier: Apache-2.0
/**
 * Unified outbound delivery -- format, chunk, retry, send.
 *
 * Single entry point for ALL outbound text delivery. Every message,
 * regardless of origin, gets platform-aware formatting, chunking within
 * limits, and optional retry.
 *
 * Queue integration: each chunk is persisted before send,
 * acknowledged on success, and nacked/failed on error.
 *
 * @module
 */

import type { SendMessageOptions, TypedEventBus, DeliveryQueuePort } from "@comis/core";
import { tryGetContext, getGlobalHookRunner } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err, suppressError, checkAborted } from "@comis/shared";
import { formatForChannel } from "./format-for-channel.js";
import { chunkForDelivery } from "./chunk-for-delivery.js";
import { chunkBlocks } from "./block-chunker.js";
import type { RetryEngine } from "./retry-engine.js";
import { isPermanentError } from "./permanent-errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Universal chunk limit default.
 *
 * All platforms default to this unless overridden by ChannelCapability or
 * config. This is a UX limit, not an API limit -- shorter chunks are more
 * readable on mobile.
 */
const DEFAULT_CHUNK_LIMIT = 4000;

/**
 * Platforms that require IR-based rendering via formatForChannel.
 *
 * These platforms produce already-rendered text (HTML, plain text with
 * control codes) after formatForChannel -- we use chunkBlocks (raw text
 * chunker) on the rendered output, not chunkIR (which would double-parse).
 *
 * Matches the set in format-for-channel.ts PLATFORMS_NEEDING_IR_RENDER.
 */
const PLATFORMS_NEEDING_FORMAT = new Set([
  "telegram",
  "signal",
  "whatsapp",
  "imessage",
  "line",
  "irc",
  "slack",
  "email",
]);

/**
 * Platforms that pass through raw markdown.
 *
 * These receive raw markdown and either render it natively (discord)
 * or don't need formatting (gateway, echo). We use chunkForDelivery with
 * IR pipeline for format-aware chunking.
 */
const PASSTHROUGH_PLATFORMS = new Set(["discord", "gateway", "echo"]);

/**
 * Backoff schedule for queue nack retry delays (milliseconds).
 *
 * Index = attemptCount (0-based from queue entry).
 * Values: 5s, 25s, 2m, 10m, 10m (cap).
 *
 * Exported for use by drain cycle.
 */
export const QUEUE_BACKOFF_SCHEDULE_MS: readonly number[] = Object.freeze([
  5_000,
  25_000,
  120_000,
  600_000,
  600_000,
]);

/**
 * Compute the backoff delay for a queue retry based on attempt count.
 *
 * Uses QUEUE_BACKOFF_SCHEDULE_MS, clamping at the last value for
 * attempt counts beyond the schedule length.
 *
 * Exported for use by drain cycle.
 *
 * @param attemptCount - The current attempt count (0-based)
 * @returns Delay in milliseconds before next retry
 */
export function computeQueueBackoff(attemptCount: number): number {
  const idx = Math.min(attemptCount, QUEUE_BACKOFF_SCHEDULE_MS.length - 1);
  return QUEUE_BACKOFF_SCHEDULE_MS[idx];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

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

/** Dependencies injected into the delivery function. */
export interface DeliverToChannelDeps {
  /** Event bus for observability. */
  eventBus?: TypedEventBus;
  /** Retry engine for exponential backoff. Optional -- no retry without it. */
  retryEngine?: RetryEngine;
  /** Platform limit override. Falls back to DEFAULT_CHUNK_LIMIT (4000). */
  maxCharsOverride?: number;
  /**
   * Delivery queue for crash-safe persistence.
   *
   * Each chunk is enqueued before send and acked/nacked/failed after.
   * When the daemon creates deps, it provides either the real SQLite adapter
   * or the no-op adapter (queue disabled).
   */
  deliveryQueue: DeliveryQueuePort;
  /** Reply mode for this delivery (off/first/all). Default: "first". */
  replyMode?: "off" | "first" | "all";
  /**
   * External abort signal. Checked before each chunk send.
   * Aborted deliveries emit delivery:aborted (not delivery:complete).
   */
  abortSignal?: AbortSignal;
  /**
   * Per-instance set of in-flight outbound sendMessage promises. When provided,
   * each chunk send is added to the set BEFORE the await (so a throwing send
   * is still tracked) and removed via .finally() on settle. Drained in
   * channel-manager.stopAll() with a 5s deadline so SIGUSR2 cannot tear down
   * adapters mid-send (which would orphan the SQLite delivery-queue ack and
   * trigger a duplicate retry on the next instance). Created by the
   * channel-manager factory; do not pass externally.
   */
  inFlightSends?: Set<Promise<unknown>>;
}

// ---------------------------------------------------------------------------
// Chunk limit resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective chunk limit for a delivery.
 *
 * Resolution order (first defined wins):
 *   1. maxCharsOverride -- caller-provided explicit override
 *   2. DEFAULT_CHUNK_LIMIT (4000) -- universal fallback
 *
 * Exported for callers that need the resolved limit (execution pipeline)
 * and for testing.
 */
export function resolveChunkLimit(maxCharsOverride?: number): number {
  if (typeof maxCharsOverride === "number" && maxCharsOverride > 0) {
    return maxCharsOverride;
  }
  return DEFAULT_CHUNK_LIMIT;
}

// ---------------------------------------------------------------------------
// Core delivery function
// ---------------------------------------------------------------------------

/**
 * Unified delivery function: format + chunk + queue + retry + send + events.
 *
 * Algorithm:
 * 1. Early return on empty text (0 chunks)
 * 2. Format: formatForChannel() unless skipFormat
 * 3. Chunk: split at platform limit unless skipChunking
 * 4. Send: each chunk with queue persistence + retry if available
 * 5. Aggregate: return DeliveryResult
 *
 * Queue integration:
 * - BEFORE send: enqueue chunk in delivery queue (if deps.deliveryQueue present)
 * - AFTER send success: ack the queue entry
 * - AFTER send failure: nack (transient) or fail (permanent/exhausted)
 * - Queue failures are logged but do not block delivery (graceful degradation)
 *
 * @param adapter - Minimal adapter with sendMessage + channelType
 * @param channelId - Target channel/chat identifier
 * @param text - Message text (markdown)
 * @param options - Delivery options (replyTo, threadId, skipFormat, etc.)
 * @param deps - Dependencies (eventBus, retryEngine, maxCharsOverride, deliveryQueue)
 * @returns Result wrapping the delivery outcome
 */
export async function deliverToChannel(
  adapter: DeliveryAdapter,
  channelId: string,
  text: string,
  options?: DeliverToChannelOptions,
  deps?: DeliverToChannelDeps,
): Promise<Result<DeliveryResult, Error>> {
  const startTime = Date.now();

  try {
    // --- 1. EARLY RETURN: empty text ---
    if (!text || !text.trim()) {
      return ok({
        ok: true,
        totalChunks: 0,
        deliveredChunks: 0,
        failedChunks: 0,
        chunks: [],
        totalChars: 0,
      });
    }

    // --- 1b. HOOKS: before_delivery ---
    let deliveryText = text;
    const hookRunner = getGlobalHookRunner();
    if (hookRunner) {
      const hookCtx = tryGetContext();
      const hookResult = await hookRunner.runBeforeDelivery(
        {
          text: deliveryText,
          channelType: adapter.channelType,
          channelId,
          options: (options ?? {}) as Record<string, unknown>,
          origin: options?.origin ?? "unknown",
        },
        {
          sessionKey: hookCtx?.sessionKey,
          agentId: undefined,
          traceId: hookCtx?.traceId,
        },
      );

      if (hookResult?.cancel) {
        // Log cancellation at INFO via event
        deps?.eventBus?.emit("delivery:hook_cancelled", {
          channelId,
          channelType: adapter.channelType,
          reason: hookResult.cancelReason ?? "unknown",
          origin: options?.origin ?? "unknown",
          timestamp: Date.now(),
        });
        return ok({
          ok: false,
          totalChunks: 0,
          deliveredChunks: 0,
          failedChunks: 0,
          chunks: [],
          totalChars: 0,
        });
      }

      if (hookResult?.text !== undefined) {
        deliveryText = hookResult.text;
      }
    }

    // --- 2. FORMAT: unless skipFormat ---
    let formatted = deliveryText;
    if (!options?.skipFormat) {
      formatted = formatForChannel(deliveryText, adapter.channelType);
    }

    // Post-format whitespace guard -- reject if formatting reduced text to whitespace
    if (!formatted.trim()) {
      return ok({
        ok: true,
        totalChunks: 0,
        deliveredChunks: 0,
        failedChunks: 0,
        chunks: [],
        totalChars: 0,
      });
    }

    // --- 3. CHUNK: unless skipChunking ---
    let chunks: string[];
    const maxChars = resolveChunkLimit(deps?.maxCharsOverride);

    if (options?.skipChunking) {
      // Caller guarantees text fits -- send as-is
      chunks = [formatted];
    } else if (formatted.length <= maxChars) {
      // Short text -- skip chunking overhead
      chunks = [formatted];
    } else if (adapter.channelType === "gateway") {
      // Gateway: no chunking (web client renders markdown, no length limit)
      chunks = [formatted];
    } else if (PLATFORMS_NEEDING_FORMAT.has(adapter.channelType) && !options?.skipFormat) {
      // Platforms that went through formatForChannel: text is already rendered
      // (HTML for telegram, plain text for signal/whatsapp/etc.)
      // Use chunkBlocks on the rendered output to avoid double-parsing
      chunks = chunkBlocks(formatted, { mode: "paragraph", maxChars });
    } else if (PASSTHROUGH_PLATFORMS.has(adapter.channelType)) {
      // Passthrough platforms (discord, slack): raw markdown, use IR chunker
      chunks = chunkForDelivery(formatted, adapter.channelType, {
        maxChars,
        useMarkdownIR: true,
      });
    } else {
      // Unknown platform: fall back to paragraph-based chunking
      chunks = chunkBlocks(formatted, { mode: "paragraph", maxChars });
    }

    // Safety: never return empty chunk array
    if (chunks.length === 0) {
      chunks = [formatted];
    }

    // Resolve context for queue integration (non-throwing)
    const ctx = tryGetContext();
    const tenantId = ctx?.tenantId ?? "default";
    const traceId = ctx?.traceId ?? null;

    // Resolve delivery strategy
    const strategy: DeliveryStrategy = options?.strategy ?? "all-or-abort";

    // --- 4. SEND: each chunk ---
    const chunkResults: ChunkDeliveryResult[] = [];
    let aborted = false;

    for (let i = 0; i < chunks.length; i++) {
      // --- Abort check ---
      if (deps?.abortSignal) {
        const abortCheck = checkAborted(deps.abortSignal);
        if (!abortCheck.ok) {
          aborted = true;
          const reason = abortCheck.error.message;
          // Emit delivery:aborted event
          deps.eventBus?.emit("delivery:aborted", {
            channelId,
            channelType: adapter.channelType,
            reason,
            chunksDelivered: chunkResults.filter(r => r.ok).length,
            totalChunks: chunks.length,
            durationMs: Date.now() - startTime,
            origin: options?.origin ?? "unknown",
            timestamp: Date.now(),
          });
          break;
        }
      }

      const chunk = chunks[i];

      // Build SendMessageOptions
      const sendOpts: SendMessageOptions = {};

      // replyTo: respects replyMode
      if (options?.replyTo) {
        const replyMode = deps?.replyMode ?? "first";
        if (options.isSystemMessage) {
          // System messages (compaction, system) always thread without consuming first slot
          sendOpts.replyTo = options.replyTo;
        } else if (replyMode === "all") {
          sendOpts.replyTo = options.replyTo;
        } else if (replyMode === "first" && i === 0) {
          sendOpts.replyTo = options.replyTo;
        }
        // replyMode === "off" -> never set replyTo for non-system messages
      }

      // threadId: all chunks
      if (options?.threadId) {
        sendOpts.threadId = options.threadId;
      }

      // extra: dual-purpose pass-through for both platform-specific metadata
      // (telegramThreadScope) and rich SendMessageOptions (buttons, cards, effects).
      // Spread known top-level SendMessageOptions keys, preserve remainder as extra.
      if (options?.extra) {
        const { buttons, cards, effects, threadReply, ...rest } = options.extra as Record<string, unknown>;
        if (buttons !== undefined) (sendOpts as Record<string, unknown>).buttons = buttons;
        if (cards !== undefined) (sendOpts as Record<string, unknown>).cards = cards;
        if (effects !== undefined) (sendOpts as Record<string, unknown>).effects = effects;
        if (threadReply !== undefined) (sendOpts as Record<string, unknown>).threadReply = threadReply;
        if (Object.keys(rest).length > 0) sendOpts.extra = rest;
      }

      // --- Queue: enqueue before send ---
      let entryId: string | null = null;
      if (deps?.deliveryQueue) {
        const enqueueResult = await deps.deliveryQueue.enqueue({
          text: chunk,
          channelType: adapter.channelType,
          channelId,
          tenantId,
          optionsJson: JSON.stringify(sendOpts),
          origin: options?.origin ?? "unknown",
          formatApplied: true,
          chunkingApplied: true,
          maxAttempts: 5,
          createdAt: Date.now(),
          scheduledAt: Date.now(),
          expireAt: Date.now() + 3_600_000, // 1 hour
          traceId,
        });

        if (enqueueResult.ok) {
          entryId = enqueueResult.value;
          // Emit delivery:enqueued event
          deps.eventBus?.emit("delivery:enqueued", {
            entryId,
            channelId,
            channelType: adapter.channelType,
            origin: options?.origin ?? "unknown",
            timestamp: Date.now(),
          });
        }
        // If enqueue fails, log and continue -- queue failure should not block delivery
      }

      // Send with or without retry
      const retried = Boolean(deps?.retryEngine);
      const chunkSendStart = Date.now();

      // Build the send promise WITHOUT awaiting yet, so we can register it
      // in deps.inFlightSends synchronously before the underlying HTTPS POST
      // is observable as in-flight. This guarantees that a SIGUSR2 hitting
      // mid-send will see the promise in the Set and drain it before tearing
      // down adapters (avoids orphaned SQLite delivery-queue acks and the
      // resulting duplicate-message retry on the next instance).
      const sendPromise: Promise<Result<string, Error>> = deps?.retryEngine
        ? deps.retryEngine.sendWithRetry(
            // RetryEngine expects a ChannelPort-like adapter -- our
            // DeliveryAdapter has the same sendMessage signature, so cast
            // through unknown
            adapter as unknown as Parameters<RetryEngine["sendWithRetry"]>[0],
            channelId,
            chunk,
            sendOpts,
          )
        : adapter.sendMessage(channelId, chunk, sendOpts);

      if (deps?.inFlightSends) {
        const tracked: Promise<unknown> = sendPromise;
        deps.inFlightSends.add(tracked);
        // .finally fires on both fulfillment and rejection -- guarantees
        // Set cleanup even if sendPromise rejects. We intentionally do
        // not await this side-effect; the void keeps no-floating-promise
        // lint quiet without altering the awaited value below.
        void sendPromise.finally(() => {
          deps.inFlightSends?.delete(tracked);
        });
      }

      const result: Result<string, Error> = await sendPromise;

      const chunkResult: ChunkDeliveryResult = {
        ok: result.ok,
        charCount: chunk.length,
        retried,
      };

      if (result.ok) {
        chunkResult.messageId = result.value;

        // --- Queue: ack on success ---
        if (entryId && deps?.deliveryQueue) {
          // ack failure is non-fatal -- log and continue
          await deps.deliveryQueue.ack(entryId, result.value);
          deps.eventBus?.emit("delivery:acked", {
            entryId,
            channelId,
            channelType: adapter.channelType,
            messageId: result.value,
            durationMs: Date.now() - chunkSendStart,
            timestamp: Date.now(),
          });
        }
      } else {
        chunkResult.error = result.error;

        // --- Queue: nack or fail on error ---
        if (entryId && deps?.deliveryQueue) {
          const errorMsg = result.error.message;

          if (strategy === "best-effort") {
            // Best-effort: fail the queue entry (terminal -- no drain re-delivery of stale chunks)
            await deps.deliveryQueue.fail(entryId, errorMsg);
            deps.eventBus?.emit("delivery:failed", {
              entryId,
              channelId,
              channelType: adapter.channelType,
              error: errorMsg,
              reason: "permanent_error",
              timestamp: Date.now(),
            });
          } else if (isPermanentError(errorMsg)) {
            // Permanent error -- fail immediately, no retries
            await deps.deliveryQueue.fail(entryId, errorMsg);
            deps.eventBus?.emit("delivery:failed", {
              entryId,
              channelId,
              channelType: adapter.channelType,
              error: errorMsg,
              reason: "permanent_error",
              timestamp: Date.now(),
            });
          } else if (deps.retryEngine) {
            // Retry engine was used and exhausted its retries -- fail
            await deps.deliveryQueue.fail(entryId, errorMsg);
            deps.eventBus?.emit("delivery:failed", {
              entryId,
              channelId,
              channelType: adapter.channelType,
              error: errorMsg,
              reason: "retries_exhausted",
              timestamp: Date.now(),
            });
          } else {
            // No retry engine -- nack for queue-level retry
            const nextRetryAt = Date.now() + computeQueueBackoff(0);
            await deps.deliveryQueue.nack(entryId, errorMsg, nextRetryAt);
            deps.eventBus?.emit("delivery:nacked", {
              entryId,
              channelId,
              channelType: adapter.channelType,
              error: errorMsg,
              attemptCount: 1,
              nextRetryAt,
              timestamp: Date.now(),
            });
          }
        }

        // --- Strategy branching after failure ---
        chunkResults.push(chunkResult);

        // Emit per-chunk event before potential break
        if (deps?.eventBus) {
          deps.eventBus.emit("delivery:chunk_sent", {
            channelId,
            channelType: adapter.channelType,
            chunkIndex: i,
            totalChunks: chunks.length,
            charCount: chunk.length,
            ok: false,
            retried,
            timestamp: Date.now(),
          });
        }

        if (strategy === "best-effort") {
          // Best-effort: call onChunkError and continue to next chunk
          options?.onChunkError?.(result.error, i, chunks.length);
          continue;
        } else {
          // all-or-abort: stop sending remaining chunks
          break;
        }
      }

      chunkResults.push(chunkResult);

      // Emit per-chunk event
      if (deps?.eventBus) {
        deps.eventBus.emit("delivery:chunk_sent", {
          channelId,
          channelType: adapter.channelType,
          chunkIndex: i,
          totalChunks: chunks.length,
          charCount: chunk.length,
          ok: result.ok,
          retried,
          timestamp: Date.now(),
        });
      }
    }

    // --- 5. AGGREGATE ---
    const deliveredChunks = chunkResults.filter((r) => r.ok).length;
    const failedChunks = chunkResults.filter((r) => !r.ok).length;
    const totalChars = chunkResults.reduce((sum, r) => sum + r.charCount, 0);

    const deliveryResult: DeliveryResult = {
      ok: failedChunks === 0,
      totalChunks: chunkResults.length,
      deliveredChunks,
      failedChunks,
      chunks: chunkResults,
      totalChars,
    };

    // Emit delivery:complete event (only if NOT aborted -- delivery:aborted was emitted in the loop)
    if (deps?.eventBus && !aborted) {
      deps.eventBus.emit("delivery:complete", {
        channelId,
        channelType: adapter.channelType,
        totalChunks: deliveryResult.totalChunks,
        deliveredChunks: deliveryResult.deliveredChunks,
        failedChunks: deliveryResult.failedChunks,
        totalChars: deliveryResult.totalChars,
        durationMs: Date.now() - startTime,
        origin: options?.origin ?? "unknown",
        strategy,
        timestamp: Date.now(),
      });
    }

    // --- 6. HOOKS: after_delivery -- skip for aborted deliveries ---
    if (hookRunner && !aborted) {
      const afterCtx = tryGetContext();
      suppressError(
        hookRunner.runAfterDelivery(
          {
            text: deliveryText,
            channelType: adapter.channelType,
            channelId,
            result: deliveryResult,
            durationMs: Date.now() - startTime,
            origin: options?.origin ?? "unknown",
          },
          {
            sessionKey: afterCtx?.sessionKey,
            agentId: undefined,
            traceId: afterCtx?.traceId,
          },
        ),
        "after_delivery hook failed",
      );
    }

    return ok(deliveryResult);
  } catch (error) {
    // Unexpected error -- wrap in Result
    const wrapped = error instanceof Error ? error : new Error(String(error));
    return err(wrapped);
  }
}
