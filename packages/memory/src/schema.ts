// SPDX-License-Identifier: Apache-2.0
// @allow-throw: initSchema() embeddingDimensions DDL precondition guard; invalid input prevents schema interpolation; consumed at bootstrap (daemon entry — daemon.ts boundary).
/**
 * SQLite schema initialization for the @comis/memory package.
 *
 * Creates all tables, virtual tables, indexes, and triggers required
 * by the memory system. Uses better-sqlite3 for synchronous DDL and
 * sqlite-vec for vector search support (with graceful degradation).
 */
import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { ensureLcdTables } from "./schema-lcd.js";
import { ensurePinnedColumn } from "./schema-pinned.js";
import { ensureVideoJobTable } from "./schema-video-jobs.js";
import { ensureOutcomeEventsTable } from "./schema-outcome-events.js";

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
 * Additively ensure the `memories` table carries every column the current code
 * expects, adding any absent. The package's forward-only, additive column-add path
 * (design §4.1): SQLite has no `ADD COLUMN IF NOT EXISTS`, so each add is guarded by a
 * `PRAGMA table_info(memories)` presence check. Safe on every boot, including a live
 * `~/.comis` DB created before a column existed — existing rows get the column NULL (a
 * nullable add is O(1); no rewrite, no backfill).
 * Added columns (each documented at its add-site below): `occurred_at`,
 * the observation set `proof_count`/`source_ids`/`consolidated_at`/
 * `confidence`/`history`, the typed-observation pair
 * `observation_kind`/`pattern_type`, and the lifecycle markers
 * `lifecycle_demoted_at`/`evicted_at`/`strength` (nullable SIDE-columns,
 * NO PK change). All nullable (NULL = the pre-feature default), NO CHECK (the enums
 * are the Zod domain type's job).
 *
 * @param db - An open better-sqlite3 Database whose `memories` table already exists.
 */
export function ensureMemoryColumns(db: Database.Database): void {
  // Object-literal cast (matches the `as { v: string } | undefined` style at the
  // vec_version() probe below); the untyped-sqlite rule targets `as Foo[]` (a \w+
  // named type) and does NOT match an object-literal cast.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[]).map((r) => r.name),
  );
  // Nullable add → O(1), no table rewrite, no destructive rewrite.
  if (!cols.has("occurred_at")) db.exec(`ALTER TABLE memories ADD COLUMN occurred_at INTEGER`);
  // Observation columns. All nullable → O(1) ADD, no rewrite, no backfill
  // (existing rows get NULL = "raw, never consolidated"). Forward-only.
  if (!cols.has("proof_count")) db.exec(`ALTER TABLE memories ADD COLUMN proof_count INTEGER`);
  if (!cols.has("source_ids")) db.exec(`ALTER TABLE memories ADD COLUMN source_ids TEXT`);
  if (!cols.has("consolidated_at")) db.exec(`ALTER TABLE memories ADD COLUMN consolidated_at INTEGER`);
  if (!cols.has("confidence")) db.exec(`ALTER TABLE memories ADD COLUMN confidence REAL`);
  if (!cols.has("history")) db.exec(`ALTER TABLE memories ADD COLUMN history TEXT`);
  // Typed-observation columns. Both nullable → O(1) ADD, no rewrite,
  // no backfill (existing rows get NULL: observation_kind NULL = "merge" on read, the
  // forward-only default). NO CHECK — the enum is enforced in the MemoryEntry Zod type
  // + the lenient LLM parser, per the occurred_at/proof_count no-CHECK precedent.
  if (!cols.has("observation_kind")) db.exec(`ALTER TABLE memories ADD COLUMN observation_kind TEXT`);
  if (!cols.has("pattern_type")) db.exec(`ALTER TABLE memories ADD COLUMN pattern_type TEXT`);
  // Lifecycle marker columns. Nullable → O(1) ADD, no rewrite/backfill
  // (existing rows get NULL = "not demoted / not evicted / no strength yet" = byte-
  // identity for a pre-lifecycle DB). Forward-only, NO CHECK, NO PK CHANGE: nullable SIDE-
  // columns on the `id`-keyed table, never an identity key (the PK-widening lesson
  // :150-218 — a side-column over a rebuild). The sweep is SCAFFOLD-DORMANT: it
  // computes strength/tiers but writes NONE of these markers (the deferred live policy
  // sets them NON-DESTRUCTIVELY, a marker never a DELETE — the `consolidated_at` :62).
  if (!cols.has("lifecycle_demoted_at")) db.exec(`ALTER TABLE memories ADD COLUMN lifecycle_demoted_at INTEGER`);
  if (!cols.has("evicted_at")) db.exec(`ALTER TABLE memories ADD COLUMN evicted_at INTEGER`);
  if (!cols.has("strength")) db.exec(`ALTER TABLE memories ADD COLUMN strength REAL`);
}

/**
 * Idempotently create the entity-association junction tables:
 * `memory_entities` (one row per resolved entity, scoped to tenant+agent) and
 * `memory_entity_links` (the many-to-many memory<->entity edge). Mirrors
 * `ensureMemoryColumns`'s forward-only, additive contract — all DDL is `CREATE … IF
 * NOT EXISTS`, safe on every boot including a live `~/.comis` DB created before the
 * feature existed (no backfill: existing memories have no links until re-extracted).
 *
 * ## The UNIQUE index keys on `canonical_key`, NOT a SQL lower() expression
 *
 * RESEARCH Pitfall 3: SQLite's built-in `lower()` is ASCII-only (it leaves
 * `İSTANBUL`/`CAFÉ`/`ПРИВЕТ` unchanged), so the original §4.2 spec's UNIQUE index
 * over a SQL `lower(...)` of the display name would NOT dedup Turkish/CJK/Cyrillic
 * case-variants → duplicate entities. Instead the resolver computes a
 * locale-independent `canonical_key` in TypeScript (`normalizeEntityKey` in
 * entity-resolver.ts: lower+NFKD+strip-marks) and we UNIQUE-index THAT stored column.
 *
 * The index keys on `(tenant_id, agent_id, canonical_key)` so two agents or tenants
 * NEVER collapse to one entity row even with an identical name — the resolver-side
 * half of the isolation boundary.
 *
 * `ON DELETE CASCADE` on `memory_entity_links.memory_id → memories(id)` is the
 * ENTIRE link-maintenance story (no orphan-sweep job). It fires
 * automatically because `openSqliteDatabase` already sets `PRAGMA foreign_keys = ON`
 * (sqlite-adapter-base.ts:52). NB: the parent `memory_entities` row is intentionally
 * NOT cascaded by a memory delete (entities are per-concept and may be re-linked;
 * RESEARCH Pitfall 7), so a stale `mention_count` is by-design, not an orphan bug.
 *
 * @param db - An open better-sqlite3 Database whose `memories` table exists (the FK
 *   target). Call AFTER the base `memories` CREATE.
 */
export function ensureEntityTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entities (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      canonical_name TEXT NOT NULL,            -- display form (first-seen casing)
      canonical_key  TEXT NOT NULL,            -- normalized key (TS lower+NFKD+strip-marks; NOT sqlite lower(), Pitfall 3)
      mention_count INTEGER NOT NULL DEFAULT 1,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mement_uniq
      ON memory_entities(tenant_id, agent_id, canonical_key);

    CREATE TABLE IF NOT EXISTS memory_entity_links (
      memory_id TEXT NOT NULL REFERENCES memories(id)        ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
      PRIMARY KEY (memory_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mentlink_entity ON memory_entity_links(entity_id);
  `);
}

/**
 * Idempotently create the recall-utility usefulness table (per-intent buckets
 * were added later): `memory_usefulness` — one row per
 * (tenant, agent, memory, intent) carrying the durable used/ignored counts +
 * last-useful-at the recall-utility feedback loop learns from (HINDSIGHT_VS_COMIS.md
 * #7). Forward-only, idempotent, re-run-safe — safe on every boot incl. a live
 * `~/.comis` DB predating the feature (no row loss, no corruption).
 *
 * ## PRIMARY KEY = isolation boundary + the per-intent upsert key
 *
 * `PRIMARY KEY (tenant_id, agent_id, memory_id, intent)` is both the adapter's
 * `ON CONFLICT` target and the load-bearing isolation scope — two agents/tenants
 * NEVER share a row even for the same `memory_id` (the adapter also filters every
 * read/write on `(tenant_id, agent_id)`). `intent` is an ADDITIONAL key, never a
 * relaxation. `ON DELETE CASCADE` on `memory_id → memories(id)` is the ENTIRE
 * row-maintenance story (no orphan-sweep): it fires via the `PRAGMA foreign_keys =
 * ON` already set by `openSqliteDatabase`.
 *
 * ## Widening the PK on a pre-intent DB: a transactional REBUILD
 *
 * `intent TEXT NOT NULL DEFAULT ''` partitions the signal per query-intent (global
 * bucket = `''`, the byte-identical pre-intent path). A FRESH DB gets the 4-col PK from
 * `CREATE TABLE`. An EXISTING (pre-intent) DB has a 3-col PK, and SQLite has NO
 * `ALTER ADD PRIMARY KEY` — a bare `ADD COLUMN intent` leaves it 3-col, so the
 * adapter's 4-col `ON CONFLICT(...,intent)` aborts the SECOND intent bucket's
 * upsert with `UNIQUE constraint failed`. So the pre-intent path runs the
 * standard SQLite transactional table REBUILD (taken when the 4-col PK is absent
 * via `PRAGMA table_info`): create a `_new` table with the genuine 4-col PK, copy
 * EVERY row into the `''` bucket (`COALESCE(intent,'')` — no loss/corruption),
 * drop, rename. Re-run-safe (4-col PK present → skip) and brackets the rename with
 * `foreign_keys` OFF so the `memories(id)` FK is not transiently dropped.
 *
 * @param db - An open better-sqlite3 Database whose `memories` table already
 *   exists (the FK target). Call AFTER `ensureEntityTables` in `initSchema`.
 */
export function ensureUsefulnessTable(db: Database.Database): void {
  // FRESH DB: the 4-col PK + intent column. EXISTING DB: no-op here (the PK-shape
  // rebuild below widens it).
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_usefulness (
      tenant_id      TEXT NOT NULL,
      agent_id       TEXT NOT NULL,
      memory_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      intent         TEXT NOT NULL DEFAULT '',
      used_count     INTEGER NOT NULL DEFAULT 0,
      ignored_count  INTEGER NOT NULL DEFAULT 0,
      last_useful_at INTEGER,
      PRIMARY KEY (tenant_id, agent_id, memory_id, intent)
    );
  `);
  // Detect a pre-intent (or partially-migrated) table by its PK shape (`pk>0` marks a
  // PK member). The object-literal cast is the sanctioned PRAGMA idiom, NOT `as Foo[]`.
  const tableInfo = db.prepare(`PRAGMA table_info(memory_usefulness)`).all() as { name: string; pk: number }[];
  const pkHasIntent = tableInfo.some((c) => c.pk > 0 && c.name === "intent");
  if (!pkHasIntent) {
    // EXISTING (pre-intent) DB: REBUILD to genuinely widen the PK to 4-col (ADD COLUMN
    // cannot). A PRISTINE pre-intent table has NO `intent` column (copy the ''
    // literal); a PARTIALLY-migrated one (column present, PK still 3-col) COALESCEs
    // it. Toggle foreign_keys OFF around the rename (the pragma is a no-op INSIDE a
    // txn, so it MUST bracket db.transaction) so the memories(id) FK is not dropped.
    const intentSelectExpr = tableInfo.some((c) => c.name === "intent") ? "COALESCE(intent, '')" : "''";
    const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1;
    if (fkWasOn) db.pragma("foreign_keys = OFF");
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE memory_usefulness_new (
          tenant_id      TEXT NOT NULL,
          agent_id       TEXT NOT NULL,
          memory_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          intent         TEXT NOT NULL DEFAULT '',
          used_count     INTEGER NOT NULL DEFAULT 0,
          ignored_count  INTEGER NOT NULL DEFAULT 0,
          last_useful_at INTEGER,
          PRIMARY KEY (tenant_id, agent_id, memory_id, intent)
        );
        INSERT INTO memory_usefulness_new (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, last_useful_at)
          SELECT tenant_id, agent_id, memory_id, ${intentSelectExpr}, used_count, ignored_count, last_useful_at FROM memory_usefulness;
        DROP TABLE memory_usefulness;
        ALTER TABLE memory_usefulness_new RENAME TO memory_usefulness;
      `);
    });
    rebuild();
    // Restore the pragma. No foreign_key_check needed: the INSERT…SELECT copies rows
    // VERBATIM and the FK target (memories.id) is unchanged — no new dangling ref.
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
  // The explicit named 4-col index for the adapter's per-intent upsert ON CONFLICT target (idempotent; redundant with the now-4-col PK but harmless).
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_usefulness_intent ON memory_usefulness(tenant_id, agent_id, memory_id, intent)`,
  );
}

/**
 * Idempotently create the causal-edge table:
 * `memory_causal_edges` — one row per directed cause→effect edge between two
 * memories, scoped to a (tenant, agent). Mirrors `ensureEntityTables` /
 * `ensureUsefulnessTable`'s forward-only, additive contract — the DDL is
 * `CREATE TABLE IF NOT EXISTS`, so it is safe to run on every boot including a
 * live `~/.comis` DB created before the feature existed (no backfill: existing
 * memories simply have no causal edges until re-extracted).
 *
 * ## The PRIMARY KEY is the isolation boundary AND the idempotency target
 *
 * Comis runs many agents in one DB. `PRIMARY KEY (tenant_id, agent_id,
 * source_memory_id, target_memory_id)` is both the `INSERT OR IGNORE` conflict
 * target for the adapter's idempotent edge write and the load-bearing isolation
 * scope — an edge written under one (tenant, agent) is NEVER returned for another
 * by memory-id coincidence, and the adapter additionally filters every read/write
 * on tenant_id + agent_id (belt-and-braces).
 *
 * `ON DELETE CASCADE` on BOTH `source_memory_id` and `target_memory_id →
 * memories(id)` is the ENTIRE edge-maintenance story (no orphan-sweep job — the
 * same cascade pattern the entity links use): a memory delete drops every edge it participates in
 * automatically. It fires because `openSqliteDatabase` already sets
 * `PRAGMA foreign_keys = ON` (sqlite-adapter-base.ts) — no pragma is set here.
 * The `idx_causal_target` index serves the read lane's effect→cause direction
 * (the source→effect direction is served by the PK prefix).
 *
 * @param db - An open better-sqlite3 Database whose `memories` table already
 *   exists (the FK target). Call AFTER `ensureUsefulnessTable` in `initSchema`.
 */
export function ensureCausalTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_causal_edges (
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      confidence       REAL NOT NULL DEFAULT 1.0,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, agent_id, source_memory_id, target_memory_id)
    );
    CREATE INDEX IF NOT EXISTS idx_causal_target
      ON memory_causal_edges(tenant_id, agent_id, target_memory_id);
  `);
}

/**
 * Create the segregated bi-temporal knowledge-graph triple table.
 * Forward-only additive, idempotent (every
 * `CREATE TABLE/INDEX IF NOT EXISTS`), safe on every boot — the same path serves
 * a fresh DB and a live DB that predates the table (existing `~/.comis` DBs gain
 * the empty table with no backfill; mirrors `ensureCausalTables`).
 *
 * ## Schema shape (the contract the other knowledge-graph code builds on)
 *
 * One row = one S/P/O assertion with the FOUR bi-temporal timestamps (Graphiti's
 * model, epoch ms): the VALID-time pair `t_valid_start` / `t_valid_end`
 * (`t_valid_end IS NULL` = currently believed — the default recall filter)
 * and the TXN-time pair `t_ingested` / `expired_at` (when we learned it / when we
 * stopped believing it). Plus the world OCCURRED range `t_occurred` /
 * `t_occurred_end`, the Comis `trust` ladder, optional `source_memory_id`
 * provenance, and a `confidence`.
 *
 * ## The PRIMARY KEY is per-row `id`, NOT the current-truth tuple
 *
 * History is NON-DESTRUCTIVE — many superseded versions of a
 * (tenant, agent, subject, predicate) coexist, so the PK is the row `id`.
 * "Single current truth" is enforced by the partial index `idx_triples_current`
 * (on `t_valid_end IS NULL`) + the upsert transaction, NOT a UNIQUE
 * constraint. The `ON DELETE CASCADE` on `source_memory_id -> memories(id)`
 * fires via the `PRAGMA foreign_keys = ON` already set by `openSqliteDatabase`
 * (no pragma is set here) — deleting a source memory drops its derived triples.
 *
 * ## Isolation (the §5.2 invariant)
 *
 * Every row carries `tenant_id` + `agent_id`, and every index leads with them —
 * the adapter (sqlite-triple-store.ts) filters every statement on
 * `(tenant_id, agent_id)`. The `trust` CHECK rejects an out-of-ladder value at
 * write.
 *
 * @param db - An open better-sqlite3 Database whose `memories` table already
 *   exists (the FK target). Call AFTER `ensureCausalTables` in `initSchema`.
 */
export function ensureTripleTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_triples (
      id               TEXT NOT NULL,
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      subject          TEXT NOT NULL,
      predicate        TEXT NOT NULL,
      object           TEXT NOT NULL,
      trust            TEXT NOT NULL CHECK(trust IN ('system','learned','external')),
      t_valid_start    INTEGER NOT NULL,
      t_valid_end      INTEGER,
      t_ingested       INTEGER NOT NULL,
      expired_at       INTEGER,
      t_occurred       INTEGER,
      t_occurred_end   INTEGER,
      source_memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
      confidence       REAL,
      PRIMARY KEY (id)
    );
    CREATE INDEX IF NOT EXISTS idx_triples_current
      ON memory_triples(tenant_id, agent_id, subject, predicate) WHERE t_valid_end IS NULL;
    CREATE INDEX IF NOT EXISTS idx_triples_validtime
      ON memory_triples(tenant_id, agent_id, t_valid_start, t_valid_end);
    CREATE INDEX IF NOT EXISTS idx_triples_subject
      ON memory_triples(tenant_id, agent_id, subject) WHERE t_valid_end IS NULL;
  `);
}

/**
 * Create the segregated per-user-representation table.
 * Forward-only additive, idempotent, safe on every boot (a fresh DB and
 * a pre-table live `~/.comis` DB both gain the empty table with no backfill; NEVER
 * wipes). One row = one durable, PREFIX-TYPED, HIGH-TRUST fact about a single user,
 * scoped to one (tenant, agent, user); PK is the per-row `id`; `created_at` is the
 * injected clock. The sole adapter is `createSqliteUserRepresentationStore`.
 *
 * The high-trust floor at the DB layer: the `trust` CHECK admits only
 * `system`/`learned` — `'external'` is DELIBERATELY OMITTED, so an external claim
 * can NEVER enter the profile (layer 1 of the 3-layer anti-poisoning defense; the
 * adapter's write-time reject is layer 3, the port-type floor is layer 2).
 * `entry_type`'s own CHECK pins the four prefix-types — the DISTINCT vocabulary
 * from `memory_type`. Isolation (EXTENDED with
 * `user_id`): every row carries `tenant_id`+`agent_id`+`user_id`,
 * `idx_user_repr_scope` leads with all three, and the adapter filters every
 * statement on them. The `source_memory_id -> memories(id)` `ON DELETE CASCADE`
 * fires via the `PRAGMA foreign_keys = ON` set by `openSqliteDatabase`.
 *
 * @param db - An open better-sqlite3 Database whose `memories` table already exists
 *   (the FK target). Call AFTER `ensureTripleTable` in `initSchema`.
 */
export function ensureUserRepresentationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_representation (
      id               TEXT NOT NULL,
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      entry_type       TEXT NOT NULL CHECK(entry_type IN ('identity','preference','relationship','instruction')),
      content          TEXT NOT NULL,
      trust            TEXT NOT NULL CHECK(trust IN ('system','learned')),
      source_memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER,
      PRIMARY KEY (id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_repr_scope
      ON user_representation(tenant_id, agent_id, user_id);
  `);
}

/**
 * Create the `relationship` table — the sole storage for directional, multi-party
 * relationship modeling. Additive, forward-only,
 * idempotent. One row = the durable, DIRECTIONAL, HIGH-TRUST edge `subjectUser`'s
 * representation OF `aboutUser`, scoped to one (tenant, agent, channel). Sole
 * adapter: `createSqliteRelationshipStore`.
 *
 * The high-trust floor at the DB layer: `CHECK(trust IN
 * ('system','learned'))` — `'external'` STRUCTURALLY ABSENT, so external content
 * can NEVER enter a relationship (defense-in-depth with the adapter write-boundary
 * reject (layer 3) + the port-type floor (layer 2)). Isolation (EXTENDED with
 * `channel_id`, the NEW privacy axis): every row carries
 * `tenant_id`+`agent_id`+`channel_id`, `idx_relationship_scope` leads with all
 * three, the adapter filters every statement on them; the directional
 * `(subject_user_id, about_user_id)` pair is ROW DATA, NOT a security filter (A→B
 * is DISTINCT from B→A, never symmetrized). The `source_memory_id -> memories(id)`
 * `ON DELETE CASCADE` fires via the `PRAGMA foreign_keys = ON` set by
 * `openSqliteDatabase`.
 *
 * @param db - An open better-sqlite3 Database whose `memories` table already exists
 *   (the FK target). Call AFTER `ensureUserRepresentationTable` in `initSchema`.
 */
export function ensureRelationshipTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relationship (
      id               TEXT NOT NULL,
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      channel_id       TEXT NOT NULL,
      subject_user_id  TEXT NOT NULL,
      about_user_id    TEXT NOT NULL,
      content          TEXT NOT NULL,
      trust            TEXT NOT NULL CHECK(trust IN ('system','learned')),
      source_memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER,
      PRIMARY KEY (id)
    );
    CREATE INDEX IF NOT EXISTS idx_relationship_scope
      ON relationship(tenant_id, agent_id, channel_id);
  `);
}

/**
 * Create the `tuned_alpha` table — the sole storage for the per-(tenant, agent)
 * LEARNED ranking weights. Additive, forward-only,
 * idempotent; safe on a live DB with NO backfill (an absent `(tenant, agent)` row
 * reads back `undefined` — the recall apply site's default-OFF no-op).
 * Sole adapter: `createSqliteTunedAlphaStore`. Belt #3 (the ship-gate, schema
 * layer): columns for ONLY the 4 tunable boost alphas + `updated_at` — NO fifth
 * (trust-weight) column, so the bandit can never move that weight (it stays
 * config-sourced at the apply site); the `trust_alpha` name is deliberately never
 * written (grep-0, asserted in the adapter test). `PRIMARY KEY (tenant_id,
 * agent_id)` IS the isolation boundary (RED-proven); NO FK to `memories` (per-scope
 * CONFIG state, not per-memory provenance). Call AFTER `ensureRelationshipTable`.
 */
export function ensureTunedAlphaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tuned_alpha (
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      recency_alpha    REAL NOT NULL,
      temporal_alpha   REAL NOT NULL,
      proof_alpha      REAL NOT NULL,
      usefulness_alpha REAL NOT NULL,
      updated_at       INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, agent_id)
    );
  `);
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

  // NOTE: the DAG context-store tables (ctx_*) were removed in v2.12 (Phase 126,
  // LCD reimplementation) — only the schema-create call is gone (no reverse migration; existing DBs keep harmless orphaned tables, design §9).
  // The calls below run in dependency order AFTER the `memories` table (the FK
  // target) exists; each is idempotent, and every `ON DELETE CASCADE` fires via
  // the `PRAGMA foreign_keys = ON` already set by `openSqliteDatabase`. Per-table contracts (schema shape, isolation scope, trust floor) live in each fn JSDoc.
  ensureMemoryColumns(db); // additive memory columns (forward-only; design §4.1)
  ensureEntityTables(db); // entity junction tables
  ensureUsefulnessTable(db); // recall-utility usefulness + intent bucket
  ensureCausalTables(db); // causal-edge table
  ensureTripleTable(db); // bi-temporal KG triples
  ensureUserRepresentationTable(db); // per-user representation
  ensureRelationshipTable(db); // directional relationships
  ensureTunedAlphaTable(db); // tuned ranking alphas
  ensureLcdTables(db); // LCD lossless message + parts store (Phase 127)
  ensurePinnedColumn(db); // pinned-memory column + partial index (forward-only; design §4.1)
  ensureVideoJobTable(db); // durable async video-job store (Phase 189, JOB-01/JOB-03)
  ensureOutcomeEventsTable(db); // outcome_events ledger (v2.26 WS1, OUTCOME-01) — no FK, (tenant,agent)-scoped

  // --- Observation partial indexes (design §4.1) --- created AFTER ensureMemoryColumns (indexed columns must exist first).
  // `idx_memories_unconsol` serves the candidate scan (consolidated_at IS NULL); `idx_memories_observations` serves the observation lookup (proof_count IS NOT NULL).
  // The design's third "live" index (exact-dup-retirement) is OMITTED — deferred to a later phase.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_unconsol
      ON memories(agent_id, created_at) WHERE consolidated_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_observations
      ON memories(agent_id) WHERE proof_count IS NOT NULL;
  `);

  // --- Observability persistence tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS obs_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel_id TEXT DEFAULT '',
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
    CREATE INDEX IF NOT EXISTS idx_obs_diag_session_cat ON obs_diagnostics(session_key, category, timestamp);
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

    -- SystemPromptReport persistence.
    -- Full JSON payload stored after sanitizeForPersistence pipeline.
    -- PRIMARY KEY (agent_id, session_id, run_id, generated_at) — run_id is
    -- nullable; composite key tolerates multiple reports per session.
    CREATE TABLE IF NOT EXISTS system_prompt_reports (
      agent_id        TEXT NOT NULL,
      tenant_id       TEXT,
      session_id      TEXT NOT NULL,
      run_id          TEXT,
      generated_at    INTEGER NOT NULL,
      provider        TEXT,
      model           TEXT,
      system_chars    INTEGER NOT NULL,
      system_sha256   TEXT NOT NULL,
      report_json     TEXT NOT NULL,
      PRIMARY KEY (agent_id, session_id, run_id, generated_at)
    );
    CREATE INDEX IF NOT EXISTS idx_spr_session
      ON system_prompt_reports(agent_id, session_id, generated_at);
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
