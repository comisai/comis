/**
 * SQLite schema initialization for the @comis/memory package.
 *
 * Creates all tables, virtual tables, indexes, and triggers required
 * by the memory system. Uses better-sqlite3 for synchronous DDL and
 * sqlite-vec for vector search support (with graceful degradation).
 */

import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { initContextSchema } from "./context-schema.js";

/** Module-level flag tracking whether sqlite-vec loaded successfully. */
let vecAvailable = false;

/**
 * Check whether the sqlite-vec extension was loaded successfully
 * during the last `initSchema()` call. When false, vector search
 * is unavailable and only FTS5 text search will work.
 */
export function isVecAvailable(): boolean {
  return vecAvailable;
}

/**
 * Initialize the full memory schema on the given SQLite database.
 *
 * Creates:
 * - `memories` table with CHECK constraints and indexes
 * - `vec_memories` virtual table (if sqlite-vec is available)
 * - `memory_fts` FTS5 virtual table with external content triggers
 * - `sessions` table with indexes
 *
 * Safe to call multiple times (all DDL uses IF NOT EXISTS).
 *
 * @param db - An open better-sqlite3 Database instance
 * @param embeddingDimensions - Vector dimension size for vec_memories (e.g. 1536)
 */
export function initSchema(db: Database.Database, embeddingDimensions: number): { vecAvailable: boolean } {
  // --- Validate embeddingDimensions before DDL interpolation ---
  if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
    throw new Error(
      `Invalid embeddingDimensions: expected positive integer, got ${String(embeddingDimensions)}`,
    );
  }

  // --- Load sqlite-vec extension (graceful degradation) ---
  let localVecAvailable = false;
  try {
    sqliteVec.load(db);
    // Verify the extension actually works
    const row = db.prepare("SELECT vec_version() as v").get() as { v: string } | undefined;
    if (row) {
      localVecAvailable = true;
    }
  } catch {
    // Graceful degradation: vector search unavailable, FTS5 still works
    // In production this would be logged via Pino; for now silent fallback
  }
  // Update module-level flag for backward compatibility
  vecAvailable = localVecAvailable;

  // --- Base memories table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      trust_level TEXT NOT NULL CHECK(trust_level IN ('system', 'learned', 'external')),
      memory_type TEXT NOT NULL DEFAULT 'semantic' CHECK(memory_type IN ('working', 'episodic', 'semantic', 'procedural')),
      source_who TEXT NOT NULL,
      source_channel TEXT,
      source_session_key TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      expires_at INTEGER,
      has_embedding INTEGER NOT NULL DEFAULT 0
    );
  `);

  // --- Indexes on memories ---
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_tenant ON memories(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_memories_trust ON memories(trust_level);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
  `);

  // --- Migration: add agent_id column for multi-agent memory isolation ---
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'`);
  } catch {
    // Column already exists -- safe to ignore (SQLite throws on duplicate ADD COLUMN)
  }

  // Index for agent-scoped queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);`);

  // --- Vector search table (sqlite-vec) ---
  if (localVecAvailable) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${embeddingDimensions}] distance_metric=cosine
      );
    `);
  }

  // --- FTS5 full-text search (external content) ---
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      content='memories',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );
  `);

  // Rebuild FTS5 index to ensure consistency with external content table.
  // This is safe to call on empty tables (no-op) and essential after
  // reopening a database where the FTS5 index may be stale from a
  // previous unclean shutdown. For small databases (test scenarios),
  // this is effectively instant.
  try {
    db.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`);
  } catch {
    // Rebuild may fail if the table was just created (no content yet) -- safe to ignore
  }

  // --- FTS5 sync triggers ---
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  // --- Sessions table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);

  // --- Indexes on sessions ---
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
  `);

  // --- Archives table (compaction service) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS archives (
      session_key TEXT NOT NULL,
      messages TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archives_expires ON archives(expires_at);
  `);

  // --- Identity links table (cross-platform user recognition) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_links (
      canonical_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      display_name TEXT,
      linked_at INTEGER NOT NULL,
      PRIMARY KEY (provider, provider_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_identity_canonical ON identity_links(canonical_id);
  `);

  // --- Context store tables (DAG schema) ---
  initContextSchema(db);

  // --- Observability persistence tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS obs_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel_id TEXT DEFAULT '',
      execution_id TEXT DEFAULT '',
      session_key TEXT DEFAULT '',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_input REAL NOT NULL,
      cost_output REAL NOT NULL,
      cost_total REAL NOT NULL,
      cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0,
      cache_saved REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL,
      cache_retention TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_obs_token_timestamp ON obs_token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_obs_token_agent ON obs_token_usage(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_obs_token_provider ON obs_token_usage(provider, timestamp);
    CREATE INDEX IF NOT EXISTS idx_obs_token_session ON obs_token_usage(session_key, timestamp);
  `);

  // --- Migration: add cache cost columns to obs_token_usage ---
  try {
    db.exec(`ALTER TABLE obs_token_usage ADD COLUMN cost_cache_read REAL NOT NULL DEFAULT 0`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE obs_token_usage ADD COLUMN cost_cache_write REAL NOT NULL DEFAULT 0`);
  } catch { /* Column already exists */ }
  try {
    db.exec(`ALTER TABLE obs_token_usage ADD COLUMN cache_saved REAL NOT NULL DEFAULT 0`);
  } catch { /* Column already exists */ }

  // --- Migration: add cache_retention column to obs_token_usage ---
  try {
    db.exec(`ALTER TABLE obs_token_usage ADD COLUMN cache_retention TEXT DEFAULT NULL`);
  } catch { /* Column already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS obs_delivery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      session_key TEXT DEFAULT '',
      status TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      error_message TEXT DEFAULT '',
      message_preview TEXT DEFAULT '',
      tool_calls INTEGER DEFAULT 0,
      llm_calls INTEGER DEFAULT 0,
      tokens_total INTEGER DEFAULT 0,
      cost_total REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_obs_delivery_timestamp ON obs_delivery(timestamp);
    CREATE INDEX IF NOT EXISTS idx_obs_delivery_channel ON obs_delivery(channel_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_obs_delivery_status ON obs_delivery(status, timestamp);

    CREATE TABLE IF NOT EXISTS obs_diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      agent_id TEXT DEFAULT '',
      session_key TEXT DEFAULT '',
      message TEXT NOT NULL,
      details TEXT DEFAULT '',
      trace_id TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_obs_diag_timestamp ON obs_diagnostics(timestamp);
    CREATE INDEX IF NOT EXISTS idx_obs_diag_category ON obs_diagnostics(category, timestamp);
    CREATE INDEX IF NOT EXISTS idx_obs_diag_severity ON obs_diagnostics(severity, timestamp);

    CREATE TABLE IF NOT EXISTS obs_channel_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      channel_type TEXT NOT NULL,
      channel_id TEXT DEFAULT '',
      status TEXT NOT NULL,
      messages_sent INTEGER DEFAULT 0,
      messages_received INTEGER DEFAULT 0,
      uptime_ms INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_obs_channel_timestamp ON obs_channel_snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_obs_channel_type ON obs_channel_snapshots(channel_type, timestamp);
  `);

  // --- Delivery queue table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_queue (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      options_json TEXT NOT NULL DEFAULT '{}',
      origin TEXT NOT NULL DEFAULT 'unknown',
      format_applied INTEGER NOT NULL DEFAULT 0,
      chunking_applied INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'in_flight', 'delivered', 'failed', 'expired')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL,
      scheduled_at INTEGER NOT NULL,
      expire_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      next_retry_at INTEGER,
      last_error TEXT,
      markdown_fallback_applied INTEGER NOT NULL DEFAULT 0,
      delivered_message_id TEXT,
      trace_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dq_status_scheduled
      ON delivery_queue(status, scheduled_at)
      WHERE status IN ('pending', 'in_flight');
  `);

  // --- Delivery mirror table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_mirror (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      text TEXT NOT NULL,
      media_urls TEXT NOT NULL DEFAULT '[]',
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'agent',
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'acknowledged')),
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_idempotency
      ON delivery_mirror(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_dm_session_status
      ON delivery_mirror(session_key, status)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_dm_created
      ON delivery_mirror(created_at);
  `);

  // --- Embedding provider meta table (consolidated from embedding-fingerprint.ts) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_provider_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // --- Embedding cache table (persistent L2 embedding cache) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      provider     TEXT NOT NULL,
      model        TEXT NOT NULL,
      config_hash  TEXT NOT NULL,
      text_hash    TEXT NOT NULL,
      embedding    BLOB NOT NULL CHECK(length(embedding) > 0),
      dims         INTEGER NOT NULL CHECK(dims > 0),
      hit_count    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      accessed_at  INTEGER NOT NULL,
      PRIMARY KEY (provider, model, config_hash, text_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_cache_accessed
      ON embedding_cache(accessed_at);
  `);

  // Return per-instance vec state
  return { vecAvailable: localVecAvailable };
}
