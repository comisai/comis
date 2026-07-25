// SPDX-License-Identifier: Apache-2.0
import type { ConversationRef } from "@comis/core";
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
  visibility: "conversation" | "principal" | "agent-shared";
  conversation_ref: ConversationRef | null;
  principal_id: string | null;
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
  /** Always-inject pin marker. 0 = not pinned, 1 = pinned.
   *  NOT NULL DEFAULT 0 after ensurePinnedColumn() runs. */
  pinned: number;
  /** 0 or 1 -- whether vec_memories has an embedding for this entry */
  has_embedding: number;
}

/**
 * Raw row shape for the `sessions` table.
 */
export interface SessionRow {
  tenant_id: string;
  agent_id: string;
  conversation_ref: ConversationRef;
  canonical_scope: string;
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
 * Raw row shape for the `lcd_messages` table (LCD lossless store).
 *
 * Snake_case DB-row shape — NOT the public API (consumers use the `LcdMessage`
 * DTO from `@comis/core`, reconstructed via the parts-codec). Carries the
 * tenant/agent/session isolation columns (`conversation_ref` is the composite,
 * the three broken-out columns let a scoped read filter on the SAME schema without
 * a migration). Paired 1:1 with `LcdMessageRowSchema` in
 * `./row-schemas.js` via the `row-schemas.test.ts` drift guard.
 */
export interface LcdMessageRow {
  id: string;
  /** tenant+agent+session composite scope key. */
  conversation_ref: ConversationRef;
  tenant_id: string;
  agent_id: string;
  session_key: string;
  /** Monotonic per conversation. */
  seq: number;
  /** pi-ai role string: `user` | `assistant` | `toolResult`. */
  role: string;
  /** Pre-computed agent-side; the store never computes tokens. */
  token_count: number;
  /** Unix timestamp in milliseconds (caller-supplied; the store does not stamp it). */
  created_at: number;
}

/**
 * Raw row shape for the `lcd_message_parts` table (LCD lossless store).
 *
 * One row per structured block. The typed tool columns are the queryable
 * projection; the verbatim canonical pi-ai block (plus the reasoning marker
 * and the message envelope) always lives JSON-encoded in `metadata`. Paired
 * 1:1 with `LcdMessagePartRowSchema` in `./row-schemas.js` via the drift guard.
 */
export interface LcdMessagePartRow {
  id: string;
  message_id: string;
  /** Block order within the message. */
  ordinal: number;
  /** Block kind: `text` | `tool_use` | `tool_result` | `reasoning` | `file`. */
  kind: string;
  /** Stable tool-call id; null for non-tool blocks. */
  tool_call_id: string | null;
  /** Tool name; null for non-tool blocks. */
  tool_name: string | null;
  /** JSON-encoded tool arguments; null for non-`tool_use` blocks. */
  tool_input: string | null;
  /** JSON-encoded tool output; null for non-`tool_result` blocks. */
  tool_output: string | null;
  /** 0/1 tool-result error flag; null for non-`tool_result` blocks. */
  is_error: number | null;
  /** JSON-encoded LcdPartMetadata (verbatim `raw` block + `messageEnvelope` + `topLevelReasoningOnly`). */
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

/**
 * Raw row shape for the `lcd_summaries` table (LCD compaction store).
 *
 * Snake_case DB-row shape — NOT the public API (consumers use the `LcdSummary`
 * DTO from `@comis/core`). One row per depth-0 LEAF summary; carries the
 * tenant/agent/session isolation columns so a scoped read filters on the SAME
 * schema with no migration. `taint`/`fallback` are the SQLite
 * bool 0/1 integers; `file_ids` is JSON-encoded TEXT. Paired 1:1 with
 * `LcdSummaryRowSchema` in `./row-schemas.js` via the `row-schemas.test.ts`
 * drift guard.
 */
export interface LcdSummaryRow {
  summary_id: string;
  /** tenant+agent+session composite scope key. */
  conversation_ref: string;
  tenant_id: string;
  agent_id: string;
  session_key: string;
  /** Closed union TEXT: `leaf` (depth-0). */
  kind: string;
  /** 0 for a leaf; depth>0 is the condensed tier. */
  depth: number;
  /** Min `created_at` of the covered messages. */
  earliest_at: number;
  /** Max `created_at` of the covered messages. */
  latest_at: number;
  /** Count of messages this summary covers. */
  descendant_count: number;
  /** Pre-computed agent-side; the store never computes tokens. */
  token_count: number;
  /** Leaf summary plaintext (never logged). */
  content: string;
  /** JSON-encoded string[] of covered file references. */
  file_ids: string;
  /** 0/1 untrusted-content flag. */
  taint: number;
  /** 0/1 deterministic Level-3-truncation marker. */
  fallback: number;
  /** Unix timestamp in milliseconds (caller-supplied; the store does not stamp it). */
  created_at: number;
}

/**
 * Raw row shape for the `lcd_summary_messages` table (LCD compaction store).
 *
 * The leaf→message link — one row per (summary, covered message). The
 * `message_id` FK is `ON DELETE RESTRICT` so a summarized `lcd_messages` row can
 * never be deleted (losslessness). Paired 1:1 with
 * `LcdSummaryMessageRowSchema` via the drift guard.
 */
export interface LcdSummaryMessageRow {
  summary_id: string;
  message_id: string;
}

/**
 * Raw row shape for the `lcd_summary_parents` table (LCD condensed tier).
 *
 * The condensed→child summary edge — one row per (condensed parent summary,
 * child summary it links). Mirrors `LcdSummaryMessageRow` but BOTH endpoints
 * are `lcd_summaries` rows: the `child_summary_id` FK is `ON DELETE RESTRICT`
 * so a condensed child summary can never be deleted (losslessness for the
 * multi-tier DAG). Paired 1:1 with `LcdSummaryParentRowSchema` via the drift
 * guard.
 */
export interface LcdSummaryParentRow {
  parent_summary_id: string;
  child_summary_id: string;
}

/**
 * Raw row shape for the `lcd_context_items` table (LCD compaction store).
 *
 * One row per item of the ordered model-facing view; carries the scoping
 * columns. `ordinal` is dense + gap-free per conversation (a UNIQUE
 * `(conversation_ref, ordinal)` index enforces it); `ref_kind` is the closed
 * `message`|`summary` discriminator; `ref_id` points at the referenced
 * `lcd_messages.id` or `lcd_summaries.summary_id`. Paired 1:1 with
 * `LcdContextItemRowSchema` via the drift guard.
 */
export interface LcdContextItemRow {
  id: string;
  /** tenant+agent+session composite scope key. */
  conversation_ref: string;
  tenant_id: string;
  agent_id: string;
  session_key: string;
  /** Dense, gap-free position in the model-facing order. */
  ordinal: number;
  /** Closed discriminator TEXT: `message` | `summary`. */
  ref_kind: string;
  /** `lcd_messages.id` OR `lcd_summaries.summary_id`. */
  ref_id: string;
}
