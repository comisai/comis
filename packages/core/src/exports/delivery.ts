// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Delivery primitives.
//
// Phase 30 plan 02 (CONFIG-DELIV-04, -05): the channel-platform-agnostic
// delivery helpers (formatForChannel, chunkForDelivery, chunkBlocks,
// RetryEngine, isPermanentError) moved from @comis/channels/shared/* into
// core/src/delivery/ so the upcoming createDeliveryService (plan 03) and
// production caller migration (plan 04) keep `core → channels` one-way
// (per AGENTS.md §1).
//
// The Markdown IR pipeline that underlies formatForChannel and chunkForDelivery
// (markdown-ir, ir-renderer, ir-chunker, markdown-tables, sanitize-for-plain-text,
// table-converter, telegram-file-ref-guard) moved alongside as a Rule 3
// blocking-issue fix — see 30-02-SUMMARY.md "Deviations from Plan". Those
// internals are intentionally NOT exported from this aggregator: the public
// surface gain is only the 7 names listed below (formatForChannel,
// chunkForDelivery + ChunkForDeliveryOptions, chunkBlocks, createRetryEngine +
// RetryEngine, isPermanentError + PERMANENT_ERROR_PATTERNS) plus the
// telegram-file-ref-guard symbols the daemon needs at bootstrap. createDeliveryService
// + DeliveryService will be appended here by plan 03.

export { formatForChannel } from "../delivery/format-for-channel.js";
export { chunkForDelivery } from "../delivery/chunk-for-delivery.js";
export type { ChunkForDeliveryOptions } from "../delivery/chunk-for-delivery.js";
export { chunkBlocks } from "../delivery/block-chunker.js";
// Note: block-chunker's ChunkMode + ChunkOptions are intentionally NOT
// re-exported — block-chunker's "paragraph"/"newline"/"sentence"/"length"
// ChunkMode collides with the streaming-config ChunkMode in
// exports/config.js, and AGENTS.md §2.3 (KISS/YAGNI) forbids speculative
// public exports without callers. chunkBlocks is the only block-chunker
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

// Phase 30 plan 03 — delivery type re-exports.
//
// These 5 types were declared in packages/channels/src/shared/deliver-to-channel.ts
// before plan 03. They are now owned by core/src/delivery/types.ts so the new
// createDeliveryService factory below can reference them without introducing a
// `core → channels` back-edge. Channels keeps a thin re-export shim for surface
// continuity until plan 06 deletes deliver-to-channel.ts entirely.
export type {
  DeliveryStrategy,
  DeliveryAdapter,
  DeliverToChannelOptions,
  ChunkDeliveryResult,
  DeliveryResult,
} from "../delivery/types.js";

// Phase 30 plan 03 — DeliveryService factory + interfaces. Replaces the
// standalone deliverToChannel free function in channels with a
// `createDeliveryService(deps): DeliveryService` factory in core. Closes the
// L14 (global hook runner) and L26 (optional deps) preconditions. The
// standalone export in channels was deleted in plan 06; callers now invoke
// the method form `deps.deliveryService.deliverToChannel(adapter, ...)`.
export {
  createDeliveryService,
} from "../delivery/delivery-service.js";
export type {
  DeliveryService,
  DeliveryServiceDeps,
} from "../delivery/delivery-service.js";

// Phase 30 plan 06 — queue-backoff helpers relocated from
// packages/channels/src/shared/deliver-to-channel.ts (deleted in plan 06).
// Consumed by daemon's setup-delivery.ts (drain loop) and by the
// DeliveryService factory itself.
export {
  QUEUE_BACKOFF_SCHEDULE_MS,
  computeQueueBackoff,
  resolveChunkLimit,
} from "../delivery/queue-backoff.js";
