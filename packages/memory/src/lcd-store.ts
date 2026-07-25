// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite adapter implementing ContextStorePort — the LCD (Lossless Context DAG)
 * lossless store. Mirrors createSessionStore: prepared statements bound once,
 * a synchronous port-typed object, zod-validated graceful-degrade reads, and an
 * injected wall-clock (the caller supplies `createdAt`; the store never reads
 * the clock or computes tokens).
 *
 * The write path (`append`) persists one message + its N structured parts
 * atomically in a single `db.transaction`. The read path (`getMessages`)
 * reconstructs the ordered `LcdMessage[]` DTOs; the canonical pi-ai Message
 * reconstruction delegates to @comis/core's `partsToMessage` codec — the
 * single pi-ai-typed seam, consumed by the assembly layer.
 *
 * The depth-0 leaf-compaction surface:
 * `appendLeafSummary` (ONE `db.transaction` that persists the `lcd_summaries`
 * row, links every covered message via `lcd_summary_messages`, and
 * range-replaces the covered `lcd_context_items` message-refs with one
 * summary-ref — keeping ordinals dense, gap-free and ordered) and
 * `getContextItems` (the ordered model-facing view, lazily seeded 1:1 from
 * `lcd_messages` on first read; no migration). `lcd_messages` is NEVER deleted
 * (FK RESTRICT enforces losslessness). The store NEVER logs summary `content`.
 *
 * The condensed tier: `appendCondensedSummary` (a sibling
 * clone of `appendLeafSummary` that persists a depth>0 `condensed`-kind summary,
 * links its CHILD SUMMARIES via `lcd_summary_parents` instead of messages, and
 * range-replaces the covered run of SUMMARY-refs — recomputing descendantCount +
 * time-range from the child rows). The child summary rows are NEVER deleted (FK
 * RESTRICT — losslessness for the multi-tier DAG).
 *
 * NO module-level logger (mirrors createSessionStore exactly): the
 * memory package has no infra-logging dependency and AGENTS.md §2.4 forbids
 * importing the infra logger directly (inject the logger via Deps). The boundary
 * observability line (an injected-logger INFO per append/read with
 * durationMs/err/hint) lives on the agent-side write path. The store NEVER logs
 * `metadata.raw` / `tool_output` contents (tool I/O may carry secrets; Pino
 * redaction is for logs, not the DB).
 *
 * @module
 */

import type Database from "better-sqlite3";
import {
  type AppendCondensedSummaryInput,
  type AppendMessageInput,
  type AppendSummaryInput,
  type ContextStorePort,
  type ContextStoreScope,
  type LcdContextItem,
  type LcdMessage,
  type LcdMessagePart,
  type LcdPartKind,
  type LcdRefKind,
  type LcdRole,
  type LcdSummary,
  type LcdSummaryKind,
} from "@comis/core";
import type { LcdSearchResult } from "@comis/core";
import { randomUUID } from "node:crypto";
import { searchLcdImpl } from "./lcd-fts.js";
import { createFtsPopulator } from "./lcd-store-fts-populate.js";
import { createIngestSerializer } from "./lcd-ingest-serializer.js";
import {
  buildAppendCondensedSummaryTxn,
  buildAppendLeafSummaryTxn,
} from "./lcd-store-writes.js";
import { createBoundedReads } from "./lcd-store-reads.js";
import { buildProvenanceWrites } from "./lcd-store-provenance.js";
import {
  messageRowMapper,
  partRowMapper,
  ctxItemRowMapper,
  summaryRowMapper,
  messageSeedRowMapper,
  ctxOrdinalRowMapper,
  ctxCountRowMapper,
  ctxMaxOrdinalRowMapper,
  summaryMessageIdRowMapper,
  cursorRowMapper,
  parseMetadata,
  parseJsonColumn,
  intToBool,
  boolToInt,
  parseFileIds,
} from "./lcd-store-mappers.js";

// Pure row-mapper + column-parse helpers live in ./lcd-store-mappers.ts
// (extracted to keep this factory under the architecture line cap).
// `reconstructLcdMessage` is re-exported so consumers keep importing it from the
// store module that produces the rows.
export { reconstructLcdMessage } from "./lcd-store-mappers.js";

/**
 * Create a ContextStorePort bound to the given database.
 *
 * Assumes `initSchema()` has already created the `lcd_messages` /
 * `lcd_message_parts` tables.
 */
export function createLcdStore(db: Database.Database): ContextStorePort {
  // Prepare statements once for performance. Static SQL only; bound parameters
  // for every value; no interpolated identifiers. Column-count ===
  // placeholder-count === arg-count (arg-shift guard — a shift surfaces in the
  // round-trip test).
  const insertMsg = db.prepare(`
    INSERT INTO lcd_messages
      (id, conversation_ref, tenant_id, agent_id, session_key, seq, role, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPart = db.prepare(`
    INSERT INTO lcd_message_parts
      (id, message_id, ordinal, kind, tool_call_id, tool_name, tool_input, tool_output, is_error, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Every base-table read filters by agent_id AND tenant_id in
  // addition to conversation_ref — two agents legitimately share one
  // conversation_ref (formatSessionKey omits agentId), so agent A must never read
  // agent B's rows. Bound params for the scope; the conversation_ref prefix
  // already encodes the tenant, the explicit tenant_id is defense-in-depth.
  const selectMsgs = db.prepare(
    "SELECT * FROM lcd_messages WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ? ORDER BY seq",
  );

  const selectParts = db.prepare(
    "SELECT * FROM lcd_message_parts WHERE message_id = ? ORDER BY ordinal",
  );

  // ── Summary + context_items range-replace statements ──
  // Static SQL, bound params, no interpolated identifiers.

  // The seq-ordered (id, created_at) projection — the lazy seed AND the
  // range-coverage / time-range source. (We re-select created_at by ordinal
  // range below rather than re-deriving it from getMessages, keeping it pure SQL.)
  const selectMsgSeed = db.prepare(
    "SELECT id, created_at FROM lcd_messages WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ? ORDER BY seq",
  );

  const insertSummary = db.prepare(`
    INSERT INTO lcd_summaries
      (summary_id, conversation_ref, tenant_id, agent_id, session_key, kind, depth,
       earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
    VALUES (?, ?, ?, ?, ?, 'leaf', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // The condensed-tier insert. Unlike insertSummary (which
  // hardcodes 'leaf'/0), this binds kind ('condensed') + depth as parameters —
  // 16 placeholders. insertSummary is a SEPARATE statement so the leaf and
  // condensed inserts stay independent.
  const insertCondensedSummary = db.prepare(`
    INSERT INTO lcd_summaries
      (summary_id, conversation_ref, tenant_id, agent_id, session_key, kind, depth,
       earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSummaryMessage = db.prepare(
    "INSERT OR IGNORE INTO lcd_summary_messages (summary_id, message_id) VALUES (?, ?)",
  );

  // The condensed→child summary edge (lcd_summary_parents).
  const insertSummaryParent = db.prepare(
    "INSERT OR IGNORE INTO lcd_summary_parents (parent_summary_id, child_summary_id) VALUES (?, ?)",
  );

  const insertCtxItem = db.prepare(`
    INSERT INTO lcd_context_items
      (id, conversation_ref, tenant_id, agent_id, session_key, ordinal, ref_kind, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectCtxItems = db.prepare(
    "SELECT * FROM lcd_context_items WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ? ORDER BY ordinal",
  );

  // Every leaf summary for a (conversation, agent), oldest-first — the assembler
  // keys the result by summaryId to resolve a context_items `summary`-ref to its
  // content. Scoped by agent_id + tenant_id.
  const selectSummaries = db.prepare(
    "SELECT * FROM lcd_summaries WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ? ORDER BY created_at, summary_id",
  );

  // ── Region-walk statements: edge-table reads, scoped by
  //    (conversation_ref, agent_id, tenant_id). Static SQL, bound
  //    params, no interpolated identifiers.
  // The immediate CHILD summaries of a condensed summary (lcd_summary_parents
  // condensed→child edge), joined back to lcd_summaries for the full DTO. Scoped
  // by the child's (conversation_ref, agent_id, tenant_id) so a different agent
  // sharing the conversation cannot walk this condensed edge.
  const selectSummaryChildren = db.prepare(`
    SELECT s.* FROM lcd_summaries s
    JOIN lcd_summary_parents p ON p.child_summary_id = s.summary_id
    WHERE p.parent_summary_id = ? AND s.conversation_ref = ? AND s.agent_id = ? AND s.tenant_id = ?
    ORDER BY s.created_at, s.summary_id
  `);

  // The message ids a LEAF summary covers (lcd_summary_messages leaf→message
  // edge), seq-ordered via the join to lcd_messages. The summary is scoped by
  // (conversation_ref, agent_id, tenant_id) through the JOIN (the messages carry
  // the scope columns) — a different agent cannot reach another agent's covered
  // ids within the shared conversation.
  const selectSummaryMessageIds = db.prepare(`
    SELECT sm.message_id AS message_id
    FROM lcd_summary_messages sm
    JOIN lcd_messages m ON m.id = sm.message_id
    WHERE sm.summary_id = ? AND m.conversation_ref = ? AND m.agent_id = ? AND m.tenant_id = ?
    ORDER BY m.seq
  `);

  // FTS populate (the index-write half of search) — extracted to
  // ./lcd-store-fts-populate.ts so this adapter stays under the 800-line cap
  // (mirrors the lcd-store-writes.ts / lcd-fts.ts extractions). Prepares the
  // word-lane + trigram-twin statements ONCE here (the "prepare once" discipline
  // is preserved) and exposes the gated populate methods appendTxn / the summary
  // write transactions call. Normalization for the twins lives there (the
  // single call site), so this file never folds search text itself.
  const ftsPopulator = createFtsPopulator(db);

  // The covered run [start,end] (inclusive), ordinal-ascending — used to gather
  // the message refIds the new summary links + to count descendants. The
  // model-facing view is per (conversation, agent, tenant), so the range ops are
  // agent-scoped — a leaf/condense pass must touch ONLY the acting agent's view
  // (the UNIQUE index is now (conversation_ref, agent_id, tenant_id, ordinal)).
  const selectCtxItemsInRange = db.prepare(
    "SELECT * FROM lcd_context_items WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ? AND ordinal >= ? AND ordinal <= ? ORDER BY ordinal",
  );

  const deleteCtxItemsInRange = db.prepare(
    "DELETE FROM lcd_context_items WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ? AND ordinal >= ? AND ordinal <= ?",
  );

  // The ordinals strictly above the replaced range, ascending — shifted DOWN
  // one row at a time (smallest source first → smallest, already-vacated target
  // first) so the UNIQUE (conversation_ref, agent_id, tenant_id, ordinal) index
  // never sees a transient duplicate (the delete above vacated the [start,end]
  // slots). Agent-scoped so the shift stays within the acting agent's view.
  const selectCtxOrdinalsAbove = db.prepare(
    "SELECT ordinal FROM lcd_context_items WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ? AND ordinal > ? ORDER BY ordinal",
  );

  const updateCtxItemOrdinal = db.prepare(
    "UPDATE lcd_context_items SET ordinal = ? WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ? AND ordinal = ?",
  );

  const countCtxItems = db.prepare(
    "SELECT COUNT(*) AS c FROM lcd_context_items WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ?",
  );

  // The highest ordinal currently in the (conversation, agent, tenant)
  // view — the per-append insert lands at MAX(ordinal)+1 (0 for the first row).
  // `MAX` over zero rows is SQL NULL (the nullable mapper handles it). Scoped
  // by agent_id+tenant_id so each agent keeps its OWN dense 0..N-1 sequence.
  const selectMaxCtxOrdinal = db.prepare(
    "SELECT MAX(ordinal) AS maxOrdinal FROM lcd_context_items WHERE conversation_ref = ? AND agent_id = ? AND tenant_id = ?",
  );

  // Incremental backfill: the seq-ordered (id, created_at) of THIS agent's
  // messages NOT YET represented in the model-facing view — neither a context_items
  // message-ref NOR a leaf/condensed summary_messages link. A message is
  // "represented" once it has a ref OR was collapsed into a summary, so this returns
  // EMPTY for a live append-maintained conversation (every message has a ref) and
  // for a fully-summarized run (the messages are in lcd_summary_messages) — the
  // backfill is then a clean no-op. It returns the full set only for a PRE-EXISTING
  // (legacy) conversation whose messages predate the per-append insert (zero refs,
  // zero summaries). Agent-scoped throughout.
  const selectUnseededMsgs = db.prepare(`
    SELECT m.id AS id, m.created_at AS created_at
    FROM lcd_messages m
    WHERE m.conversation_ref = ? AND m.agent_id = ? AND m.tenant_id = ?
      AND m.id NOT IN (
        SELECT ci.ref_id FROM lcd_context_items ci
        WHERE ci.conversation_ref = ? AND ci.agent_id = ? AND ci.tenant_id = ?
          AND ci.ref_kind = 'message'
      )
      AND m.id NOT IN (
        SELECT sm.message_id FROM lcd_summary_messages sm
        JOIN lcd_summaries s ON s.summary_id = sm.summary_id
        WHERE s.conversation_ref = ? AND s.agent_id = ? AND s.tenant_id = ?
      )
    ORDER BY m.seq
  `);

  // ── Durable ingest cursor ────────────────────────────────────────────────
  // Two prepared statements: an upsert (INSERT … ON CONFLICT DO UPDATE) and a
  // point-select for the two cursor fields. Static SQL, bound params, no
  // interpolated identifiers. The primary key is the three-column
  // isolation scope (conversation_ref, agent_id, tenant_id) — identical to every
  // other lcd_* table so a cross-tenant/cross-agent wipe is impossible.
  const upsertCursorStmt = db.prepare(
    "INSERT INTO lcd_ingest_cursor (conversation_ref, agent_id, tenant_id, epoch_anchor, ingested_live_len, updated_at)" +
    " VALUES (?,?,?,?,?,?)" +
    " ON CONFLICT(conversation_ref,agent_id,tenant_id)" +
    " DO UPDATE SET epoch_anchor=excluded.epoch_anchor, ingested_live_len=excluded.ingested_live_len, updated_at=excluded.updated_at",
  );

  const selectCursorStmt = db.prepare(
    "SELECT epoch_anchor, ingested_live_len FROM lcd_ingest_cursor WHERE conversation_ref=? AND agent_id=? AND tenant_id=?",
  );

  // lcd_memory_provenance writes (extracted helper).
  const provenanceWrites = buildProvenanceWrites(db);

  // ── deleteConversationLcd ────────────────────────────────────────────────
  // Deletes ALL lcd_* rows for a (conversation, agent, tenant) scope in FK-safe
  // dependency order. The RESTRICT FK on lcd_summary_messages.message_id →
  // lcd_messages.id REQUIRES deleting lcd_summary_messages rows BEFORE
  // lcd_messages rows (the RESTRICT FK is defined in schema-lcd.ts). lcd_message_parts
  // rows ride the ON DELETE CASCADE on message_id. Step 7 wipes the
  // three self-contained FTS objects — the word lane lcd_messages_fts (NO trigger;
  // adapter-populated, so a missed wipe leaves full message text matchable
  // post-reset — the live privacy defect this fixes) PLUS both trigram twins (the
  // AFTER DELETE triggers ALSO fire per-row during steps 4/5 — belt and
  // braces). Satisfies the complete-forget contract: nothing stays matchable in
  // ANY FTS object. Never throws; returns the lcd_messages delete count.
  const deleteConversationLcdTxn = db.transaction((scope: ContextStoreScope): number => {
    // 1. lcd_summary_messages: RESTRICT FK on message_id — must delete BEFORE lcd_messages.
    db.prepare(
      "DELETE FROM lcd_summary_messages WHERE summary_id IN" +
      " (SELECT summary_id FROM lcd_summaries WHERE conversation_ref=? AND agent_id=? AND tenant_id=?)",
    ).run(scope.conversationRef, scope.agentId, scope.tenantId);
    // 2. lcd_summary_parents: CASCADE FK on parent_summary_id — safe to delete before/after lcd_summaries.
    db.prepare(
      "DELETE FROM lcd_summary_parents WHERE parent_summary_id IN" +
      " (SELECT summary_id FROM lcd_summaries WHERE conversation_ref=? AND agent_id=? AND tenant_id=?)",
    ).run(scope.conversationRef, scope.agentId, scope.tenantId);
    // 3. lcd_context_items (no FK dependency on messages/summaries order).
    db.prepare(
      "DELETE FROM lcd_context_items WHERE conversation_ref=? AND agent_id=? AND tenant_id=?",
    ).run(scope.conversationRef, scope.agentId, scope.tenantId);
    // 4. lcd_summaries: after lcd_summary_messages + lcd_summary_parents rows are gone.
    db.prepare(
      "DELETE FROM lcd_summaries WHERE conversation_ref=? AND agent_id=? AND tenant_id=?",
    ).run(scope.conversationRef, scope.agentId, scope.tenantId);
    // 5. lcd_messages: CASCADE deletes lcd_message_parts rows (ON DELETE CASCADE on message_id).
    const info = db.prepare(
      "DELETE FROM lcd_messages WHERE conversation_ref=? AND agent_id=? AND tenant_id=?",
    ).run(scope.conversationRef, scope.agentId, scope.tenantId);
    // 6. lcd_ingest_cursor: clear the durable epoch cursor for this scope.
    db.prepare(
      "DELETE FROM lcd_ingest_cursor WHERE conversation_ref=? AND agent_id=? AND tenant_id=?",
    ).run(scope.conversationRef, scope.agentId, scope.tenantId);
    // 7. Wipe the three self-contained FTS objects. Each is
    // guarded — the table is ABSENT on an FTS5-less / trigram-less host (nothing
    // indexed → nothing to wipe); vtables have no FK so the order is free. The
    // scope is TWO-column: the FTS tables carry NO tenant_id — conversation_ref
    // encodes the tenant. The word lane has no AFTER DELETE
    // trigger (adapter-populated), so this explicit wipe is the ONLY forget for it.
    try {
      db.prepare(
        "DELETE FROM lcd_messages_fts WHERE conversation_ref=? AND agent_id=?",
      ).run(scope.conversationRef, scope.agentId);
    } catch {
      // Word-lane FTS table absent (FTS5 not compiled) — nothing indexed, nothing to wipe.
    }
    try {
      db.prepare(
        "DELETE FROM lcd_messages_fts_tri WHERE conversation_ref=? AND agent_id=?",
      ).run(scope.conversationRef, scope.agentId);
    } catch {
      // Message trigram twin absent (trigram tokenizer not compiled) — nothing to wipe.
    }
    try {
      db.prepare(
        "DELETE FROM lcd_summaries_fts_tri WHERE conversation_ref=? AND agent_id=?",
      ).run(scope.conversationRef, scope.agentId);
    } catch {
      // Summary trigram twin absent (trigram tokenizer not compiled) — nothing to wipe.
    }
    return info.changes as number;
  });

  /**
   * Idempotent INCREMENTAL backfill of the model-facing view from lcd_messages.
   * The view is maintained live by `appendTxn` (one message-ref per
   * append at the next ordinal), so on the live path this finds NOTHING to seed
   * and is a clean no-op. Its only real work is the migration/backfill for a
   * PRE-EXISTING conversation whose messages predate the per-append insert: it
   * seeds every message NOT YET represented (neither a context_items message-ref
   * NOR a summary_messages link), appending at `MAX(ordinal)+1` in seq order so
   * the dense sequence continues without colliding with any surviving summary-ref.
   *
   * Idempotent: calling it repeatedly seeds only the still-uncovered gap, never
   * duplicating — `selectUnseededMsgs` excludes anything already in the view or
   * already collapsed into a summary, and the running ordinal starts past the
   * current max. Every read/write below is agent-scoped, so two
   * agents sharing a conversation_ref each backfill a DENSE view over their OWN
   * uncovered messages (the UNIQUE index keys on all three scope columns). Caller
   * runs this inside a txn. Skips silently when the agent has nothing to seed.
   */
  function seedContextItems(scope: ContextStoreScope): void {
    const maxRow = ctxMaxOrdinalRowMapper.parseOptionalRow(
      selectMaxCtxOrdinal.get(scope.conversationRef, scope.agentId, scope.tenantId),
    );
    // The next dense ordinal: continue past the current max (NULL/absent → -1 → 0).
    let ordinal = (maxRow.ok && maxRow.value ? maxRow.value.maxOrdinal ?? -1 : -1) + 1;
    for (const rawMsg of selectUnseededMsgs.all(
      scope.conversationRef,
      scope.agentId,
      scope.tenantId,
      scope.conversationRef,
      scope.agentId,
      scope.tenantId,
      scope.conversationRef,
      scope.agentId,
      scope.tenantId,
    )) {
      const parsed = messageSeedRowMapper.parseOptionalRow(rawMsg);
      if (!parsed.ok || !parsed.value) continue; // skip only the bad message row
      insertCtxItem.run(
        randomUUID(),
        scope.conversationRef,
        scope.tenantId,
        scope.agentId,
        scope.sessionKey,
        ordinal,
        "message" satisfies LcdRefKind,
        parsed.value.id,
      );
      ordinal++;
    }
  }

  const seedTxn = db.transaction((scope: ContextStoreScope) => {
    seedContextItems(scope);
  });

  // The leaf + condensed summary write transactions are extracted to
  // ./lcd-store-writes.ts (mirroring the ./lcd-fts.ts extract) so this adapter
  // stays under the 800-line cap with headroom for the read-filter edits.
  // The prepared statements + mappers + seed helper are passed in so the
  // "prepare once" discipline is preserved — the closures are byte-identical
  // relocations (NO SQL/column/ordering/error-handling change). The condensed
  // txn's tamper-guard throw (the rollback mechanism) lives there now.
  const summaryWriteDeps = {
    seedContextItems,
    selectCtxItemsInRange,
    selectMsgSeed,
    selectSummaries,
    insertSummary,
    insertCondensedSummary,
    insertSummaryMessage,
    insertSummaryParent,
    insertCtxItem,
    deleteCtxItemsInRange,
    selectCtxOrdinalsAbove,
    updateCtxItemOrdinal,
    ctxItemRowMapper,
    messageSeedRowMapper,
    summaryRowMapper,
    ctxOrdinalRowMapper,
    // The normalized summary-twin insert (folds internally).
    insertSummaryTri: ftsPopulator.insertSummaryTri,
  };
  const appendLeafSummaryTxn = buildAppendLeafSummaryTxn(db, summaryWriteDeps);
  const appendCondensedSummaryTxn = buildAppendCondensedSummaryTxn(db, summaryWriteDeps);

  // Bounded reads: extracted to ./lcd-store-reads.ts to keep this file
  // under the 800-line cap (mirrors the lcd-store-writes.ts extraction pattern).
  // `selectParts` is passed in so the prepare-once discipline is preserved.
  const boundedReads = createBoundedReads(db, selectParts);

  // The per-conversation single-flight serializer the store
  // exposes via runOnConversation. The store is the single writer BOTH the live
  // ingest and the deferred compaction flow through, so the per-conversation
  // queue naturally sits at the store boundary. Infra-free (it only orders fns —
  // no logging, no SQL); the agent reaches it through the port method.
  const ingestSerializer = createIngestSerializer();

  // One atomic write: the message row + its N part rows commit together.
  const appendTxn = db.transaction((input: AppendMessageInput) => {
    const messageId = randomUUID();
    insertMsg.run(
      messageId,
      input.scope.conversationRef,
      input.scope.tenantId,
      input.scope.agentId,
      input.scope.sessionKey,
      input.seq,
      input.role,
      input.tokenCount,
      input.createdAt,
    );

    let ordinal = 0;
    for (const part of input.parts) {
      insertPart.run(
        randomUUID(),
        messageId,
        ordinal,
        part.kind,
        part.toolCallId ?? null,
        part.toolName ?? null,
        part.toolInput === undefined ? null : JSON.stringify(part.toolInput),
        part.toolOutput === undefined ? null : JSON.stringify(part.toolOutput),
        boolToInt(part.isError),
        JSON.stringify(part.metadata),
      );
      ordinal++;
    }

    // Maintain the dense model-facing view INCREMENTALLY — insert ONE
    // message-ref lcd_context_items row at the next ordinal for this message's
    // (conversation, agent, tenant) scope, inside the SAME txn so the message and
    // its context-item commit atomically. This keeps context_items a true 1:1 view
    // that grows with appends (the seed-once read-time guard used to freeze it at
    // the first read while lcd_messages kept growing). The new row
    // stamps the SAME scope columns as the message row, so two agents sharing a
    // conversation_ref each keep their own dense 0..N-1 view (the UNIQUE index keys
    // on conversation_ref+agent_id+tenant_id+ordinal). `MAX(ordinal)` over
    // zero rows is NULL → nextOrdinal 0 for the first message.
    const maxRow = ctxMaxOrdinalRowMapper.parseOptionalRow(
      selectMaxCtxOrdinal.get(input.scope.conversationRef, input.scope.agentId, input.scope.tenantId),
    );
    const nextOrdinal = (maxRow.ok && maxRow.value ? maxRow.value.maxOrdinal ?? -1 : -1) + 1;
    insertCtxItem.run(
      randomUUID(),
      input.scope.conversationRef,
      input.scope.tenantId,
      input.scope.agentId,
      input.scope.sessionKey,
      nextOrdinal,
      "message" satisfies LcdRefKind,
      messageId,
    );

    // Populate the CONTENTLESS lcd_messages_fts with the rendered
    // part-text so ctx_search finds this message (extracted to
    // ./lcd-store-fts-populate.ts — byte-identical: same gate on isFtsAvailable,
    // same rowid resolve + insert, same narrow swallow because appendTxn is a
    // db.transaction and the contentless index is best-effort only).
    ftsPopulator.populateMessageFts(messageId, input.parts, input.scope);
    // Also index the NORMALIZED trigram twin so a
    // script-routed MATCH reads Hebrew/Arabic/Cyrillic/CJK. The populator applies
    // the search fold internally (the single call site) at the same base rowid;
    // best-effort (a twin failure never fails this authoritative append).
    ftsPopulator.populateMessageTri(messageId, input.parts, input.scope);
  });

  return {
    append(input: AppendMessageInput): void {
      appendTxn(input);
    },

    getMessages(scope: ContextStoreScope): LcdMessage[] {
      // Degrade PER ROW, not per result-set. `parseRows` returns err on
      // the first bad row and discards every already-validated row — so one
      // corrupt PART row would null a whole message body (orphaning a
      // downstream tool_result -> provider rejection) and one corrupt MESSAGE
      // row would drop the whole conversation. Validate each row with
      // `parseOptionalRow` and skip ONLY the bad row, keeping its good
      // siblings — the same graceful-degrade granularity `parseMetadata` uses
      // per field. Ordering is preserved (we iterate the ORDER BY result in
      // order). The skip is silent by design: the memory package has no
      // infra-logging dependency (AGENTS.md §2.4 forbids importing getLogger
      // directly); the boundary observability line lives on the agent-side
      // injected-logger write path. A schema-violating row is unreachable via
      // the typed `append` — it requires on-disk corruption / schema drift.
      const out: LcdMessage[] = [];

      for (const rawMsg of selectMsgs.all(scope.conversationRef, scope.agentId, scope.tenantId)) {
        const parsedMsg = messageRowMapper.parseOptionalRow(rawMsg);
        if (!parsedMsg.ok || !parsedMsg.value) continue; // skip only the bad message row
        const row = parsedMsg.value;

        const parts: LcdMessagePart[] = [];
        for (const rawPart of selectParts.all(row.id)) {
          const parsedPart = partRowMapper.parseOptionalRow(rawPart);
          if (!parsedPart.ok || !parsedPart.value) continue; // skip only the bad part row
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
          conversationRef: row.conversation_ref,
          seq: row.seq,
          role: row.role as LcdRole,
          tokenCount: row.token_count,
          createdAt: row.created_at,
          parts,
        });
      }

      return out;
    },

    appendLeafSummary(input: AppendSummaryInput): string {
      return appendLeafSummaryTxn(input);
    },

    appendCondensedSummary(input: AppendCondensedSummaryInput): string {
      return appendCondensedSummaryTxn(input);
    },

    getContextItems(scope: ContextStoreScope): LcdContextItem[] {
      // The view is maintained live by appendTxn, so a live conversation
      // already has its rows here and this gate is a no-op. It still fires for a
      // PRE-EXISTING (legacy) conversation whose messages predate the per-append
      // insert (zero rows) → one incremental backfill in its own txn so the SELECT
      // below sees the inserted rows; thereafter append keeps it current. Gating on
      // `== 0` avoids taking a write transaction on every read of a maintained view.
      // The count gate + seed are agent-scoped, so each agent gets a dense view
      // over its OWN messages within a shared conversation. The count read
      // goes through ctxCountRowMapper, not a raw count cast (§6.8 untyped-sqlite).
      const countRow = ctxCountRowMapper.parseOptionalRow(
        countCtxItems.get(scope.conversationRef, scope.agentId, scope.tenantId),
      );
      if (countRow.ok && countRow.value && countRow.value.c === 0) {
        seedTxn(scope);
      }

      // Degrade PER ROW, not per result-set — a corrupt/ drifted
      // context_items row is skipped, its siblings survive (NEVER `parseRows`,
      // which would discard every already-validated row). Ordering is preserved
      // (we iterate the ORDER BY ordinal result in order). The skip is silent by
      // design: the memory package has no infra-logging dependency (AGENTS.md
      // §2.4); the boundary observability line is agent-side.
      const out: LcdContextItem[] = [];
      for (const raw of selectCtxItems.all(scope.conversationRef, scope.agentId, scope.tenantId)) {
        const parsed = ctxItemRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
        out.push({
          ordinal: parsed.value.ordinal,
          refKind: parsed.value.ref_kind as LcdRefKind,
          refId: parsed.value.ref_id,
        });
      }
      return out;
    },

    getSummaries(scope: ContextStoreScope): LcdSummary[] {
      // Degrade PER ROW, not per result-set — a corrupt/drifted summary
      // row is skipped, its siblings survive (NEVER `parseRows`, which would
      // discard every already-validated row). The skip is silent by design (the
      // memory package has no infra-logging dependency, AGENTS.md §2.4); the
      // boundary observability line is agent-side (the assembler). The
      // store NEVER logs the summary `content` (lossless store). Scoped
      // by agent_id + tenant_id.
      const out: LcdSummary[] = [];
      for (const raw of selectSummaries.all(scope.conversationRef, scope.agentId, scope.tenantId)) {
        const parsed = summaryRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
        const row = parsed.value;
        out.push({
          summaryId: row.summary_id,
          conversationRef: row.conversation_ref,
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

    getMessagesByIds(scope: ContextStoreScope, ids: string[]): LcdMessage[] {
      // Extracted to ./lcd-store-reads.ts (byte-identical relocation).
      return boundedReads.getMessagesByIds(scope, ids);
    },

    countMessages(scope: ContextStoreScope): number {
      // Extracted to ./lcd-store-reads.ts (byte-identical relocation).
      return boundedReads.countMessages(scope);
    },

    getSummariesByIds(scope: ContextStoreScope, ids: string[]): LcdSummary[] {
      // Extracted to ./lcd-store-reads.ts (byte-identical relocation).
      return boundedReads.getSummariesByIds(scope, ids);
    },

    getSummaryChildren(scope: ContextStoreScope, parentSummaryId: string): LcdSummary[] {
      // Region walk: the immediate child summaries of a condensed summary
      // (lcd_summary_parents condensed→child edge). Same map-to-DTO discipline as
      // getSummaries — reuse summaryRowMapper, per-row parseOptionalRow +
      // skip-bad-row (NEVER parseRows). Scoped by (conversation_ref,
      // agent_id, tenant_id) in the JOIN's WHERE (a wrong/stale id OR a different
      // agent → []); the store never logs content.
      const out: LcdSummary[] = [];
      for (const raw of selectSummaryChildren.all(parentSummaryId, scope.conversationRef, scope.agentId, scope.tenantId)) {
        const parsed = summaryRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
        const row = parsed.value;
        out.push({
          summaryId: row.summary_id,
          conversationRef: row.conversation_ref,
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

    getSummaryMessages(scope: ContextStoreScope, summaryId: string): string[] {
      // Region walk: the message ids a LEAF summary covers (lcd_summary_messages
      // leaf→message edge), seq-ordered. Per-row parseOptionalRow + skip-bad-row
      // (NEVER parseRows). Scoped by (conversation_ref, agent_id,
      // tenant_id) via the JOIN; unknown summaryId OR a different agent → [].
      const out: string[] = [];
      for (const raw of selectSummaryMessageIds.all(summaryId, scope.conversationRef, scope.agentId, scope.tenantId)) {
        const parsed = summaryMessageIdRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
        out.push(parsed.value.message_id);
      }
      return out;
    },

    searchLcd(
      scope: ContextStoreScope,
      query: string,
      opts: { limit: number; scope?: "messages" | "summaries" | "both" },
    ): LcdSearchResult {
      // Search: delegate the FTS5-MATCH-with-LIKE-fallback branch to lcd-fts.ts
      // (the extract that keeps this file under the 800-line cap). The `query`
      // arrives pre-sanitized (the tool sanitizes — the cut bars memory from the
      // skills sanitizer). Scoped by (conversation_ref, agent_id) — BOTH the
      // FTS MATCH path AND the LIKE fallback filter agent_id;
      // the conversation_ref prefix carries the tenant boundary. Never throws.
      // Returns LcdSearchResult: { hits, cjkZeroHit } — propagated
      // directly from searchLcdImpl; no transformation needed.
      return searchLcdImpl(db, scope.conversationRef, scope.agentId, query, opts);
    },

    runOnConversation<T>(conversationRef: string, fn: () => T | Promise<T>): Promise<T> {
      // Serialize the live ingest write and the deferred
      // compaction write per conversation so they cannot interleave on the
      // (conversation_ref, agent_id, tenant_id, seq) unique index / context_items
      // ordinals. Different conversations run concurrently (the
      // queue is per-conversation). The store does not log here — observability
      // is agent-side.
      return ingestSerializer.runOnConversation(conversationRef, fn);
    },

    // ── Durable ingest cursor ────────────────────────────────────────────────

    getIngestCursor(scope: ContextStoreScope): { epochAnchor: string; ingestedLiveLen: number } | null {
      // Point-select the cursor row for this (conversation, agent, tenant) scope.
      // Returns null when no row exists (new conversation or first run after upgrade).
      // Per-row parseOptionalRow + skip on validation failure (never throws).
      const row = selectCursorStmt.get(scope.conversationRef, scope.agentId, scope.tenantId);
      if (!row) return null;
      const parsed = cursorRowMapper.parseOptionalRow(row);
      if (!parsed.ok || !parsed.value) return null;
      return { epochAnchor: parsed.value.epoch_anchor, ingestedLiveLen: parsed.value.ingested_live_len };
    },

    upsertIngestCursor(
      scope: ContextStoreScope,
      cursor: { epochAnchor: string; ingestedLiveLen: number },
      updatedAt: number,
    ): void {
      // Atomically upsert — INSERT on first use, UPDATE on subsequent writes.
      // Must be called inside runOnConversation by the caller.
      upsertCursorStmt.run(
        scope.conversationRef,
        scope.agentId,
        scope.tenantId,
        cursor.epochAnchor,
        cursor.ingestedLiveLen,
        updatedAt,
      );
    },

    // ── Explicit LCD reset ─────────────────────────────────────────────────
    deleteConversationLcd(scope: ContextStoreScope): number {
      // Delegate to the db.transaction that deletes in FK-safe dependency order.
      // Must be called inside runOnConversation so it serializes against live ingest.
      // Returns the count of lcd_messages rows deleted (0 for an empty scope).
      return deleteConversationLcdTxn(scope);
    },

    // Provenance writes (extracted helper).
    ...provenanceWrites,
  };
}
