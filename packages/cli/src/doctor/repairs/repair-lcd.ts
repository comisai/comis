// SPDX-License-Identifier: Apache-2.0
/**
 * LCD repair module for comis doctor — DOC-03 (Phase 171).
 *
 * Two repair actions (offline-safe, pure-SQL, no daemon required):
 *   - repairFtsDrift: repopulate contentless lcd_messages_fts from lcd_message_parts;
 *                     rebuild external-content lcd_summaries_fts via 'rebuild' idiom
 *   - repairContextItems: remove dangling lcd_context_items refs (summary/message not in store)
 *
 * REMOVED: repairFallbackSummaries — LLM re-summarization is IMPOSSIBLE offline
 * (the daemon is stopped during --repair and cli↛agent is a forbidden import cut).
 * Fallback-marker summaries (fallback=1) are quality debt re-summarized by the daemon
 * during normal compaction — not repairable by doctor --repair. The fallback-summary
 * finding in lcd-health.ts is repairable:false.
 *
 * F1 ABSOLUTE CONSTRAINT: lcd_messages is NEVER written by any repair path.
 * Repairs operate strictly above the lossless verbatim raw store.
 *
 * FTS architecture:
 *   - lcd_summaries_fts: EXTERNAL-CONTENT (content='lcd_summaries') — the 'rebuild'
 *     idiom works: INSERT INTO lcd_summaries_fts(lcd_summaries_fts) VALUES('rebuild')
 *   - lcd_messages_fts: CONTENTLESS (no content= clause) — 'rebuild' ERRORS because
 *     there is no external content table to read from. Instead, re-derive FTS rows from
 *     lcd_message_parts using the same render fn as the adapter populate path
 *     (renderMessageFtsText from @comis/memory).
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
import { renderMessageFtsText } from "@comis/memory";

// ── repairFtsDrift ────────────────────────────────────────────────────────────

/**
 * Repair FTS5 index drift for lcd_messages and lcd_summaries.
 *
 * lcd_summaries_fts (EXTERNAL-CONTENT): uses the standard FTS5 'rebuild' command.
 *
 * lcd_messages_fts (CONTENTLESS): the 'rebuild' idiom does NOT work on contentless
 * tables (SQLite errors with "content= option required"). Instead:
 *   1. Delete all existing FTS shadow rows
 *   2. Re-derive content from lcd_message_parts using renderMessageFtsText
 *   3. Re-insert one FTS row per message (rowid, content, conversation_id, agent_id, message_id)
 *
 * This mirrors the adapter populate path in lcd-store.ts (the createLcdStore append
 * transaction) exactly — same render fn, same columns, same rowid linkage.
 *
 * Gracefully skips any FTS table that does not exist (FTS5 not compiled on host).
 *
 * F1: Never writes to lcd_messages. Reads lcd_messages + lcd_message_parts to
 * derive FTS content (SELECT only on both tables).
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

    // ── lcd_messages_fts (CONTENTLESS) ─────────────────────────────────────
    // 'rebuild' ERRORS on contentless tables — must re-derive from parts.
    if (tableExists("lcd_messages_fts")) {
      // Delete all existing FTS shadow rows (re-populate from scratch)
      db.prepare("DELETE FROM lcd_messages_fts").run();

      // Walk every lcd_message and re-render its parts into the contentless index
      const messages = db
        .prepare("SELECT rowid, id, conversation_id, agent_id FROM lcd_messages ORDER BY rowid")
        .all() as Array<{ rowid: number; id: string; conversation_id: string; agent_id: string }>;

      const insertFts = db.prepare(
        "INSERT INTO lcd_messages_fts(rowid, content, conversation_id, agent_id, message_id) VALUES (?, ?, ?, ?, ?)",
      );

      const selectParts = db.prepare(
        "SELECT tool_name, tool_input, tool_output, metadata FROM lcd_message_parts WHERE message_id = ? ORDER BY ordinal",
      );

      for (const msg of messages) {
        const partRows = selectParts.all(msg.id) as Array<{
          tool_name: string | null;
          tool_input: string | null;
          tool_output: string | null;
          metadata: string;
        }>;

        // Map raw DB rows to LcdMessagePart — same projection the adapter populate path uses
        const parts: LcdMessagePart[] = partRows.map((p) => ({
          kind: "text" as const, // kind is not used by renderMessageFtsText — it reads metadata.raw.text
          toolName: p.tool_name ?? undefined,
          toolInput: p.tool_input !== null ? safeParseJson(p.tool_input) : undefined,
          toolOutput: p.tool_output !== null ? safeParseJson(p.tool_output) : undefined,
          metadata: safeParseJson(p.metadata) as LcdMessagePart["metadata"],
        }));

        const content = renderMessageFtsText(parts);
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
