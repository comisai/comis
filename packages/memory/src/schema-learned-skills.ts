// SPDX-License-Identifier: Apache-2.0
/**
 * The `learned_skills` table DDL — the v2.26 Verified Learning (WS2 / SKILL-01)
 * durable store of admitted, sandbox-validated procedures. Each row is one
 * reusable procedure (markdown `body` + optional embedded `scripts`) distilled
 * from successful trajectories; candidates are admitted here at `trust=learned`,
 * `state=candidate`, and a proof count drives promote/demote/evict.
 *
 * Forward-only, re-run-safe: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT
 * EXISTS` + `CREATE … VIRTUAL TABLE IF NOT EXISTS` only — no destructive or
 * reverse DDL, no branch on an old shape (design §9, additive). Extracted from
 * `schema.ts` (which is at the 800-line cap), like `schema-outcome-events.ts` /
 * `schema-video-jobs.ts` — `initSchema` CALLS this so the table exists on every
 * boot.
 *
 * ## SEC-01 trust ceiling (T-201-05) — the keystone
 *
 * `trust_level TEXT NOT NULL CHECK (trust_level IN ('learned')) DEFAULT 'learned'`
 * makes a synthesized procedure STRUCTURALLY incapable of being `system`: the DB
 * REJECTS any other value at insert time. The store ALSO coerces `trust_level` to
 * `'learned'` in code (belt-and-suspenders) — a candidate claiming `trust:'system'`
 * is rejected by the DB AND never even reaches the column.
 *
 * ## SEC-01 isolation (T-201-06) — the multi-tenant boundary
 *
 * `(tenant_id, agent_id)` are bare `NOT NULL` columns and lead every key/index;
 * the store filters EVERY statement on them, so a procedure under one
 * (tenant, agent) is never visible to a read under another in the multi-agent DB.
 * `UNIQUE (tenant_id, agent_id, name)` is the lookup key + the idempotency
 * backstop (the store derives the row id as a deterministic hash of that tuple).
 *
 * ## FTS5 / vec0 / trigram twins
 *
 * `learned_skills_fts` (external-content FTS5 over `body`, the word lane) mirrors
 * `memory_fts`; `vec_learned_skills` (sqlite-vec, sized from the runtime-probed
 * embedding dimension) mirrors `vec_memories`; `learned_skills_fts_tri` (a
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
 * Create the `learned_skills` table + its scope index + the FTS5/vec0/trigram
 * twins idempotently.
 *
 * Safe to call multiple times (all DDL uses IF NOT EXISTS). Called from
 * `initSchema` right after `ensureOutcomeEventsTable` so the table exists on every
 * daemon boot. The `CHECK` constraints pin the `trust_level` (the SEC-01 keystone)
 * and `state` closed enums; the `UNIQUE (…)` is the lookup key + idempotency
 * backstop; the index serves the scoped `list()` read.
 *
 * @param db - An open better-sqlite3 Database instance.
 * @param embeddingDimensions - Vector dimension for `vec_learned_skills` (runtime-probed; same value as `vec_memories`).
 * @param vecAvailable - Whether sqlite-vec loaded (the vec twin is skipped when false, mirroring `vec_memories`).
 */
export function ensureLearnedSkillsTable(
  db: Database.Database,
  embeddingDimensions: number,
  vecAvailable: boolean,
): void {
  // --- Base table + scope index (forward-only, additive) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_skills (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      name             TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      trigger          TEXT,
      body             TEXT NOT NULL,
      scripts          TEXT,
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
      UNIQUE (tenant_id, agent_id, name)
    );
    CREATE INDEX IF NOT EXISTS learned_skills_scope ON learned_skills(tenant_id, agent_id, state);
  `);

  // --- Vector search twin (sqlite-vec) — sized from the runtime-probed dim ---
  // Mirrors `vec_memories` (schema.ts:502-507): skipped wholesale when sqlite-vec
  // is unavailable (FTS5 still works). Best-effort so a partial-extension host
  // still boots the base table.
  if (vecAvailable) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_learned_skills USING vec0(
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
  // `learned_skills` (the body lives in `body`, there is NO `content` column).
  // `memory_fts` names its column `content` because `memories.content` exists;
  // for external-content FTS5, the indexed column name MUST equal the source
  // column so the `'rebuild'` command (which re-reads the external content table)
  // can find it — naming it `content` here threw "no such column: content" on
  // every boot, silently leaving the index reliant on incremental triggers and
  // never re-derivable after an unclean shutdown (WR-04).
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS learned_skills_fts USING fts5(
        body,
        content='learned_skills',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
    try {
      db.exec(`INSERT INTO learned_skills_fts(learned_skills_fts) VALUES('rebuild')`);
    } catch {
      // Rebuild may fail on a freshly-created empty table — safe to ignore.
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS learned_skills_ai AFTER INSERT ON learned_skills BEGIN
        INSERT INTO learned_skills_fts(rowid, body) VALUES (new.rowid, new.body);
      END;

      CREATE TRIGGER IF NOT EXISTS learned_skills_ad AFTER DELETE ON learned_skills BEGIN
        INSERT INTO learned_skills_fts(learned_skills_fts, rowid, body) VALUES('delete', old.rowid, old.body);
      END;

      CREATE TRIGGER IF NOT EXISTS learned_skills_au AFTER UPDATE OF body ON learned_skills BEGIN
        INSERT INTO learned_skills_fts(learned_skills_fts, rowid, body) VALUES('delete', old.rowid, old.body);
        INSERT INTO learned_skills_fts(rowid, body) VALUES (new.rowid, new.body);
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
      CREATE VIRTUAL TABLE IF NOT EXISTS learned_skills_fts_tri USING fts5(
        content,
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS learned_skills_tri_ad AFTER DELETE ON learned_skills BEGIN
        DELETE FROM learned_skills_fts_tri WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS learned_skills_tri_au AFTER UPDATE OF body ON learned_skills
        WHEN old.body IS NOT new.body BEGIN
        DELETE FROM learned_skills_fts_tri WHERE rowid = old.rowid;
      END;
    `);
  } catch {
    // trigram tokenizer not compiled into this host's better-sqlite3 → boot
    // WITHOUT the trigram twin (search probes availability and degrades). The
    // triggers live in the SAME try so a failed CREATE can never orphan a trigger
    // that would break a base-table DELETE.
  }
}
