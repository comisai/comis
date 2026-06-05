// SPDX-License-Identifier: Apache-2.0
/**
 * ContextStorePort: hexagonal architecture boundary for the LCD (Lossless
 * Context DAG) message store.
 *
 * This is the NEW LCD lossless-store port introduced in v2.12 (Phase 127).
 * It reuses the `ContextStorePort` identifier that was DELETED in Phase 126
 * (the old DAG context-store port + its `Ctx*Row` DTOs), but it is a fresh,
 * unrelated interface — same name per CONTEXT.md decision Q2, NOT a revival
 * of the old contract. Do not resurrect the deleted `ctx_*` types.
 *
 * Type-only, NO zod (core ports are zero-runtime-zod by rule). Row DTOs live
 * in core/src/ports/context-store-types.ts.
 *
 * The implementation lives at the memory package's createLcdStore(); the
 * pure parts <-> pi-ai Message codec lives at core's parts-codec.ts.
 *
 * @module
 */

import type {
  AppendCondensedSummaryInput,
  AppendMessageInput,
  AppendSummaryInput,
  LcdContextItem,
  LcdMessage,
  LcdSummary,
} from "./context-store-types.js";

/**
 * ContextStorePort persists and reconstructs lossless conversation messages
 * for the LCD engine.
 *
 * All operations are synchronous (better-sqlite3 is synchronous), matching
 * the SessionStorePort precedent. The 127 surface was intentionally minimal —
 * write + read only. Phase 129 adds the sanctioned summary + context_items
 * extension (the depth-0 LEAF half; condensation is Phase 130).
 */
export interface ContextStorePort {
  /**
   * Write path (F1): persist one message + its structured parts atomically.
   * `tokenCount` arrives pre-computed on the input (the store NEVER computes
   * tokens — the caller supplies it agent-side via `estimateMessageTokens`).
   */
  append(input: AppendMessageInput): void;
  /**
   * Read path (F2): reconstruct all messages for a conversation, ordered by
   * seq. Each `LcdMessage` carries its parts; provider-correct block emission
   * is pi-ai's job downstream — this port returns the faithful canonical rows.
   */
  getMessages(conversationId: string): LcdMessage[];
  /**
   * Compaction write path (C3): persist one leaf summary, link it to the
   * covered messages (FK RESTRICT — losslessness), and range-replace the
   * covered [startOrdinal, endOrdinal] message-refs in context_items with
   * one summary-ref — ALL in one transaction. Returns the new summaryId.
   */
  appendLeafSummary(input: AppendSummaryInput): string;
  /**
   * Compaction write path (C2): persist one CONDENSED (depth>0) summary,
   * link it to its CHILD SUMMARIES via lcd_summary_parents (FK RESTRICT on
   * the child — a condensed child is never deleted, losslessness), and
   * range-replace the covered [startOrdinal, endOrdinal] SUMMARY-refs in
   * context_items with one condensed summary-ref — ALL in one transaction.
   * Returns the new summaryId.
   */
  appendCondensedSummary(input: AppendCondensedSummaryInput): string;
  /**
   * Read path: the ordered model-facing context_items view (dense, gap-free
   * ordinals). Lazily seeded 1:1 from lcd_messages on first read for a
   * conversation with no context_items rows (no migration — design §9).
   */
  getContextItems(conversationId: string): LcdContextItem[];
  /**
   * Read path: every leaf summary for a conversation. The dag assembler joins
   * these (by `summaryId`) to resolve a context_items `summary`-ref into its
   * `content` + pre-computed `tokenCount` when assembling the model-facing
   * context. Returned in insertion order; the assembler keys by id, not order.
   * `content` is the leaf plaintext and is NEVER logged (lossless store).
   */
  getSummaries(conversationId: string): LcdSummary[];
}
