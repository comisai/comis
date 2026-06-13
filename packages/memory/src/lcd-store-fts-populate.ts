// SPDX-License-Identifier: Apache-2.0
/**
 * LCD FTS populate helpers — the index-write half of FTS-01 (Phase 180).
 * Extracted from `lcd-store.ts` so the adapter stays under the 800-line
 * file-size cap (mirrors the prior `lcd-store-writes.ts` / `lcd-fts.ts`
 * extractions; RESEARCH Pitfall 4). This file holds the populate logic + its
 * prepared statements; `createLcdStore` calls `createFtsPopulator(db)` ONCE at
 * factory top and invokes the returned methods inside its write transactions
 * (so the "prepare once" discipline is preserved — the statements are prepared
 * exactly once here, not per write).
 *
 * This commit (the 800-line-gate extraction) relocates the WORD-lane populate
 * block BYTE-IDENTICALLY: same SQL strings, same `messageRowidRowMapper`
 * parseOptionalRow guard, same `isFtsAvailable` gate, same narrow catch with the
 * same comment. NO behavior change. The normalized trigram-twin insert helpers
 * (`populateMessageTri` / `insertSummaryTri`) land in the next commit (plan
 * 180-04 Task 3) and flip live then.
 *
 * `@comis/memory` is infra-free (AGENTS.md §2.4 — no logger): a degraded
 * populate skips the index row silently by design (WR-03).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { LcdMessagePart } from "@comis/core";
import { renderMessageFtsText, isFtsAvailable } from "./lcd-fts.js";
import { messageRowidRowMapper } from "./lcd-store-mappers.js";

/** The two-column scope the FTS UNINDEXED columns carry (R4). The FTS tables hold
 *  NO tenant_id — `conversation_id` encodes the tenant boundary (lcd-fts.ts:24). */
export interface FtsPopulateScope {
  conversationId: string;
  agentId: string;
}

/** The populate surface `createLcdStore` injects into its write transactions. */
export interface FtsPopulator {
  /** Word-lane populate (byte-identical relocation of the appendTxn block):
   *  the self-contained `lcd_messages_fts` row at the base-table rowid. Gated on
   *  `isFtsAvailable`; the narrow catch swallows a post-boot INSERT failure. */
  populateMessageFts(messageId: string, parts: LcdMessagePart[], scope: FtsPopulateScope): void;
}

/**
 * Prepare the FTS populate statements ONCE and return the populate surface.
 */
export function createFtsPopulator(db: Database.Database): FtsPopulator {
  // ── Word lane (always present when FTS5 is compiled) ────────────────────────
  // Contentless lcd_messages_fts populate (gap #1): one row per appended message,
  // rowid joinable to the lcd_messages rowid, content = rendered part-text. Only
  // run when the FTS table exists (guarded at the call site so an FTS-less host's
  // append never throws).
  const insertMessageFts = db.prepare(
    "INSERT INTO lcd_messages_fts(rowid, content, conversation_id, agent_id, message_id) VALUES (?, ?, ?, ?, ?)",
  );

  // The just-inserted message's rowid — keeps lcd_messages_fts.rowid joinable to
  // lcd_messages.rowid. Bound by the message id.
  const selectMessageRowid = db.prepare("SELECT rowid FROM lcd_messages WHERE id = ?");

  function populateMessageFts(messageId: string, parts: LcdMessagePart[], scope: FtsPopulateScope): void {
    // E1 (gap #1): populate the CONTENTLESS lcd_messages_fts with the rendered
    // part-text so ctx_search finds this message. lcd_messages has no content
    // column (text is JSON in the parts), so the adapter — not a trigger — is the
    // only place that can render + index it; keep the FTS rowid in step with the
    // lcd_messages rowid (joinable).
    //
    // WR-03: GATE the populate on isFtsAvailable(db) (memoized per db). On an
    // FTS5-uncompiled host the lcd_*_fts tables are absent, so this is a CLEAN
    // CONDITIONAL SKIP — the EXPECTED degraded-host case no longer rides the
    // exception path (the old bare `catch {}` swallowed it indistinguishably from
    // a genuine fault, masking a real populate regression — search would silently
    // degrade with no signal). The remaining narrow try/catch then covers ONLY a
    // genuinely-exceptional populate failure (e.g. on-disk FTS corruption after a
    // healthy boot). The swallow is RETAINED — and must be — because appendTxn is
    // a db.transaction: re-throwing would roll back the message+parts write the
    // contentless index is merely best-effort for (LOSSLESS-CLAW §4: the lossless
    // base tables are authoritative; search is a recoverable derived index that
    // the LIKE fallback also covers). @comis/memory is intentionally logger-free
    // (AGENTS.md §2.4 — no getLogger import), so this content-free swallow is the
    // floor; the agent-side boundary-observability line for FTS-populate health
    // rides the injected-logger write path (Plan 128), not this layer.
    if (isFtsAvailable(db)) {
      try {
        const parsedRowid = messageRowidRowMapper.parseOptionalRow(selectMessageRowid.get(messageId));
        if (parsedRowid.ok && parsedRowid.value) {
          insertMessageFts.run(
            parsedRowid.value.rowid,
            renderMessageFtsText(parts),
            scope.conversationId,
            scope.agentId, // R4: agent_id UNINDEXED so the FTS MATCH filters by agent (WR-02)
            messageId,
          );
        }
      } catch {
        // FTS available at boot but the populate INSERT failed (genuinely
        // exceptional — e.g. FTS index corruption). Best-effort: skip indexing
        // THIS message rather than fail the authoritative base-table write
        // (cannot re-throw inside the txn). The LIKE fallback still covers it.
      }
    }
  }

  return { populateMessageFts };
}
