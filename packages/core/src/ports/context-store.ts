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
  ContextStoreScope,
  LcdContextItem,
  LcdMessage,
  LcdSearchHit,
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
   * Read path (F2): reconstruct all messages for the `scope`, ordered by seq.
   * Each `LcdMessage` carries its parts; provider-correct block emission is
   * pi-ai's job downstream — this port returns the faithful canonical rows.
   * Scoped by (conversationId, agentId, tenantId) — full isolation (R4): two
   * agents sharing one conversation_id never read each other's messages (WR-02).
   */
  getMessages(scope: ContextStoreScope): LcdMessage[];
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
   * Scoped by (conversationId, agentId, tenantId) — full isolation (R4).
   */
  getContextItems(scope: ContextStoreScope): LcdContextItem[];
  /**
   * Read path: every leaf summary for a conversation. The dag assembler joins
   * these (by `summaryId`) to resolve a context_items `summary`-ref into its
   * `content` + pre-computed `tokenCount` when assembling the model-facing
   * context. Returned in insertion order; the assembler keys by id, not order.
   * `content` is the leaf plaintext and is NEVER logged (lossless store).
   * Scoped by (conversationId, agentId, tenantId) — full isolation (R4).
   */
  getSummaries(scope: ContextStoreScope): LcdSummary[];
  /**
   * E1 region walk: the immediate CHILD summaries of a condensed summary
   * (the lcd_summary_parents condensed→child edge). Returns [] when the
   * summary has no children (a leaf) or does not exist. Scoped by
   * (conversationId, agentId, tenantId) — full isolation (R4): a different
   * agent sharing the conversation cannot reach this condensed edge (WR-02).
   */
  getSummaryChildren(scope: ContextStoreScope, parentSummaryId: string): LcdSummary[];
  /**
   * E1 region walk: the message ids a LEAF summary covers
   * (the lcd_summary_messages leaf→message edge). Returns [] when the summary
   * covers no messages or does not exist. Scoped by (conversationId, agentId,
   * tenantId) — full isolation (R4): a different agent cannot reach the covered
   * ids of another agent's summary within the shared conversation (WR-02).
   */
  getSummaryMessages(scope: ContextStoreScope, summaryId: string): string[];
  /**
   * E1 search: full-text search over THIS (conversation, agent)'s lossless
   * store — FTS5 MATCH when available, LIKE scan fallback otherwise. The `query`
   * MUST already be sanitized by the caller (sanitizeFts5Query lives in
   * @comis/skills; @comis/memory cannot import it — PATTERNS gap #2). Scoped by
   * (conversationId, agentId) — full isolation (R4): BOTH the FTS path AND the
   * LIKE fallback filter agent_id so a different agent's hits never leak (WR-02,
   * Pitfall 3). The conversation_id prefix carries the tenant boundary.
   */
  searchLcd(
    scope: ContextStoreScope,
    query: string,
    opts: { limit: number; scope?: "messages" | "summaries" | "both" },
  ): LcdSearchHit[];
}
