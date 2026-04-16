/**
 * Internal database row shapes for the @comis/memory package.
 *
 * These types mirror the SQLite column layout and are NOT part of
 * the public API. Consumers use the domain types from @comis/core.
 */

/**
 * Raw row shape for the `memories` table.
 */
export interface MemoryRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  user_id: string;
  content: string;
  trust_level: string;
  memory_type: string;
  source_who: string;
  source_channel: string | null;
  source_session_key: string | null;
  /** JSON-encoded string[] */
  tags: string;
  /** Unix timestamp in milliseconds */
  created_at: number;
  /** Unix timestamp in milliseconds, null if never updated */
  updated_at: number | null;
  /** Unix timestamp in milliseconds, null if no expiry */
  expires_at: number | null;
  /** 0 or 1 -- whether vec_memories has an embedding for this entry */
  has_embedding: number;
}

/**
 * Raw row shape for the `sessions` table.
 */
export interface SessionRow {
  session_key: string;
  tenant_id: string;
  user_id: string;
  channel_id: string;
  /** JSON-encoded unknown[] */
  messages: string;
  /** Unix timestamp in milliseconds */
  created_at: number;
  /** Unix timestamp in milliseconds */
  updated_at: number;
  /** JSON-encoded Record<string, unknown> */
  metadata: string;
}

/**
 * Row shape returned by sqlite-vec KNN queries.
 */
export interface VecSearchRow {
  memory_id: string;
  distance: number;
}

/**
 * Row shape returned by FTS5 search queries joined with memories.
 */
export interface FtsSearchRow {
  id: string;
  content: string;
  rank: number;
}

/**
 * Raw row shape for the `named_graphs` table.
 */
export interface NamedGraphRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  label: string;
  nodes: string;
  edges: string;
  settings: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

// --- Context store row types ---

/**
 * Raw row shape for the `ctx_conversations` table.
 */
export interface CtxConversationRow {
  conversation_id: string;
  tenant_id: string;
  agent_id: string;
  session_key: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Raw row shape for the `ctx_messages` table.
 */
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

/**
 * Raw row shape for the `ctx_message_parts` table.
 */
export interface CtxMessagePartRow {
  part_id: number;
  message_id: number;
  ordinal: number;
  part_type: string;
  content: string | null;
  metadata: string | null;
}

/**
 * Raw row shape for the `ctx_summaries` table.
 */
export interface CtxSummaryRow {
  summary_id: string;
  conversation_id: string;
  kind: string;
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
 * Raw row shape for the `ctx_summary_messages` table.
 */
export interface CtxSummaryMessageRow {
  summary_id: string;
  message_id: number;
  ordinal: number;
}

/**
 * Raw row shape for the `ctx_summary_parents` table.
 */
export interface CtxSummaryParentRow {
  summary_id: string;
  parent_summary_id: string;
  ordinal: number;
}

/**
 * Raw row shape for the `ctx_context_items` table.
 */
export interface CtxContextItemRow {
  conversation_id: string;
  ordinal: number;
  item_type: string;
  message_id: number | null;
  summary_id: string | null;
}

/**
 * Raw row shape for the `ctx_large_files` table.
 */
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

/**
 * Raw row shape for the `ctx_expansion_grants` table.
 */
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
