// SPDX-License-Identifier: Apache-2.0
/**
 * LCD repair module for comis doctor, including the normalized
 * trigram-twin backfill.
 *
 * Two repair actions (offline-safe, pure-SQL, no daemon required):
 *   - repairFtsDrift: repopulate self-contained lcd_messages_fts from lcd_message_parts;
 *                     rebuild external-content lcd_summaries_fts via 'rebuild' idiom;
 *                     AND backfill the three self-contained trigram twins with
 *                     NORMALIZED text so pre-existing history becomes
 *                     trigram-searchable
 *   - repairContextItems: remove dangling lcd_context_items refs (summary/message not in store)
 *
 * Deliberately NO repairFallbackSummaries. Fallback-marker rows are retained as
 * immutable nodes in the lossless summary DAG; later compaction can nest them
 * under a new parent but does not rewrite them. Doctor reports their reachability
 * and directs operators to prevent new markers by correcting summarizer failures
 * or compaction budgets. The underlying messages remain recoverable, and the
 * fallback-summary finding in lcd-health.ts is repairable:false.
 *
 * ABSOLUTE CONSTRAINT: lcd_messages is NEVER written by any repair path.
 * Repairs operate strictly above the lossless verbatim raw store.
 *
 * FTS architecture:
 *   - lcd_summaries_fts: EXTERNAL-CONTENT (content='lcd_summaries') — the 'rebuild'
 *     idiom works: INSERT INTO lcd_summaries_fts(lcd_summaries_fts) VALUES('rebuild')
 *   - lcd_messages_fts: SELF-CONTAINED (stores its own content; no content= clause) —
 *     'rebuild' ERRORS because there is no external content table to read from.
 *     Instead, re-derive FTS rows from lcd_message_parts using the same render fn as
 *     the adapter populate path (renderMessageFtsText from @comis/memory).
 *   - lcd_messages_fts_tri / lcd_summaries_fts_tri / memory_fts_tri: SELF-CONTAINED
 *     FTS5 trigram twins. They store NORMALIZED text so a script-routed
 *     MATCH can read Hebrew/Arabic/Cyrillic/CJK. The backfill below feeds each twin
 *     `normalizeForSearch(...)` of EXACTLY what the populate path indexes — the SAME
 *     render fn for messages, the raw content column for summaries/memories — so the
 *     repair output is byte-equivalent to a fresh TS write (index side, query
 *     side, and doctor backfill all share one normalizer). These twins are NOT
 *     external-content, so 'rebuild' is forbidden — it would re-index RAW text and
 *     silently undo the normalization. Skipped wholesale on hosts lacking the
 *     trigram tokenizer (tableExists guard).
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
import type { LcdMessagePart } from "@comis/core";
import { normalizeForSearch } from "@comis/core";
import { renderMessageFtsText } from "@comis/memory";

// ── repairFtsDrift ────────────────────────────────────────────────────────────

/**
 * Repair FTS5 index drift for lcd_messages and lcd_summaries, plus backfill the
 * three normalized trigram twins.
 *
 * lcd_summaries_fts (EXTERNAL-CONTENT): uses the standard FTS5 'rebuild' command.
 *
 * lcd_messages_fts (SELF-CONTAINED): the 'rebuild' idiom does NOT work on
 * self-contained tables (SQLite errors with "content= option required"). Instead:
 *   1. Delete all existing FTS shadow rows
 *   2. Re-derive content from lcd_message_parts using renderMessageFtsText
 *   3. Re-insert one FTS row per message (rowid, content, conversation_id, agent_id, message_id)
 *
 * This mirrors the adapter populate path in lcd-store.ts (the createLcdStore append
 * transaction) exactly — same render fn, same columns, same rowid linkage.
 *
 * Trigram twins (lcd_messages_fts_tri / lcd_summaries_fts_tri / memory_fts_tri):
 * SELF-CONTAINED, so 'rebuild' is FORBIDDEN (it would re-index raw
 * pre-normalization text). Each twin is delete-all-then-repopulated with
 * `normalizeForSearch(...)` of exactly what the populate path indexes — the SAME
 * renderMessageFtsText output for messages, the raw content column for
 * summaries/memories — at the base row's rowid, copying the base row's R4 scope
 * columns verbatim. This makes pre-existing history (rows written before the
 * twins' populate path indexed them) trigram-searchable, operator-run. Each twin is independently
 * guarded on its own existence (tableExists), so a trigram-less host skips them all
 * gracefully and a partial-schema db skips whichever twins are absent.
 *
 * Gracefully skips any FTS table that does not exist (FTS5 not compiled on host).
 *
 * Never writes to lcd_messages / lcd_summaries / memories. Reads them (SELECT
 * only) to derive FTS content; only the FTS shadow objects are mutated.
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

    // Prepared lazily on first message walk — `lcd_message_parts` carries
    // tool_name/tool_input/tool_output only in the full schema, and a no-FTS host
    // (no message-bearing FTS table) must never prepare against them and throw
    // "no such column" before any guard runs.
    let selectParts: Database.Statement | undefined;
    const getSelectParts = (): Database.Statement => {
      selectParts ??= db.prepare(
        "SELECT tool_name, tool_input, tool_output, metadata FROM lcd_message_parts WHERE message_id = ? ORDER BY ordinal",
      );
      return selectParts;
    };

    /** Re-render one message's parts into FTS text via renderMessageFtsText —
     *  the SAME projection + render fn the adapter populate path uses. Both the
     *  word lane and the trigram twin feed off this single render (the twin wraps
     *  it in normalizeForSearch); rendered once per walk, allocation-bounded. */
    const renderMessageContent = (messageId: string): string => {
      const partRows = getSelectParts().all(messageId) as Array<{
        tool_name: string | null;
        tool_input: string | null;
        tool_output: string | null;
        metadata: string;
      }>;
      const parts: LcdMessagePart[] = partRows.map((p) => ({
        kind: "text" as const, // kind is not used by renderMessageFtsText — it reads metadata.raw.text
        toolName: p.tool_name ?? undefined,
        toolInput: p.tool_input !== null ? safeParseJson(p.tool_input) : undefined,
        toolOutput: p.tool_output !== null ? safeParseJson(p.tool_output) : undefined,
        metadata: safeParseJson(p.metadata) as LcdMessagePart["metadata"],
      }));
      return renderMessageFtsText(parts);
    };

    // ── lcd_messages_fts (SELF-CONTAINED) ──────────────────────────────────
    // 'rebuild' ERRORS on self-contained tables — must re-derive from parts.
    if (tableExists("lcd_messages_fts")) {
      // Delete all existing FTS shadow rows (re-populate from scratch)
      db.prepare("DELETE FROM lcd_messages_fts").run();

      // Walk every lcd_message and re-render its parts into the self-contained index
      const messages = db
        .prepare("SELECT rowid, id, conversation_id, agent_id FROM lcd_messages ORDER BY rowid")
        .all() as Array<{ rowid: number; id: string; conversation_id: string; agent_id: string }>;

      const insertFts = db.prepare(
        "INSERT INTO lcd_messages_fts(rowid, content, conversation_id, agent_id, message_id) VALUES (?, ?, ?, ?, ?)",
      );

      for (const msg of messages) {
        const content = renderMessageContent(msg.id);
        insertFts.run(msg.rowid, content, msg.conversation_id, msg.agent_id, msg.id);
      }

      actions.push(
        `Repopulated lcd_messages_fts from lcd_message_parts (${messages.length} message(s))`,
      );
    }

    // ── lcd_summaries_fts (EXTERNAL-CONTENT) ───────────────────────────────
    // 'rebuild' works because lcd_summaries_fts has content='lcd_summaries'
    if (tableExists("lcd_summaries_fts")) {
      db.prepare(
        "INSERT INTO lcd_summaries_fts(lcd_summaries_fts) VALUES('rebuild')",
      ).run();
      actions.push("Rebuilt lcd_summaries_fts FTS index");
    }

    // ── lcd_messages_fts_tri (SELF-CONTAINED TRIGRAM TWIN — NORMALIZED) ─────
    // Backfill the trigram twin from the base rows with NORMALIZED, re-rendered
    // text at the base rowid, copying R4 scope columns verbatim. Indexes EXACTLY
    // what the populate path indexes: normalizeForSearch(renderMessageFtsText(parts)).
    // 'rebuild' is forbidden (self-contained) — it would re-index raw text.
    if (tableExists("lcd_messages_fts_tri")) {
      db.prepare("DELETE FROM lcd_messages_fts_tri").run();

      const messages = db
        .prepare("SELECT rowid, id, conversation_id, agent_id FROM lcd_messages ORDER BY rowid")
        .all() as Array<{ rowid: number; id: string; conversation_id: string; agent_id: string }>;

      const insertTri = db.prepare(
        "INSERT INTO lcd_messages_fts_tri(rowid, content, conversation_id, agent_id, message_id) VALUES (?, ?, ?, ?, ?)",
      );

      for (const msg of messages) {
        const content = normalizeForSearch(renderMessageContent(msg.id));
        insertTri.run(msg.rowid, content, msg.conversation_id, msg.agent_id, msg.id);
      }

      actions.push(
        `Repopulated lcd_messages_fts_tri (normalized) from lcd_message_parts (${messages.length} message(s))`,
      );
    }

    // ── lcd_summaries_fts_tri (SELF-CONTAINED TRIGRAM TWIN — NORMALIZED) ────
    // Backfill from lcd_summaries.content normalized, at the base rowid, R4 scope
    // copied verbatim.
    if (tableExists("lcd_summaries_fts_tri")) {
      db.prepare("DELETE FROM lcd_summaries_fts_tri").run();

      const summaries = db
        .prepare(
          "SELECT rowid, summary_id, conversation_id, agent_id, content FROM lcd_summaries ORDER BY rowid",
        )
        .all() as Array<{
        rowid: number;
        summary_id: string;
        conversation_id: string;
        agent_id: string;
        content: string;
      }>;

      const insertTri = db.prepare(
        "INSERT INTO lcd_summaries_fts_tri(rowid, content, conversation_id, agent_id, summary_id) VALUES (?, ?, ?, ?, ?)",
      );

      for (const sum of summaries) {
        insertTri.run(
          sum.rowid,
          normalizeForSearch(sum.content),
          sum.conversation_id,
          sum.agent_id,
          sum.summary_id,
        );
      }

      actions.push(
        `Repopulated lcd_summaries_fts_tri (normalized) from lcd_summaries (${summaries.length} summary(ies))`,
      );
    }

    // ── memory_fts_tri (SELF-CONTAINED TRIGRAM TWIN — NORMALIZED, rowid lane) ─
    // Backfill from memories.content normalized, at the memories rowid. The LTM
    // trigram lane carries NO scope columns — it scopes via a rowid-JOIN to
    // memories plus post-fusion tenant/agent filters.
    if (tableExists("memory_fts_tri")) {
      db.prepare("DELETE FROM memory_fts_tri").run();

      const memories = db
        .prepare("SELECT rowid, content FROM memories ORDER BY rowid")
        .all() as Array<{ rowid: number; content: string }>;

      const insertTri = db.prepare(
        "INSERT INTO memory_fts_tri(rowid, content) VALUES (?, ?)",
      );

      for (const mem of memories) {
        insertTri.run(mem.rowid, normalizeForSearch(mem.content));
      }

      actions.push(
        `Repopulated memory_fts_tri (normalized) from memories (${memories.length} memory(ies))`,
      );
    }

    return ok(actions);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** JSON.parse that degrades to the raw string on error (mirrors safeStringify in lcd-fts.ts). */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
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
 * Reads lcd_messages to verify ref existence only (SELECT). NEVER writes to it.
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
    // SELECT from lcd_messages (read-only check) — never INSERT/UPDATE/DELETE lcd_messages
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
