// SPDX-License-Identifier: Apache-2.0
/**
 * Trigram twin DDL — the trigram-search table half.
 *
 * Three SELF-CONTAINED FTS5 trigram twins that mirror the lossless base tables,
 * plus the base-table delete-mirror triggers and the WHEN-guarded memories
 * content-update trigger:
 *
 *   - `lcd_messages_fts_tri`   ← lcd_messages   (conversation_ref/agent_id/message_id UNINDEXED)
 *   - `lcd_summaries_fts_tri`  ← lcd_summaries  (conversation_ref/agent_id/summary_id UNINDEXED)
 *   - `memory_fts_tri`         ← memories       (no scope columns — the rowid-JOIN lane)
 *
 * The twins are the substrate the search/write paths target: appends
 * write `normalizeForSearch(content)` into them (TS-side) so a
 * script-routed `MATCH` can read Hebrew/Arabic/Cyrillic/CJK; the base-table
 * triggers below close the ~5 delete/update bypass sites BY CONSTRUCTION — a
 * delete needs no normalizer, and a missed TS write site can never leave
 * matchable text behind (the fail-safe direction is DE-INDEXED, never wrongly
 * indexed).
 *
 * ## Self-contained, NOT external-content (deliberate; "rebuild" REJECTED)
 *
 * These twins store their OWN `content` (no `content=`/`content_rowid=` option).
 * An external-content twin would expose the FTS5 `'rebuild'` command, which
 * re-reads the RAW base-table text — silently UNDOING the normalization
 * the twins exist to hold. The doctor backfill instead feeds
 * normalized text explicitly. These twins are NOT content-free shadow tables —
 * storing their own content is exactly the mechanism that keeps orphaned rows
 * matchable until a SCOPED DELETE removes them (the scoped-wipe path).
 *
 * ## Per-block boot safety (each twin CREATE + its trigger(s) are ONE block)
 *
 * `initSchema` runs on every host, including ones whose better-sqlite3 lacks the
 * trigram tokenizer. Each twin is created in its own try/catch, paired with its
 * trigger(s): a base-table existence guard + the CREATE-then-triggers in a single
 * `db.exec` means a failed twin CREATE (trigram absent) skips that twin's
 * triggers — no orphan trigger can ever reference a missing twin and break a
 * base-table DELETE. Search probes availability at query time
 * (`isTriAvailable`) and degrades to the scan floors; it never
 * hard-fails. Forward-only: every CREATE is guarded re-run-safe, no DROP /
 * down-migration. Static SQL, no interpolated identifiers.
 *
 * @module
 */

import { normalizeForSearch } from "@comis/core";
import type Database from "better-sqlite3";
import { z } from "zod";

const SchemaRowSchema = z.strictObject({ sql: z.string().nullable() });
const MemoryBackfillRowSchema = z.strictObject({
  rowid: z.number().int().positive(),
  content: z.string(),
  partition_id: z.number().int().positive(),
});

/** True iff a base table `name` exists — so a twin block is skipped wholesale on
 *  a partial-schema host (the table + its triggers stay paired; no orphan twin
 *  table and no orphan trigger). Static SQL, bound param. */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function schemaSql(db: Database.Database, name: string): string | undefined {
  const parsed = SchemaRowSchema.safeParse(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name),
  );
  return parsed.success ? (parsed.data.sql ?? undefined) : undefined;
}

/**
 * Idempotently create the three trigram twins + their base-table delete-mirror
 * triggers + the WHEN-guarded memories content-update trigger. Forward-only and
 * re-run-safe (every CREATE is existence-guarded). Never throws for a missing trigram
 * tokenizer or a partial-schema test db — each twin's CREATE + trigger(s) share
 * one try/catch so a failed CREATE skips its triggers (no orphan trigger).
 *
 * Called as the LAST statement of `ensureLcdTables` (schema-lcd.ts), after the
 * base LCD tables and the word-lane FTS section exist; `schema.ts:initSchema`
 * picks it up transitively (schema.ts is at the 800-line gate and is NOT
 * touched).
 *
 * @param db - An open better-sqlite3 Database with the LCD/memories base tables.
 */
export function ensureTrigramTwins(db: Database.Database): void {
  // ── Block 1: lcd_messages twin + delete-mirror trigger ──────────────────────
  if (tableExists(db, "lcd_messages")) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lcd_messages_fts_tri USING fts5(
          content,
          conversation_ref UNINDEXED,
          agent_id UNINDEXED,          -- per-agent read isolation; MATCH … AND agent_id = ?
          message_id UNINDEXED,
          tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS lcd_messages_tri_ad AFTER DELETE ON lcd_messages BEGIN
          DELETE FROM lcd_messages_fts_tri WHERE rowid = old.rowid;
        END;
      `);
    } catch {
      // trigram tokenizer not compiled into this host's better-sqlite3 (or base
      // table absent in a partial-schema test db) → boot WITHOUT this twin;
      // search probes availability (isTriAvailable) and degrades to the floors
      // (never hard-fails). The trigger lives in the SAME block so a failed twin
      // CREATE can never orphan a trigger that would break base-table DELETEs.
    }
  }

  // ── Block 2: lcd_summaries twin + delete-mirror trigger ─────────────────────
  if (tableExists(db, "lcd_summaries")) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lcd_summaries_fts_tri USING fts5(
          content,
          conversation_ref UNINDEXED,
          agent_id UNINDEXED,          -- per-agent read isolation; MATCH … AND agent_id = ?
          summary_id UNINDEXED,
          tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS lcd_summaries_tri_ad AFTER DELETE ON lcd_summaries BEGIN
          DELETE FROM lcd_summaries_fts_tri WHERE rowid = old.rowid;
        END;
      `);
    } catch {
      // trigram tokenizer not compiled into this host's better-sqlite3 (or base
      // table absent in a partial-schema test db) → boot WITHOUT this twin;
      // search probes availability (isTriAvailable) and degrades to the floors
      // (never hard-fails). The trigger lives in the SAME block so a failed twin
      // CREATE can never orphan a trigger that would break base-table DELETEs.
    }
  }

  // ── Block 3: memories twin + delete-mirror trigger + WHEN-guarded update ─────
  // The memory twin carries an indexed authority token, so tenant-agent scope is
  // applied by MATCH before ranking and LIMIT. It also carries TWO triggers (delete + update); the
  // WHEN-guarded update is mandatory: a plain `AFTER UPDATE OF content` fires on
  // the consolidation proof-only fold `content = COALESCE(NULL, content)`
  // (probe-verified), which would silently de-index a
  // memory on every consolidation. The WHEN guard below de-indexes ONLY when the
  // content column value actually changed; the normalized re-insert is
  // TS-side, and its failure leaves the row de-indexed (the
  // fail-safe direction), never stale-indexed.
  if (tableExists(db, "memories")) {
    try {
      const existingSql = schemaSql(db, "memory_fts_tri");
      const needsRebuild = existingSql === undefined || !/authority_token/i.test(existingSql);
      if (needsRebuild) {
        db.exec(`
          DROP TRIGGER IF EXISTS memories_tri_ad;
          DROP TRIGGER IF EXISTS memories_tri_au;
          DROP TABLE IF EXISTS memory_fts_tri;
        `);
      }
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_tri USING fts5(
          content,
          authority_token,
          tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS memories_tri_ad AFTER DELETE ON memories BEGIN
          DELETE FROM memory_fts_tri WHERE rowid = old.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS memories_tri_au AFTER UPDATE OF content ON memories
          WHEN old.content IS NOT new.content BEGIN
          DELETE FROM memory_fts_tri WHERE rowid = old.rowid;
        END;
      `);
      if (needsRebuild) {
        const rows = db
          .prepare(
            `SELECT m.rowid, m.content, p.partition_id
             FROM memories m
             JOIN memory_authority_partitions p
               ON p.tenant_id = m.tenant_id AND p.agent_id = m.agent_id
              AND p.visibility_key = CASE m.visibility
                WHEN 'conversation' THEN 'conversation:' || m.conversation_ref
                WHEN 'principal' THEN 'principal:' || m.principal_id
                ELSE 'agent-shared'
              END`,
          )
          .iterate();
        const insert = db.prepare(
          "INSERT INTO memory_fts_tri(rowid, content, authority_token) VALUES (?, ?, ?)",
        );
        for (const raw of rows) {
          const parsed = MemoryBackfillRowSchema.safeParse(raw);
          if (!parsed.success) continue;
          insert.run(
            parsed.data.rowid,
            normalizeForSearch(parsed.data.content),
            `authority_${parsed.data.partition_id}`,
          );
        }
      }
    } catch {
      // trigram tokenizer not compiled into this host's better-sqlite3 (or base
      // table absent in a partial-schema test db) → boot WITHOUT this twin;
      // search probes availability (isTriAvailable) and degrades to the floors
      // (never hard-fails). The triggers live in the SAME block so a failed twin
      // CREATE can never orphan a trigger that would break base-table DELETEs.
    }
  }
}
