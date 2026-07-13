// SPDX-License-Identifier: Apache-2.0
/**
 * DeliveryService factory.
 *
 * The single outbound-delivery entry point for channel adapters:
 *  1. Hooks run through `deps.hookRunner` — REQUIRED, injected at
 *     construction, never resolved from global state.
 *  2. Deps are captured in closure at construction (`deps.deliveryQueue` is
 *     REQUIRED; eventBus / retryEngine / abortSignal / maxCharsOverride /
 *     replyMode are optional, so the INNER `?.` on those fields is
 *     deliberate). In-flight outbound `Promise` tracking is owned internally
 *     by the factory and drained via the public `drainInFlight()` method —
 *     callers must NOT inject a tracking Set via deps.
 *
 * Hook execution order, traceId propagation, the suppressError wrap on
 * after_delivery, and all `delivery:*` event emissions are load-bearing
 * contracts pinned by the pipeline tests in delivery-service.test.ts.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err, suppressError, checkAborted } from "@comis/shared";
import { scrubSecretsFromText } from "../security/secret-egress-guard.js";

import type { HookRunner } from "../hooks/hook-runner.js";
import type { TypedEventBus } from "../event-bus/bus.js";
import type {
  DeliveryQueuePort,
} from "../ports/delivery-queue.js";
import type { SendMessageOptions } from "../ports/channel.js";
import { tryGetContext } from "../context/context.js";

import { formatForChannel } from "./format-for-channel.js";
import { chunkForDelivery } from "./chunk-for-delivery.js";
import { chunkBlocks } from "./block-chunker.js";
import type { RetryEngine } from "./retry-engine.js";
import { isPermanentError } from "./permanent-errors.js";
import { computeQueueBackoff, resolveChunkLimit } from "./queue-backoff.js";

import type {
  DeliveryAdapter,
  DeliverToChannelOptions,
  DeliveryStrategy,
  ChunkDeliveryResult,
  DeliveryResult,
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
 * `hookRunner` + `deliveryQueue` are REQUIRED. `eventBus`, `retryEngine`,
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

  /** Event bus. OPTIONAL — observability only; emits delivery:* events. */
  eventBus?: TypedEventBus;

  /** Retry engine. OPTIONAL — no retry without it. */
  retryEngine?: RetryEngine;

  /** Per-caller chunk-size override. OPTIONAL — defaults to DEFAULT_CHUNK_LIMIT (4000). */
  maxCharsOverride?: number;

  /** Reply mode for this delivery (off/first/all). OPTIONAL — default: "first". */
  replyMode?: "off" | "first" | "all";

  /**
   * OPTIONAL outbound-message →
   * trajectory binding for the DIRECT ack path. The recurring delivery-queue
   * DRAIN (setup-delivery.ts:drainDeliveryQueue) already binds; but the PRIMARY
   * inbound-reply path (setup-and-route → executeAndDeliver → execution-deliver
   * → this `deliverToChannel`) sends via the direct ack (enqueue in_flight →
   * adapter.sendMessage → ack). Without this callback it would never bind the
   * minted reply id → trajectory, so a reaction on a normal agent reply would
   * map-miss and never drive learning. Threaded here so the direct ack
   * binds the SAME (messageId → scope) the drain does. `undefined` when learning-
   * outcome is disabled for every agent → the direct ack does ZERO extra work
   * (byte-identity). The same callback instance feeds BOTH the drain and this
   * path, and `ReactionTrajectoryMap.record` is idempotent by messageId, so a
   * reply that traverses both (transient-nack → drain retry) cannot double-bind.
   * Invoked ONLY on a successful ack with a non-null traceId AND a non-null
   * agentId (the request ALS) — a null traceId/agentId (a pre-executor / non-
   * agent send) is a FAIL-CLOSED skip: mis-attributing a reaction to the tenantId
   * would corrupt cross-agent isolation, so we record nothing.
   */
  recordOutboundMessage?: (
    messageId: string,
    scope: { traceId: string; tenantId: string; agentId: string; sessionId: string; participantId?: string },
  ) => void;
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
  /**
   * Per-instance set of in-flight outbound sendMessage promises. Each chunk
   * send is added to the set BEFORE the await (so a SIGUSR2 hitting mid-send
   * sees the promise in the Set and can drain it) and removed via .finally()
   * on settle. Drained on shutdown via the public `drainInFlight()` method
   * with a deadline so SIGUSR2 cannot tear down adapters mid-HTTP-response
   * (which would orphan the SQLite delivery-queue ack and trigger a
   * duplicate retry on the next instance). The Set lives entirely inside
   * the factory closure — callers cannot inject one via deps.
   */
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
            deps.eventBus?.emit("delivery:hook_cancelled", {
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
        // The resolved agentId for the turn rides on the
        // request ALS (executor entry, context.ts:49). It is the partition the
        // reaction trajectory map + the byte-identity gate key on downstream —
        // NEVER the tenantId. Persisted into the queue entry's optionsJson below
        // so the drain (setup-delivery.ts) attributes a reaction on this outbound
        // to the REAL agent. `null` when absent (pre-executor paths) → the drain
        // fails closed and does not map the message.
        const agentId = ctx?.agentId ?? null;
        // Group reaction-spoof guard: the conversation PARTICIPANT — the inbound
        // sender whose message triggered this reply — rides on the request ALS as
        // ctx.userId (the inbound pipeline sets userId = sessionKey.userId =
        // msg.senderId). It is threaded onto the reaction trajectory binding so an
        // unmapped group BYSTANDER cannot inherit defaultTrustLevel and spoof
        // reaction-learning; only the participant (or an explicitly-mapped reactor)
        // drives it. `undefined` on pre-resolution paths → the trust resolution fails
        // safe to the standard defaultTrustLevel-for-unmapped behavior.
        const participantId = ctx?.userId;

        // Resolve delivery strategy
        const strategy: DeliveryStrategy = options?.strategy ?? "all-or-abort";

        // --- 4. SEND: each chunk ---
        const chunkResults: ChunkDeliveryResult[] = [];
        let aborted = false;

        for (let i = 0; i < chunks.length; i++) {
          // --- Abort check ---
          if (options?.abortSignal) {
            const abortCheck = checkAborted(options.abortSignal);
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

          // replyTo: respects replyMode. Per-call options.replyMode
          // supersedes the closure-captured deps.replyMode so callers that
          // resolve per-channel/per-chat-type variance (execution-deliver
          // reading streamingConfig.replyModeByChatType) can still override the
          // service-wide default without constructing a new DeliveryService.
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
            }
            // If enqueue fails, log and continue -- queue failure should not block delivery
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
          // .finally fires on both fulfillment and rejection -- guarantees
          // Set cleanup even if sendPromise rejects. We intentionally do
          // not await this side-effect; the void keeps no-floating-promise
          // lint quiet without altering the awaited value below.
          void sendPromise.finally(() => {
            inFlightSends.delete(tracked);
          });

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
              // ack failure is non-fatal -- log and continue
              await deps.deliveryQueue.ack(entryId, result.value);
              deps.eventBus?.emit("delivery:acked", {
                entryId,
                channelId,
                channelType: adapter.channelType,
                messageId: result.value,
                durationMs: systemNowMs() - chunkSendStart,
                timestamp: systemNowMs(),
              });
            }

            // --- Bind the minted reply id → trajectory on the
            // DIRECT ack path (the primary inbound-reply path sends HERE, not via
            // the drain). Mirrors the drain's binding (setup-delivery.ts:287) so a
            // reaction on this outbound reply resolves its trajectory. Fail-closed:
            // a null traceId OR a null agentId (a pre-executor / non-agent send) is
            // a SKIP — mis-attributing a reaction to the tenantId would corrupt
            // cross-agent isolation. The callback is undefined when
            // learning-outcome is disabled for all agents → zero extra work
            // (byte-identity). ReactionTrajectoryMap.record is idempotent by
            // messageId, so a reply that ALSO traverses the drain (transient-nack →
            // retry) cannot double-bind. Diagnosability: the bind shares the
            // SAME messageId as the delivery:acked event just emitted (so the
            // attribution is reconstructable from the event trail), and the
            // downstream observeReactionNonFatal INFO line is the proof it resolved
            // — no raw daemon.log join needed.
            if (deps.recordOutboundMessage !== undefined && traceId !== null && agentId !== null) {
              deps.recordOutboundMessage(result.value, {
                traceId,
                tenantId,
                agentId,
                sessionId: traceId, // session identity falls back to the trajectory id (scope-consistent with the drain)
                // Bind the conversation participant (the inbound sender) so a
                // reaction from an unmapped group bystander is inert (resolves to
                // "external"); only the participant inherits defaultTrustLevel.
                participantId,
              });
              // The bind above is otherwise SILENT. Emit a
              // positive, counts-only `delivery:reply_bound` so the primary-path
              // attribution is observable — a later reaction map-miss can then be
              // told apart ("bind fired → entry evicted" vs "bind never fired")
              // from the event trail in one obs call, with no daemon.log grep.
              // Same fail-closed branch as the bind; shares `messageId` with the
              // `delivery:acked` event just emitted. IDS/closed-scalars ONLY —
              // never a body or a secret (redaction discipline); `agentId` is the REAL
              // agent (never the tenantId). Only on the learning-enabled path
              // (recordOutboundMessage defined) → byte-identity when disabled.
              deps.eventBus?.emit("delivery:reply_bound", {
                messageId: result.value,
                channelId,
                channelType: adapter.channelType,
                traceId,
                agentId,
                timestamp: systemNowMs(),
              });
            }
          } else {
            chunkResult.error = result.error;

            // --- Queue: nack or fail on error ---
            if (entryId) {
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
                  timestamp: systemNowMs(),
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
                  timestamp: systemNowMs(),
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
                  timestamp: systemNowMs(),
                });
              } else {
                // No retry engine -- nack for queue-level retry
                const nextRetryAt = systemNowMs() + computeQueueBackoff(0);
                await deps.deliveryQueue.nack(entryId, errorMsg, nextRetryAt);
                deps.eventBus?.emit("delivery:nacked", {
                  entryId,
                  channelId,
                  channelType: adapter.channelType,
                  error: errorMsg,
                  attemptCount: 1,
                  nextRetryAt,
                  timestamp: systemNowMs(),
                });
              }
            }

            // --- Strategy branching after failure ---
            chunkResults.push(chunkResult);

            // Emit per-chunk event before potential break
            if (deps.eventBus) {
              deps.eventBus.emit("delivery:chunk_sent", {
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
            deps.eventBus.emit("delivery:chunk_sent", {
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
          deps.eventBus.emit("delivery:complete", {
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
