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
const REQUIRED_LCD_TABLES = [
  "lcd_messages",
  "lcd_summaries",
  "lcd_summary_parents",
  "lcd_context_items",
  "lcd_ingest_cursor",
] as const;

function scanRequiredSchema(db: Database.Database): DoctorFinding[] {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'lcd_messages',
      'lcd_summaries',
      'lcd_summary_parents',
      'lcd_context_items',
      'lcd_ingest_cursor'
    )
  `).all() as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  const missing = REQUIRED_LCD_TABLES.filter((table) => !present.has(table));
  if (missing.length === 0) return [];
  return [{
    category: CATEGORY,
    check: "LCD schema",
    status: "fail",
    message: `LCD schema initialization is incomplete; missing table(s): ${missing.join(", ")}`,
    suggestion: "Restart the daemon to initialize the LCD schema, then rerun comis doctor",
    repairable: false,
  }];
}

// ── Scan class 1: orphaned lcd_summaries ────────────────────────────────────

/**
 * Detect lcd_summaries rows that are not reachable from a same-scope active
 * context root through same-scope condensed-summary edges.
 *
 * Condensation intentionally removes child summaries from the model-facing
 * context while retaining them behind `lcd_summary_parents` for losslessness.
 * An edge below an unreachable parent does not make its child reachable.
 */
function scanOrphanedSummaries(db: Database.Database): DoctorFinding[] {
  const row = db
    .prepare(`
      WITH RECURSIVE reachable(summary_id, conversation_id, tenant_id, agent_id) AS (
        SELECT DISTINCT s.summary_id, s.conversation_id, s.tenant_id, s.agent_id
        FROM lcd_summaries s
        JOIN lcd_context_items ci
          ON ci.ref_kind = 'summary'
         AND ci.ref_id = s.summary_id
         AND ci.conversation_id = s.conversation_id
         AND ci.tenant_id = s.tenant_id
         AND ci.agent_id = s.agent_id
        UNION
        SELECT child.summary_id, child.conversation_id, child.tenant_id, child.agent_id
        FROM reachable parent
        JOIN lcd_summary_parents sp ON sp.parent_summary_id = parent.summary_id
        JOIN lcd_summaries child
          ON child.summary_id = sp.child_summary_id
         AND child.conversation_id = parent.conversation_id
         AND child.tenant_id = parent.tenant_id
         AND child.agent_id = parent.agent_id
      )
      SELECT COUNT(*) AS c
      FROM lcd_summaries s
      WHERE NOT EXISTS (SELECT 1 FROM reachable r WHERE r.summary_id = s.summary_id)
    `)
    .get() as { c: number } | undefined;

  const count = row?.c ?? 0;
  if (count === 0) return [];

  return [
    {
      category: CATEGORY,
      check: "Orphaned summaries",
      status: "warn",
      message: `${count} orphaned lcd_summaries found (errorKind: lcd_orphaned_summary)`,
      suggestion:
        "Inspect the LCD write transaction; every summary must be reachable from a same-scope active context root",
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
  const row = db
    .prepare(`
      SELECT COUNT(*) AS c FROM lcd_context_items ci
      WHERE (ci.ref_kind = 'message'
             AND NOT EXISTS (
               SELECT 1 FROM lcd_messages m
               WHERE m.id = ci.ref_id
                 AND m.conversation_id = ci.conversation_id
                 AND m.tenant_id = ci.tenant_id
                 AND m.agent_id = ci.agent_id
             ))
         OR (ci.ref_kind = 'summary'
             AND NOT EXISTS (
               SELECT 1 FROM lcd_summaries s
               WHERE s.summary_id = ci.ref_id
                 AND s.conversation_id = ci.conversation_id
                 AND s.tenant_id = ci.tenant_id
                 AND s.agent_id = ci.agent_id
             ))
    `)
    .get() as { c: number } | undefined;

  const count = row?.c ?? 0;
  if (count === 0) return [];
  const label = count === 1 ? "ref" : "refs";

  return [
    {
      category: CATEGORY,
      check: "Dangling context refs",
      status: "warn",
      message: `${count} dangling context_items ${label} found`,
      suggestion: "Run lcd context-item repair to remove stale refs",
      repairable: true,
    },
  ];
}

// ── Scan class 3: fallback-marker summaries ──────────────────────────────────

/**
 * Detect lcd_summaries with fallback=1.
 *
 * A fallback marker indicates deterministic emergency truncation was used
 * after summarization failed to produce a smaller result. Child rows remain in
 * the DAG permanently even after a later condensed summary replaces their
 * context refs, so report active roots, reachable ancestry, and unreachable
 * rows separately.
 */
function scanFallbackMarkers(db: Database.Database): DoctorFinding[] {
  const row = db
    .prepare(`
      WITH RECURSIVE
      active_roots(summary_id, conversation_id, tenant_id, agent_id) AS (
        SELECT DISTINCT s.summary_id, s.conversation_id, s.tenant_id, s.agent_id
        FROM lcd_summaries s
        JOIN lcd_context_items ci
          ON ci.ref_kind = 'summary'
         AND ci.ref_id = s.summary_id
         AND ci.conversation_id = s.conversation_id
         AND ci.tenant_id = s.tenant_id
         AND ci.agent_id = s.agent_id
      ),
      reachable(summary_id, conversation_id, tenant_id, agent_id) AS (
        SELECT summary_id, conversation_id, tenant_id, agent_id FROM active_roots
        UNION
        SELECT child.summary_id, child.conversation_id, child.tenant_id, child.agent_id
        FROM reachable parent
        JOIN lcd_summary_parents sp ON sp.parent_summary_id = parent.summary_id
        JOIN lcd_summaries child
          ON child.summary_id = sp.child_summary_id
         AND child.conversation_id = parent.conversation_id
         AND child.tenant_id = parent.tenant_id
         AND child.agent_id = parent.agent_id
      )
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN EXISTS (
          SELECT 1 FROM active_roots root WHERE root.summary_id = s.summary_id
        ) THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN NOT EXISTS (
          SELECT 1 FROM active_roots root WHERE root.summary_id = s.summary_id
        ) AND EXISTS (
          SELECT 1 FROM reachable r WHERE r.summary_id = s.summary_id
        ) THEN 1 ELSE 0 END), 0) AS reachable_ancestor,
        COALESCE(SUM(CASE WHEN NOT EXISTS (
          SELECT 1 FROM reachable r WHERE r.summary_id = s.summary_id
        ) THEN 1 ELSE 0 END), 0) AS unlinked
      FROM lcd_summaries s
      WHERE s.fallback = 1
    `)
    .get() as { total: number; active: number; reachable_ancestor: number; unlinked: number } | undefined;

  const total = row?.total ?? 0;
  if (total === 0) return [];

  const active = row?.active ?? 0;
  const reachableAncestor = row?.reachable_ancestor ?? 0;
  const unlinked = row?.unlinked ?? 0;
  const activeLabel = active === 1 ? "root" : "roots";
  const ancestorLabel = reachableAncestor === 1 ? "ancestor" : "ancestors";

  return [
    {
      category: CATEGORY,
      check: "Fallback summaries",
      status: "warn",
      message:
        `${total} fallback-marker lcd_summaries ` +
        `(${active} active ${activeLabel}, ${reachableAncestor} reachable ${ancestorLabel}, ${unlinked} unreachable); ` +
        "deterministic emergency truncation was used after summarization failed to produce a smaller result",
      suggestion:
        "Fallback markers are immutable DAG history; normal compaction may nest them but does not rewrite them. " +
        "Inspect summarizer provider failures and compaction budgets to prevent new markers; " +
        "underlying messages remain available through LCD retrieval.",
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

// ── Scan class 5: tenant and agent scope integrity ───────────────────────────

/**
 * Detect lcd_messages or lcd_summaries rows with NULL tenant_id or agent_id.
 *
 * Every row must carry its tenant and agent scope. Affected rows are invisible
 * to scope-filtered queries and may leak across agent boundaries.
 */
function scanScopeAnomalies(db: Database.Database): DoctorFinding[] {
  const row = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM lcd_messages WHERE tenant_id IS NULL OR agent_id IS NULL) AS msg_nulls,
        (SELECT COUNT(*) FROM lcd_summaries WHERE tenant_id IS NULL OR agent_id IS NULL) AS sum_nulls,
        (SELECT COUNT(*)
         FROM lcd_summary_parents sp
         JOIN lcd_summaries parent ON parent.summary_id = sp.parent_summary_id
         JOIN lcd_summaries child ON child.summary_id = sp.child_summary_id
         WHERE parent.conversation_id <> child.conversation_id
            OR parent.tenant_id <> child.tenant_id
            OR parent.agent_id <> child.agent_id) AS edge_scope_mismatches
    `)
    .get() as { msg_nulls: number; sum_nulls: number; edge_scope_mismatches: number } | undefined;

  const msgNulls = row?.msg_nulls ?? 0;
  const sumNulls = row?.sum_nulls ?? 0;
  const edgeScopeMismatches = row?.edge_scope_mismatches ?? 0;

  if (msgNulls + sumNulls + edgeScopeMismatches === 0) return [];

  const messageLabel = msgNulls === 1 ? "message" : "messages";
  const summaryLabel = sumNulls === 1 ? "summary" : "summaries";

  const missingScopeMessage =
    `LCD scope integrity failure: ${msgNulls} ${messageLabel} + ${sumNulls} ${summaryLabel} ` +
    "have a missing tenant_id or agent_id";
  const edgeLabel = edgeScopeMismatches === 1 ? "edge" : "edges";
  const message = edgeScopeMismatches === 0
    ? missingScopeMessage
    : msgNulls + sumNulls === 0
      ? `LCD scope integrity failure: ${edgeScopeMismatches} cross-scope summary ${edgeLabel}`
      : `${missingScopeMessage}; ${edgeScopeMismatches} cross-scope summary ${edgeLabel}`;

  return [
    {
      category: CATEGORY,
      check: "LCD scope integrity",
      status: "fail",
      message,
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
  const row = db
    .prepare(`
      SELECT COUNT(*) AS c
      FROM lcd_ingest_cursor c
      WHERE c.ingested_live_len > (
        SELECT COUNT(*) FROM lcd_messages m
        WHERE m.conversation_id = c.conversation_id
          AND m.agent_id = c.agent_id
          AND m.tenant_id = c.tenant_id
      )
    `)
    .get() as { c: number } | undefined;

  const count = row?.c ?? 0;
  if (count === 0) return [];

  return [
    {
      category: CATEGORY,
      check: "Cursor over-count",
      status: "warn",
      message: `${count} lcd_ingest_cursor rows with ingested_live_len exceeding the persisted message count`,
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
 *   1. Orphaned lcd_summaries (not reachable from a same-scope active root)
 *   2. Dangling context_item refs (ref_id points nowhere in the same scope)
 *   3. Fallback-marker summaries (fallback=1, quality debt)
 *   4. FTS row-count drift (when FTS5 tables are present)
 *   5. Tenant and agent scope integrity (NULL tenant_id or agent_id)
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
    const dbPath = context.memoryDbPath ?? context.dataDir + "/memory.db";

    // New install — no memory.db yet. Skip silently.
    if (!existsSync(dbPath)) return findings;

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      findings.push({
        category: CATEGORY,
        check: "LCD Store open",
        status: "fail",
        message: "Failed to open memory.db for LCD scan",
        suggestion: "Check file permissions on " + dbPath,
        repairable: false,
      });
      return findings;
    }

    try {
      db.pragma("busy_timeout = 100");

      const schemaFindings = scanRequiredSchema(db);
      if (schemaFindings.length > 0) return schemaFindings;

      findings.push(...scanOrphanedSummaries(db));
      findings.push(...scanDanglingRefs(db));
      findings.push(...scanFallbackMarkers(db));
      findings.push(...scanFtsDrift(db));
      findings.push(...scanScopeAnomalies(db));
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
        check: "LCD Store scan",
        status: "fail",
        message: "LCD store opened but an integrity scan could not complete",
        suggestion: "Inspect daemon logs for SQLite lock or schema errors, then rerun comis doctor",
        repairable: false,
      });
    } finally {
      db?.close();
    }

    return findings;
  },
};
