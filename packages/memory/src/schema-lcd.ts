// SPDX-License-Identifier: Apache-2.0
/**
 * LCD (Lossless Context DAG) lossless-store schema (Phase 127, F1).
 *
 * Extracted from `schema.ts` so the LCD DDL stays cohesive and the umbrella
 * schema module stays under the file-size gate. `initSchema` (in `schema.ts`)
 * calls `ensureLcdTables` in its ordered `ensure*` block; the data-write
 * boundary (INSERT/SELECT with user data) is the `createLcdStore` adapter
 * (`lcd-store.ts`), which uses static `prepare()` only.
 *
 * @module
 */

import type Database from "better-sqlite3";

/**
 * Idempotently create the LCD (Lossless Context DAG) lossless message store
 * (Phase 127, F1): `lcd_messages` (one row per turn) + `lcd_message_parts` (one
 * row per structured block) — plus the Phase-129 (C3) compaction tables:
 * `lcd_summaries` (one row per depth-0 leaf summary), `lcd_summary_messages`
 * (the leaf→message link, `ON DELETE RESTRICT` on the message FK to ENFORCE
 * losslessness) and `lcd_context_items` (the ordered, dense model-facing view).
 * Forward-only, re-run-safe — `CREATE … IF NOT EXISTS` only; NO `DROP TABLE` /
 * down-migration (design §9).
 *
 * ## What it persists (F1)
 *
 * Every structured block — `text` / `tool_use` / `tool_result` / `reasoning` /
 * `file` — is stored as an `lcd_message_parts` row with its typed tool columns
 * (`tool_call_id` / `tool_name` / `tool_input` / `tool_output` / `is_error`) AND
 * the verbatim canonical pi-ai block in the JSON `metadata` column (which also
 * carries the F2 message envelope + the F3 reasoning marker). The typed columns
 * are the queryable projection; `metadata.raw` is the lossless source of truth.
 *
 * ## Isolation scope (R4 — enforced Phase 132, schema NOW)
 *
 * `lcd_messages` carries `conversation_id` (the tenant+agent+session composite)
 * plus the three broken-out `tenant_id` / `agent_id` / `session_key` columns and
 * the `(conversation_id, seq)` UNIQUE index from day 1, so Phase 132's R4
 * read/write tenant filters key on the EXISTING schema with no migration. A
 * missing scoping column now would be a latent cross-tenant hole (threat
 * T-127-06).
 *
 * ## Cascade
 *
 * The `lcd_message_parts.message_id` FK is `ON DELETE CASCADE`; deleting a
 * message removes its parts. The cascade fires via the `PRAGMA foreign_keys =
 * ON` already set by `openSqliteDatabase` (sqlite-adapter-base.ts:52). `seq` is
 * monotonic PER conversation (the unique index enforces no duplicate seq within
 * a conversation).
 *
 * The DDL is a single static `db.exec(...)` with no interpolated identifiers or
 * values — the data-write boundary (INSERT/SELECT with user data) is the
 * `createLcdStore` adapter, which uses static `prepare()` only (threat T-127-07).
 *
 * @param db - An open better-sqlite3 Database. LCD has no FK into `memories`, so
 *   it may be created in any order relative to the other ensure* tables.
 */
export function ensureLcdTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lcd_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,            -- tenant+agent+session composite (R4 scoping; enforce Phase 132)
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_key     TEXT NOT NULL,
      seq             INTEGER NOT NULL,         -- monotonic PER conversation
      role            TEXT NOT NULL
        CHECK (role IN ('user', 'assistant', 'toolResult')),  -- IN-01: defense-in-depth; matches LcdRole + the unchecked read-path cast
      token_count     INTEGER NOT NULL,         -- pre-computed agent-side; the store never computes it
      created_at      INTEGER NOT NULL          -- caller-supplied epoch ms (the store does not stamp it)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcd_messages_conv_seq
      ON lcd_messages(conversation_id, seq);

    CREATE TABLE IF NOT EXISTS lcd_message_parts (
      id           TEXT PRIMARY KEY,
      message_id   TEXT NOT NULL REFERENCES lcd_messages(id) ON DELETE CASCADE,
      ordinal      INTEGER NOT NULL,            -- block order within the message
      kind         TEXT NOT NULL
        CHECK (kind IN ('text', 'tool_use', 'tool_result', 'reasoning', 'file')),  -- IN-01: defense-in-depth; matches LcdPartKind + the unchecked read-path cast
      tool_call_id TEXT,                         -- ToolCall.id / ToolResultMessage.toolCallId (NULL for non-tool)
      tool_name    TEXT,                         -- ToolCall.name / ToolResultMessage.toolName
      tool_input   TEXT,                         -- JSON: ToolCall.arguments
      tool_output  TEXT,                         -- JSON: ToolResultMessage.content
      is_error     INTEGER,                      -- 0/1; NULL for non-tool_result
      metadata     TEXT NOT NULL DEFAULT '{}'   -- JSON LcdPartMetadata: { raw, rawType, topLevelReasoningOnly, messageEnvelope }
    );
    CREATE INDEX IF NOT EXISTS idx_lcd_parts_msg ON lcd_message_parts(message_id, ordinal);

    -- ── LCD compaction tables (Phase 129, C3) ──────────────────────────────
    -- The depth-0 leaf-summary half of the contract. lcd_summaries holds one
    -- row per leaf summary (a condensation of a contiguous run of messages);
    -- lcd_summary_messages links a summary to the messages it covers; and
    -- lcd_context_items is the ordered model-facing view the assembler walks
    -- (each item references either a raw message or a leaf summary). Condensed
    -- kinds (depth>0) are Phase 130. Forward-only, re-run-safe (CREATE … IF NOT
    -- EXISTS only); NO DROP / down-migration (design §9).

    CREATE TABLE IF NOT EXISTS lcd_summaries (
      summary_id       TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL,            -- tenant+agent+session composite (R4 scoping; enforce Phase 132)
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      session_key      TEXT NOT NULL,
      kind             TEXT NOT NULL
        CHECK (kind IN ('leaf')),                -- closed union; condensed kinds = Phase 130
      depth            INTEGER NOT NULL,         -- 0 for 129 (leaf)
      earliest_at      INTEGER NOT NULL,         -- min created_at of the covered messages
      latest_at        INTEGER NOT NULL,         -- max created_at of the covered messages
      descendant_count INTEGER NOT NULL,         -- count of covered messages
      token_count      INTEGER NOT NULL,         -- pre-computed agent-side; the store never computes it
      content          TEXT NOT NULL,            -- leaf summary plaintext (never logged)
      file_ids         TEXT NOT NULL DEFAULT '[]', -- JSON string[]
      taint            INTEGER NOT NULL DEFAULT 0, -- 0/1 untrusted-content flag (enforced Phase 132)
      fallback         INTEGER NOT NULL DEFAULT 0, -- 0/1 Level-3 deterministic-truncation marker
      created_at       INTEGER NOT NULL          -- caller-supplied epoch ms (the store does not stamp it)
    );
    CREATE INDEX IF NOT EXISTS idx_lcd_summaries_conv ON lcd_summaries(conversation_id);

    CREATE TABLE IF NOT EXISTS lcd_summary_messages (
      summary_id TEXT NOT NULL REFERENCES lcd_summaries(summary_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES lcd_messages(id) ON DELETE RESTRICT,  -- RESTRICT ENFORCES losslessness (Pitfall 5)
      PRIMARY KEY (summary_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lcd_summary_messages_msg ON lcd_summary_messages(message_id);

    CREATE TABLE IF NOT EXISTS lcd_context_items (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,             -- tenant+agent+session composite (R4 scoping; enforce Phase 132)
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_key     TEXT NOT NULL,
      ordinal         INTEGER NOT NULL,          -- dense, gap-free position in the model-facing order
      ref_kind        TEXT NOT NULL
        CHECK (ref_kind IN ('message','summary')),  -- closed discriminator (AGENTS.md §2.8)
      ref_id          TEXT NOT NULL              -- lcd_messages.id OR lcd_summaries.summary_id
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcd_ctx_items_conv_ord ON lcd_context_items(conversation_id, ordinal);
  `);
}
