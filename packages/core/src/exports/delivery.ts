// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Delivery primitives.
//
// The channel-platform-agnostic delivery helpers (formatForChannel,
// chunkForDelivery, chunkBlocks, RetryEngine, isPermanentError) live in
// core/src/delivery/ so that `core → channels` stays one-way.
//
// The Markdown IR pipeline that underlies formatForChannel and chunkForDelivery
// (markdown-ir, ir-renderer, ir-chunker, markdown-tables, sanitize-for-plain-text,
// table-converter, telegram-file-ref-guard) lives alongside, keeping the
// `core → channels` dependency one-way.
// Those internals are intentionally NOT exported from this aggregator: the
// public surface is limited to the names below plus the telegram-file-ref-guard
// symbols the daemon needs at bootstrap.

export { formatForChannel } from "../delivery/format-for-channel.js";
export { chunkForDelivery } from "../delivery/chunk-for-delivery.js";
export type { ChunkForDeliveryOptions } from "../delivery/chunk-for-delivery.js";
export { chunkBlocks } from "../delivery/block-chunker.js";
// Note: block-chunker's ChunkMode + ChunkOptions are intentionally NOT
// re-exported — block-chunker's "paragraph"/"newline"/"sentence"/"length"
// ChunkMode collides with the streaming-config ChunkMode in
// exports/config.js, and KISS/YAGNI forbids speculative public exports
// without callers. chunkBlocks is the only block-chunker
// symbol consumed cross-package.
export { createRetryEngine, createBlockRetryGuard } from "../delivery/retry-engine.js";
export type { RetryEngine, BlockRetryGuard } from "../delivery/retry-engine.js";
export { isPermanentError, PERMANENT_ERROR_PATTERNS } from "../delivery/permanent-errors.js";

// Markdown IR types — re-exported as a narrow public type surface so the
// Signal channel adapter (signal-format.ts, signal-adapter.ts) can keep its
// existing typed pipeline import after the Markdown IR pipeline's
// relocation into core. The IR parser (parseMarkdownToIR) is also exported
// because signal-format.test.ts exercises it directly.
export { parseMarkdownToIR } from "../delivery/markdown-ir.js";
export type { MarkdownIR, MarkdownBlock, MarkdownSpan } from "../delivery/markdown-ir.js";

// Telegram file-ref guard — moved alongside the Markdown IR pipeline so
// ir-renderer (now in core/delivery) keeps a relative import. The daemon
// initializes the guard during bootstrap (setup-channels.ts), so the
// initializer + classification sets stay in the public surface.
export {
  guardTelegramFileRefs,
  initTelegramFileGuardConfig,
  isTelegramFileGuardEnabled,
  ALWAYS_GUARD_EXTENSIONS,
  AMBIGUOUS_EXTENSIONS,
} from "../delivery/telegram-file-ref-guard.js";

// Delivery type re-exports.
//
// These 5 types are owned by core/src/delivery/types.ts so the createDeliveryService
// factory below can reference them without introducing a `core → channels`
// back-edge.
export type {
  DeliveryStrategy,
  DeliveryAdapter,
  DeliverToChannelOptions,
  ChunkDeliveryResult,
  DeliveryResult,
} from "../delivery/types.js";

// DeliveryService factory + interfaces. Provides a `createDeliveryService(deps):
// DeliveryService` factory in core; callers invoke the method form
// `deps.deliveryService.deliverToChannel(adapter, ...)`.
export {
  createDeliveryService,
} from "../delivery/delivery-service.js";
export type {
  DeliveryService,
  DeliveryServiceDeps,
} from "../delivery/delivery-service.js";

// Queue-backoff helpers. Consumed by daemon's setup-delivery.ts (drain loop)
// and by the DeliveryService factory itself.
export {
  QUEUE_BACKOFF_SCHEDULE_MS,
  computeQueueBackoff,
  resolveChunkLimit,
} from "../delivery/queue-backoff.js";
