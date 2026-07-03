// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite adapter implementing ContextBrowsePort — the READ-ONLY operator-browse
 * surface over the LCD lossless store. Separate from createLcdStore (the
 * write+assemble ContextStorePort) so the heavily-implemented write port is not
 * widened for one operator-only read (blast-radius / KISS — see
 * core/src/ports/context-store.ts ContextBrowsePort doc).
 *
 * The single capability: enumerate the distinct conversations one agent owns
 * within one tenant, most-recently-updated first, paginated. Tenant + agent
 * isolation: every query filters by agent_id AND tenant_id so a conversation_id shared by
 * two agents (formatSessionKey omits agentId) never leaks across agents, and one
 * tenant never sees another's. Static SQL, bound params, no interpolated
 * identifiers; reads degrade gracefully (createRowMapper, no `as` casts —
 * §6.8 untyped-sqlite) and NEVER carry message/summary content (IDs/counts only).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type {
  ContextBrowsePort,
  ContextBrowseScope,
  LcdConversationPage,
  LcdConversationSummary,
} from "@comis/core";
import { z } from "zod";
import { createRowMapper } from "./row-mapper.js";

/**
 * One GROUP BY row of the distinct-conversation projection: the conversation
 * key columns plus aggregate min/max created_at and the message count. All
 * metadata — no content column is selected.
 */
const ConversationRowSchema = z.strictObject({
  conversation_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  session_key: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  message_count: z.number(),
});
const conversationRowMapper = createRowMapper(ConversationRowSchema);

/** Single-column COUNT(DISTINCT conversation_id) projection for the unpaginated total. */
const TotalRowSchema = z.strictObject({ total: z.number() });
const totalRowMapper = createRowMapper(TotalRowSchema);

/**
 * Create a ContextBrowsePort bound to the given database.
 *
 * Assumes `initSchema()` has already created the `lcd_messages` table.
 */
export function createLcdBrowseStore(db: Database.Database): ContextBrowsePort {
  // The distinct-conversation page, most-recently-updated first. Filter by
  // agent_id AND tenant_id (the conversation_id prefix carries the tenant; the
  // explicit tenant_id is defense-in-depth). `session_key` is grouped via
  // MIN so the GROUP BY stays keyed on the conversation alone (one session per
  // conversation in the current model). No content column is selected.
  const selectConversations = db.prepare(`
    SELECT
      conversation_id              AS conversation_id,
      tenant_id                    AS tenant_id,
      agent_id                     AS agent_id,
      MIN(session_key)             AS session_key,
      MIN(created_at)              AS created_at,
      MAX(created_at)              AS updated_at,
      COUNT(*)                     AS message_count
    FROM lcd_messages
    WHERE agent_id = ? AND tenant_id = ?
    GROUP BY conversation_id, tenant_id, agent_id
    ORDER BY MAX(created_at) DESC, conversation_id
    LIMIT ? OFFSET ?
  `);

  // The unpaginated count of distinct conversations for the (agent, tenant).
  const selectTotal = db.prepare(`
    SELECT COUNT(DISTINCT conversation_id) AS total
    FROM lcd_messages
    WHERE agent_id = ? AND tenant_id = ?
  `);

  return {
    listConversations(
      scope: ContextBrowseScope,
      opts: { limit: number; offset: number },
    ): LcdConversationPage {
      // Degrade PER ROW — a corrupt/drifted row is skipped, its siblings
      // survive (never parseRows, which would discard every already-validated
      // row). Ordering is preserved (we iterate the ORDER BY result in order).
      const conversations: LcdConversationSummary[] = [];
      for (const raw of selectConversations.all(scope.agentId, scope.tenantId, opts.limit, opts.offset)) {
        const parsed = conversationRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
        const row = parsed.value;
        conversations.push({
          conversationId: row.conversation_id,
          tenantId: row.tenant_id,
          agentId: row.agent_id,
          sessionKey: row.session_key,
          title: null, // the LCD store has no per-conversation title column
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          messageCount: row.message_count,
        });
      }

      const totalRow = totalRowMapper.parseOptionalRow(selectTotal.get(scope.agentId, scope.tenantId));
      const total = totalRow.ok && totalRow.value ? totalRow.value.total : conversations.length;

      return { conversations, total };
    },
  };
}
