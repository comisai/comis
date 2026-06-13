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
 * The WORD-lane populate (`populateMessageFts`) was relocated BYTE-IDENTICALLY
 * (same SQL strings, same `messageRowidRowMapper` guard, same `isFtsAvailable`
 * gate, same narrow catch). The normalized TRIGRAM-TWIN inserts
 * (`populateMessageTri` / `insertSummaryTri`) are the index half of the FTS-01
 * symmetry: they fold RAW content through `normalizeForSearch` HERE — the I7
 * single call site — so the call sites in `lcd-store.ts` / `lcd-store-writes.ts`
 * CANNOT forget the fold. The stored twin text is the SAME symbol the query side
 * (plan 180-05) imports, which is the entire FTS-01 contract: query מלך finds
 * stored מלכים because both fold identically.
 *
 * Each twin's statements are prepared inside its OWN try/catch — `prepare()`
 * THROWS on a trigram-less host (the twin tables are absent → "no such table"),
 * so a failed prep sets THAT twin's handles null and its methods become a clean
 * no-op. This mirrors the `isFtsAvailable` defensive posture without a second
 * probe: if a twin's statements compiled, that twin's table exists. The preps are
 * INDEPENDENT (WR-01) so a partial-schema host with one twin present and the other
 * absent keeps the present twin live — matching ensureTrigramTwins's per-block DDL.
 *
 * `@comis/memory` is infra-free (AGENTS.md §2.4 — no logger): a degraded
 * populate skips the index row silently by design (WR-03); a twin failure leaves
 * the row DE-INDEXED (the fail-safe direction), never a rolled-back base write.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { LcdMessagePart } from "@comis/core";
import { normalizeForSearch } from "@comis/core";
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
  /** Trigram-twin populate: `normalizeForSearch(renderMessageFtsText(parts))`
   *  into `lcd_messages_fts_tri` at the base rowid. Normalizes internally (I7).
   *  No-op when the twins are absent (trigram-less host). */
  populateMessageTri(messageId: string, parts: LcdMessagePart[], scope: FtsPopulateScope): void;
  /** Trigram-twin populate for a summary: `normalizeForSearch(rawContent)` into
   *  `lcd_summaries_fts_tri` at the summary's base rowid (resolved by summary_id).
   *  Normalizes internally (I7). No-op when the twins are absent. */
  insertSummaryTri(summaryId: string, rawContent: string, scope: FtsPopulateScope): void;
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

  // ── Trigram twins (probe-gated via guarded prep) ────────────────────────────
  // `prepare()` THROWS on a trigram-less host (the twin tables do not exist →
  // "no such table"). A failed prep leaves the handles null and every twin method
  // is a clean no-op — search degrades to the scan floors (plan 180-05), the
  // append path is unaffected. If the statements compiled, the twin tables exist
  // (so no second runtime probe is needed). The twin's rowid = the base rowid
  // (the same linkage insertMessageFts uses) so the 180-02 AFTER DELETE triggers
  // mirror twin deletes by `old.rowid`.
  //
  // WR-01: prepare EACH twin in its OWN try/catch — mirror ensureTrigramTwins's
  // per-block DDL independence. On a partial-schema host where the message twin
  // exists but the summaries twin does NOT (e.g. the summaries CREATE failed while
  // the messages one succeeded, or a hand-edited dev DB — each DDL twin lives in
  // its own block, so this divergence is reachable), a single shared try/catch
  // would let the absent-summaries prep throw and null the message-twin handle
  // too, silently de-activating a message trigram lane that IS present and IS
  // being read by searchTrigram. Independent preps keep each present twin live.
  let insertMessageTri: Database.Statement | null = null;
  try {
    insertMessageTri = db.prepare(
      "INSERT INTO lcd_messages_fts_tri(rowid, content, conversation_id, agent_id, message_id) VALUES (?, ?, ?, ?, ?)",
    );
  } catch {
    // Message twin absent (trigram tokenizer missing, or this twin's DDL block
    // failed) → the handle stays null and populateMessageTri is a clean no-op.
    insertMessageTri = null;
  }

  // The summary twin needs BOTH statements (the rowid lookup + the insert), so
  // they share ONE try/catch — they target the SAME twin and are useless apart.
  let insertSummaryTriStmt: Database.Statement | null = null;
  let selectSummaryRowid: Database.Statement | null = null;
  try {
    insertSummaryTriStmt = db.prepare(
      "INSERT INTO lcd_summaries_fts_tri(rowid, content, conversation_id, agent_id, summary_id) VALUES (?, ?, ?, ?, ?)",
    );
    selectSummaryRowid = db.prepare("SELECT rowid FROM lcd_summaries WHERE summary_id = ?");
  } catch {
    // Summary twin absent (trigram tokenizer missing, or this twin's DDL block
    // failed) → both handles stay null and insertSummaryTri is a clean no-op. A
    // present message twin (above) is UNAFFECTED (WR-01).
    insertSummaryTriStmt = null;
    selectSummaryRowid = null;
  }

  function populateMessageTri(messageId: string, parts: LcdMessagePart[], scope: FtsPopulateScope): void {
    // No-op on a trigram-less host (guarded prep set the handle null).
    if (insertMessageTri === null) return;
    try {
      const parsedRowid = messageRowidRowMapper.parseOptionalRow(selectMessageRowid.get(messageId));
      if (parsedRowid.ok && parsedRowid.value) {
        insertMessageTri.run(
          parsedRowid.value.rowid,
          // I7: normalize RAW content HERE (the single call site) so the index
          // side folds identically to the query side (plan 180-05 imports the
          // same symbol). The folded text is what a script-routed MATCH reads.
          normalizeForSearch(renderMessageFtsText(parts)),
          scope.conversationId,
          scope.agentId, // R4: agent_id UNINDEXED so the twin MATCH filters by agent (WR-02)
          messageId,
        );
      }
    } catch {
      // Best-effort — skip indexing THIS row rather than fail the authoritative
      // base-table write; cannot re-throw inside the txn; fail-safe = de-indexed
      // (the scan floor still covers it; the doctor backfill repopulates).
    }
  }

  function insertSummaryTri(summaryId: string, rawContent: string, scope: FtsPopulateScope): void {
    // No-op on a trigram-less host (guarded prep set the handles null).
    if (insertSummaryTriStmt === null || selectSummaryRowid === null) return;
    try {
      const parsedRowid = messageRowidRowMapper.parseOptionalRow(selectSummaryRowid.get(summaryId));
      if (parsedRowid.ok && parsedRowid.value) {
        insertSummaryTriStmt.run(
          parsedRowid.value.rowid,
          // I7: normalize RAW summary content HERE (the single call site).
          normalizeForSearch(rawContent),
          scope.conversationId,
          scope.agentId, // R4: agent_id UNINDEXED so the twin MATCH filters by agent (WR-02)
          summaryId,
        );
      }
    } catch {
      // Best-effort — skip indexing THIS row rather than fail the authoritative
      // base-table write; cannot re-throw inside the txn; fail-safe = de-indexed
      // (the scan floor still covers it; the doctor backfill repopulates).
    }
  }

  return { populateMessageFts, populateMessageTri, insertSummaryTri };
}
