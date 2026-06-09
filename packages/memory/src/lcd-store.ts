// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite adapter implementing ContextStorePort — the LCD (Lossless Context DAG)
 * lossless store. Mirrors createSessionStore: prepared statements bound once,
 * a synchronous port-typed object, zod-validated graceful-degrade reads, and an
 * injected wall-clock (the caller supplies `createdAt`; the store never reads
 * the clock or computes tokens).
 *
 * The write path (`append`) persists one message + its N structured parts
 * atomically in a single `db.transaction` (F1). The read path (`getMessages`)
 * reconstructs the ordered `LcdMessage[]` DTOs; the canonical pi-ai Message
 * reconstruction delegates to @comis/core's `partsToMessage` codec (F2/F3) — the
 * single pi-ai-typed seam, consumed by Phase 128 assembly.
 *
 * Phase 129 (C3) extends the store with the depth-0 leaf-compaction surface:
 * `appendLeafSummary` (ONE `db.transaction` that persists the `lcd_summaries`
 * row, links every covered message via `lcd_summary_messages`, and
 * range-replaces the covered `lcd_context_items` message-refs with one
 * summary-ref — keeping ordinals dense, gap-free and ordered) and
 * `getContextItems` (the ordered model-facing view, lazily seeded 1:1 from
 * `lcd_messages` on first read; no migration). `lcd_messages` is NEVER deleted
 * (FK RESTRICT enforces losslessness). The store NEVER logs summary `content`.
 *
 * Phase 130 (C2) adds the condensed tier: `appendCondensedSummary` (a sibling
 * clone of `appendLeafSummary` that persists a depth>0 `condensed`-kind summary,
 * links its CHILD SUMMARIES via `lcd_summary_parents` instead of messages, and
 * range-replaces the covered run of SUMMARY-refs — recomputing descendantCount +
 * time-range from the child rows). The child summary rows are NEVER deleted (FK
 * RESTRICT — losslessness for the multi-tier DAG).
 *
 * NO module-level logger in Phase 127 (mirrors createSessionStore exactly): the
 * memory package has no infra-logging dependency and AGENTS.md §2.4 forbids
 * importing the infra logger directly (inject the logger via Deps). The boundary
 * observability line (an injected-logger INFO per append/read with
 * durationMs/err/hint) lands in Phase 128 when the live append-on-turn
 * write-path is wired. The store NEVER logs `metadata.raw` / `tool_output`
 * contents (tool I/O may carry secrets — a Phase-132 concern; Pino redaction is
 * for logs, not the DB).
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
import type { LcdSearchHit } from "@comis/core";
import { randomUUID } from "node:crypto";
import { renderMessageFtsText, searchLcdImpl, isFtsAvailable } from "./lcd-fts.js";
import { createIngestSerializer } from "./lcd-ingest-serializer.js";
import {
  buildAppendCondensedSummaryTxn,
  buildAppendLeafSummaryTxn,
} from "./lcd-store-writes.js";
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
  messageRowidRowMapper,
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
  // for every value; no interpolated identifiers (T-127-09). Column-count ===
  // placeholder-count === arg-count (arg-shift guard — a shift surfaces in the
  // round-trip test).
  const insertMsg = db.prepare(`
    INSERT INTO lcd_messages
      (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPart = db.prepare(`
    INSERT INTO lcd_message_parts
      (id, message_id, ordinal, kind, tool_call_id, tool_name, tool_input, tool_output, is_error, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // R4 (132-03): every base-table read filters by agent_id AND tenant_id in
  // addition to conversation_id — two agents legitimately share one
  // conversation_id (formatSessionKey omits agentId), so agent A must never read
  // agent B's rows (WR-02). Bound params for the scope; the conversation_id prefix
  // already encodes the tenant, the explicit tenant_id is defense-in-depth.
  const selectMsgs = db.prepare(
    "SELECT * FROM lcd_messages WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ? ORDER BY seq",
  );

  const selectParts = db.prepare(
    "SELECT * FROM lcd_message_parts WHERE message_id = ? ORDER BY ordinal",
  );

  // ── Phase 129 (C3) statements: summaries + context_items range-replace ──
  // Static SQL, bound params, no interpolated identifiers (T-129-03).

  // The seq-ordered (id, created_at) projection — the lazy seed AND the
  // range-coverage / time-range source. (We re-select created_at by ordinal
  // range below rather than re-deriving it from getMessages, keeping it pure SQL.)
  const selectMsgSeed = db.prepare(
    "SELECT id, created_at FROM lcd_messages WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ? ORDER BY seq",
  );

  const insertSummary = db.prepare(`
    INSERT INTO lcd_summaries
      (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
       earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
    VALUES (?, ?, ?, ?, ?, 'leaf', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Phase 130 (C2): the condensed-tier insert. Unlike insertSummary (which
  // hardcodes 'leaf'/0), this binds kind ('condensed') + depth as parameters —
  // 16 placeholders. insertSummary is left UNCHANGED (a SEPARATE method, no
  // regression risk to the green 129 leaf transaction; RESEARCH A3).
  const insertCondensedSummary = db.prepare(`
    INSERT INTO lcd_summaries
      (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
       earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSummaryMessage = db.prepare(
    "INSERT OR IGNORE INTO lcd_summary_messages (summary_id, message_id) VALUES (?, ?)",
  );

  // Phase 130 (C2): the condensed→child summary edge (lcd_summary_parents).
  const insertSummaryParent = db.prepare(
    "INSERT OR IGNORE INTO lcd_summary_parents (parent_summary_id, child_summary_id) VALUES (?, ?)",
  );

  const insertCtxItem = db.prepare(`
    INSERT INTO lcd_context_items
      (id, conversation_id, tenant_id, agent_id, session_key, ordinal, ref_kind, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectCtxItems = db.prepare(
    "SELECT * FROM lcd_context_items WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ? ORDER BY ordinal",
  );

  // Every leaf summary for a (conversation, agent), oldest-first — the assembler
  // keys the result by summaryId to resolve a context_items `summary`-ref to its
  // content. R4: scoped by agent_id + tenant_id (WR-02).
  const selectSummaries = db.prepare(
    "SELECT * FROM lcd_summaries WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ? ORDER BY created_at, summary_id",
  );

  // ── Phase 131 (E1) region-walk statements: edge-table reads, scoped by
  //    (conversation_id, agent_id, tenant_id) — R4 132-03. Static SQL, bound
  //    params, no interpolated identifiers (T-127-09 / T-131-02-01).
  // The immediate CHILD summaries of a condensed summary (lcd_summary_parents
  // condensed→child edge), joined back to lcd_summaries for the full DTO. Scoped
  // by the child's (conversation_id, agent_id, tenant_id) so a different agent
  // sharing the conversation cannot walk this condensed edge (WR-02).
  const selectSummaryChildren = db.prepare(`
    SELECT s.* FROM lcd_summaries s
    JOIN lcd_summary_parents p ON p.child_summary_id = s.summary_id
    WHERE p.parent_summary_id = ? AND s.conversation_id = ? AND s.agent_id = ? AND s.tenant_id = ?
    ORDER BY s.created_at, s.summary_id
  `);

  // The message ids a LEAF summary covers (lcd_summary_messages leaf→message
  // edge), seq-ordered via the join to lcd_messages. The summary is scoped by
  // (conversation_id, agent_id, tenant_id) through the JOIN (the messages carry
  // the scope columns) — a different agent cannot reach another agent's covered
  // ids within the shared conversation (WR-02).
  const selectSummaryMessageIds = db.prepare(`
    SELECT sm.message_id AS message_id
    FROM lcd_summary_messages sm
    JOIN lcd_messages m ON m.id = sm.message_id
    WHERE sm.summary_id = ? AND m.conversation_id = ? AND m.agent_id = ? AND m.tenant_id = ?
    ORDER BY m.seq
  `);

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

  // The covered run [start,end] (inclusive), ordinal-ascending — used to gather
  // the message refIds the new summary links + to count descendants. R4: the
  // model-facing view is per (conversation, agent, tenant), so the range ops are
  // agent-scoped — a leaf/condense pass must touch ONLY the acting agent's view
  // (the UNIQUE index is now (conversation_id, agent_id, tenant_id, ordinal)).
  const selectCtxItemsInRange = db.prepare(
    "SELECT * FROM lcd_context_items WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ? AND ordinal >= ? AND ordinal <= ? ORDER BY ordinal",
  );

  const deleteCtxItemsInRange = db.prepare(
    "DELETE FROM lcd_context_items WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ? AND ordinal >= ? AND ordinal <= ?",
  );

  // The ordinals strictly above the replaced range, ascending — shifted DOWN
  // one row at a time (smallest source first → smallest, already-vacated target
  // first) so the UNIQUE (conversation_id, agent_id, tenant_id, ordinal) index
  // never sees a transient duplicate (the delete above vacated the [start,end]
  // slots). Agent-scoped (R4) so the shift stays within the acting agent's view.
  const selectCtxOrdinalsAbove = db.prepare(
    "SELECT ordinal FROM lcd_context_items WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ? AND ordinal > ? ORDER BY ordinal",
  );

  const updateCtxItemOrdinal = db.prepare(
    "UPDATE lcd_context_items SET ordinal = ? WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ? AND ordinal = ?",
  );

  const countCtxItems = db.prepare(
    "SELECT COUNT(*) AS c FROM lcd_context_items WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?",
  );

  // EFF-01: bounded total-message COUNT for the assembler's `persistedMsgCount` —
  // a single integer, NO row materialization, so it keeps the O(referenced-ids)
  // read budget (never an O(total-history) row fetch). R4: scoped by agent_id +
  // tenant_id (WR-02). The count read goes through ctxCountRowMapper, not a raw
  // count cast (§6.8 untyped-sqlite) — same { c } shape as countCtxItems.
  const countMsgs = db.prepare(
    "SELECT COUNT(*) AS c FROM lcd_messages WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?",
  );

  // CRIT-2: the highest ordinal currently in the (conversation, agent, tenant)
  // view — the per-append insert lands at MAX(ordinal)+1 (0 for the first row).
  // `MAX` over zero rows is SQL NULL (the nullable mapper handles it). R4: scoped
  // by agent_id+tenant_id so each agent keeps its OWN dense 0..N-1 sequence.
  const selectMaxCtxOrdinal = db.prepare(
    "SELECT MAX(ordinal) AS maxOrdinal FROM lcd_context_items WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?",
  );

  // CRIT-2 incremental backfill: the seq-ordered (id, created_at) of THIS agent's
  // messages NOT YET represented in the model-facing view — neither a context_items
  // message-ref NOR a leaf/condensed summary_messages link. A message is
  // "represented" once it has a ref OR was collapsed into a summary, so this returns
  // EMPTY for a live append-maintained conversation (every message has a ref) and
  // for a fully-summarized run (the messages are in lcd_summary_messages) — the
  // backfill is then a clean no-op. It returns the full set only for a PRE-EXISTING
  // (legacy) conversation whose messages predate the per-append insert (zero refs,
  // zero summaries). R4: agent-scoped throughout (WR-02).
  const selectUnseededMsgs = db.prepare(`
    SELECT m.id AS id, m.created_at AS created_at
    FROM lcd_messages m
    WHERE m.conversation_id = ? AND m.agent_id = ? AND m.tenant_id = ?
      AND m.id NOT IN (
        SELECT ci.ref_id FROM lcd_context_items ci
        WHERE ci.conversation_id = ? AND ci.agent_id = ? AND ci.tenant_id = ?
          AND ci.ref_kind = 'message'
      )
      AND m.id NOT IN (
        SELECT sm.message_id FROM lcd_summary_messages sm
        JOIN lcd_summaries s ON s.summary_id = sm.summary_id
        WHERE s.conversation_id = ? AND s.agent_id = ? AND s.tenant_id = ?
      )
    ORDER BY m.seq
  `);

  // ── Phase 164 (RR1): durable ingest cursor ──────────────────────────────────
  // Two prepared statements: an upsert (INSERT … ON CONFLICT DO UPDATE) and a
  // point-select for the two cursor fields. Static SQL, bound params, no
  // interpolated identifiers (T-127-09). The primary key is the three-column R4
  // isolation scope (conversation_id, agent_id, tenant_id) — identical to every
  // other lcd_* table so a cross-tenant/cross-agent wipe is impossible (T-164-01).
  const upsertCursorStmt = db.prepare(
    "INSERT INTO lcd_ingest_cursor (conversation_id, agent_id, tenant_id, epoch_anchor, ingested_live_len, updated_at)" +
    " VALUES (?,?,?,?,?,?)" +
    " ON CONFLICT(conversation_id,agent_id,tenant_id)" +
    " DO UPDATE SET epoch_anchor=excluded.epoch_anchor, ingested_live_len=excluded.ingested_live_len, updated_at=excluded.updated_at",
  );

  const selectCursorStmt = db.prepare(
    "SELECT epoch_anchor, ingested_live_len FROM lcd_ingest_cursor WHERE conversation_id=? AND agent_id=? AND tenant_id=?",
  );

  // ── Phase 164 (RR4): deleteConversationLcd transaction ──────────────────────
  // Deletes ALL lcd_* rows for a (conversation, agent, tenant) scope in FK-safe
  // dependency order. The RESTRICT FK on lcd_summary_messages.message_id →
  // lcd_messages.id REQUIRES deleting lcd_summary_messages rows BEFORE
  // lcd_messages rows (verified: schema-lcd.ts:138). lcd_message_parts rows are
  // removed automatically by the ON DELETE CASCADE on message_id. The
  // lcd_messages_fts contentless shadow rows are orphaned (FTS5 contentless tables
  // degrade gracefully — no FK; documented tradeoff). Never throws; returns the
  // count of lcd_messages rows deleted (0 for an empty/nonexistent conversation).
  const deleteConversationLcdTxn = db.transaction((scope: ContextStoreScope): number => {
    // 1. lcd_summary_messages: RESTRICT FK on message_id — must delete BEFORE lcd_messages.
    db.prepare(
      "DELETE FROM lcd_summary_messages WHERE summary_id IN" +
      " (SELECT summary_id FROM lcd_summaries WHERE conversation_id=? AND agent_id=? AND tenant_id=?)",
    ).run(scope.conversationId, scope.agentId, scope.tenantId);
    // 2. lcd_summary_parents: CASCADE FK on parent_summary_id — safe to delete before/after lcd_summaries.
    db.prepare(
      "DELETE FROM lcd_summary_parents WHERE parent_summary_id IN" +
      " (SELECT summary_id FROM lcd_summaries WHERE conversation_id=? AND agent_id=? AND tenant_id=?)",
    ).run(scope.conversationId, scope.agentId, scope.tenantId);
    // 3. lcd_context_items (no FK dependency on messages/summaries order).
    db.prepare(
      "DELETE FROM lcd_context_items WHERE conversation_id=? AND agent_id=? AND tenant_id=?",
    ).run(scope.conversationId, scope.agentId, scope.tenantId);
    // 4. lcd_summaries: after lcd_summary_messages + lcd_summary_parents rows are gone.
    db.prepare(
      "DELETE FROM lcd_summaries WHERE conversation_id=? AND agent_id=? AND tenant_id=?",
    ).run(scope.conversationId, scope.agentId, scope.tenantId);
    // 5. lcd_messages: CASCADE deletes lcd_message_parts rows (ON DELETE CASCADE on message_id).
    const info = db.prepare(
      "DELETE FROM lcd_messages WHERE conversation_id=? AND agent_id=? AND tenant_id=?",
    ).run(scope.conversationId, scope.agentId, scope.tenantId);
    // 6. lcd_ingest_cursor: clear the durable epoch cursor for this scope.
    db.prepare(
      "DELETE FROM lcd_ingest_cursor WHERE conversation_id=? AND agent_id=? AND tenant_id=?",
    ).run(scope.conversationId, scope.agentId, scope.tenantId);
    return info.changes as number;
  });

  /**
   * Idempotent INCREMENTAL backfill of the model-facing view from lcd_messages
   * (CRIT-2). The view is maintained live by `appendTxn` (one message-ref per
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
   * current max. R4 (132-03): every read/write below is agent-scoped, so two
   * agents sharing a conversation_id each backfill a DENSE view over their OWN
   * uncovered messages (the UNIQUE index keys on all three scope columns). Caller
   * runs this inside a txn. Skips silently when the agent has nothing to seed.
   */
  function seedContextItems(scope: ContextStoreScope): void {
    const maxRow = ctxMaxOrdinalRowMapper.parseOptionalRow(
      selectMaxCtxOrdinal.get(scope.conversationId, scope.agentId, scope.tenantId),
    );
    // The next dense ordinal: continue past the current max (NULL/absent → -1 → 0).
    let ordinal = (maxRow.ok && maxRow.value ? maxRow.value.maxOrdinal ?? -1 : -1) + 1;
    for (const rawMsg of selectUnseededMsgs.all(
      scope.conversationId,
      scope.agentId,
      scope.tenantId,
      scope.conversationId,
      scope.agentId,
      scope.tenantId,
      scope.conversationId,
      scope.agentId,
      scope.tenantId,
    )) {
      const parsed = messageSeedRowMapper.parseOptionalRow(rawMsg);
      if (!parsed.ok || !parsed.value) continue; // skip only the bad message row (WR-02)
      insertCtxItem.run(
        randomUUID(),
        scope.conversationId,
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
  // stays under the 800-line cap with headroom for the R4 read-filter edits.
  // The prepared statements + mappers + seed helper are passed in so the
  // "prepare once" discipline is preserved — the closures are byte-identical
  // relocations (NO SQL/column/ordering/error-handling change). The condensed
  // txn's WR-02 tamper-guard throw (the rollback mechanism) lives there now.
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
  };
  const appendLeafSummaryTxn = buildAppendLeafSummaryTxn(db, summaryWriteDeps);
  const appendCondensedSummaryTxn = buildAppendCondensedSummaryTxn(db, summaryWriteDeps);

  // R3 (132-04): the per-conversation single-flight serializer the store
  // exposes via runOnConversation. The store is the single writer BOTH the live
  // ingest and the deferred (C4) compaction flow through, so the per-conversation
  // queue naturally sits at the store boundary. Infra-free (it only orders fns —
  // no logging, no SQL); the agent reaches it through the port method.
  const ingestSerializer = createIngestSerializer();

  // One atomic write: the message row + its N part rows commit together (F1).
  const appendTxn = db.transaction((input: AppendMessageInput) => {
    const messageId = randomUUID();
    insertMsg.run(
      messageId,
      input.scope.conversationId,
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

    // CRIT-2: maintain the dense model-facing view INCREMENTALLY — insert ONE
    // message-ref lcd_context_items row at the next ordinal for this message's
    // (conversation, agent, tenant) scope, inside the SAME txn so the message and
    // its context-item commit atomically. This keeps context_items a true 1:1 view
    // that grows with appends (the seed-once read-time guard used to freeze it at
    // the first read while lcd_messages kept growing — DAG-CRIT-2). The new row
    // stamps the SAME scope columns as the message row, so two agents sharing a
    // conversation_id each keep their own dense 0..N-1 view (the UNIQUE index keys
    // on conversation_id+agent_id+tenant_id+ordinal — WR-02). `MAX(ordinal)` over
    // zero rows is NULL → nextOrdinal 0 for the first message.
    const maxRow = ctxMaxOrdinalRowMapper.parseOptionalRow(
      selectMaxCtxOrdinal.get(input.scope.conversationId, input.scope.agentId, input.scope.tenantId),
    );
    const nextOrdinal = (maxRow.ok && maxRow.value ? maxRow.value.maxOrdinal ?? -1 : -1) + 1;
    insertCtxItem.run(
      randomUUID(),
      input.scope.conversationId,
      input.scope.tenantId,
      input.scope.agentId,
      input.scope.sessionKey,
      nextOrdinal,
      "message" satisfies LcdRefKind,
      messageId,
    );

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
            renderMessageFtsText(input.parts),
            input.scope.conversationId,
            input.scope.agentId, // R4: agent_id UNINDEXED so the FTS MATCH filters by agent (WR-02)
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
  });

  return {
    append(input: AppendMessageInput): void {
      appendTxn(input);
    },

    getMessages(scope: ContextStoreScope): LcdMessage[] {
      // WR-02: degrade PER ROW, not per result-set. `parseRows` returns err on
      // the first bad row and discards every already-validated row — so one
      // corrupt PART row would null a whole message body (orphaning a
      // downstream tool_result -> provider rejection) and one corrupt MESSAGE
      // row would drop the whole conversation. Validate each row with
      // `parseOptionalRow` and skip ONLY the bad row, keeping its good
      // siblings — the same graceful-degrade granularity `parseMetadata` uses
      // per field. Ordering is preserved (we iterate the ORDER BY result in
      // order). The skip is silent by design: the memory package has no
      // infra-logging dependency (AGENTS.md §2.4 forbids importing getLogger
      // directly); the boundary observability line lands in Phase 128 with the
      // injected-logger write path. A schema-violating row is unreachable via
      // the typed `append` — it requires on-disk corruption / schema drift.
      const out: LcdMessage[] = [];

      for (const rawMsg of selectMsgs.all(scope.conversationId, scope.agentId, scope.tenantId)) {
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

    appendLeafSummary(input: AppendSummaryInput): string {
      return appendLeafSummaryTxn(input);
    },

    appendCondensedSummary(input: AppendCondensedSummaryInput): string {
      return appendCondensedSummaryTxn(input);
    },

    getContextItems(scope: ContextStoreScope): LcdContextItem[] {
      // The view is maintained live by appendTxn (CRIT-2), so a live conversation
      // already has its rows here and this gate is a no-op. It still fires for a
      // PRE-EXISTING (legacy) conversation whose messages predate the per-append
      // insert (zero rows) → one incremental backfill in its own txn so the SELECT
      // below sees the inserted rows; thereafter append keeps it current. Gating on
      // `== 0` avoids taking a write transaction on every read of a maintained view.
      // R4: the count gate + seed are agent-scoped, so each agent gets a dense view
      // over its OWN messages within a shared conversation (WR-02). The count read
      // goes through ctxCountRowMapper, not a raw count cast (§6.8 untyped-sqlite).
      const countRow = ctxCountRowMapper.parseOptionalRow(
        countCtxItems.get(scope.conversationId, scope.agentId, scope.tenantId),
      );
      if (countRow.ok && countRow.value && countRow.value.c === 0) {
        seedTxn(scope);
      }

      // WR-02: degrade PER ROW, not per result-set — a corrupt/ drifted
      // context_items row is skipped, its siblings survive (NEVER `parseRows`,
      // which would discard every already-validated row). Ordering is preserved
      // (we iterate the ORDER BY ordinal result in order). The skip is silent by
      // design: the memory package has no infra-logging dependency (AGENTS.md
      // §2.4); the boundary observability line is agent-side (Plan 05).
      const out: LcdContextItem[] = [];
      for (const raw of selectCtxItems.all(scope.conversationId, scope.agentId, scope.tenantId)) {
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
      // WR-02: degrade PER ROW, not per result-set — a corrupt/drifted summary
      // row is skipped, its siblings survive (NEVER `parseRows`, which would
      // discard every already-validated row). The skip is silent by design (the
      // memory package has no infra-logging dependency, AGENTS.md §2.4); the
      // boundary observability line is agent-side (the assembler, Plan 05). The
      // store NEVER logs the summary `content` (lossless store; T-129-10). R4:
      // scoped by agent_id + tenant_id (WR-02).
      const out: LcdSummary[] = [];
      for (const raw of selectSummaries.all(scope.conversationId, scope.agentId, scope.tenantId)) {
        const parsed = summaryRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
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

    getMessagesByIds(scope: ContextStoreScope, ids: string[]): LcdMessage[] {
      // EFF-01: bounded fetch — short-circuit immediately on empty set so zero
      // DB queries are issued (the IN() SQL with zero placeholders is also an
      // error in most SQLite builds, making the guard doubly necessary).
      if (ids.length === 0) return [];
      // Variable-length IN — built at call time (NOT a cached prepare).
      // Documented deviation from the prepare-once rule: the working set is
      // bounded by context_items cardinality (max ~100 items per turn), so the
      // extra statement-prepare cost is negligible and avoids a placeholder-count
      // mismatch at the boundary. T-170-01-01: ids are always bound as '?'
      // parameters — never string-interpolated — so SQL injection is structurally
      // impossible. T-170-01-02: the three-column R4 scope triple
      // (conversation_id, agent_id, tenant_id) is always present so a cross-agent
      // id lookup returns [] (EFF-01-S-4).
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
      // EFF-01: single-integer COUNT — no row materialization, so it preserves the
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
      // EFF-01: bounded fetch — short-circuit on empty set (zero DB queries).
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

    getSummaryChildren(scope: ContextStoreScope, parentSummaryId: string): LcdSummary[] {
      // E1 region walk: the immediate child summaries of a condensed summary
      // (lcd_summary_parents condensed→child edge). Same map-to-DTO discipline as
      // getSummaries — reuse summaryRowMapper, per-row parseOptionalRow +
      // skip-bad-row (NEVER parseRows — WR-02). R4: scoped by (conversation_id,
      // agent_id, tenant_id) in the JOIN's WHERE (a wrong/stale id OR a different
      // agent → []); the store never logs content.
      const out: LcdSummary[] = [];
      for (const raw of selectSummaryChildren.all(parentSummaryId, scope.conversationId, scope.agentId, scope.tenantId)) {
        const parsed = summaryRowMapper.parseOptionalRow(raw);
        if (!parsed.ok || !parsed.value) continue; // skip only the bad row
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

    getSummaryMessages(scope: ContextStoreScope, summaryId: string): string[] {
      // E1 region walk: the message ids a LEAF summary covers (lcd_summary_messages
      // leaf→message edge), seq-ordered. Per-row parseOptionalRow + skip-bad-row
      // (NEVER parseRows — WR-02). R4: scoped by (conversation_id, agent_id,
      // tenant_id) via the JOIN; unknown summaryId OR a different agent → [].
      const out: string[] = [];
      for (const raw of selectSummaryMessageIds.all(summaryId, scope.conversationId, scope.agentId, scope.tenantId)) {
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
    ): LcdSearchHit[] {
      // E1 search: delegate the FTS5-MATCH-with-LIKE-fallback branch to lcd-fts.ts
      // (the extract that keeps this file under the 800-line cap). The `query`
      // arrives pre-sanitized (the tool sanitizes — the cut bars memory from the
      // skills sanitizer). R4: scoped by (conversation_id, agent_id) — BOTH the
      // FTS MATCH path AND the LIKE fallback filter agent_id (WR-02, Pitfall 3);
      // the conversation_id prefix carries the tenant boundary. Never throws.
      return searchLcdImpl(db, scope.conversationId, scope.agentId, query, opts);
    },

    runOnConversation<T>(conversationId: string, fn: () => T | Promise<T>): Promise<T> {
      // R3 (132-04): serialize the live ingest write and the deferred (C4)
      // compaction write per conversation so they cannot interleave on the
      // (conversation_id, agent_id, tenant_id, seq) unique index / context_items
      // ordinals (Pitfall 2). Different conversations run concurrently (the
      // queue is per-conversation). The store does not log here — observability
      // is agent-side (Plan 132-04 Task 3).
      return ingestSerializer.runOnConversation(conversationId, fn);
    },

    // ── Phase 164 (RR1): durable ingest cursor ──────────────────────────────

    getIngestCursor(scope: ContextStoreScope): { epochAnchor: string; ingestedLiveLen: number } | null {
      // Point-select the cursor row for this (conversation, agent, tenant) scope.
      // Returns null when no row exists (new conversation or first run after upgrade).
      // Per-row parseOptionalRow + skip on validation failure (never throws — WR-02).
      const row = selectCursorStmt.get(scope.conversationId, scope.agentId, scope.tenantId);
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
        scope.conversationId,
        scope.agentId,
        scope.tenantId,
        cursor.epochAnchor,
        cursor.ingestedLiveLen,
        updatedAt,
      );
    },

    // ── Phase 164 (RR4): explicit LCD reset ─────────────────────────────────

    deleteConversationLcd(scope: ContextStoreScope): number {
      // Delegate to the db.transaction that deletes in FK-safe dependency order.
      // Must be called inside runOnConversation so it serializes against live ingest.
      // Returns the count of lcd_messages rows deleted (0 for an empty scope).
      return deleteConversationLcdTxn(scope);
    },
  };
}
