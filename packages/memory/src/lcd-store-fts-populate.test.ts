// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for createFtsPopulator — the index-write half of the FTS search
 * path. These pin the populator's three contracts directly (the lcd-store.test.ts
 * suite covers the wired end-to-end behavior; here we test the helper in
 * isolation against hand-built tables):
 *   1. NORMALIZATION applied — a twin row stores normalizeForSearch(content), so a
 *      folded query token matches and the RAW (un-folded) token does NOT (the
 *      index side — the discriminator that proves the fold ran at write time).
 *   2. NULL-handle no-op — on a host WITHOUT the trigram twins, the guarded prep
 *      sets the twin handles null and the twin methods are clean no-ops (no throw).
 *   3. Scope columns — the twin row carries the conversation_id + agent_id
 *      passed in the scope (the MATCH filters on them; a wrong scope finds nothing).
 *
 * Hebrew fixtures are codepoint-built (String.fromCodePoint — never literal
 * glyphs). "הספרים" normalizes to "הספרימ" (final mem folds; leading he kept).
 */
import type { LcdMessagePart } from "@comis/core";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { ensureLcdTables } from "./schema-lcd.js";
import { createFtsPopulator } from "./lcd-store-fts-populate.js";

// ── Hebrew fixtures (codepoint-built) ───────────────────────────────────────
/** "הספרים" — he+samekh+pe+resh+yod+FINAL-mem (raw stored text). */
const HE_HASFARIM_RAW = String.fromCodePoint(0x05d4, 0x05e1, 0x05e4, 0x05e8, 0x05d9, 0x05dd);
/** "ספרימ" — samekh+pe+resh+yod+REGULAR-mem: the FOLDED query token (substring of "הספרימ"). */
const HE_SFARIM_FOLDED = String.fromCodePoint(0x05e1, 0x05e4, 0x05e8, 0x05d9, 0x05de);
/** "ספרים" — samekh+pe+resh+yod+FINAL-mem: the RAW (un-folded) token (NOT a substring of "הספרימ"). */
const HE_SFARIM_RAW = String.fromCodePoint(0x05e1, 0x05e4, 0x05e8, 0x05d9, 0x05dd);
const DQUOTE = String.fromCodePoint(0x22);
const quoted = (t: string): string => DQUOTE + t + DQUOTE;

/** A single text part carrying `text` (the renderMessageFtsText source surface). */
function textParts(text: string): LcdMessagePart[] {
  return [{ kind: "text", metadata: { raw: { type: "text", text }, rawType: "text" } }];
}

/** Seed a minimal lcd_messages row at rowid via the base id, return its id. */
function seedMessage(db: Database.Database, id: string, conversationId: string, agentId: string): void {
  db.prepare(
    `INSERT INTO lcd_messages (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at)
     VALUES (?, ?, 't', ?, 's', 0, 'user', 1, 1000)`,
  ).run(id, conversationId, agentId);
}

/** Seed a minimal lcd_summaries row, return its summary_id. */
function seedSummary(db: Database.Database, summaryId: string, conversationId: string, agentId: string, content: string): void {
  db.prepare(
    `INSERT INTO lcd_summaries
       (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
        earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
     VALUES (?, ?, 't', ?, 's', 'leaf', 0, 1, 1, 0, 1, ?, '[]', 0, 0, 1)`,
  ).run(summaryId, conversationId, agentId, content);
}

function triMatch(db: Database.Database, table: string, matchExpr: string, conversationId: string, agentId: string): unknown[] {
  return db
    .prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? AND conversation_id = ? AND agent_id = ?`)
    .all(matchExpr, conversationId, agentId);
}

describe("createFtsPopulator — normalized trigram twin inserts", () => {
  let db: Database.Database;

  beforeEach(() => {
    // Full LCD schema incl. the trigram twins (ensureLcdTables wires
    // ensureTrigramTwins as its last statement). lcd_summaries is external-content
    // FTS-backed, so its INSERT trigger fires — harmless for the twin assertions.
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // Base tables the populator + summary FTS depend on: a memories stub (the
    // provenance FK target) then the LCD tables.
    db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY);");
    ensureLcdTables(db);
  });

  it("populateMessageTri stores the FOLDED content so a folded MATCH hits and the RAW token does not", () => {
    seedMessage(db, "m1", "conv", "agent");
    const pop = createFtsPopulator(db);
    pop.populateMessageTri("m1", textParts(HE_HASFARIM_RAW), { conversationId: "conv", agentId: "agent" });

    // The folded query token is a substring of the normalized store "הספרימ".
    expect(triMatch(db, "lcd_messages_fts_tri", quoted(HE_SFARIM_FOLDED), "conv", "agent").length).toBeGreaterThan(0);
    // The RAW final-mem token is NOT — proving the stored content was folded.
    expect(triMatch(db, "lcd_messages_fts_tri", quoted(HE_SFARIM_RAW), "conv", "agent")).toHaveLength(0);
  });

  it("insertSummaryTri stores the FOLDED summary content (folded MATCH hits, raw does not)", () => {
    seedSummary(db, "sum1", "conv", "agent", HE_HASFARIM_RAW);
    const pop = createFtsPopulator(db);
    pop.insertSummaryTri("sum1", HE_HASFARIM_RAW, { conversationId: "conv", agentId: "agent" });

    expect(triMatch(db, "lcd_summaries_fts_tri", quoted(HE_SFARIM_FOLDED), "conv", "agent").length).toBeGreaterThan(0);
    expect(triMatch(db, "lcd_summaries_fts_tri", quoted(HE_SFARIM_RAW), "conv", "agent")).toHaveLength(0);
  });

  it("the twin row carries the conversation_id + agent_id from the scope (a different agent's MATCH finds nothing)", () => {
    seedMessage(db, "m1", "conv", "agent-a");
    const pop = createFtsPopulator(db);
    pop.populateMessageTri("m1", textParts(HE_HASFARIM_RAW), { conversationId: "conv", agentId: "agent-a" });

    // The writing agent finds it; a different agent (same conversation) does not —
    // the insert stamped agent_id from the scope, and the MATCH filters on it.
    expect(triMatch(db, "lcd_messages_fts_tri", quoted(HE_SFARIM_FOLDED), "conv", "agent-a").length).toBeGreaterThan(0);
    expect(triMatch(db, "lcd_messages_fts_tri", quoted(HE_SFARIM_FOLDED), "conv", "agent-b")).toHaveLength(0);
  });

  it("populateMessageTri at the base rowid keeps the twin row joinable to lcd_messages", () => {
    seedMessage(db, "m1", "conv", "agent");
    const baseRowid = (db.prepare("SELECT rowid FROM lcd_messages WHERE id = 'm1'").get() as { rowid: number }).rowid;
    const pop = createFtsPopulator(db);
    pop.populateMessageTri("m1", textParts(HE_HASFARIM_RAW), { conversationId: "conv", agentId: "agent" });

    const twinRow = db
      .prepare("SELECT rowid FROM lcd_messages_fts_tri WHERE conversation_id = 'conv' AND agent_id = 'agent'")
      .get() as { rowid: number } | undefined;
    expect(twinRow).toBeDefined();
    expect(twinRow!.rowid).toBe(baseRowid);
  });
});

describe("createFtsPopulator — null-handle no-op on a trigram-less host", () => {
  let noTri: Database.Database;

  beforeEach(() => {
    // Base LCD tables + the WORD-lane FTS but NO trigram twins (the
    // trigram-tokenizer-absent host shape). The guarded prep in createFtsPopulator
    // must catch the "no such table: lcd_messages_fts_tri" and set null handles.
    noTri = new Database(":memory:");
    noTri.pragma("foreign_keys = ON");
    noTri.exec(`
      CREATE TABLE lcd_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_key TEXT NOT NULL, seq INTEGER NOT NULL,
        role TEXT NOT NULL, token_count INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE lcd_summaries (
        summary_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_key TEXT NOT NULL, kind TEXT NOT NULL, depth INTEGER NOT NULL,
        earliest_at INTEGER NOT NULL, latest_at INTEGER NOT NULL, descendant_count INTEGER NOT NULL,
        token_count INTEGER NOT NULL, content TEXT NOT NULL, file_ids TEXT NOT NULL DEFAULT '[]',
        taint INTEGER NOT NULL DEFAULT 0, fallback INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE lcd_messages_fts USING fts5(
        content, conversation_id UNINDEXED, agent_id UNINDEXED, message_id UNINDEXED, tokenize='porter unicode61'
      );
    `);
  });

  it("createFtsPopulator does not throw when the trigram twins are absent (guarded prep)", () => {
    expect(() => createFtsPopulator(noTri)).not.toThrow();
  });

  it("populateMessageTri / insertSummaryTri are clean no-ops on a trigram-less host (null handles)", () => {
    seedMessage(noTri, "m1", "conv", "agent");
    seedSummary(noTri, "sum1", "conv", "agent", HE_HASFARIM_RAW);
    const pop = createFtsPopulator(noTri);
    // Neither call throws (the twin handles are null → early return).
    expect(() => pop.populateMessageTri("m1", textParts(HE_HASFARIM_RAW), { conversationId: "conv", agentId: "agent" })).not.toThrow();
    expect(() => pop.insertSummaryTri("sum1", HE_HASFARIM_RAW, { conversationId: "conv", agentId: "agent" })).not.toThrow();
    // The twin tables genuinely do not exist on this host.
    const triExists = noTri
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcd_messages_fts_tri'")
      .get();
    expect(triExists).toBeUndefined();
  });
});

describe("createFtsPopulator — per-twin prep independence on a partial-schema host", () => {
  let partial: Database.Database;

  beforeEach(() => {
    // The PARTIAL-schema host this guards: the MESSAGE twin exists (its
    // ensureTrigramTwins block succeeded) but the SUMMARY twin does NOT (its block
    // failed — base tables diverged, a hand-edited dev db, or the summaries CREATE
    // threw while the messages one succeeded). schema-trigram.ts creates each twin
    // in its OWN per-block try/catch, so this state is genuinely reachable.
    partial = new Database(":memory:");
    partial.pragma("foreign_keys = ON");
    partial.exec(`
      CREATE TABLE lcd_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_key TEXT NOT NULL, seq INTEGER NOT NULL,
        role TEXT NOT NULL, token_count INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE lcd_summaries (
        summary_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_key TEXT NOT NULL, kind TEXT NOT NULL, depth INTEGER NOT NULL,
        earliest_at INTEGER NOT NULL, latest_at INTEGER NOT NULL, descendant_count INTEGER NOT NULL,
        token_count INTEGER NOT NULL, content TEXT NOT NULL, file_ids TEXT NOT NULL DEFAULT '[]',
        taint INTEGER NOT NULL DEFAULT 0, fallback INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      -- The WORD-lane FTS exists (its section runs before ensureTrigramTwins, so a
      -- host that got as far as creating the message TWIN necessarily has it).
      CREATE VIRTUAL TABLE lcd_messages_fts USING fts5(
        content, conversation_id UNINDEXED, agent_id UNINDEXED, message_id UNINDEXED, tokenize='porter unicode61'
      );
      -- The MESSAGE twin is present (its DDL block succeeded) …
      CREATE VIRTUAL TABLE lcd_messages_fts_tri USING fts5(
        content, conversation_id UNINDEXED, agent_id UNINDEXED, message_id UNINDEXED, tokenize='trigram'
      );
      -- … but the SUMMARY twin is deliberately ABSENT (its block failed).
    `);
  });

  it("populateMessageTri still indexes into the PRESENT message twin even though the summary twin is absent", () => {
    // The defect: createFtsPopulator prepped all three twin statements in ONE
    // try/catch, so the absent-summary-twin prep threw and nulled ALL handles —
    // silently de-activating the message-twin write path even though
    // lcd_messages_fts_tri exists and searchTrigram reads it (a silent search
    // degrade with no signal). Per-twin prep must keep the message twin live.
    seedMessage(partial, "m1", "conv", "agent");
    const pop = createFtsPopulator(partial);
    pop.populateMessageTri("m1", textParts(HE_HASFARIM_RAW), { conversationId: "conv", agentId: "agent" });

    // The message twin received the folded row (proves the message-twin handle was
    // NOT nulled by the absent summary-twin prep).
    expect(triMatch(partial, "lcd_messages_fts_tri", quoted(HE_SFARIM_FOLDED), "conv", "agent").length).toBeGreaterThan(0);
  });

  it("insertSummaryTri is a clean no-op when only the summary twin is absent (no throw, message twin unaffected)", () => {
    seedSummary(partial, "sum1", "conv", "agent", HE_HASFARIM_RAW);
    const pop = createFtsPopulator(partial);
    // The summary twin genuinely does not exist → insertSummaryTri early-returns.
    expect(() => pop.insertSummaryTri("sum1", HE_HASFARIM_RAW, { conversationId: "conv", agentId: "agent" })).not.toThrow();
    const summaryTriExists = partial
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcd_summaries_fts_tri'")
      .get();
    expect(summaryTriExists).toBeUndefined();
  });

  it("createFtsPopulator does not throw on the partial-schema host (guarded per-twin prep)", () => {
    expect(() => createFtsPopulator(partial)).not.toThrow();
  });
});
