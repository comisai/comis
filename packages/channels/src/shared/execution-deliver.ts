// SPDX-License-Identifier: Apache-2.0
/**
 * Execution Pipeline Phase 4: Block Delivery.
 *
 * Handles chunking, block coalescing, block pacer creation, delivery
 * to channel, streaming progress events, and delivery metrics logging.
 *
 * @module
 */

import type { ChannelPort, NormalizedMessage, PerChannelStreamingConfig } from "@comis/core";
import { tryGetContext } from "@comis/core";

import type { ExecutionPipelineDeps } from "./execution-pipeline.js";
import { buildThreadSendOpts } from "./execution-pipeline.js";
import { chunkForDelivery } from "./chunk-for-delivery.js";
import { deliverToChannel } from "./deliver-to-channel.js";
import { createBlockPacer } from "./block-pacer.js";
import type { BlockPacer } from "./block-pacer.js";
import type { TypingLifecycleController } from "./typing-lifecycle-controller.js";
import { createBlockRetryGuard } from "./retry-engine.js";
import { coalesceBlocks } from "./block-coalescer.js";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for the delivery phase. */
export type DeliverDeps = Pick<
  ExecutionPipelineDeps,
  "eventBus" | "logger" | "streamingConfig" | "channelRegistry" | "retryEngine" | "deliveryQueue" | "inFlightSends"
>;

// ---------------------------------------------------------------------------
// Phase function
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
): Promise<void> {
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
      timestamp: Date.now(),
    });
  }

  // 'message' mode: start typing just before block delivery
  if (blockStreamCfg.typingMode === "message" && typingLifecycle?.controller && !typingLifecycle.controller.isActive) {
    typingLifecycle.controller.start(effectiveMsg.channelId);
    deps.eventBus.emit("typing:started", {
      channelId: adapter.channelId,
      chatId: effectiveMsg.channelId,
      mode: blockStreamCfg.typingMode,
      timestamp: Date.now(),
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

      const deliveryResult = await deliverToChannel(adapter, effectiveMsg.channelId, text, {
        replyTo: blockIndex === 0 ? replyTo : undefined,
        threadId: threadOpts?.threadId,
        extra: threadOpts?.extra,
        skipFormat: true,
        skipChunking: true,
        origin: "agent",
      }, deps.deliveryQueue
        ? { retryEngine: deps.retryEngine, eventBus: deps.eventBus, deliveryQueue: deps.deliveryQueue, replyMode: resolvedReplyMode, abortSignal: deliverySignal, inFlightSends: deps.inFlightSends }
        : undefined);

      if (!deliveryResult.ok || !deliveryResult.value.ok) {
        failedChunks++;
        const chunkErr = !deliveryResult.ok ? deliveryResult.error : undefined;
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
          errorKind: "delivery" as const,
        }, "Delivery failure");
        blockGuard?.recordFailure();
        if (blockGuard?.shouldAbort) {
          deps.logger.warn({ channelId: effectiveMsg.channelId, hint: "Multiple consecutive send failures; check platform connectivity", errorKind: "network" as const }, "Block delivery aborted after consecutive failures");
          return;
        }
      } else {
        deliveredChunks++;
        blockGuard?.recordSuccess();
      }

      // Pipeline-specific UX event: block index tracking for streaming progress.
      deps.eventBus.emit("streaming:block_sent", {
        channelId: adapter.channelId,
        chatId: effectiveMsg.channelId,
        blockIndex,
        totalBlocks,
        charCount: text.length,
        timestamp: Date.now(),
      });
      blockIndex++;
    });
    // Signal delivery complete -- typing can now stop
    typingLifecycle?.markDispatchIdle();
  } finally {
    activePacers.delete(pacer);
  }

  const deliveryCtx = tryGetContext();
  deps.logger.debug({
    traceId: deliveryCtx?.traceId,
    step: "block-delivery",
    rawBlocks: blocks.length,
    coalescedGroups: coalescedGroups.length,
    chatId: effectiveMsg.channelId,
    success: failedChunks === 0,
  }, "Block delivery complete");

  // Delivery complete INFO bookend
  const deliveryDurationMs = Math.round(performance.now() - deliveryStartMs);
  const e2eDurationMs = effectiveMsg.timestamp
    ? Date.now() - effectiveMsg.timestamp
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
}
