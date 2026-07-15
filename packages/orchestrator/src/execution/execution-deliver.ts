// SPDX-License-Identifier: Apache-2.0
/**
 * Execution pipeline stage: block delivery.
 *
 * Handles chunking, block coalescing, block pacer creation, delivery
 * to channel, streaming progress events, and delivery metrics logging.
 *
 * @module
 */

import type {
  ChannelPort,
  NormalizedMessage,
  PerChannelStreamingConfig,
  ClockPort,
  DeliveryStageResult,
  FinalDeliveryReceipt,
  DeliveryFailureReceipt,
} from "@comis/core";
import {
  resolvePlatformDeliveryResult,
  tryGetContext,
  chunkForDelivery,
  createBlockRetryGuard,
  systemNowMs,
  sanitizeLogString,
} from "@comis/core";
import { ok, err } from "@comis/shared";

import type { ExecutionPipelineDeps } from "./execution-pipeline.js";
import { buildThreadSendOpts } from "./execution-pipeline.js";
import { createBlockPacer, coalesceBlocks } from "@comis/channels";
import type { BlockPacer, TypingLifecycleController } from "@comis/channels";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for the delivery stage. */
export type DeliverDeps = Pick<
  ExecutionPipelineDeps,
  "eventBus" | "logger" | "streamingConfig" | "channelRegistry" | "retryEngine" | "deliveryQueue" | "deliveryService"
> & {
  /**
   * Optional injected clock. When present, `deliveredAtMs` is read from it
   * (deterministic in tests). When absent, the sanctioned-root `systemNowMs()`
   * is used — this stage is one of the sanctioned roots for `systemNowMs`
   * (it already uses it for delivery metrics).
   */
  clock?: ClockPort;
};

/**
 * `delivery.visibleReplies` policy threaded into the delivery stage.
 * The resolved per-chat-type mode + whether the `message` tool acted
 * (`send`/`reply`/`attach`) this turn. When the policy for the inbound chat type
 * is `"message_tool"` and the tool did NOT act, the final assistant text is
 * suppressed (the activity/approval surfaces and lifecycle reactions are
 * unaffected — they are produced elsewhere).
 */
export interface VisibleRepliesEnforcement {
  visibleReplies: { direct: "automatic" | "message_tool"; group: "automatic" | "message_tool" };
  /** True if the model called the `message` tool with send/reply/attach this turn. */
  messageToolActed: boolean;
}

/** Truncation cap for the failure receipt's `lastError`. */
const MAX_LAST_ERROR_CHARS = 200;

/** A success receipt for a turn where delivery was intentionally suppressed (visibleReplies). */
const SUPPRESSED_RECEIPT: FinalDeliveryReceipt = {
  ok: true,
  deliveredChunks: 0,
  lastChunkMessageId: "",
  deliveredAtMs: 0,
};

// ---------------------------------------------------------------------------
// Stage function
// ---------------------------------------------------------------------------

/**
 * Chunk, coalesce, pace, and deliver the response text to the channel.
 *
 * Handles block streaming delivery with human-like pacing, retry guards,
 * and delivery metrics logging.
 */
export async function deliverExecutionResponse(
  deps: DeliverDeps,
  adapter: ChannelPort,
  effectiveMsg: NormalizedMessage,
  finalDeliveryText: string,
  blockStreamCfg: PerChannelStreamingConfig,
  activePacers: Set<BlockPacer>,
  replyTo: string | undefined,
  deliverySignal: AbortSignal,
  typingLifecycle: TypingLifecycleController | undefined,
  enforcement?: VisibleRepliesEnforcement,
): Promise<DeliveryStageResult> {
  // === VISIBLE-REPLIES ENFORCEMENT ===
  // Runs AFTER the response filter (the caller passes the post-filter
  // finalDeliveryText) and BEFORE any assistant-text delivery. When the chat
  // type's policy is "message_tool" and the model did not call the `message`
  // tool with send/reply/attach, the final assistant text is suppressed: the
  // tool already produced the user-visible output, so re-sending the model's
  // narration would double-post. Activity/approval surfaces + lifecycle
  // reactions are produced elsewhere and are NOT affected by this gate.
  if (enforcement) {
    const chatType = effectiveMsg.chatType ?? "dm";
    const policy = chatType === "dm" ? enforcement.visibleReplies.direct : enforcement.visibleReplies.group;
    if (policy === "message_tool" && !enforcement.messageToolActed) {
      const suppressCtx = tryGetContext();
      deps.logger.debug({
        traceId: suppressCtx?.traceId,
        step: "visible-replies",
        chatType,
        policy,
        messageToolActed: false,
      }, "Final assistant text suppressed by visibleReplies=message_tool");
      return ok(SUPPRESSED_RECEIPT);
    }
  }

  // Capability-driven config lookup
  const caps = deps.channelRegistry?.getCapabilities(adapter.channelType);

  // Chunk the response at natural boundaries.
  const maxChars = blockStreamCfg.chunkMaxChars ?? caps?.limits?.maxMessageChars ?? 4096;
  const blocks = chunkForDelivery(finalDeliveryText, adapter.channelType, {
    maxChars,
    tableMode: blockStreamCfg.tableMode ?? "code",
    useMarkdownIR: blockStreamCfg.useMarkdownIR,
    chunkMode: blockStreamCfg.chunkMode,
    chunkMinChars: blockStreamCfg.chunkMinChars,
  });

  const chunkCtx = tryGetContext();
  deps.logger.debug({
    traceId: chunkCtx?.traceId,
    step: "chunking",
    inputLen: finalDeliveryText.length,
    itemCount: blocks.length,
    reason: blockStreamCfg.useMarkdownIR ? "markdown-ir" : blockStreamCfg.chunkMode,
    chunkSizes: blocks.map(b => b.length),
    formatMode: blockStreamCfg.useMarkdownIR ? `${adapter.channelType}-markdown-ir` : (blockStreamCfg.chunkMode ?? "paragraph"),
  }, "Response chunked for delivery");

  // === BLOCK COALESCING ===
  const coalescerCfg = blockStreamCfg.coalescer;
  const { groups: coalescedGroups, flushEvents } = coalesceBlocks(blocks, coalescerCfg);

  // Emit coalesce:flushed events
  for (const evt of flushEvents) {
    deps.eventBus.emit("coalesce:flushed", {
      channelId: adapter.channelId,
      chatId: effectiveMsg.channelId,
      blockCount: evt.blockCount,
      charCount: evt.charCount,
      trigger: evt.trigger,
      timestamp: systemNowMs(),
    });
  }

  // 'message' mode: start typing just before block delivery
  if (blockStreamCfg.typingMode === "message" && typingLifecycle?.controller && !typingLifecycle.controller.isActive) {
    typingLifecycle.controller.start(effectiveMsg.channelId);
    deps.eventBus.emit("typing:started", {
      channelId: adapter.channelId,
      chatId: effectiveMsg.channelId,
      mode: blockStreamCfg.typingMode,
      timestamp: systemNowMs(),
    });
  }

  // Resolve replyMode from config chain
  const chatType = effectiveMsg.chatType ?? "dm";
  const resolvedReplyMode =
    blockStreamCfg.replyModeByChatType?.[chatType]
    ?? blockStreamCfg.replyMode
    ?? deps.streamingConfig?.defaultReplyMode
    ?? "first";

  // Capture delivery start for duration tracking
  const deliveryStartMs = performance.now();
  let deliveredChunks = 0;
  let failedChunks = 0;
  // The REAL message id of the last successfully-delivered chunk
  // (replaces the synthetic "block-delivery" id at the pipeline call site) and
  // the first failure's classified error (for the DeliveryFailureReceipt).
  let lastChunkMessageId = "";
  let firstFailure: { errorKind: DeliveryFailureReceipt["errorKind"]; message: string } | undefined;

  // Create block pacer for human-like delivery timing
  const pacer = createBlockPacer({
    timingConfig: blockStreamCfg.deliveryTiming,
    coalesceMaxChars: coalescerCfg.maxChars,
    disableCoalescing: true,
    externalSignal: deliverySignal,
  });
  activePacers.add(pacer);

  try {
    let blockIndex = 0;
    const totalBlocks = coalescedGroups.length;
    const blockGuard = deps.retryEngine ? createBlockRetryGuard() : undefined;
    await pacer.deliver(coalescedGroups, async (text) => {
      const threadOpts = buildThreadSendOpts(effectiveMsg.metadata);

      // Method form via threaded DeliveryService. retryEngine /
      // deliveryQueue / eventBus / in-flight tracking are captured by the
      // closure at composition root; replyMode + abortSignal still ride per-call.
      const deliveryResult = await deps.deliveryService.deliverToChannel(adapter, effectiveMsg.channelId, text, {
        replyTo: blockIndex === 0 ? replyTo : undefined,
        // Original subject rides through so subject-threading channels (email)
        // can form a "Re: <subject>" reply; only inbound email messages carry
        // emailSubject metadata, so other channels get undefined and ignore it.
        subject: effectiveMsg.metadata?.emailSubject as string | undefined,
        threadId: threadOpts?.threadId,
        extra: threadOpts?.extra,
        skipFormat: true,
        skipChunking: true,
        origin: "agent",
        replyMode: resolvedReplyMode,
        abortSignal: deliverySignal,
      });

      const platformDelivery = resolvePlatformDeliveryResult(deliveryResult);
      const platformResult = platformDelivery.ok ? platformDelivery.value : undefined;

      if (platformResult === undefined || !platformResult.ok) {
        failedChunks++;
        const chunkErr = platformDelivery.ok ? undefined : platformDelivery.error;
        // Record the FIRST failure for the DeliveryFailureReceipt.
        // Chat-platform send failures classify as "platform" (AGENTS.md §2.1).
        if (!firstFailure) {
          const failChunk = platformResult?.chunks.find((c) => !c.ok);
          const rawMessage =
            chunkErr instanceof Error ? chunkErr.message
              : failChunk?.error instanceof Error ? failChunk.error.message
                : "delivery failed";
          firstFailure = { errorKind: "platform", message: rawMessage };
        }
        const dlvCtx = tryGetContext();
        deps.logger.warn({
          traceId: dlvCtx?.traceId,
          channelType: effectiveMsg.channelType ?? "unknown",
          chatId: effectiveMsg.channelId,
          deliveryStatus: "failed",
          deliveredChunks,
          failedChunks,
          err: chunkErr instanceof Error ? chunkErr : (chunkErr != null ? String(chunkErr) : "unknown"),
          hint: "Message delivery to channel failed -- user may not have received the response",
          errorKind: "platform" as const,
        }, "Delivery failure");
        blockGuard?.recordFailure();
        if (blockGuard?.shouldAbort) {
          deps.logger.warn({ channelId: effectiveMsg.channelId, hint: "Multiple consecutive send failures; check platform connectivity", errorKind: "network" as const }, "Block delivery aborted after consecutive failures");
          return;
        }
      } else {
        deliveredChunks++;
        blockGuard?.recordSuccess();
        // Capture the real last-chunk message id from the delivery result.
        // The last successful chunk in this group wins; the final group's last
        // chunk is the receipt's lastChunkMessageId.
        const lastOk = [...platformResult.chunks].reverse().find((c) => c.ok && c.messageId);
        if (lastOk?.messageId) lastChunkMessageId = lastOk.messageId;
      }

      // Pipeline-specific UX event: block index tracking for streaming progress.
      deps.eventBus.emit("streaming:block_sent", {
        channelId: adapter.channelId,
        chatId: effectiveMsg.channelId,
        blockIndex,
        totalBlocks,
        charCount: text.length,
        timestamp: systemNowMs(),
      });
      blockIndex++;
    });
    // Signal delivery complete -- typing can now stop
    typingLifecycle?.markDispatchIdle();
  } finally {
    activePacers.delete(pacer);
  }

  // Capture the settle timestamp the moment the last chunk's send-promise
  // resolved — i.e. right after pacer.deliver settles, before any post-delivery
  // bookkeeping. Injected ClockPort when present (deterministic tests); otherwise
  // the sanctioned-root systemNowMs (this stage is a sanctioned root). Used as
  // deliveredAtMs on the success receipt and failedAtMs on the failure receipt.
  const settledAtMs = deps.clock ? deps.clock.now() : systemNowMs();

  // Blocks the pacer never attempted because the external signal aborted
  // mid-delivery (its hard-stop skips the remainder WITHOUT sending). Counting
  // only FAILED chunks read a fully-skipped delivery as success — observed
  // live: a spend-aborted turn logged success:true while the user received
  // nothing. The skip is not a platform failure (nothing was attempted), so
  // the receipt shape is unchanged; the LOGS must carry the truth.
  const skippedChunks = deliverySignal.aborted
    ? Math.max(0, coalescedGroups.length - (deliveredChunks + failedChunks))
    : 0;
  const deliveryCtx = tryGetContext();
  if (skippedChunks > 0) {
    deps.logger.warn({
      traceId: deliveryCtx?.traceId,
      channelType: effectiveMsg.channelType ?? "unknown",
      chatId: effectiveMsg.channelId,
      skippedChunks,
      totalChunks: coalescedGroups.length,
      hint: "Execution abort cut delivery short — the remaining blocks were never sent and the user did not receive them; check the execution:aborted reason for this turn",
      errorKind: "precondition" as const,
    }, "Block delivery skipped by aborted execution");
    // The pacer's hard stop never reaches deliverToChannel, so none of the
    // delivery events fire — the trajectory records NOTHING for a turn whose
    // reply was never sent. Announce the skip on the existing
    // delivery:aborted event (chunksDelivered counts what DID go out before
    // the signal fired) so `explain` shows the undelivered turn.
    deps.eventBus.emit("delivery:aborted", {
      channelId: effectiveMsg.channelId,
      channelType: effectiveMsg.channelType ?? "unknown",
      reason: typeof deliverySignal.reason === "string" ? deliverySignal.reason : "aborted",
      chunksDelivered: deliveredChunks,
      totalChunks: coalescedGroups.length,
      durationMs: Math.round(performance.now() - deliveryStartMs),
      origin: "agent",
      timestamp: systemNowMs(),
    });
  }
  deps.logger.debug({
    traceId: deliveryCtx?.traceId,
    step: "block-delivery",
    rawBlocks: blocks.length,
    coalescedGroups: coalescedGroups.length,
    chatId: effectiveMsg.channelId,
    success: failedChunks === 0 && skippedChunks === 0,
    ...(skippedChunks > 0 ? { skippedChunks } : {}),
  }, "Block delivery complete");

  // Delivery complete INFO bookend
  const deliveryDurationMs = Math.round(performance.now() - deliveryStartMs);
  const e2eDurationMs = effectiveMsg.timestamp
    ? systemNowMs() - effectiveMsg.timestamp
    : undefined;
  deps.logger.info({
    traceId: deliveryCtx?.traceId,
    channelType: effectiveMsg.channelType ?? "unknown",
    chatId: effectiveMsg.channelId,
    chunks: coalescedGroups.length,
    deliveryDurationMs,
    e2eDurationMs: e2eDurationMs != null && e2eDurationMs >= 0 ? e2eDurationMs : undefined,
  }, "Delivery complete");

  // Signal execution complete for message mode
  if (typingLifecycle && blockStreamCfg.typingMode === "message") {
    typingLifecycle.markRunComplete();
  }

  // === DELIVERY RECEIPT ===
  // Any failed chunk => err(DeliveryFailureReceipt) so the coordinator can
  // classify the turn as kind:"failure" and keep the activity trail.
  if (failedChunks > 0 || firstFailure) {
    const rawError = firstFailure?.message ?? "delivery failed";
    // Redact credentials, then bound to the receipt's ≤200-char contract.
    const lastError = sanitizeLogString(rawError).slice(0, MAX_LAST_ERROR_CHARS);
    return err({
      ok: false,
      deliveredChunks,
      failedChunks,
      errorKind: firstFailure?.errorKind ?? "platform",
      lastError,
      failedAtMs: settledAtMs,
    });
  }

  return ok({
    ok: true,
    deliveredChunks,
    lastChunkMessageId,
    deliveredAtMs: settledAtMs,
  });
}
