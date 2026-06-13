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

import { ensureTrigramTwins } from "./schema-trigram.js";

/**
 * Idempotently create the LCD (Lossless Context DAG) lossless message store
 * (Phase 127, F1): `lcd_messages` (one row per turn) + `lcd_message_parts` (one
 * row per structured block) — plus the Phase-129 (C3) compaction tables:
 * `lcd_summaries` (one row per leaf/condensed summary), `lcd_summary_messages`
 * (the leaf→message link, `ON DELETE RESTRICT` on the message FK to ENFORCE
 * losslessness) and `lcd_context_items` (the ordered, dense model-facing view) —
 * plus the Phase-130 (C2) condensed tier table `lcd_summary_parents` (the
 * condensed→child summary edge, `ON DELETE RESTRICT` on the child FK so a
 * condensed child summary is never deleted — losslessness for the multi-tier
 * DAG). Forward-only, re-run-safe — `CREATE … IF NOT EXISTS` only; NO `DROP
 * TABLE` / down-migration (design §9).
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
 * ## Isolation scope (R4 — ENFORCED Phase 132-03)
 *
 * `lcd_messages` carries `conversation_id` (the tenant+agent+session composite)
 * plus the three broken-out `tenant_id` / `agent_id` / `session_key` columns and
 * the `(conversation_id, seq)` UNIQUE index from day 1. Phase 132-03 (R4) now
 * FILTERS every read by `agent_id` AND `tenant_id` (not just `conversation_id`),
 * closing the Phase-131 WR-02 cross-agent gap (two agents legitimately share one
 * `conversation_id` since `formatSessionKey` omits agentId). The FTS5 vtables
 * carry an `agent_id UNINDEXED` column so the MATCH path filters agent_id too
 * (forward-only `CREATE VIRTUAL TABLE IF NOT EXISTS` — a pre-existing dev DB
 * created before 132-03 lacks the column and needs a wipe; no migration per
 * design §9). A missing scoping column would be a latent cross-tenant hole
 * (threat T-127-06).
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
    -- R4 (132-03): seq is monotonic PER (conversation, agent, tenant). Two agents
    -- legitimately share one conversation_id (formatSessionKey omits agentId), so
    -- each agent owns an independent seq sequence (its agent-scoped high-water
    -- mark) — a conversation-global (conversation_id, seq) index would collide
    -- when both agents append. Per-agent uniqueness; the per-conversation R3
    -- serializer (132-04/05) still guards interleaved writes. For the common
    -- one-agent-per-conversation case this is identical to the old index.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcd_messages_conv_agent_seq
      ON lcd_messages(conversation_id, agent_id, tenant_id, seq);

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
        CHECK (kind IN ('leaf','condensed')),    -- closed union (leaf | condensed)
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

    -- ── LCD condensed tier (Phase 130, C2) ─────────────────────────────────
    -- lcd_summary_parents is the condensed→child summary edge: one row per
    -- (condensed parent summary, child summary it links). It mirrors
    -- lcd_summary_messages but BOTH endpoints are lcd_summaries rows — the
    -- parent FK CASCADEs (deleting a condensed summary drops its edges) and the
    -- child FK is ON DELETE RESTRICT (a condensed child summary can never be
    -- deleted — the losslessness ledger for the multi-tier DAG). Forward-only,
    -- re-run-safe (CREATE … IF NOT EXISTS only); NO DROP / down-migration.
    CREATE TABLE IF NOT EXISTS lcd_summary_parents (
      parent_summary_id TEXT NOT NULL REFERENCES lcd_summaries(summary_id) ON DELETE CASCADE,
      child_summary_id  TEXT NOT NULL REFERENCES lcd_summaries(summary_id) ON DELETE RESTRICT,  -- RESTRICT ENFORCES losslessness
      PRIMARY KEY (parent_summary_id, child_summary_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lcd_summary_parents_child ON lcd_summary_parents(child_summary_id);

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
    -- R4 (132-03): the model-facing view is per (conversation, agent, tenant) —
    -- each agent's ordinals are dense + gap-free over ITS OWN items. A
    -- conversation-global (conversation_id, ordinal) index would collide when two
    -- agents sharing a conversation_id each seed a dense 0..N-1 sequence; scoping
    -- the index by agent_id+tenant_id keeps both dense + isolated. Identical to
    -- the old index for the common one-agent-per-conversation case.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcd_ctx_items_conv_agent_ord
      ON lcd_context_items(conversation_id, agent_id, tenant_id, ordinal);

    -- ── Phase 164 (RR1): durable per-conversation ingest cursor ────────────────
    -- Stores the durable per-conversation epoch cursor used by the afterTurn
    -- ingest to detect JSONL re-bases (a fresh/disjoint live transcript) and
    -- continue-append without a gap. Primary key = (conversation_id, agent_id,
    -- tenant_id) — the same three-column R4 isolation scope as lcd_messages.
    -- updated_at is caller-supplied epoch ms (the store never reads the clock).
    -- Forward-only, re-run-safe (CREATE … IF NOT EXISTS only; NO DROP TABLE /
    -- down-migration — design §9). An existing memory.db gains the empty table at
    -- the next boot; existing conversations have no cursor row (first-turn after
    -- upgrade detects null → treats as epoch A with ingestedLiveLen=0, correct).
    CREATE TABLE IF NOT EXISTS lcd_ingest_cursor (
      conversation_id   TEXT    NOT NULL,
      agent_id          TEXT    NOT NULL,
      tenant_id         TEXT    NOT NULL,
      epoch_anchor      TEXT    NOT NULL,       -- messageEpochAnchor(live[0]): "role:ts:fp"
      ingested_live_len INTEGER NOT NULL,       -- ingestedLiveLen at last successful ingest
      updated_at        INTEGER NOT NULL,       -- caller-supplied epoch ms
      PRIMARY KEY (conversation_id, agent_id, tenant_id)
    );
  `);

  // ── Phase 172 (DIST-01/03/05): LCD→LTM distillation provenance ─────────
  // Links a distilled episodic memory to the LCD condensed summary it came from.
  // Additive (CREATE IF NOT EXISTS only, forward-only — design §9).
  //
  // FK design decisions (from design/lcd-v3-unified-substrate.md §6.2):
  //   memory_id → memories(id) ON DELETE CASCADE:
  //     Auto-deletes provenance row when the distilled memory is deleted.
  //     This is the correct direction for DIST-05 (--memory cleanup) — a
  //     deleteBySessionKey call removes memories rows and their provenance rows
  //     are swept automatically by the CASCADE.
  //   superseded_by → memories(id) ON DELETE SET NULL:
  //     If the subsuming distilled memory is later deleted, the superseded
  //     provenance row becomes "dormant-eligible" again rather than being
  //     deleted (conservative / reversible by design — §14 decision 3).
  //   summary_id is intentionally NOT a FK into lcd_summaries:
  //     Provenance rows must survive LCD resets (which wipe lcd_summaries) so
  //     that DIST-05 --memory delete can still query source_session_key.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lcd_memory_provenance (
      provenance_id      TEXT    PRIMARY KEY,
      memory_id          TEXT    NOT NULL
        REFERENCES memories(id) ON DELETE CASCADE,
      summary_id         TEXT    NOT NULL,     -- NOT FK into lcd_summaries (survives LCD resets)
      source_session_key TEXT    NOT NULL,     -- for DIST-05 --memory delete path
      conversation_id    TEXT    NOT NULL,     -- R4 isolation column
      agent_id           TEXT    NOT NULL,     -- R4 isolation column
      tenant_id          TEXT    NOT NULL,     -- R4 isolation column
      created_at         INTEGER NOT NULL,
      superseded_by      TEXT                 -- memory_id of subsuming distilled memory (pyramid rule)
        REFERENCES memories(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prov_memory
      ON lcd_memory_provenance(memory_id);
    CREATE INDEX IF NOT EXISTS idx_prov_summary
      ON lcd_memory_provenance(summary_id);
    CREATE INDEX IF NOT EXISTS idx_prov_session
      ON lcd_memory_provenance(source_session_key, tenant_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_prov_superseded
      ON lcd_memory_provenance(superseded_by)
      WHERE superseded_by IS NOT NULL;
  `);

  // ── LCD full-text search (Phase 131, E1 ctx_search) ────────────────────────
  // TWO FTS5 virtual tables over the lossless store (RESEARCH Open Q1 → two
  // tables: origin parity, clean per-`scope` query, and PATTERNS gap #1 forces
  // different mechanisms — summaries HAVE a `content` column, messages do NOT).
  //
  //   - lcd_summaries_fts : external-content over lcd_summaries.content (mirrors
  //       memory_fts over memories.content, schema.ts:531-565). Kept in sync by
  //       AFTER INSERT/DELETE triggers; the 'rebuild' idiom backfills pre-index
  //       history (A5).
  //   - lcd_messages_fts  : SELF-CONTAINED — it stores its OWN content (no
  //       `content=` option), because lcd_messages has NO content column (the
  //       message text is JSON in lcd_message_parts.tool_input/tool_output + text
  //       parts), so there is no external table to project from. The
  //       createLcdStore adapter populates it on `append` with rendered part-text
  //       (the self-contained-FTS populate path, gap #1). There is no external
  //       table to 'rebuild' from, so pre-index message history is covered by
  //       searchLcd's LIKE fallback (and new appends populate it going forward —
  //       a documented tradeoff). (Storing its own content is also why orphaned
  //       rows stay matchable until an explicit scoped DELETE — the G10 hole the
  //       Phase-180 wipe-list close addresses.)
  //
  // The WHOLE section is wrapped in a try/catch so a host whose better-sqlite3
  // lacks compiled FTS5 still BOOTS (Pitfall 4 — initSchema must not throw):
  // searchLcd then detects the missing table and degrades to a LIKE scan. The
  // CREATE statements use `IF NOT EXISTS` (forward-only, re-run-safe — the file's
  // discipline; NO DROP). No interpolated identifiers/values (T-127-09).
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS lcd_summaries_fts USING fts5(
        content,
        conversation_id UNINDEXED,
        agent_id UNINDEXED,          -- R4: per-agent read isolation (WR-02); flat AND agent_id = ?
        summary_id UNINDEXED,
        content='lcd_summaries',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS lcd_messages_fts USING fts5(
        content,
        conversation_id UNINDEXED,
        agent_id UNINDEXED,          -- R4: per-agent read isolation (WR-02); adapter-populated on append
        message_id UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
    // A5 backfill: cover summaries written BEFORE the index existed (RESEARCH A5,
    // MEDIUM risk if skipped). External-content 'rebuild' idiom (mirror
    // schema.ts:545-549) — safe on an empty/just-created table.
    try {
      db.exec(`INSERT INTO lcd_summaries_fts(lcd_summaries_fts) VALUES('rebuild')`);
    } catch {
      // Safe to ignore on a just-created table with no content yet (schema.ts:547).
    }
    // Sync triggers for the EXTERNAL-CONTENT summaries table (lcd_summaries is
    // append-only/immutable, so INSERT + DELETE are the relevant ones; mirror
    // schema.ts:552-565). lcd_messages_fts is adapter-populated (no triggers —
    // the parts JSON cannot be rendered in SQL).
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS lcd_summaries_ai AFTER INSERT ON lcd_summaries BEGIN
        INSERT INTO lcd_summaries_fts(rowid, content, conversation_id, agent_id, summary_id)
        VALUES (new.rowid, new.content, new.conversation_id, new.agent_id, new.summary_id);
      END;
      CREATE TRIGGER IF NOT EXISTS lcd_summaries_ad AFTER DELETE ON lcd_summaries BEGIN
        INSERT INTO lcd_summaries_fts(lcd_summaries_fts, rowid, content, conversation_id, agent_id, summary_id)
        VALUES ('delete', old.rowid, old.content, old.conversation_id, old.agent_id, old.summary_id);
      END;
    `);
  } catch {
    // FTS5 not compiled into this host's better-sqlite3 → boot WITHOUT the index.
    // searchLcd detects the missing table and uses a LIKE scan (never hard-fails).
  }

  // ── Phase 180 (FTS-01): trigram twins for multilingual search ───────────────
  // The self-contained trigram twins (lcd_messages_fts_tri / lcd_summaries_fts_tri
  // / memory_fts_tri) + their base-table delete-mirror triggers. Created LAST, so
  // the LCD/memories base tables exist by now; schema.ts:initSchema picks this up
  // transitively (schema.ts is at the 800-line gate and is NOT touched). Each twin
  // is per-block boot-safe (trigram-absent hosts skip it cleanly — see the
  // schema-trigram.ts module doc).
  ensureTrigramTwins(db);
}
