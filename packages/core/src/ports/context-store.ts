// SPDX-License-Identifier: Apache-2.0
/**
 * ContextStorePort: hexagonal architecture boundary for the LCD (Lossless
 * Context DAG) message store.
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
  AppendProvenanceInput,
  AppendSummaryInput,
  ContextBrowseScope,
  ContextStoreScope,
  LcdContextItem,
  LcdConversationPage,
  LcdMessage,
  LcdSearchResult,
  LcdSummary,
} from "./context-store-types.js";

/**
 * ContextStorePort persists and reconstructs lossless conversation messages
 * for the LCD engine.
 *
 * All operations are synchronous (better-sqlite3 is synchronous), matching
 * the SessionStorePort precedent. The surface is intentionally minimal:
 * the write + read core plus the sanctioned summary + context_items
 * extension (depth-0 LEAF summaries and their condensation).
 */
export interface ContextStorePort {
  /**
   * Write path: persist one message + its structured parts atomically.
   * `tokenCount` arrives pre-computed on the input (the store NEVER computes
   * tokens — the caller supplies it agent-side via `estimateMessageTokens`).
   */
  append(input: AppendMessageInput): void;
  /**
   * Read path: reconstruct all messages for the `scope`, ordered by seq.
   * Each `LcdMessage` carries its parts; provider-correct block emission is
   * pi-ai's job downstream — this port returns the faithful canonical rows.
   * Scoped by (conversationRef, agentId, tenantId) — full isolation: two
   * agents sharing one conversation_ref never read each other's messages.
   */
  getMessages(scope: ContextStoreScope): LcdMessage[];
  /**
   * Compaction write path: persist one leaf summary, link it to the
   * covered messages (FK RESTRICT — losslessness), and range-replace the
   * covered [startOrdinal, endOrdinal] message-refs in context_items with
   * one summary-ref — ALL in one transaction. Returns the new summaryId.
   */
  appendLeafSummary(input: AppendSummaryInput): string;
  /**
   * Compaction write path: persist one CONDENSED (depth>0) summary,
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
   * conversation with no context_items rows (lazy seeding instead of a
   * migration step).
   * Scoped by (conversationRef, agentId, tenantId) — full isolation.
   */
  getContextItems(scope: ContextStoreScope): LcdContextItem[];
  /**
   * Read path: every leaf summary for a conversation. The dag assembler joins
   * these (by `summaryId`) to resolve a context_items `summary`-ref into its
   * `content` + pre-computed `tokenCount` when assembling the model-facing
   * context. Returned in insertion order; the assembler keys by id, not order.
   * `content` is the leaf plaintext and is NEVER logged (lossless store).
   * Scoped by (conversationRef, agentId, tenantId) — full isolation.
   */
  getSummaries(scope: ContextStoreScope): LcdSummary[];
  /**
   * Bounded read path — fetch only the message rows whose ids are in
   * the provided set. Scoped by (conversationRef, agentId, tenantId) — isolation
   * identical to getMessages. Returns rows ordered by seq, same as getMessages.
   *
   * Returns [] when ids is empty (no DB query issued). Callers must collect
   * refIds from getContextItems before calling this method.
   */
  getMessagesByIds(scope: ContextStoreScope, ids: string[]): LcdMessage[];

  /**
   * Bounded read path — fetch only the summary rows whose summaryIds are
   * in the provided set. Scoped by (conversationRef, agentId, tenantId) — isolation
   * identical to getSummaries. Returns rows ordered by created_at, summary_id.
   *
   * Returns [] when ids is empty (no DB query issued).
   */
  getSummariesByIds(scope: ContextStoreScope, ids: string[]): LcdSummary[];

  /**
   * The TOTAL count of persisted messages in the scope — a bounded
   * `COUNT(*)` that returns a single integer WITHOUT materializing any rows, so
   * it preserves the O(referenced-ids) read budget (no O(total-history) fetch).
   *
   * This is the authoritative `persistedMsgCount` the dag assembler needs for its
   * fresh-tail / eviction overlap math: messages are never deleted by
   * summarization (losslessness), so this total stays correct even after the
   * oldest message-refs collapse into summary-refs — unlike `getMessagesByIds`,
   * whose bounded result counts only the still-referenced subset. Scoped by
   * (conversationRef, agentId, tenantId) — full isolation: a different agent
   * sharing the conversation is never counted. Returns 0 for an empty scope.
   */
  countMessages(scope: ContextStoreScope): number;

  /**
   * Region walk: the immediate CHILD summaries of a condensed summary
   * (the lcd_summary_parents condensed→child edge). Returns [] when the
   * summary has no children (a leaf) or does not exist. Scoped by
   * (conversationRef, agentId, tenantId) — full isolation: a different
   * agent sharing the conversation cannot reach this condensed edge.
   */
  getSummaryChildren(scope: ContextStoreScope, parentSummaryId: string): LcdSummary[];
  /**
   * Region walk: the message ids a LEAF summary covers
   * (the lcd_summary_messages leaf→message edge). Returns [] when the summary
   * covers no messages or does not exist. Scoped by (conversationRef, agentId,
   * tenantId) — full isolation: a different agent cannot reach the covered
   * ids of another agent's summary within the shared conversation.
   */
  getSummaryMessages(scope: ContextStoreScope, summaryId: string): string[];
  /**
   * Full-text search over THIS (conversation, agent)'s lossless
   * store — FTS5 MATCH when available, LIKE scan fallback otherwise. The `query`
   * MUST already be sanitized by the caller (sanitizeFts5Query lives in
   * @comis/skills; @comis/memory cannot import it). Scoped by
   * (conversationRef, agentId) — full isolation: BOTH the FTS path AND the
   * LIKE fallback filter agent_id so a different agent's hits never leak.
   * The conversation_ref prefix carries the tenant boundary.
   *
   * Returns an {@link LcdSearchResult} wrapper: `hits` is the
   * FTS/trigram/scan result array; `lane` names the lane that served the query
   * ("word" word-FTS/LIKE, "tri" trigram twins, "scan" the bounded normalized
   * floor); `matchErrored` is true iff a MATCH threw and degraded to [] (an
   * errored zero-result is NOT a lane gap — signal purity); `scriptZeroHit` is the
   * dominant non-Latin {@link ScriptClass} when the search ran cleanly and
   * returned zero hits (the zero-hit trigger, generalized beyond CJK); `cjkZeroHit`
   * stays as the derived `scriptZeroHit === "cjk"` boolean; `scanCapped` flags a
   * scan floor that hit its row cap. All diagnostics are content-free
   * (enums/booleans, never the query text); the caller's logging boundary
   * (skills/agent) emits the `script_zero_hit` event when `scriptZeroHit` is set.
   */
  searchLcd(
    scope: ContextStoreScope,
    query: string,
    opts: { limit: number; scope?: "messages" | "summaries" | "both" },
  ): LcdSearchResult;
  /**
   * Per-conversation single-flight: run `fn` on the queue
   * dedicated to `conversationRef`. Serializes the live ingest write and the
   * deferred compaction write so they cannot interleave on
   * (conversation_ref, agent_id, tenant_id, seq) / the lcd_context_items ordinals
   * — the integrity boundary the deferred second writer requires.
   * Operations on the same conversation are strictly one-at-a-time; operations
   * on different conversations run concurrently (the queue is per-conversation,
   * never a global lock). Accepts a synchronous OR async `fn` (the live ingest's
   * better-sqlite3 append is synchronous; the deferred compaction is async). The
   * agent has no p-queue dependency, so it reaches the memory-owned per-
   * conversation queue ONLY through this port method (the agent↛memory cut holds).
   */
  runOnConversation<T>(conversationRef: string, fn: () => T | Promise<T>): Promise<T>;

  /**
   * Read the durable ingest cursor for this
   * (conversation, agent, tenant) scope.
   * Returns null when no row exists — a conversation that has never been
   * ingested.
   * The caller interprets null as "no prior epoch: treat as epoch A with
   * ingestedLiveLen = 0" — the steady-state continue path.
   */
  getIngestCursor(scope: ContextStoreScope): { epochAnchor: string; ingestedLiveLen: number } | null;

  /**
   * Atomically upsert the durable ingest cursor.
   * MUST be called inside runOnConversation by the caller (lcd-store's
   * single-flight serializer ensures the cursor write and the message append
   * are serialized for the same conversation).
   * `updatedAt` is caller-supplied epoch ms — the store never reads the clock.
   */
  upsertIngestCursor(
    scope: ContextStoreScope,
    cursor: { epochAnchor: string; ingestedLiveLen: number },
    updatedAt: number,
  ): void;

  /**
   * Delete ALL lcd_* rows for this (conversation, agent, tenant)
   * scope in FK-safe dependency order:
   * lcd_summary_messages (RESTRICT FK) → lcd_summary_parents → lcd_context_items →
   * lcd_summaries → lcd_messages (CASCADE deletes lcd_message_parts) → lcd_ingest_cursor.
   *
   * Returns the count of lcd_messages rows deleted.
   * MUST be called inside runOnConversation so it serializes against live ingest.
   * Never throws; returns 0 on no-op (empty conversation).
   *
   * The three-column scope filter (conversation_ref, agent_id, tenant_id)
   * on every DELETE statement mirrors the lcd-store selectMsgs read isolation —
   * a cross-tenant or cross-agent wipe is impossible by construction.
   */
  deleteConversationLcd(scope: ContextStoreScope): number;

  /**
   * Write a provenance row linking a distilled episodic
   * memory to the LCD condensed summary it was distilled from.
   *
   * Synchronous (better-sqlite3). Scoped via input.conversationRef /
   * agentId / tenantId. No return value — the provenanceId is caller-supplied.
   *
   * OPTIONAL: ContextStorePort implementations (e.g. test stubs) may omit it.
   * The distillation runner gates on `deps.lcdStore.appendProvenance != null`.
   */
  appendProvenance?(input: AppendProvenanceInput): void;

  /**
   * Mark an existing lcd_memory_provenance row as
   * superseded by a newer distilled memory (the pyramid rule).
   *
   * Sets `superseded_by = supersededByMemoryId` WHERE `summary_id = summaryId`
   * AND `tenant_id = tenantId` AND `agent_id = agentId` AND
   * `superseded_by IS NULL`. Synchronous. No-op when no matching row.
   *
   * The `tenantId`/`agentId` predicate is load-bearing — the UPDATE
   * is on a multi-tenant table, so a summary_id collision under a different
   * scope must be a fail-closed no-op (never flip another scope's row).
   *
   * OPTIONAL: see appendProvenance note above.
   */
  markProvenanceSuperseded?(
    summaryId: string,
    supersededByMemoryId: string,
    tenantId: string,
    agentId: string,
  ): void;
}

/**
 * TYPE-ONLY read port for the lcd_memory_provenance
 * table, consumed by the post-fusion provenance down-weighting pass in
 * createMemoryRecall (packages/agent/src/rag/memory-recall.ts).
 *
 * This is a SEPARATE, minimal read port — NOT a method on ContextStorePort —
 * to keep the recall pipeline's import surface narrow (it already has
 * MemoryEmbeddingStore, MemoryEntityStore, etc. as optional deps; this follows
 * the same pattern). The concrete adapter is daemon-injected. TYPE-ONLY from
 * @comis/core — the agent↛memory build cut holds.
 *
 * Synchronous (better-sqlite3).
 */
export interface LcdProvenanceReadStore {
  /**
   * Return all provenance rows where summary_id = summaryId, scoped to
   * (tenant, agent) for isolation. Used by the post-fusion pass to
   * identify same-conversation paired memories to down-weight.
   */
  getProvenanceForSummary(
    scope: ContextStoreScope,
    summaryId: string,
  ): Array<{
    provenanceId: string;
    memoryId: string;
    sourceSessionKey: string;
    supersededBy: string | null;
  }>;
}

/**
 * ContextBrowsePort: the READ-ONLY operator-browse boundary over the same LCD
 * lossless store.
 *
 * This is a SEPARATE, additive port — NOT a method on {@link ContextStorePort}.
 * ContextStorePort is the write+assemble surface that the agent/skills/daemon
 * wire deeply (dozens of stubs implement it); the operator Context DAG browser
 * needs only one capability ContextStorePort lacks — enumerate the distinct
 * conversations an agent owns — so it gets its own minimal port rather than
 * widening the heavily-implemented one (KISS / blast-radius). It is consumed
 * ONLY by the daemon's context.* RPC handlers; the rest of the read surface the
 * browser needs (a conversation's context_items + summaries) is already on
 * ContextStorePort (`getContextItems` / `getSummaries`).
 *
 * Synchronous (better-sqlite3 is synchronous), mirroring ContextStorePort.
 */
export interface ContextBrowsePort {
  /**
   * List the distinct LCD conversations owned by ONE agent within ONE tenant,
   * most-recently-updated first, paginated. Filters by `agentId`
   * AND `tenantId`, so two agents that legitimately share one conversation_ref
   * never see each other's conversations, and one tenant never sees another's.
   * Returns a page of metadata rows (IDs/counts/time-bounds only — NEVER any
   * message or summary content) plus the unpaginated `total`.
   */
  listConversations(
    scope: ContextBrowseScope,
    opts: { limit: number; offset: number },
  ): LcdConversationPage;
}
