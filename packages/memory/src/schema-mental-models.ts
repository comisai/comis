// SPDX-License-Identifier: Apache-2.0
/**
 * The `mental_models` table DDL — the v2.31 Mental Model doc store (generalized
 * from the v2.26 Verified Learning WS2 / SKILL-01 `learned_skills` procedural
 * store). Each row is one advisory doc of `kind ∈ {skill, profile, topic}`
 * (markdown `body`) distilled from successful trajectories; candidates are
 * admitted here at `trust=learned`, `state=candidate`, and a proof count drives
 * promote/demote/evict. A `kind='skill'` row materializes byte-identically to the
 * pre-generalization learned-skill surface (the no-behavior-change guarantee).
 *
 * Forward-only, re-run-safe: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT
 * EXISTS` + `CREATE … VIRTUAL TABLE IF NOT EXISTS` only — no reverse DDL, no
 * branch on an old shape (design §9, additive) — PLUS a one-time copy-forward
 * REBUILD from a pre-existing `learned_skills` table (below). Extracted from
 * `schema.ts` (which is at the 800-line cap), like `schema-outcome-events.ts` /
 * `schema-video-jobs.ts` — `initSchema` CALLS this so the table exists on every
 * boot.
 *
 * ## The advisory-doc-only shape (no learned code)
 *
 * The generalized table DROPS the executable `scripts` column entirely (it was
 * always the literal NULL in the store's `insertStmt` — a true no-op to drop). A
 * mental-model doc is READ by the agent, which acts through its already-
 * permissioned tools; there is no learned-code path. The `required_tools` /
 * `params_schema` / `mutating` advisory-metadata columns are KEPT (the surface
 * filter reads `mutating`). The dead `trigger` column is dropped too (zero
 * readers). The new `structured_body` / `history` JSON columns are provisioned
 * NULL this phase (Phase 223 populates `structured_body` via typed delta-ops).
 *
 * ## SEC-01 trust ceiling (T-201-05) — the keystone
 *
 * `trust_level TEXT NOT NULL CHECK (trust_level IN ('learned')) DEFAULT 'learned'`
 * makes a learned doc STRUCTURALLY incapable of being `system`: the DB REJECTS
 * any other value at insert time. The store ALSO coerces `trust_level` to
 * `'learned'` in code (belt-and-suspenders) — a candidate claiming `trust:'system'`
 * is rejected by the DB AND never even reaches the column.
 *
 * ## SEC-01 isolation (T-201-06) — the multi-tenant boundary
 *
 * `(tenant_id, agent_id)` are bare `NOT NULL` columns and lead every key/index;
 * the store filters EVERY statement on them, so a doc under one (tenant, agent)
 * is never visible to a read under another in the multi-agent DB.
 * `UNIQUE (tenant_id, agent_id, kind, topic_key, name)` is the lookup key + the
 * idempotency backstop (the store derives the row id as a deterministic hash of
 * that tuple).
 *
 * ## FTS5 / vec0 / trigram twins
 *
 * `mental_models_fts` (external-content FTS5 over `body`, the word lane) mirrors
 * `memory_fts`; `vec_mental_models` (sqlite-vec, sized from the runtime-probed
 * embedding dimension) mirrors `vec_memories`; `mental_models_fts_tri` (a
 * self-contained trigram twin) mirrors `memory_fts_tri` for non-Latin recall.
 * Each twin is best-effort (wrapped so a host whose better-sqlite3 lacks the FTS5
 * or trigram tokenizer still boots — the base table is created unconditionally).
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard is
 * needed ([[node-permission-model-disables-fsync]]).
 *
 * @module
 */

import type Database from "better-sqlite3";

/**
 * Create the `mental_models` table + its scope index + the FTS5/vec0/trigram
 * twins idempotently, and (one-time) copy any pre-existing `learned_skills` rows
 * forward as `kind='skill'`.
 *
 * Safe to call multiple times (all DDL uses IF NOT EXISTS; the copy-forward only
 * fires while a `learned_skills` table still exists). Called from `initSchema`
 * right after `ensureOutcomeEventsTable` so the table exists on every daemon
 * boot. The `CHECK` constraints pin the `trust_level` (the SEC-01 keystone),
 * `kind`, and `state` closed enums; the `UNIQUE (…)` is the lookup key +
 * idempotency backstop; the index serves the scoped `list()` read.
 *
 * @param db - An open better-sqlite3 Database instance.
 * @param embeddingDimensions - Vector dimension for `vec_mental_models` (runtime-probed; same value as `vec_memories`).
 * @param vecAvailable - Whether sqlite-vec loaded (the vec twin is skipped when false, mirroring `vec_memories`).
 */
export function ensureMentalModelsTable(
  db: Database.Database,
  embeddingDimensions: number,
  vecAvailable: boolean,
): void {
  // --- Base table + scope index (forward-only, additive) ---
  // The generalized doc shape: kind/topic_key/structured_body/history added; the
  // executable `scripts` column and the dead `trigger` column dropped.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mental_models (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('skill','profile','topic')) DEFAULT 'skill',
      topic_key        TEXT NOT NULL DEFAULT '',
      name             TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      body             TEXT NOT NULL,
      structured_body  TEXT,
      history          TEXT,
      required_tools   TEXT,
      params_schema    TEXT,
      trust_level      TEXT NOT NULL CHECK (trust_level IN ('learned')) DEFAULT 'learned',
      state            TEXT NOT NULL CHECK (state IN ('candidate','active','stale','archived')) DEFAULT 'candidate',
      proof_count      INTEGER NOT NULL DEFAULT 0,
      confidence       REAL NOT NULL DEFAULT 0,
      strength         REAL NOT NULL DEFAULT 0,
      source_traj_ids  TEXT,
      validation_result TEXT,
      mutating         INTEGER NOT NULL DEFAULT 0,
      pinned           INTEGER NOT NULL DEFAULT 0,
      validated_at     INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER,
      evicted_at       INTEGER,
      UNIQUE (tenant_id, agent_id, kind, topic_key, name)
    );
    CREATE INDEX IF NOT EXISTS mental_models_scope ON mental_models(tenant_id, agent_id, kind, state);
  `);

  // --- One-time copy-forward REBUILD from a pre-existing `learned_skills` table ---
  // A FRESH DB skips this (the generalized table above is the only one). A dev/test
  // DB that admitted under the pre-generalization name copies every row forward as
  // kind='skill' and DROPS the old table + its orphaned twins/triggers. (The prod
  // table is empty — synthesis never admitted — so this is the dev/test path.)
  //
  // Mirrors the `ensureTunedAlphaIntent` REBUILD shape (detect → fk-toggle → txn →
  // copy → drop), but detects the OLD TABLE BY NAME (a different table name, not a
  // column add). This is a forward-only REBUILD / copy-forward (the
  // `ensureTunedAlphaIntent` vocabulary) — there is no compatibility shim, alias,
  // or dual-read path: the old table is copied once and dropped in the same txn.
  //
  // The copied `id` is the OLD (tenant, agent, name) hash verbatim — SQLite has no
  // sha256 builtin to recompute the widened (tenant, agent, kind, topic_key, name)
  // hash inside INSERT…SELECT. A later re-admit of the same skill recomputes the
  // widened id and upserts; the row-resurrection path (ON CONFLICT … state=
  // 'candidate', evicted_at=NULL) tolerates the transient. Acceptable because prod
  // is empty (dev/test-only).
  const oldExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learned_skills'")
    .get();
  if (oldExists !== undefined) {
    const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1;
    if (fkWasOn) db.pragma("foreign_keys = OFF"); // pragma OUTSIDE the txn (no-op INSIDE a txn)
    const copyForward = db.transaction(() => {
      db.exec(`
        INSERT OR IGNORE INTO mental_models
          (id, tenant_id, agent_id, kind, topic_key, name, description, body,
           required_tools, params_schema, trust_level, state, proof_count, confidence,
           strength, source_traj_ids, validation_result, mutating, pinned, validated_at,
           created_at, updated_at, evicted_at)
          SELECT id, tenant_id, agent_id, 'skill', '', name, description, body,
                 required_tools, params_schema, 'learned', state, proof_count, confidence,
                 strength, source_traj_ids, validation_result, mutating, pinned, validated_at,
                 created_at, updated_at, evicted_at
          FROM learned_skills;
        DROP TABLE learned_skills;
        DROP TABLE IF EXISTS learned_skills_fts;
        DROP TABLE IF EXISTS learned_skills_fts_tri;
        DROP TABLE IF EXISTS vec_learned_skills;
        DROP TRIGGER IF EXISTS learned_skills_ai;
        DROP TRIGGER IF EXISTS learned_skills_ad;
        DROP TRIGGER IF EXISTS learned_skills_au;
        DROP TRIGGER IF EXISTS learned_skills_tri_ad;
        DROP TRIGGER IF EXISTS learned_skills_tri_au;
      `);
    });
    copyForward();
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }

  // --- Vector search twin (sqlite-vec) — sized from the runtime-probed dim ---
  // Mirrors `vec_memories` (schema.ts:502-507): skipped wholesale when sqlite-vec
  // is unavailable (FTS5 still works). Best-effort so a partial-extension host
  // still boots the base table.
  if (vecAvailable) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_mental_models USING vec0(
          skill_id TEXT PRIMARY KEY,
          embedding float[${embeddingDimensions}] distance_metric=cosine
        );
      `);
    } catch {
      // sqlite-vec present at load but vec0 CREATE failed on this host — degrade
      // to FTS-only (the base table is already created above).
    }
  }

  // --- FTS5 word-lane twin (external content over `body`) ---
  // Mirrors `memory_fts` (schema.ts:510-545): external-content config + the
  // _ai/_ad/_au sync triggers; the `rebuild` is wrapped (safe-no-op on an empty
  // table). Best-effort so a host without the FTS5 module still boots.
  //
  // The FTS column is named `body` to MATCH the real source column on
  // `mental_models` (the body lives in `body`, there is NO `content` column).
  // `memory_fts` names its column `content` because `memories.content` exists;
  // for external-content FTS5, the indexed column name MUST equal the source
  // column so the `'rebuild'` command (which re-reads the external content table)
  // can find it — naming it `content` here threw "no such column: content" on
  // every boot, silently leaving the index reliant on incremental triggers and
  // never re-derivable after an unclean shutdown (WR-04).
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mental_models_fts USING fts5(
        body,
        content='mental_models',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
    try {
      db.exec(`INSERT INTO mental_models_fts(mental_models_fts) VALUES('rebuild')`);
    } catch {
      // Rebuild may fail on a freshly-created empty table — safe to ignore.
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS mental_models_ai AFTER INSERT ON mental_models BEGIN
        INSERT INTO mental_models_fts(rowid, body) VALUES (new.rowid, new.body);
      END;

      CREATE TRIGGER IF NOT EXISTS mental_models_ad AFTER DELETE ON mental_models BEGIN
        INSERT INTO mental_models_fts(mental_models_fts, rowid, body) VALUES('delete', old.rowid, old.body);
      END;

      CREATE TRIGGER IF NOT EXISTS mental_models_au AFTER UPDATE OF body ON mental_models BEGIN
        INSERT INTO mental_models_fts(mental_models_fts, rowid, body) VALUES('delete', old.rowid, old.body);
        INSERT INTO mental_models_fts(rowid, body) VALUES (new.rowid, new.body);
      END;
    `);
  } catch {
    // FTS5 tokenizer not compiled into this host's better-sqlite3 → boot WITHOUT
    // the word-lane twin (search probes availability and degrades). The triggers
    // live in the SAME try so a failed FTS CREATE can never orphan a trigger that
    // would break a base-table INSERT/DELETE.
  }

  // --- Trigram twin (self-contained, non-Latin lane) ---
  // Mirrors `memory_fts_tri` (schema-trigram.ts:136): self-contained (stores its
  // OWN content — no external `rebuild` that would undo normalization) + a
  // delete-mirror + a WHEN-guarded body-update trigger. Best-effort: a host
  // without the trigram tokenizer boots without it.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mental_models_fts_tri USING fts5(
        content,
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS mental_models_tri_ad AFTER DELETE ON mental_models BEGIN
        DELETE FROM mental_models_fts_tri WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS mental_models_tri_au AFTER UPDATE OF body ON mental_models
        WHEN old.body IS NOT new.body BEGIN
        DELETE FROM mental_models_fts_tri WHERE rowid = old.rowid;
      END;
    `);
  } catch {
    // trigram tokenizer not compiled into this host's better-sqlite3 → boot
    // WITHOUT the trigram twin (search probes availability and degrades). The
    // triggers live in the SAME try so a failed CREATE can never orphan a trigger
    // that would break a base-table DELETE.
  }
}
