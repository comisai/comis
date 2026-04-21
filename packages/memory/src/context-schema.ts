// SPDX-License-Identifier: Apache-2.0
/**
 * Context store SQLite schema DDL.
 *
 * Creates the 12 `ctx_`-prefixed tables, 10 indexes, and 2 FTS5 virtual
 * tables that back the DAG-based context engine. Standalone FTS5 tables
 * are used (not external content) because the context store is the sole
 * writer for all ctx_ tables.
 *
 * @module
 */

import type Database from "better-sqlite3";

/**
 * Create all context-store tables if they do not already exist.
 *
 * Includes:
 * - 9 regular tables with CHECK constraints and foreign keys
 * - 10 indexes for query performance
 * - 2 standalone FTS5 virtual tables with porter tokenizer
 *
 * Safe to call multiple times (idempotent via IF NOT EXISTS).
 *
 * @param db - An open better-sqlite3 Database instance
 */
export function initContextSchema(db: Database.Database): void {
  db.exec(`
    -- Conversations (1:1 with agent sessions)
    CREATE TABLE IF NOT EXISTS ctx_conversations (
      conversation_id  TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      session_key      TEXT NOT NULL,
      title            TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tenant_id, session_key)
    );

    -- Messages (immutable after write, AUTOINCREMENT prevents rowid reuse)
    CREATE TABLE IF NOT EXISTS ctx_messages (
      message_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id  TEXT NOT NULL REFERENCES ctx_conversations(conversation_id) ON DELETE CASCADE,
      seq              INTEGER NOT NULL,
      role             TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
      content          TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      token_count      INTEGER NOT NULL,
      tool_name        TEXT,
      tool_call_id     TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (conversation_id, seq)
    );
    CREATE INDEX IF NOT EXISTS ctx_messages_conv_seq ON ctx_messages(conversation_id, seq);
    CREATE INDEX IF NOT EXISTS ctx_messages_hash ON ctx_messages(content_hash);

    -- Message parts (normalized structured content blocks)
    CREATE TABLE IF NOT EXISTS ctx_message_parts (
      part_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id       INTEGER NOT NULL REFERENCES ctx_messages(message_id) ON DELETE CASCADE,
      ordinal          INTEGER NOT NULL,
      part_type        TEXT NOT NULL,
      content          TEXT,
      metadata         TEXT,
      UNIQUE (message_id, ordinal)
    );

    -- Summary DAG nodes
    CREATE TABLE IF NOT EXISTS ctx_summaries (
      summary_id       TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL REFERENCES ctx_conversations(conversation_id) ON DELETE CASCADE,
      kind             TEXT NOT NULL CHECK (kind IN ('leaf','condensed')),
      depth            INTEGER NOT NULL DEFAULT 0,
      content          TEXT NOT NULL,
      token_count      INTEGER NOT NULL,
      file_ids         TEXT NOT NULL DEFAULT '[]',
      earliest_at      TEXT,
      latest_at        TEXT,
      descendant_count       INTEGER NOT NULL DEFAULT 0,
      descendant_token_count INTEGER NOT NULL DEFAULT 0,
      source_token_count     INTEGER NOT NULL DEFAULT 0,
      counts_dirty     INTEGER NOT NULL DEFAULT 0,
      quality_score    REAL,
      compaction_level TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ctx_summaries_conv ON ctx_summaries(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS ctx_summaries_depth ON ctx_summaries(conversation_id, depth);

    -- Leaf summary -> source message links
    CREATE TABLE IF NOT EXISTS ctx_summary_messages (
      summary_id   TEXT NOT NULL REFERENCES ctx_summaries(summary_id) ON DELETE CASCADE,
      message_id   INTEGER NOT NULL REFERENCES ctx_messages(message_id) ON DELETE RESTRICT,
      ordinal      INTEGER NOT NULL,
      PRIMARY KEY (summary_id, message_id)
    );

    -- Condensed summary -> parent summary links
    CREATE TABLE IF NOT EXISTS ctx_summary_parents (
      summary_id         TEXT NOT NULL REFERENCES ctx_summaries(summary_id) ON DELETE CASCADE,
      parent_summary_id  TEXT NOT NULL REFERENCES ctx_summaries(summary_id) ON DELETE RESTRICT,
      ordinal            INTEGER NOT NULL,
      PRIMARY KEY (summary_id, parent_summary_id)
    );

    -- Ordered context items (what the model sees)
    CREATE TABLE IF NOT EXISTS ctx_context_items (
      conversation_id  TEXT NOT NULL REFERENCES ctx_conversations(conversation_id) ON DELETE CASCADE,
      ordinal          INTEGER NOT NULL,
      item_type        TEXT NOT NULL CHECK (item_type IN ('message','summary')),
      message_id       INTEGER REFERENCES ctx_messages(message_id) ON DELETE RESTRICT,
      summary_id       TEXT REFERENCES ctx_summaries(summary_id) ON DELETE RESTRICT,
      PRIMARY KEY (conversation_id, ordinal),
      CHECK (
        (item_type = 'message' AND message_id IS NOT NULL AND summary_id IS NULL) OR
        (item_type = 'summary' AND summary_id IS NOT NULL AND message_id IS NULL)
      )
    );

    -- Large file storage metadata
    CREATE TABLE IF NOT EXISTS ctx_large_files (
      file_id          TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL REFERENCES ctx_conversations(conversation_id) ON DELETE CASCADE,
      file_name        TEXT,
      mime_type        TEXT,
      byte_size        INTEGER,
      content_hash     TEXT,
      storage_path     TEXT NOT NULL,
      exploration_summary TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ctx_large_files_conv ON ctx_large_files(conversation_id);
    CREATE INDEX IF NOT EXISTS ctx_large_files_hash ON ctx_large_files(content_hash);

    -- Expansion grants (persisted, not in-memory)
    CREATE TABLE IF NOT EXISTS ctx_expansion_grants (
      grant_id         TEXT PRIMARY KEY,
      issuer_session   TEXT NOT NULL,
      conversation_ids TEXT NOT NULL,
      summary_ids      TEXT NOT NULL DEFAULT '[]',
      max_depth        INTEGER NOT NULL DEFAULT 3,
      token_cap        INTEGER NOT NULL DEFAULT 4000,
      tokens_consumed  INTEGER NOT NULL DEFAULT 0,
      expires_at       TEXT NOT NULL,
      revoked          INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ctx_grants_session ON ctx_expansion_grants(issuer_session);
    CREATE INDEX IF NOT EXISTS ctx_grants_expires ON ctx_expansion_grants(expires_at);

    -- FTS5 indexes (standalone, not external content)
    CREATE VIRTUAL TABLE IF NOT EXISTS ctx_messages_fts USING fts5(
      content,
      tokenize='porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ctx_summaries_fts USING fts5(
      summary_id,
      content,
      tokenize='porter unicode61'
    );
  `);
}
