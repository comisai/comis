// SPDX-License-Identifier: Apache-2.0
/**
 * DeliveryService factory.
 *
 * The single outbound-delivery entry point for channel adapters. Hooks and
 * durable queueing are required construction dependencies; retry, events,
 * chunk limits, reply behavior, and cancellation are optional. The service
 * owns and exposes bounded draining for its in-flight sends.
 *
 * Hook execution order, traceId propagation, the suppressError wrap on
 * after_delivery, and all `delivery:*` event emissions are load-bearing
 * contracts pinned by the pipeline tests in delivery-service.test.ts.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err, suppressError, checkAborted, tryCatch } from "@comis/shared";
import { scrubSecretsFromText } from "../security/secret-egress-guard.js";

import type { HookRunner } from "../hooks/hook-runner.js";
import type { TypedEventBus } from "../event-bus/bus.js";
import type { EventMap } from "../event-bus/events.js";
import { emitObservationalEventSafely } from "../event-bus/observational-emission.js";
import type {
  DeliveryQueuePort,
} from "../ports/delivery-queue.js";
import type { SendMessageOptions } from "../ports/channel.js";
import type { ComisLogger } from "../logging/log-fields.js";
import { toSafeErrorLogString } from "../security/log-sanitizer.js";
import { tryGetContext } from "../context/context.js";

import { formatForChannel } from "./format-for-channel.js";
import { chunkForDelivery } from "./chunk-for-delivery.js";
import { chunkBlocks } from "./block-chunker.js";
import {
  AMBIGUOUS_SEND_OUTCOME_ERROR,
  classifySendError,
  EXPLICIT_SEND_REJECTION_ERROR,
  RETRY_EXHAUSTED_SEND_ERROR,
  type RetryEngine,
} from "./retry-engine.js";
import { isPermanentError } from "./permanent-errors.js";
import { computeQueueBackoff, resolveChunkLimit } from "./queue-backoff.js";

import {
  DeliveryQueueTransitionError,
  type DeliveryQueueTransition,
  type DeliveryQueueTransitionFailure,
  type DeliveryAdapter,
  type DeliverToChannelOptions,
  type DeliveryStrategy,
  type ChunkDeliveryResult,
  type DeliveryResult,
} from "./types.js";
import { systemNowMs, systemSetTimeout } from "../runtime/system-time.js";

// ---------------------------------------------------------------------------
// Constants — platform sets local to the delivery pipeline. The chunk-limit
// default and queue-backoff schedule live in `./queue-backoff.js`.
// ---------------------------------------------------------------------------

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

const PASSTHROUGH_PLATFORMS = new Set(["discord", "gateway", "echo"]);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Dependencies for createDeliveryService.
 *
 * `hookRunner` + `deliveryQueue` + `logger` are REQUIRED. `eventBus`, `retryEngine`,
 * `maxCharsOverride`, `replyMode`, and `abortSignal` are optional
 * per-instance / per-call knobs.
 *
 * Note: in-flight outbound `Promise` tracking is an internal concern of
 * `createDeliveryService` (no `inFlightSends` deps field). The drain is
 * exposed via the public `drainInFlight()` method on the returned service.
 */
export interface DeliveryServiceDeps {
  /** Hook runner. REQUIRED — hooks are injected, never resolved from global state. */
  hookRunner: HookRunner;

  /**
   * Delivery queue for crash-safe persistence. REQUIRED. Use
   * `createNoOpDeliveryQueue()` from `@comis/core` when the queue feature
   * is disabled.
   */
  deliveryQueue: DeliveryQueuePort;
  /** Module-bound structured logger. REQUIRED for queue durability failures. */
  logger: ComisLogger;
  /** Event bus. OPTIONAL — observability only; emits delivery:* events. */
  eventBus?: TypedEventBus;

  /** Retry engine. OPTIONAL — no retry without it. */
  retryEngine?: RetryEngine;

  /** Per-caller chunk-size override. OPTIONAL — defaults to DEFAULT_CHUNK_LIMIT (4000). */
  maxCharsOverride?: number;

  /** Reply mode for this delivery (off/first/all). OPTIONAL — default: "first". */
  replyMode?: "off" | "first" | "all";

  /**
   * Optional binding from a successfully minted platform message ID to its
   * request trajectory. The callback is idempotent because direct delivery and
   * a later queue retry can observe the same message. It still runs when a queue
   * transition fails because the platform ID remains authoritative. Missing
   * trace or agent identity fails closed to prevent cross-agent attribution.
   */
  recordOutboundMessage?: (
    messageId: string,
    scope: { traceId: string; tenantId: string; agentId: string; sessionId: string; participantId?: string },
  ) => void;
}

function emitDeliveryEvent<K extends keyof EventMap>(
  deps: Pick<DeliveryServiceDeps, "eventBus" | "logger">,
  event: K,
  payload: EventMap[K],
): void {
  if (deps.eventBus === undefined) return;
  emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, event, payload);
}

function reportQueueTransitionFailure(
  deps: Pick<DeliveryServiceDeps, "eventBus" | "logger">,
  transition: DeliveryQueueTransition, deliveryId: string | null, cause: Error,
  channelId: string, channelType: string,
): DeliveryQueueTransitionFailure {
  const errorKind = "dependency" as const;
  const timestamp = systemNowMs();
  deps.logger.warn({
    step: "delivery-queue-transition",
    transition,
    deliveryId,
    channelId,
    channelType,
    err: toSafeErrorLogString(cause),
    errorKind,
    hint: "Check delivery queue storage health and restore writable persistence before retrying",
  }, "Delivery queue transition failed");
  emitDeliveryEvent(deps, "delivery:queue_transition_failed", {
    deliveryId,
    transition,
    errorKind,
    channelId,
    channelType,
    timestamp,
  });
  return { transition, deliveryId, errorKind, cause };
}
/**
 * DeliveryService — outbound delivery + shutdown drain.
 *
 * No speculative methods — add ops only when call sites exist.
 * `abortSignal` rides on the per-call options argument, not on the
 * construction-time deps.
 */
export interface DeliveryService {
  deliverToChannel(
    adapter: DeliveryAdapter,
    channelId: string,
    text: string,
    options?: DeliverToChannelOptions & { abortSignal?: AbortSignal },
  ): Promise<Result<DeliveryResult, Error>>;

  /**
   * Drain in-flight outbound sends with a deadline.
   *
   * SIGUSR2 hot-reload calls this from channel-manager.stopAll() so adapter
   * teardown does not race against in-flight HTTP requests (which would
   * orphan the SQLite delivery-queue ack and trigger duplicate retries).
   *
   * Returns telemetry — drain count, remaining count, duration ms — for
   * caller logging. Never throws; remaining > 0 indicates deadline expired.
   *
   * @param deadlineMs - Maximum wait time. Defaults to 5000.
   */
  drainInFlight(deadlineMs?: number): Promise<{ drained: number; remaining: number; durationMs: number }>;
}

/**
 * Construct a DeliveryService bound to the provided dependencies.
 *
 * Dependencies are captured in closure; subsequent calls all observe the same
 * hookRunner / deliveryQueue / eventBus / retryEngine references.
 *
 * IMPORTANT: This factory MUST NOT call `tryGetContext()` or any
 * AsyncLocalStorage helpers at construction time — those are per-request
 * concerns. The closure captures `deps`; per-request context (traceId,
 * sessionKey) is resolved INSIDE the method body.
 */
export function createDeliveryService(deps: DeliveryServiceDeps): DeliveryService {
  // Register each send before awaiting it so shutdown can drain transport work
  // before adapter teardown. The set is private to this service instance.
  const inFlightSends = new Set<Promise<unknown>>();

  return {
    async deliverToChannel(
      adapter: DeliveryAdapter,
      channelId: string,
      text: string,
      options?: DeliverToChannelOptions & { abortSignal?: AbortSignal },
    ): Promise<Result<DeliveryResult, Error>> {
      const startTime = systemNowMs();

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
        // deps.hookRunner is REQUIRED, so the variable is always present
        // (no if-guard needed). An empty plugin registry still causes
        // runBeforeDelivery to return undefined (see
        // hooks/hook-runner.ts:runModifyingHook empty-registry short-circuit).
        let deliveryText = text;

        // --- One-pass egress secret scan BEFORE hooks and chunking ---
        // mightContainSecret pre-filter inside — secret-free messages pay near-zero cost.
        // Scan is here (not inside the chunk loop) to satisfy the O(1) per-delivery
        // perf contract: secret-free 10k-char messages complete in <5ms.
        const egressScrub = scrubSecretsFromText(deliveryText);
        if (egressScrub.redactions > 0) {
          deliveryText = egressScrub.text;
        }

        const hookRunner = deps.hookRunner;
        {
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
            emitDeliveryEvent(deps, "delivery:hook_cancelled", {
              channelId,
              channelType: adapter.channelType,
              reason: hookResult.cancelReason ?? "unknown",
              origin: options?.origin ?? "unknown",
              timestamp: systemNowMs(),
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
        const maxChars = resolveChunkLimit(deps.maxCharsOverride);

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
          // Passthrough platforms (discord, echo): raw markdown, use IR chunker
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
        // Persist the request-scoped agent identity for queue-drain attribution;
        // missing identity fails closed instead of substituting the tenant.
        const agentId = ctx?.agentId ?? null;
        // Bind reactions to the inbound participant so an unmapped group
        // bystander cannot inherit the participant's trust.
        const participantId = ctx?.userId;

        // Resolve delivery strategy
        const strategy: DeliveryStrategy = options?.strategy ?? "all-or-abort";

        // --- 4. SEND: each chunk ---
        const chunkResults: ChunkDeliveryResult[] = [];
        const queueTransitionFailures: DeliveryQueueTransitionFailure[] = [];
        let aborted = false;

        for (let i = 0; i < chunks.length; i++) {
          // --- Abort check ---
          if (options?.abortSignal) {
            const abortCheck = checkAborted(options.abortSignal);
            if (!abortCheck.ok) {
              aborted = true;
              const reason = abortCheck.error.message;
              // Emit delivery:aborted event
              emitDeliveryEvent(deps, "delivery:aborted", {
                channelId,
                channelType: adapter.channelType,
                reason,
                chunksDelivered: chunkResults.filter(r => r.ok).length,
                totalChunks: chunks.length,
                durationMs: systemNowMs() - startTime,
                origin: options?.origin ?? "unknown",
                timestamp: systemNowMs(),
              });
              break;
            }
          }

          const chunk = chunks[i];

          // Build SendMessageOptions
          const sendOpts: SendMessageOptions = {};

          // A per-call reply mode overrides the service default for
          // channel- or chat-specific routing.
          if (options?.replyTo) {
            const replyMode = options?.replyMode ?? deps.replyMode ?? "first";
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

          // subject: all chunks (email forms a "Re: <subject>" reply subject so
          // the reply threads and never shows an empty subject line; channels
          // without a subject concept ignore it).
          if (options?.subject) {
            sendOpts.subject = options.subject;
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

          // --- Queue: enqueue (in_flight lease) before send ---
          // We insert with status='in_flight' so the recurring drainer's
          // `WHERE status='pending'` filter does NOT race-pick this row mid-send.
          // On successful send, ack flips
          // 'in_flight' -> 'delivered'; on permanent failure, fail flips
          // 'in_flight' -> 'failed'; on transient failure, nack flips
          // 'in_flight' -> 'pending' for the drainer to retry. All ack/nack/fail
          // statements are status-agnostic UPDATE-by-id, so no SQL change is needed.
          let entryId: string | null = null;
          // deps.deliveryQueue is REQUIRED in DeliveryServiceDeps — no
          // null-guard needed here.
          {
            // Persist agentId into the serialized options so
            // the drain reads the REAL agent (drain reads options.agentId). It is
            // added to a SEPARATE persistence object — NOT to `sendOpts` — so it
            // never rides into the platform `adapter.sendMessage` call. Omitted
            // entirely when absent (pre-executor paths), keeping the drain
            // fail-closed rather than mis-attributing to the tenantId.
            //
            // Likewise persist the conversation participant (ctx.userId) so
            // a reaction resolved via the DRAIN path (not the direct ack) is also
            // participant-aware — an unmapped group bystander stays inert. Omitted
            // when absent; the drain then threads `undefined` → fail-safe.
            const persistedOptions: Record<string, unknown> = { ...sendOpts };
            if (agentId !== null) persistedOptions.agentId = agentId;
            if (participantId !== undefined) persistedOptions.participantId = participantId;
            const enqueueResult = await deps.deliveryQueue.enqueueInFlight({
              text: chunk,
              channelType: adapter.channelType,
              channelId,
              tenantId,
              optionsJson: JSON.stringify(persistedOptions),
              origin: options?.origin ?? "unknown",
              maxAttempts: 5,
              createdAt: systemNowMs(),
              scheduledAt: systemNowMs(),
              expireAt: systemNowMs() + 3_600_000, // 1 hour
              traceId,
            });

            if (enqueueResult.ok) {
              entryId = enqueueResult.value;
              // delivery:enqueued is emitted by the adapter (SqliteDeliveryQueueAdapter
              // emits inside enqueueInFlight after the INSERT succeeds -- single source of
              // truth). No-op here.
            } else {
              queueTransitionFailures.push(reportQueueTransitionFailure(
                deps, "enqueue_in_flight", null, enqueueResult.error,
                channelId, adapter.channelType,
              ));
            }
            // The platform send still proceeds so the returned transition error
            // can retain the real send outcome instead of guessing whether the
            // user received the chunk.
          }

          // Send with or without retry
          const retried = Boolean(deps.retryEngine);
          const chunkSendStart = systemNowMs();

          // Build the send promise WITHOUT awaiting yet, so we can register it
          // in the internal inFlightSends Set synchronously before the
          // underlying HTTPS POST is observable as in-flight. This guarantees
          // that a SIGUSR2 hitting mid-send will see the promise in the Set
          // and `drainInFlight()` will await it before tearing down adapters
          // (avoids orphaned SQLite delivery-queue acks and the resulting
          // duplicate-message retry on the next instance).
          const sendPromise: Promise<Result<string, Error>> = deps.retryEngine
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

          const tracked: Promise<unknown> = sendPromise;
          inFlightSends.add(tracked);
          // Register both settlement branches explicitly. Discarding a
          // `.finally()` result would create a second rejected promise when
          // the adapter rejects, even though the authoritative send below is
          // translated to Result by the outer boundary.
          const clearTrackedSend = (): void => {
            inFlightSends.delete(tracked);
          };
          void sendPromise.then(clearTrackedSend, clearTrackedSend);

          const result: Result<string, Error> = await sendPromise;

          const chunkResult: ChunkDeliveryResult = {
            ok: result.ok,
            charCount: chunk.length,
            retried,
          };

          if (result.ok) {
            chunkResult.messageId = result.value;

            // --- Queue: ack on success ---
            if (entryId) {
              const ackResult = await deps.deliveryQueue.ack(entryId, result.value);
              if (ackResult.ok) {
                emitDeliveryEvent(deps, "delivery:acked", {
                  entryId,
                  channelId,
                  channelType: adapter.channelType,
                  messageId: result.value,
                  durationMs: systemNowMs() - chunkSendStart,
                  timestamp: systemNowMs(),
                });
              } else {
                queueTransitionFailures.push(reportQueueTransitionFailure(
                  deps, "ack", entryId, ackResult.error,
                  channelId, adapter.channelType,
                ));
              }
            }

            // Bind the authoritative platform ID on the direct-send path. Missing
            // request identity skips the bind; the callback is idempotent when a
            // queue retry later observes the same message.
            if (deps.recordOutboundMessage !== undefined && traceId !== null && agentId !== null) {
              const recorded = tryCatch(() => deps.recordOutboundMessage?.(result.value, {
                traceId,
                tenantId,
                agentId,
                sessionId: traceId, // session identity falls back to the trajectory id (scope-consistent with the drain)
                // Bind the conversation participant (the inbound sender) so a
                // reaction from an unmapped group bystander is inert (resolves to
                // "external"); only the participant inherits defaultTrustLevel.
                participantId,
              }));
              if (!recorded.ok) {
                void tryCatch(() => deps.logger.warn({
                  step: "delivery-reply-bind",
                  channelId,
                  channelType: adapter.channelType,
                  err: toSafeErrorLogString(recorded.error),
                  errorKind: "internal" as const,
                  hint: "Inspect the outbound trajectory-binding callback; platform delivery succeeded but reaction attribution was not recorded",
                }, "Outbound reply trajectory binding failed"));
              }
              // Emit only closed identifiers so attribution failures can distinguish
              // a missing bind from later eviction without exposing message content.
              if (recorded.ok) {
                emitDeliveryEvent(deps, "delivery:reply_bound", {
                  messageId: result.value,
                  channelId,
                  channelType: adapter.channelType,
                  traceId,
                  agentId,
                  timestamp: systemNowMs(),
                });
              }
            }
          } else {
            chunkResult.error = result.error;

            // --- Queue: nack or fail on error ---
            if (entryId) {
              const errorMsg = result.error.message;
              const errorClassification = classifySendError(result.error);
              const uncertainOutcome = errorClassification === "uncertain";
              const failReason = uncertainOutcome
                ? "uncertain_outcome" as const
                : strategy === "best-effort" ||
                    isPermanentError(errorMsg) ||
                    errorClassification === "markdown-fallback"
                  ? "permanent_error" as const
                  : deps.retryEngine
                    ? "retries_exhausted" as const
                    : null;
              const persistedError = failReason === "uncertain_outcome"
                ? AMBIGUOUS_SEND_OUTCOME_ERROR
                : failReason === "retries_exhausted"
                  ? RETRY_EXHAUSTED_SEND_ERROR
                  : EXPLICIT_SEND_REJECTION_ERROR;

              if (failReason !== null) {
                const failResult = await deps.deliveryQueue.fail(entryId, persistedError);
                if (failResult.ok) {
                  emitDeliveryEvent(deps, "delivery:failed", {
                    entryId,
                    channelId,
                    channelType: adapter.channelType,
                    error: persistedError,
                    reason: failReason,
                    timestamp: systemNowMs(),
                  });
                } else {
                  queueTransitionFailures.push(reportQueueTransitionFailure(
                    deps, "fail", entryId, failResult.error,
                    channelId, adapter.channelType,
                  ));
                }
              } else {
                // No retry engine -- nack for queue-level retry
                const nextRetryAt = systemNowMs() + computeQueueBackoff(0);
                const nackResult = await deps.deliveryQueue.nack(
                  entryId,
                  EXPLICIT_SEND_REJECTION_ERROR,
                  nextRetryAt,
                );
                if (nackResult.ok) {
                  emitDeliveryEvent(deps, "delivery:nacked", {
                    entryId,
                    channelId,
                    channelType: adapter.channelType,
                    error: EXPLICIT_SEND_REJECTION_ERROR,
                    attemptCount: 1,
                    nextRetryAt,
                    timestamp: systemNowMs(),
                  });
                } else {
                  queueTransitionFailures.push(reportQueueTransitionFailure(
                    deps, "nack", entryId, nackResult.error,
                    channelId, adapter.channelType,
                  ));
                }
              }
            }

            // --- Strategy branching after failure ---
            chunkResults.push(chunkResult);

            // Emit per-chunk event before potential break
            if (deps.eventBus) {
              emitDeliveryEvent(deps, "delivery:chunk_sent", {
                channelId,
                channelType: adapter.channelType,
                chunkIndex: i,
                totalChunks: chunks.length,
                charCount: chunk.length,
                ok: false,
                retried,
                timestamp: systemNowMs(),
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
          if (deps.eventBus) {
            emitDeliveryEvent(deps, "delivery:chunk_sent", {
              channelId,
              channelType: adapter.channelType,
              chunkIndex: i,
              totalChunks: chunks.length,
              charCount: chunk.length,
              ok: result.ok,
              retried,
              timestamp: systemNowMs(),
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
        if (deps.eventBus && !aborted) {
          emitDeliveryEvent(deps, "delivery:complete", {
            channelId,
            channelType: adapter.channelType,
            totalChunks: deliveryResult.totalChunks,
            deliveredChunks: deliveryResult.deliveredChunks,
            failedChunks: deliveryResult.failedChunks,
            totalChars: deliveryResult.totalChars,
            durationMs: systemNowMs() - startTime,
            origin: options?.origin ?? "unknown",
            strategy,
            timestamp: systemNowMs(),
          });
        }

        // --- 6. HOOKS: after_delivery -- skip for aborted deliveries ---
        // hookRunner is always present (deps.hookRunner is REQUIRED).
        if (!aborted) {
          const afterCtx = tryGetContext();
          suppressError(
            hookRunner.runAfterDelivery(
              {
                text: deliveryText,
                channelType: adapter.channelType,
                channelId,
                result: deliveryResult,
                durationMs: systemNowMs() - startTime,
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

        if (queueTransitionFailures.length > 0) {
          return err(new DeliveryQueueTransitionError(queueTransitionFailures, deliveryResult));
        }
        return ok(deliveryResult);
      } catch (error) {
        // Unexpected error -- wrap in Result
        const wrapped = error instanceof Error ? error : new Error(String(error));
        return err(wrapped);
      }
    },

    async drainInFlight(
      deadlineMs = 5000,
    ): Promise<{ drained: number; remaining: number; durationMs: number }> {
      const start = systemNowMs();
      const inFlightCount = inFlightSends.size;
      if (inFlightCount === 0) {
        return { drained: 0, remaining: 0, durationMs: 0 };
      }
      // Race the in-flight settles against the deadline timer. `systemSetTimeout`
      // is the sanctioned-root indirection for `setTimeout`
      // (the only sanctioned-root in `packages/core/src/runtime/system-time.ts`).
      await Promise.race([
        Promise.allSettled([...inFlightSends]),
        new Promise<void>((resolve) => {
          const handle = systemSetTimeout(() => resolve(), deadlineMs);
          handle.unref?.();
        }),
      ]);
      return {
        drained: inFlightCount - inFlightSends.size,
        remaining: inFlightSends.size,
        durationMs: systemNowMs() - start,
      };
    },
  };
}
