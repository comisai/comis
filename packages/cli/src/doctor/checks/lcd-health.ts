// SPDX-License-Identifier: Apache-2.0
/**
 * LCD store health check for comis doctor.
 *
 * Six read-only SQL scan classes against memory.db that give operators
 * store-integrity visibility without raw SQL access. Each scan class
 * targets one known corruption shape (see the enumeration on the check
 * export below).
 *
 * Privacy: all finding `message` fields carry ONLY counts, UUIDs, and
 * errorKind strings — never `content` column values, message text, or
 * summary plaintext.
 *
 * Safety: opens memory.db with `readonly: true` so a scan can never mutate
 * the store, and sets `busy_timeout = 100` so a locked store degrades the
 * scan instead of hanging the CLI.
 *
 * @module
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import type { DoctorCheck, DoctorFinding } from "../types.js";

const CATEGORY = "lcd";

// ── Scan class 1: orphaned lcd_summaries ────────────────────────────────────

/**
 * Detect lcd_summaries rows with no matching lcd_context_items entry.
 *
 * An orphaned summary was compacted but never linked into the model-facing
 * context view — it wastes storage and indicates a partial write.
 */
function scanOrphanedSummaries(db: Database.Database): DoctorFinding[] {
  const rows = db
    .prepare(`
      SELECT summary_id FROM lcd_summaries s
      WHERE NOT EXISTS (
        SELECT 1 FROM lcd_context_items ci
        WHERE ci.ref_id = s.summary_id AND ci.ref_kind = 'summary'
      ) LIMIT 50
    `)
    .all() as Array<{ summary_id: string }>;

  if (rows.length === 0) return [];

  return [
    {
      category: CATEGORY,
      check: "Orphaned summaries",
      status: "warn",
      message: `${rows.length} orphaned lcd_summaries found (errorKind: lcd_orphaned_summary)`,
      suggestion: "Run lcd compaction repair or rebuild the context-item view",
      repairable: false,
    },
  ];
}

// ── Scan class 2: dangling context_item refs ─────────────────────────────────

/**
 * Detect lcd_context_items rows whose ref_id points to a non-existent
 * lcd_messages or lcd_summaries row.
 *
 * A dangling ref means the model-facing view references a deleted or
 * never-written record — the assembler will fail silently on that turn.
 */
function scanDanglingRefs(db: Database.Database): DoctorFinding[] {
  const rows = db
    .prepare(`
      SELECT ci.id, ci.ref_kind, ci.ref_id FROM lcd_context_items ci
      WHERE (ci.ref_kind = 'message'
             AND NOT EXISTS (SELECT 1 FROM lcd_messages m WHERE m.id = ci.ref_id))
         OR (ci.ref_kind = 'summary'
             AND NOT EXISTS (SELECT 1 FROM lcd_summaries s WHERE s.summary_id = ci.ref_id))
      LIMIT 50
    `)
    .all() as Array<{ id: string; ref_kind: string; ref_id: string }>;

  if (rows.length === 0) return [];

  return [
    {
      category: CATEGORY,
      check: "Dangling context refs",
      status: "warn",
      message: `${rows.length} dangling context_items refs found`,
      suggestion: "Run lcd context-item repair to remove stale refs",
      repairable: true,
    },
  ];
}

// ── Scan class 3: fallback-marker summaries ──────────────────────────────────

/**
 * Detect lcd_summaries with fallback=1.
 *
 * A fallback marker indicates the model used deterministic truncation
 * rather than an LLM summary — quality debt that accumulates silently.
 */
function scanFallbackMarkers(db: Database.Database): DoctorFinding[] {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM lcd_summaries WHERE fallback = 1`)
    .get() as { c: number } | undefined;

  const c = row?.c ?? 0;
  if (c === 0) return [];

  return [
    {
      category: CATEGORY,
      check: "Fallback summaries",
      status: "warn",
      message: `${c} fallback-marker lcd_summaries (quality debt — model truncated without LLM)`,
      suggestion:
        "Fallback summaries are re-summarized by the daemon during normal compaction. " +
        "No offline repair is possible (requires the LLM summarizer, which is unavailable " +
        "when the daemon is stopped). Run the daemon to allow normal compaction to replace them.",
      repairable: false,
    },
  ];
}

// ── Scan class 4: FTS row-count drift ────────────────────────────────────────

/**
 * Detect drift between lcd_messages / lcd_summaries row counts and their
 * corresponding FTS5 index tables.
 *
 * If FTS tables are absent (FTS5 not compiled) this scan returns no findings
 * and the check degrades gracefully.
 */
function scanFtsDrift(db: Database.Database): DoctorFinding[] {
  // Probe FTS availability — if the virtual table doesn't exist, skip silently
  try {
    db.prepare("SELECT rowid FROM lcd_messages_fts LIMIT 1").all();
  } catch {
    // FTS5 not available or table absent — skip this scan class
    return [];
  }

  const row = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM lcd_messages) - (SELECT COUNT(*) FROM lcd_messages_fts) AS msg_drift,
        (SELECT COUNT(*) FROM lcd_summaries) - (SELECT COUNT(*) FROM lcd_summaries_fts) AS sum_drift
    `)
    .get() as { msg_drift: number; sum_drift: number } | undefined;

  // Negative drift = orphaned contentless FTS shadow rows, which are
  // EXPECTED after a deleteConversationLcd / `sessions reset` (the
  // contentless FTS5 table has no FK and is not pruned on message delete). Only
  // POSITIVE drift — messages/summaries present but not yet indexed — is the real
  // corruption signal. Floor at 0 so a healthy post-reset store stays clean.
  const msgDrift = Math.max(0, row?.msg_drift ?? 0);
  const sumDrift = Math.max(0, row?.sum_drift ?? 0);

  if (msgDrift === 0 && sumDrift === 0) return [];

  return [
    {
      category: CATEGORY,
      check: "FTS sync",
      status: "warn",
      message: `FTS out of sync: messages drift=${msgDrift}, summaries drift=${sumDrift}`,
      suggestion: "Rebuild FTS indexes: INSERT INTO lcd_messages_fts(lcd_messages_fts) VALUES('rebuild')",
      repairable: true,
    },
  ];
}

// ── Scan class 5: R4 scope anomalies ─────────────────────────────────────────

/**
 * Detect lcd_messages or lcd_summaries rows with NULL tenant_id or agent_id.
 *
 * These violate the R4 isolation scope invariant (every row must carry its
 * tenant/agent scope) — affected rows will be invisible to scope-filtered
 * queries and may leak across agent boundaries.
 */
function scanR4Anomalies(db: Database.Database): DoctorFinding[] {
  const row = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM lcd_messages WHERE tenant_id IS NULL OR agent_id IS NULL) AS msg_nulls,
        (SELECT COUNT(*) FROM lcd_summaries WHERE tenant_id IS NULL OR agent_id IS NULL) AS sum_nulls
    `)
    .get() as { msg_nulls: number; sum_nulls: number } | undefined;

  const msgNulls = row?.msg_nulls ?? 0;
  const sumNulls = row?.sum_nulls ?? 0;

  if (msgNulls + sumNulls === 0) return [];

  return [
    {
      category: CATEGORY,
      check: "R4 scope anomalies",
      status: "fail",
      message: `R4 scope anomalies: ${msgNulls} messages + ${sumNulls} summaries with NULL tenant_id or agent_id`,
      suggestion: "Investigate write paths that omit tenant_id/agent_id scoping",
      repairable: false,
    },
  ];
}

// ── Scan class 6: lcd_ingest_cursor over-count ───────────────────────────────

/**
 * Detect lcd_ingest_cursor rows whose `ingested_live_len` EXCEEDS the persisted
 * message count for the scope — a genuine cursor/store inconsistency.
 *
 * The ingest path appends live messages 1:1 and NEVER deletes (the only delete
 * path, deleteConversationLcd, also clears the cursor in the same transaction),
 * so a healthy cursor always has `ingested_live_len <= COUNT(lcd_messages)` for
 * its scope — equal in single-epoch steady state, strictly less once a prior
 * epoch has accumulated. `ingested_live_len` GREATER than the persisted count is
 * therefore impossible in normal operation and signals a corrupt / hand-edited
 * cursor. Note: under the epoch model a cursor with `ingested_live_len = 0` (or
 * small) while many durable messages exist is a NORMAL fresh epoch /
 * continue-append state and is correctly NOT flagged (0 <= msg_count).
 * Content-free: counts only.
 */
function scanCursorInconsistencies(db: Database.Database): DoctorFinding[] {
  const rows = db
    .prepare(`
      SELECT c.conversation_id
      FROM lcd_ingest_cursor c
      WHERE c.ingested_live_len > (
        SELECT COUNT(*) FROM lcd_messages m
        WHERE m.conversation_id = c.conversation_id
          AND m.agent_id = c.agent_id
          AND m.tenant_id = c.tenant_id
      )
      LIMIT 20
    `)
    .all() as Array<{ conversation_id: string }>;

  if (rows.length === 0) return [];

  return [
    {
      category: CATEGORY,
      check: "Cursor over-count",
      status: "warn",
      message: `${rows.length} lcd_ingest_cursor rows with ingested_live_len exceeding the persisted message count`,
      suggestion: "Recalculate the affected cursor(s) — ingested_live_len must not exceed COUNT(lcd_messages) for the scope",
      repairable: false,
    },
  ];
}

// ── Main check export ─────────────────────────────────────────────────────────

/**
 * Doctor check: LCD store integrity.
 *
 * Runs six read-only SQL scans against memory.db:
 *   1. Orphaned lcd_summaries (no context_item back-link)
 *   2. Dangling context_item refs (ref_id points nowhere)
 *   3. Fallback-marker summaries (fallback=1, quality debt)
 *   4. FTS row-count drift (when FTS5 tables are present)
 *   5. R4 scope anomalies (NULL tenant_id or agent_id)
 *   6. lcd_ingest_cursor over-count (ingested_live_len > persisted msg count)
 *
 * Returns [] when memory.db is absent (new-install safe).
 * Returns 1 "pass" finding when all 6 scan classes are clean.
 */
export const lcdHealthCheck: DoctorCheck = {
  id: "lcd-health",
  name: "LCD Store",
  run: async (context): Promise<DoctorFinding[]> => {
    const findings: DoctorFinding[] = [];
    const dbPath = context.dataDir + "/memory.db";

    // New install — no memory.db yet. Skip silently.
    if (!existsSync(dbPath)) return findings;

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      // Short timeout — treat BUSY as a "scan could not acquire read lock"
      // degradation rather than hanging the CLI.
      db.pragma("busy_timeout = 100");

      findings.push(...scanOrphanedSummaries(db));
      findings.push(...scanDanglingRefs(db));
      findings.push(...scanFallbackMarkers(db));
      findings.push(...scanFtsDrift(db));
      findings.push(...scanR4Anomalies(db));
      findings.push(...scanCursorInconsistencies(db));

      // If all six scan classes came back clean, report healthy
      if (findings.length === 0) {
        findings.push({
          category: CATEGORY,
          check: "LCD Store",
          status: "pass",
          message: "LCD store is healthy (6/6 scan classes clean)",
          repairable: false,
        });
      }
    } catch {
      findings.push({
        category: CATEGORY,
        check: "LCD Store open",
        status: "fail",
        message: "Failed to open memory.db for LCD scan",
        suggestion: "Check file permissions on " + dbPath,
        repairable: false,
      });
    } finally {
      db?.close();
    }

    return findings;
  },
};
