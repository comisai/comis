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
  /** Unix timestamp in milliseconds, null if the event time is unknown. */
  occurred_at: number | null;
  /** Evidence count; null = raw memory, >=1 = observation. */
  proof_count: number | null;
  /** JSON-encoded string[] of contributing source ids; null on raw memories. */
  source_ids: string | null;
  /** Unix ms; set when folded into an observation. */
  consolidated_at: number | null;
  /** Observation confidence 0..1; null on raw memories. */
  confidence: number | null;
  /** JSON-encoded audit array of prior contents; null on raw memories. */
  history: string | null;
  /** Reasoning-observation kind TEXT; null = "merge". */
  observation_kind: string | null;
  /** Inductive pattern class TEXT; null unless observationKind="inductive". */
  pattern_type: string | null;
  /** Unix ms; non-destructive demote marker; null = not demoted (DORMANT). */
  lifecycle_demoted_at: number | null;
  /** Unix ms; non-destructive evict marker; null = not evicted (DORMANT). */
  evicted_at: number | null;
  /** Computed lifecycle strength 0..1; null = not yet computed. */
  strength: number | null;
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

// --- Context store row types (removed in v2.12) ---
//
// The 9 `Ctx*Row` interfaces and their `ctx_*` SQLite schema were removed in
// v2.12 (Phase 126) along with the DAG context engine — the row DTOs, the
// `context-store-types.ts` port, and the `ctx_*` tables no longer exist. The
// LCD store and its row model are reintroduced fresh in a later phase. Nothing
// destructive is written for the removal; existing DBs keep harmless empty
// `ctx_*` tables that no code reads.
