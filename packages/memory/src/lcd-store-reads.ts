// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded read helpers extracted from `lcd-store.ts` to keep the store
 * factory under the 800-line architecture line cap (mirrors the prior
 * `lcd-store-writes.ts` + `lcd-fts.ts` extractions).
 *
 * Three responsibilities, BYTE-IDENTICAL relocations of the methods that used
 * to live inside the `createLcdStore` return object (no SQL/column/ordering/
 * error-handling change):
 *   1. `getMessagesByIds(scope, ids)` — bounded message fetch via variable-length
 *      IN(), scoped by (conversation_id, agent_id, tenant_id).
 *   2. `getSummariesByIds(scope, ids)` — bounded summary fetch via variable-length
 *      IN(), same scope discipline.
 *   3. `countMessages(scope)` — single-integer COUNT(*) over lcd_messages with no
 *      row materialization, preserving the O(referenced-ids) read budget.
 *
 * The factory `createBoundedReads(db, selectParts)` takes:
 *   - `db`           — the live database handle (for on-demand IN() prepares +
 *                      the `countMsgs` statement prepared once here).
 *   - `selectParts`  — the shared "SELECT * FROM lcd_message_parts WHERE
 *                      message_id = ? ORDER BY ordinal" statement already prepared
 *                      at `createLcdStore` top (preserves the prepare-once rule).
 *
 * `@comis/memory` is infra-free (AGENTS.md §2.4 — no logger): a degraded row
 * is skipped silently, exactly as the originals did.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type {
  ContextStoreScope,
  LcdMessage,
  LcdMessagePart,
  LcdPartKind,
  LcdRole,
  LcdSummary,
  LcdSummaryKind,
} from "@comis/core";
import {
  messageRowMapper,
  partRowMapper,
  summaryRowMapper,
  ctxCountRowMapper,
  parseJsonColumn,
  parseMetadata,
  intToBool,
  parseFileIds,
} from "./lcd-store-mappers.js";

/**
 * The three bounded-read methods returned by the factory.
 * Signatures are byte-identical to the `ContextStorePort` declarations.
 */
export interface BoundedReads {
  getMessagesByIds(scope: ContextStoreScope, ids: string[]): LcdMessage[];
  getSummariesByIds(scope: ContextStoreScope, ids: string[]): LcdSummary[];
  countMessages(scope: ContextStoreScope): number;
}

/**
 * Build the three bounded-read helpers. Call once at `createLcdStore`
 * top and spread the returned object into the port literal.
 *
 * @param db          — the live better-sqlite3 Database handle.
 * @param selectParts — the shared lcd_message_parts SELECT statement (prepared
 *                      once at createLcdStore top; passed in to preserve the
 *                      prepare-once discipline).
 */
export function createBoundedReads(
  db: Database.Database,
  selectParts: Database.Statement,
): BoundedReads {
  // Bounded total-message COUNT for the assembler's `persistedMsgCount` —
  // a single integer, NO row materialization, so it keeps the O(referenced-ids)
  // read budget (never an O(total-history) row fetch). Scoped by agent_id +
  // tenant_id. The count read goes through ctxCountRowMapper, not a raw
  // count cast (§6.8 untyped-sqlite) — same { c } shape as countCtxItems.
  const countMsgs = db.prepare(
    "SELECT COUNT(*) AS c FROM lcd_messages WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?",
  );

  return {
    getMessagesByIds(scope: ContextStoreScope, ids: string[]): LcdMessage[] {
      // Bounded fetch — short-circuit immediately on empty set so zero
      // DB queries are issued (the IN() SQL with zero placeholders is also an
      // error in most SQLite builds, making the guard doubly necessary).
      if (ids.length === 0) return [];
      // Variable-length IN — built at call time (NOT a cached prepare).
      // Documented deviation from the prepare-once rule: the working set is
      // bounded by context_items cardinality (max ~100 items per turn), so the
      // extra statement-prepare cost is negligible and avoids a placeholder-count
      // mismatch at the boundary. Ids are always bound as '?'
      // parameters — never string-interpolated — so SQL injection is structurally
      // impossible. The three-column scope triple
      // (conversation_id, agent_id, tenant_id) is always present so a cross-agent
      // id lookup returns [].
      const placeholders = ids.map(() => "?").join(",");
      const stmt = db.prepare(
        `SELECT * FROM lcd_messages
         WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?
           AND id IN (${placeholders})
         ORDER BY seq`,
      );
      const out: LcdMessage[] = [];
      for (const rawMsg of stmt.all(scope.conversationId, scope.agentId, scope.tenantId, ...ids)) {
        const parsedMsg = messageRowMapper.parseOptionalRow(rawMsg);
        if (!parsedMsg.ok || !parsedMsg.value) continue;
        const row = parsedMsg.value;
        const parts: LcdMessagePart[] = [];
        for (const rawPart of selectParts.all(row.id)) {
          const parsedPart = partRowMapper.parseOptionalRow(rawPart);
          if (!parsedPart.ok || !parsedPart.value) continue;
          const p = parsedPart.value;
          parts.push({
            kind: p.kind as LcdPartKind,
            toolCallId: p.tool_call_id ?? undefined,
            toolName: p.tool_name ?? undefined,
            toolInput: parseJsonColumn(p.tool_input),
            toolOutput: parseJsonColumn(p.tool_output),
            isError: intToBool(p.is_error),
            metadata: parseMetadata(p.metadata),
          });
        }
        out.push({
          id: row.id,
          conversationId: row.conversation_id,
          seq: row.seq,
          role: row.role as LcdRole,
          tokenCount: row.token_count,
          createdAt: row.created_at,
          parts,
        });
      }
      return out;
    },

    countMessages(scope: ContextStoreScope): number {
      // Single-integer COUNT — no row materialization, so it preserves the
      // O(referenced-ids) read budget (the assembler's persistedMsgCount no longer
      // forces an O(total-history) getMessages fetch). Routed through
      // ctxCountRowMapper, not a raw count cast (§6.8 untyped-sqlite). A scope with
      // no rows yields { c: 0 }; a parse failure (corruption/drift) degrades to 0
      // rather than throwing — a missing count must never break live assembly.
      const countRow = ctxCountRowMapper.parseOptionalRow(
        countMsgs.get(scope.conversationId, scope.agentId, scope.tenantId),
      );
      return countRow.ok && countRow.value ? countRow.value.c : 0;
    },

    getSummariesByIds(scope: ContextStoreScope, ids: string[]): LcdSummary[] {
      // Bounded fetch — short-circuit on empty set (zero DB queries).
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(",");
      const stmt = db.prepare(
        `SELECT * FROM lcd_summaries
         WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?
           AND summary_id IN (${placeholders})
         ORDER BY created_at, summary_id`,
      );
      const out: LcdSummary[] = [];
      for (const raw of stmt.all(scope.conversationId, scope.agentId, scope.tenantId, ...ids)) {
        const parsed = summaryRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue;
        const row = parsed.value;
        out.push({
          summaryId: row.summary_id,
          conversationId: row.conversation_id,
          kind: row.kind as LcdSummaryKind,
          depth: row.depth,
          earliestAt: row.earliest_at,
          latestAt: row.latest_at,
          descendantCount: row.descendant_count,
          tokenCount: row.token_count,
          content: row.content,
          fileIds: parseFileIds(row.file_ids),
          taint: row.taint !== 0,
          fallback: row.fallback !== 0,
          createdAt: row.created_at,
        });
      }
      return out;
    },
  };
}
