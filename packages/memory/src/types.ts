// SPDX-License-Identifier: Apache-2.0
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
//
// The 9 `Ctx*Row` interfaces previously declared here are now the single
// source-of-truth in `@comis/core/src/ports/context-store-types.ts`
// (Phase 31 commit 1 / MEM-CTX-PORTS-03). Memory consumers should import
// them from `@comis/core` (or transitively re-exported from
// `@comis/memory`'s public index). Database schema and persisted column
// layout are unchanged (MEM-CTX-PORTS-17).
