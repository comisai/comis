// SPDX-License-Identifier: Apache-2.0
/**
 * LCD repair module for comis doctor — DOC-03 (Phase 171).
 *
 * Three repair actions:
 *   - repairFtsDrift: rebuild FTS5 content indexes for lcd_messages and lcd_summaries
 *   - repairContextItems: remove dangling lcd_context_items refs (summary/message not in store)
 *   - repairFallbackSummaries: re-enqueue fallback=1 summaries through the §6.4 seam
 *
 * F1 ABSOLUTE CONSTRAINT: lcd_messages is NEVER written by any repair path.
 * Repairs operate strictly above the lossless verbatim raw store.
 *
 * Open DB in READ-WRITE mode (timeout: 5000) to surface SQLITE_BUSY cleanly.
 * Operator must stop daemon first and run `comis sessions backup` before repair.
 *
 * Content-free logging: finding ids, counts, errorKind only — never content column values.
 *
 * @module
 */
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import Database from "better-sqlite3";

// ── Local types (no @comis/agent import — cli does not depend on agent) ───────

/**
 * Minimal injected deps for repairFallbackSummaries.
 *
 * This is a locally-defined structural type so that repair-lcd.ts does NOT
 * import from @comis/agent (which would break the cycles:refs gate).
 * The daemon wires the actual LeafSummarizer at call time.
 */
export type RepairSummarizeDeps = {
  /**
   * Spend-governed summarizer seam (§6.4). Receives the stored content as a
   * single user message and returns a new summary string. Output passes through
   * validateMemoryWrite (inside the seam) — T-171-15 scrub is inside deps.summarize.
   */
  summarize: (
    messages: Array<{ role: string; content: string }>,
    opts?: { reserveTokens?: number },
  ) => Promise<string>;
  /** Returns true when the per-tenant circuit breaker is open. */
  isBreakerOpen: () => boolean;
};

// ── repairFtsDrift ────────────────────────────────────────────────────────────

/**
 * Rebuild FTS5 content-table indexes for lcd_messages and lcd_summaries.
 *
 * Uses the FTS5 `rebuild` command which re-indexes all content already present
 * in the base tables. Gracefully skips any FTS table that does not exist.
 *
 * F1: Never writes to lcd_messages.
 */
export async function repairFtsDrift(
  db: Database.Database,
): Promise<Result<string[], Error>> {
  const actions: string[] = [];
  try {
    const tableExists = (name: string): boolean => {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(name) as { name: string } | undefined;
      return row !== undefined;
    };

    if (tableExists("lcd_messages_fts")) {
      db.prepare(
        "INSERT INTO lcd_messages_fts(lcd_messages_fts) VALUES('rebuild')",
      ).run();
      actions.push("Rebuilt lcd_messages_fts FTS index");
    }

    if (tableExists("lcd_summaries_fts")) {
      db.prepare(
        "INSERT INTO lcd_summaries_fts(lcd_summaries_fts) VALUES('rebuild')",
      ).run();
      actions.push("Rebuilt lcd_summaries_fts FTS index");
    }

    return ok(actions);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// ── repairContextItems ────────────────────────────────────────────────────────

/**
 * Remove dangling lcd_context_items refs.
 *
 * Deletes entries where:
 *   - ref_kind = 'summary' AND ref_id has no matching lcd_summaries.summary_id
 *   - ref_kind = 'message' AND ref_id has no matching lcd_messages.id
 *
 * An optional conversationId scope can narrow the repair to one conversation.
 *
 * F1: Reads lcd_messages to verify ref existence only (SELECT). NEVER writes to it.
 */
export async function repairContextItems(
  db: Database.Database,
  scope?: { conversationId?: string },
): Promise<Result<string[], Error>> {
  const actions: string[] = [];
  try {
    // Delete dangling summary refs
    const summaryDeleteSql =
      "DELETE FROM lcd_context_items" +
      " WHERE ref_kind='summary'" +
      " AND ref_id NOT IN (SELECT summary_id FROM lcd_summaries)" +
      (scope?.conversationId ? " AND conversation_id=?" : "");

    const summaryDangling = scope?.conversationId
      ? db.prepare(summaryDeleteSql).run(scope.conversationId)
      : db.prepare(summaryDeleteSql).run();

    if (summaryDangling.changes > 0) {
      actions.push(
        `Removed ${summaryDangling.changes} dangling summary lcd_context_items ref(s)`,
      );
    }

    // Delete dangling message refs
    // F1: SELECT from lcd_messages (read-only check) — never INSERT/UPDATE/DELETE lcd_messages
    const messageDeleteSql =
      "DELETE FROM lcd_context_items" +
      " WHERE ref_kind='message'" +
      " AND ref_id NOT IN (SELECT id FROM lcd_messages)" +
      (scope?.conversationId ? " AND conversation_id=?" : "");

    const messageDangling = scope?.conversationId
      ? db.prepare(messageDeleteSql).run(scope.conversationId)
      : db.prepare(messageDeleteSql).run();

    if (messageDangling.changes > 0) {
      actions.push(
        `Removed ${messageDangling.changes} dangling message lcd_context_items ref(s)`,
      );
    }

    return ok(actions);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// ── repairFallbackSummaries ───────────────────────────────────────────────────

/**
 * Re-enqueue fallback=1 summaries through the §6.4 summarizer seam.
 *
 * For each lcd_summaries row with fallback=1:
 *   - Re-summarizes via deps.summarize (the spend-governed seam)
 *   - Updates lcd_summaries SET content=<new>, fallback=0 for the row
 *   - Individual failures (summarizer unavailable) are skipped — non-fatal
 *
 * Per §6.4: if deps.isBreakerOpen() returns true, no summarization is attempted
 * and ok([]) is returned immediately (truncation floor remains).
 *
 * T-171-15 VERIFICATION: deps.summarize is the spend-governed seam
 * (wrapSummarizerWithDegradeObservability → summarizerSpendBreaker →
 * wrapSummarizerWithFailover → inner). The inner summarizer calls generateSummary
 * which passes through validateMemoryWrite (the existing output scrub path in the
 * @comis/agent barrel). No additional scrub is needed here — the scrub is inside
 * the seam, not the caller.
 *
 * F1: NEVER writes to lcd_messages. Only lcd_summaries is modified.
 */
export async function repairFallbackSummaries(
  db: Database.Database,
  deps: RepairSummarizeDeps,
): Promise<Result<string[], Error>> {
  const actions: string[] = [];

  // Per §6.4: breaker OPEN → no summarization attempted
  if (deps.isBreakerOpen()) {
    return ok([]);
  }

  try {
    const fallbackRows = db
      .prepare("SELECT summary_id, content FROM lcd_summaries WHERE fallback=1")
      .all() as Array<{ summary_id: string; content: string }>;

    for (const row of fallbackRows) {
      // Content-free: never log row.content; log row.summary_id (UUID) only
      try {
        const newContent = await deps.summarize(
          [{ role: "user", content: row.content }],
          { reserveTokens: 800 },
        );
        // T-171-15: newContent is scrub-safe via the deps.summarize seam
        db.prepare(
          "UPDATE lcd_summaries SET content=?, fallback=0 WHERE summary_id=?",
        ).run(newContent, row.summary_id);
        actions.push(`Re-summarized fallback summary id=${row.summary_id}`);
      } catch (_err) {
        // Individual summary failure — skip and continue (non-fatal)
        actions.push(`Skipped summary id=${row.summary_id} (summarizer unavailable)`);
      }
    }

    return ok(actions);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
