// SPDX-License-Identifier: Apache-2.0
/**
 * Row DTOs for ContextStorePort. Type-only.
 *
 * Lifted from packages/core/src/ports/context-store.ts:50-139 (Phase 28
 * commit 4 inlined them) and packages/memory/src/types.ts:91-209
 * (canonical source through Phase 30). Phase 31 commit 1 moves them here
 * per MEM-CTX-PORTS-03.
 *
 * Per design §8.2.1 these row DTOs land in core/src/ports/ (NOT
 * core/src/domain/) to preserve the domain/persistence boundary.
 *
 * Two additional types (CtxSummaryMessageRow, CtxSummaryParentRow) live
 * here as well even though they are not referenced by any ContextStorePort
 * method signature — they are part of memory's public row-DTO surface and
 * per RESEARCH.md Open Question #3 the canonical home is core for
 * single-source-of-truth.
 *
 * @module
 */

/** Raw row shape for the `ctx_conversations` table. */
export interface CtxConversationRow {
  conversation_id: string;
  tenant_id: string;
  agent_id: string;
  session_key: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/** Raw row shape for the `ctx_messages` table. */
export interface CtxMessageRow {
  message_id: number;
  conversation_id: string;
  seq: number;
  role: string;
  content: string;
  content_hash: string;
  token_count: number;
  tool_name: string | null;
  tool_call_id: string | null;
  created_at: string;
}

/** Raw row shape for the `ctx_message_parts` table. */
export interface CtxMessagePartRow {
  part_id: number;
  message_id: number;
  ordinal: number;
  part_type: string;
  content: string | null;
  metadata: string | null;
}

/** Raw row shape for the `ctx_summaries` table. */
export interface CtxSummaryRow {
  summary_id: string;
  conversation_id: string;
  kind: "leaf" | "condensed";
  depth: number;
  content: string;
  token_count: number;
  file_ids: string;
  earliest_at: string | null;
  latest_at: string | null;
  descendant_count: number;
  descendant_token_count: number;
  source_token_count: number;
  counts_dirty: number;
  quality_score: number | null;
  compaction_level: string | null;
  created_at: string;
}

/**
 * Raw row shape for the `ctx_summary_messages` link table (memory-internal;
 * not referenced by ContextStorePort method signatures).
 */
export interface CtxSummaryMessageRow {
  summary_id: string;
  message_id: number;
  ordinal: number;
}

/**
 * Raw row shape for the `ctx_summary_parents` link table (memory-internal;
 * not referenced by ContextStorePort method signatures).
 */
export interface CtxSummaryParentRow {
  summary_id: string;
  parent_summary_id: string;
  ordinal: number;
}

/** Raw row shape for the `ctx_context_items` table. */
export interface CtxContextItemRow {
  conversation_id: string;
  ordinal: number;
  item_type: string;
  message_id: number | null;
  summary_id: string | null;
}

/** Raw row shape for the `ctx_large_files` table. */
export interface CtxLargeFileRow {
  file_id: string;
  conversation_id: string;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  content_hash: string | null;
  storage_path: string;
  exploration_summary: string | null;
  created_at: string;
}

/** Raw row shape for the `ctx_expansion_grants` table. */
export interface CtxExpansionGrantRow {
  grant_id: string;
  issuer_session: string;
  conversation_ids: string;
  summary_ids: string;
  max_depth: number;
  token_cap: number;
  tokens_consumed: number;
  expires_at: string;
  revoked: number;
  created_at: string;
}
