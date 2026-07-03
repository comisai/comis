// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for repair-lcd.ts.
 *
 * Uses an in-memory better-sqlite3 database with the real LCD schema
 * (lcd_context_items / ref_kind, lcd_summaries / summary_id, lcd_messages)
 * to verify all repair actions.
 *
 * ABSOLUTE CONSTRAINT: lcd_messages is NEVER modified by any repair.
 * Every test suite asserts row count + content hash unchanged after repair.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import {
  repairFtsDrift,
  repairContextItems,
} from "./repair-lcd.js";

// ── Schema setup ─────────────────────────────────────────────────────────────

/**
 * Create a test DB that mirrors the REAL LCD schema:
 *  - lcd_messages_fts is SELF-CONTAINED (stores its own content; no content=
 *    clause) — matches schema-lcd.ts (the table holds its own re-rendered
 *    content rather than referencing an external content table)
 *  - lcd_summaries_fts is EXTERNAL-CONTENT (content=lcd_summaries) — matches schema-lcd.ts
 *  - lcd_message_parts holds the structured parts that repairFtsDrift reads
 *  - memories holds the LTM base rows that memory_fts_tri shadows (rowid + content)
 *
 * Pass `{ withTrigramTwins: true }` to also create the three normalized trigram
 * twins (lcd_messages_fts_tri / lcd_summaries_fts_tri / memory_fts_tri) using the
 * exact DDL the real `ensureTrigramTwins` (schema-trigram.ts) installs.
 * Omitting it leaves the twins absent — the trigram-less host shape.
 */
function createTestDb(opts: { withTrigramTwins?: boolean } = {}): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE lcd_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL DEFAULT 'conv-1',
      tenant_id       TEXT NOT NULL DEFAULT 'tenant1',
      agent_id        TEXT NOT NULL DEFAULT 'agent1',
      seq             INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE lcd_message_parts (
      id         TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES lcd_messages(id) ON DELETE CASCADE,
      ordinal    INTEGER NOT NULL DEFAULT 0,
      tool_name  TEXT,
      tool_input TEXT,
      tool_output TEXT,
      metadata   TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE lcd_summaries (
      summary_id      TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL DEFAULT 'conv-1',  -- R4 scope col the twin carries UNINDEXED (matches real schema-lcd.ts)
      fallback        INTEGER NOT NULL DEFAULT 0,
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      content         TEXT NOT NULL
    );
    CREATE TABLE lcd_context_items (
      id              TEXT PRIMARY KEY,
      ref_kind        TEXT NOT NULL CHECK (ref_kind IN ('message','summary')),
      ref_id          TEXT NOT NULL,
      conversation_id TEXT NOT NULL
    );
    CREATE TABLE memories (
      id        TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      agent_id  TEXT NOT NULL DEFAULT 'default',
      content   TEXT NOT NULL
    );
    -- SELF-CONTAINED FTS — matches real schema-lcd.ts lcd_messages_fts
    -- (no content= clause; stores its own re-rendered content via renderMessageFtsText)
    CREATE VIRTUAL TABLE lcd_messages_fts USING fts5(
      content,
      conversation_id UNINDEXED,
      agent_id UNINDEXED,
      message_id UNINDEXED
    );
    -- EXTERNAL-CONTENT FTS — matches real schema-lcd.ts lcd_summaries_fts
    -- ('rebuild' idiom works because it has an external content table)
    CREATE VIRTUAL TABLE lcd_summaries_fts USING fts5(
      content,
      content='lcd_summaries',
      content_rowid='rowid'
    );
  `);
  if (opts.withTrigramTwins) {
    createTrigramTwins(db);
  }
  return db;
}

/**
 * Create the three SELF-CONTAINED FTS5 trigram twins exactly as the real
 * `ensureTrigramTwins` (packages/memory/src/schema-trigram.ts)
 * installs them — same columns, same UNINDEXED scope columns, same trigram
 * tokenizer. The doctor twin backfill repopulates these.
 * (Inlined rather than imported because `ensureTrigramTwins` is not on the
 * @comis/memory barrel; the existing harness likewise hand-builds the word-lane
 * FTS DDL.)
 */
function createTrigramTwins(db: Db): void {
  db.exec(`
    CREATE VIRTUAL TABLE lcd_messages_fts_tri USING fts5(
      content,
      conversation_id UNINDEXED,
      agent_id UNINDEXED,
      message_id UNINDEXED,
      tokenize='trigram'
    );
    CREATE VIRTUAL TABLE lcd_summaries_fts_tri USING fts5(
      content,
      conversation_id UNINDEXED,
      agent_id UNINDEXED,
      summary_id UNINDEXED,
      tokenize='trigram'
    );
    CREATE VIRTUAL TABLE memory_fts_tri USING fts5(
      content,
      tokenize='trigram'
    );
  `);
}

/** Return a simple row-count fingerprint for asserting lcd_messages is never written by repair. */
function lcdMessagesFingerprint(db: Db): { count: number; ids: string[] } {
  const rows = db
    .prepare("SELECT id FROM lcd_messages ORDER BY id")
    .all() as Array<{ id: string }>;
  return { count: rows.length, ids: rows.map((r) => r.id) };
}

// ── repairFtsDrift tests ─────────────────────────────────────────────────────

describe("repairFtsDrift", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("repairFtsDrift repopulates contentless lcd_messages_fts and returns ok", async () => {
    // Insert a message with a part whose text will be rendered into the FTS
    db.prepare("INSERT INTO lcd_messages VALUES ('msg-1', 'conv-1', 'tenant1', 'agent1', 0)").run();
    db.prepare(
      "INSERT INTO lcd_message_parts(id, message_id, ordinal, metadata) VALUES (?, ?, 0, ?)",
    ).run("part-1", "msg-1", JSON.stringify({ raw: { text: "hello world" } }));
    const result = await repairFtsDrift(db);
    expect(result.ok).toBe(true);
    // lcd_messages_fts is CONTENTLESS — repopulate path, not 'rebuild'
    expect(result.value!.some((a) => a.includes("lcd_messages_fts"))).toBe(true);
  });

  it("repairFtsDrift uses rebuild for external-content lcd_summaries_fts", async () => {
    db.prepare(
      "INSERT INTO lcd_summaries(summary_id, fallback, tenant_id, agent_id, content) VALUES ('sum-1', 0, 'tenant1', 'agent1', 'summary text')",
    ).run();
    const result = await repairFtsDrift(db);
    expect(result.ok).toBe(true);
    expect(result.value!.some((a) => a.includes("lcd_summaries_fts"))).toBe(true);
  });

  it("repairFtsDrift contentless FTS: messages are queryable after repair", async () => {
    // Insert a message with a tool_name part
    db.prepare("INSERT INTO lcd_messages VALUES ('msg-query', 'conv-1', 'tenant1', 'agent1', 0)").run();
    db.prepare(
      "INSERT INTO lcd_message_parts(id, message_id, ordinal, tool_name, metadata) VALUES (?, ?, 0, ?, ?)",
    ).run("part-query", "msg-query", "search_tool", JSON.stringify({}));
    await repairFtsDrift(db);
    // The FTS content should now include the tool name
    const ftsRow = db
      .prepare("SELECT content, message_id FROM lcd_messages_fts WHERE message_id = ?")
      .get("msg-query") as { content: string; message_id: string } | undefined;
    expect(ftsRow).toBeDefined();
    expect(ftsRow?.content).toContain("search_tool");
  });

  it("repairFtsDrift never modifies the lcd_messages table — the raw store is read-only to repairs", async () => {
    db.prepare("INSERT INTO lcd_messages VALUES ('msg-f1', 'conv-1', 'tenant1', 'agent1', 0)").run();
    const before = lcdMessagesFingerprint(db);

    const result = await repairFtsDrift(db);

    const after = lcdMessagesFingerprint(db);
    expect(result.ok).toBe(true);
    expect(after.count).toBe(before.count);
    expect(after.ids).toEqual(before.ids);
  });

  it("repairFtsDrift returns ok with empty actions when no FTS tables exist", async () => {
    const noFtsDb = new Database(":memory:");
    noFtsDb.exec(`
      CREATE TABLE lcd_messages (id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE lcd_message_parts (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE lcd_summaries (summary_id TEXT PRIMARY KEY, content TEXT NOT NULL);
    `);
    const result = await repairFtsDrift(noFtsDb);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.value)).toBe(true);
    expect(result.value!.length).toBe(0);
    noFtsDb.close();
  });
});

// ── repairContextItems tests ─────────────────────────────────────────────────

describe("repairContextItems", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("repairContextItems removes dangling lcd_context_items refs where ref_id has no matching row", async () => {
    // Insert a dangling summary ref (no corresponding lcd_summaries row)
    db.prepare(
      "INSERT INTO lcd_context_items VALUES (?, 'summary', ?, 'conv-1')",
    ).run("ctx-1", "nonexistent-summary-id");

    const result = await repairContextItems(db);

    expect(result.ok).toBe(true);
    const remaining = db
      .prepare("SELECT COUNT(*) AS c FROM lcd_context_items")
      .get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("repairContextItems never writes lcd_messages — the raw store is read-only to repairs", async () => {
    db.prepare("INSERT INTO lcd_messages VALUES ('msg-f1', 'conv-1', 'tenant1', 'agent1', 0)").run();
    const before = lcdMessagesFingerprint(db);

    await repairContextItems(db);

    const after = lcdMessagesFingerprint(db);
    expect(after.count).toBe(before.count);
    expect(after.ids).toEqual(before.ids);
  });

  it("repairContextItems returns ok with count of removed dangling refs", async () => {
    // Insert two dangling refs with no backing rows
    db.prepare("INSERT INTO lcd_context_items VALUES (?, 'summary', ?, 'conv-1')").run(
      "ctx-dangling-1",
      "ghost-summary-1",
    );
    db.prepare("INSERT INTO lcd_context_items VALUES (?, 'message', ?, 'conv-1')").run(
      "ctx-dangling-2",
      "ghost-message-1",
    );
    const result = await repairContextItems(db);

    expect(result.ok).toBe(true);
    const joined = result.value!.join(" ");
    // At least one action string must mention a count
    expect(joined).toMatch(/\d+/);
    expect(result.value!.length).toBeGreaterThan(0);
  });

  it("repairContextItems leaves valid lcd_context_items refs untouched", async () => {
    // Valid summary ref
    db.prepare(
      "INSERT INTO lcd_summaries(summary_id, fallback, tenant_id, agent_id, content) VALUES (?, 0, 'tenant1', 'agent1', 'summary text')",
    ).run("sum-real");
    db.prepare("INSERT INTO lcd_context_items VALUES (?, 'summary', ?, 'conv-1')").run(
      "ctx-valid",
      "sum-real",
    );
    // Dangling summary ref
    db.prepare("INSERT INTO lcd_context_items VALUES (?, 'summary', ?, 'conv-1')").run(
      "ctx-dangling",
      "ghost-sum",
    );

    const result = await repairContextItems(db);

    expect(result.ok).toBe(true);
    const remaining = db
      .prepare("SELECT COUNT(*) AS c FROM lcd_context_items")
      .get() as { c: number };
    // Only the dangling one should be removed; valid ref stays
    expect(remaining.c).toBe(1);
    const validRow = db
      .prepare("SELECT id FROM lcd_context_items WHERE id='ctx-valid'")
      .get();
    expect(validRow).toBeTruthy();
  });
});

// ── repairFtsDrift: contentless-table handling ────────────────────────────────

describe("repairFtsDrift — contentless FTS guard (no 'rebuild' on self-contained tables)", () => {
  it("repairFtsDrift does NOT use rebuild on contentless lcd_messages_fts — no error thrown", async () => {
    // This is the key regression test:
    // lcd_messages_fts is CONTENTLESS in production (no content= clause).
    // Calling INSERT INTO lcd_messages_fts(lcd_messages_fts) VALUES('rebuild')
    // on a contentless table throws "content= option required".
    // repairFtsDrift must NOT use 'rebuild' on the contentless table.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE lcd_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL DEFAULT 'conv', tenant_id TEXT NOT NULL DEFAULT 't', agent_id TEXT NOT NULL DEFAULT 'a', seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE lcd_message_parts (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0, tool_name TEXT, tool_input TEXT, tool_output TEXT, metadata TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE lcd_summaries (summary_id TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE VIRTUAL TABLE lcd_messages_fts USING fts5(content, conversation_id UNINDEXED, agent_id UNINDEXED, message_id UNINDEXED);
    `);
    // Must NOT throw (a 'rebuild' on a contentless table would throw)
    const result = await repairFtsDrift(db);
    expect(result.ok).toBe(true);
    db.close();
  });

  it("repairFtsDrift repopulates contentless FTS from lcd_message_parts metadata", async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO lcd_messages VALUES ('msg-cr02', 'conv-1', 'tenant1', 'agent1', 0)").run();
    // Part with text in metadata.raw.text
    db.prepare(
      "INSERT INTO lcd_message_parts(id, message_id, ordinal, metadata) VALUES (?, ?, 0, ?)",
    ).run("part-cr02", "msg-cr02", JSON.stringify({ raw: { text: "test content for FTS" } }));

    await repairFtsDrift(db);

    // After repair, FTS row should exist for the message
    const ftsRows = db
      .prepare("SELECT message_id FROM lcd_messages_fts")
      .all() as Array<{ message_id: string }>;
    expect(ftsRows.some((r) => r.message_id === "msg-cr02")).toBe(true);
    db.close();
  });
});

// ── repairFtsDrift: normalized trigram twin backfill ─────────────────────────
//
// The doctor backfill is the designed path for pre-existing history — rows
// written before the twins' populate path indexed them.
// `repairFtsDrift` must repopulate all THREE self-contained trigram twins from
// the base rows with NORMALIZED text (`normalizeForSearch(...)`), so the repair
// output indexes EXACTLY what the populate path indexes. These cases FAIL on a
// repair that never touches the twins (they would stay empty post-repair).
//
// The Hebrew fixtures are plain string literals with no embedded ASCII `"`
// glyph inside a Hebrew acronym, so they are inlined directly.

describe("repairFtsDrift — normalized trigram twin backfill", () => {
  /** Seed one Hebrew message (rendered from a part), one summary, one memory — the
   *  un-backfilled shape: base rows present, twins EMPTY. */
  function seedHebrewBaseRows(db: Db): void {
    // lcd_messages + part — the part text is rendered via renderMessageFtsText
    db.prepare(
      "INSERT INTO lcd_messages VALUES ('msg-he', 'conv-he', 'tenant1', 'agent-a', 0)",
    ).run();
    db.prepare(
      "INSERT INTO lcd_message_parts(id, message_id, ordinal, metadata) VALUES (?, ?, 0, ?)",
    ).run("part-he", "msg-he", JSON.stringify({ raw: { text: "הספרים על המדף" } }));
    // lcd_summaries
    db.prepare(
      "INSERT INTO lcd_summaries(summary_id, conversation_id, fallback, tenant_id, agent_id, content) VALUES ('sum-he', 'conv-he', 0, 'tenant1', 'agent-a', ?)",
    ).run("הספרים סוכמו");
    // memories
    db.prepare(
      "INSERT INTO memories(id, tenant_id, agent_id, content) VALUES ('mem-he', 'tenant1', 'agent-a', ?)",
    ).run("הספרים נשמרו בזיכרון");
  }

  it("backfills all three trigram twins from base rows at the base rowid with scope columns", async () => {
    const db = createTestDb({ withTrigramTwins: true });
    seedHebrewBaseRows(db);

    const result = await repairFtsDrift(db);
    expect(result.ok).toBe(true);

    // lcd_messages_fts_tri: rendered+normalized content at the base rowid, scope copied
    const msgBase = db
      .prepare("SELECT rowid, conversation_id, agent_id, id FROM lcd_messages WHERE id='msg-he'")
      .get() as { rowid: number; conversation_id: string; agent_id: string; id: string };
    const msgTri = db
      .prepare(
        "SELECT rowid, conversation_id, agent_id, message_id FROM lcd_messages_fts_tri WHERE message_id='msg-he'",
      )
      .get() as
      | { rowid: number; conversation_id: string; agent_id: string; message_id: string }
      | undefined;
    expect(msgTri).toBeDefined();
    expect(msgTri?.rowid).toBe(msgBase.rowid);
    expect(msgTri?.conversation_id).toBe(msgBase.conversation_id);
    expect(msgTri?.agent_id).toBe(msgBase.agent_id);
    expect(msgTri?.message_id).toBe(msgBase.id);

    // lcd_summaries_fts_tri: normalized content at the base rowid, R4 scope copied
    const sumBase = db
      .prepare("SELECT rowid, conversation_id, agent_id, summary_id FROM lcd_summaries WHERE summary_id='sum-he'")
      .get() as
      | { rowid: number; conversation_id: string; agent_id: string; summary_id: string }
      | undefined;
    const sumTri = db
      .prepare(
        "SELECT rowid, conversation_id, agent_id, summary_id FROM lcd_summaries_fts_tri WHERE summary_id='sum-he'",
      )
      .get() as
      | { rowid: number; conversation_id: string; agent_id: string; summary_id: string }
      | undefined;
    expect(sumTri).toBeDefined();
    expect(sumTri?.rowid).toBe(sumBase?.rowid);
    expect(sumTri?.conversation_id).toBe("conv-he");
    expect(sumTri?.agent_id).toBe("agent-a");
    expect(sumTri?.summary_id).toBe("sum-he");

    // memory_fts_tri: normalized content at the memories rowid (rowid-only lane)
    const memBase = db
      .prepare("SELECT rowid FROM memories WHERE id='mem-he'")
      .get() as { rowid: number };
    const memTri = db
      .prepare("SELECT rowid FROM memory_fts_tri WHERE rowid=?")
      .get(memBase.rowid) as { rowid: number } | undefined;
    expect(memTri).toBeDefined();
    expect(memTri?.rowid).toBe(memBase.rowid);

    db.close();
  });

  it("feeds NORMALIZED text so a folded Hebrew query matches the backfilled twin", async () => {
    const db = createTestDb({ withTrigramTwins: true });
    seedHebrewBaseRows(db);

    await repairFtsDrift(db);

    // Stored text 'הספרים' was normalized at backfill (final mem ם → מ folds);
    // the query token 'ספרימ' (already folded) MATCHes only because the index
    // holds normalized text, not the raw 'הספרים'. This proves the doctor
    // backfill runs the same normalizer as the index and query sides.
    const msgHit = db
      .prepare(`SELECT message_id FROM lcd_messages_fts_tri WHERE lcd_messages_fts_tri MATCH '"ספרימ"'`)
      .all() as Array<{ message_id: string }>;
    expect(msgHit.some((r) => r.message_id === "msg-he")).toBe(true);

    const sumHit = db
      .prepare(`SELECT summary_id FROM lcd_summaries_fts_tri WHERE lcd_summaries_fts_tri MATCH '"ספרימ"'`)
      .all() as Array<{ summary_id: string }>;
    expect(sumHit.some((r) => r.summary_id === "sum-he")).toBe(true);

    const memHit = db
      .prepare(`SELECT rowid FROM memory_fts_tri WHERE memory_fts_tri MATCH '"ספרימ"'`)
      .all() as Array<{ rowid: number }>;
    expect(memHit.length).toBeGreaterThan(0);

    db.close();
  });

  it("leaves the word-lane repair behavior unchanged (lcd_messages_fts + lcd_summaries_fts still repopulated)", async () => {
    const db = createTestDb({ withTrigramTwins: true });
    db.prepare("INSERT INTO lcd_messages VALUES ('msg-w', 'conv-1', 'tenant1', 'agent1', 0)").run();
    db.prepare(
      "INSERT INTO lcd_message_parts(id, message_id, ordinal, tool_name, metadata) VALUES (?, ?, 0, ?, ?)",
    ).run("part-w", "msg-w", "search_tool", JSON.stringify({ raw: { text: "hello world" } }));
    db.prepare(
      "INSERT INTO lcd_summaries(summary_id, fallback, tenant_id, agent_id, content) VALUES ('sum-w', 0, 'tenant1', 'agent1', 'word lane summary')",
    ).run();

    const result = await repairFtsDrift(db);
    expect(result.ok).toBe(true);

    // Word lane lcd_messages_fts: re-rendered, contains the tool name (existing behavior)
    const wordMsg = db
      .prepare("SELECT content FROM lcd_messages_fts WHERE message_id='msg-w'")
      .get() as { content: string } | undefined;
    expect(wordMsg?.content).toContain("search_tool");

    // Word lane lcd_summaries_fts: rebuilt, the summary is matchable (existing behavior)
    const wordSum = db
      .prepare(`SELECT rowid FROM lcd_summaries_fts WHERE lcd_summaries_fts MATCH 'word'`)
      .all() as Array<{ rowid: number }>;
    expect(wordSum.length).toBeGreaterThan(0);

    // Both word-lane action strings still present
    const joined = result.value!.join(" ");
    expect(joined).toContain("lcd_messages_fts");
    expect(joined).toContain("lcd_summaries_fts");

    db.close();
  });

  it("skips twin backfill gracefully on a trigram-less host (no twins → no twin actions, no error)", async () => {
    // No withTrigramTwins → the three twins are absent (the trigram-less host shape)
    const db = createTestDb();
    db.prepare("INSERT INTO lcd_messages VALUES ('msg-nt', 'conv-1', 'tenant1', 'agent1', 0)").run();
    db.prepare(
      "INSERT INTO lcd_message_parts(id, message_id, ordinal, metadata) VALUES (?, ?, 0, ?)",
    ).run("part-nt", "msg-nt", JSON.stringify({ raw: { text: "hello" } }));
    db.prepare(
      "INSERT INTO lcd_summaries(summary_id, fallback, tenant_id, agent_id, content) VALUES ('sum-nt', 0, 'tenant1', 'agent1', 'summary')",
    ).run();

    const result = await repairFtsDrift(db);
    expect(result.ok).toBe(true);

    // Existing word-lane actions intact; NO twin action lines
    const joined = result.value!.join(" ");
    expect(joined).toContain("lcd_messages_fts");
    expect(joined).toContain("lcd_summaries_fts");
    expect(joined).not.toContain("fts_tri");

    db.close();
  });

  it("returns a human-readable, counts-only action line for each backfilled twin", async () => {
    const db = createTestDb({ withTrigramTwins: true });
    seedHebrewBaseRows(db);

    const result = await repairFtsDrift(db);
    expect(result.ok).toBe(true);

    const actions = result.value!;
    expect(actions.some((a) => a.includes("lcd_messages_fts_tri"))).toBe(true);
    expect(actions.some((a) => a.includes("lcd_summaries_fts_tri"))).toBe(true);
    expect(actions.some((a) => a.includes("memory_fts_tri"))).toBe(true);
    // Counts only, never indexed text: the Hebrew content must not
    // appear in any action string.
    const joined = actions.join(" ");
    expect(joined).not.toContain("הספרים");
    // Each twin line carries a numeric count
    const triLines = actions.filter((a) => a.includes("fts_tri"));
    for (const line of triLines) {
      expect(line).toMatch(/\d+/);
    }

    db.close();
  });

  it("copies each base row's OWN scope columns — never mixes scopes across a two-agent fixture", async () => {
    const db = createTestDb({ withTrigramTwins: true });
    // Two agents, each with its own message in its own conversation
    db.prepare("INSERT INTO lcd_messages VALUES ('msg-a', 'conv-a', 'tenant1', 'agent-a', 0)").run();
    db.prepare(
      "INSERT INTO lcd_message_parts(id, message_id, ordinal, metadata) VALUES (?, ?, 0, ?)",
    ).run("part-a", "msg-a", JSON.stringify({ raw: { text: "alpha message" } }));
    db.prepare("INSERT INTO lcd_messages VALUES ('msg-b', 'conv-b', 'tenant1', 'agent-b', 0)").run();
    db.prepare(
      "INSERT INTO lcd_message_parts(id, message_id, ordinal, metadata) VALUES (?, ?, 0, ?)",
    ).run("part-b", "msg-b", JSON.stringify({ raw: { text: "bravo message" } }));

    await repairFtsDrift(db);

    const rowA = db
      .prepare("SELECT conversation_id, agent_id FROM lcd_messages_fts_tri WHERE message_id='msg-a'")
      .get() as { conversation_id: string; agent_id: string };
    const rowB = db
      .prepare("SELECT conversation_id, agent_id FROM lcd_messages_fts_tri WHERE message_id='msg-b'")
      .get() as { conversation_id: string; agent_id: string };
    expect(rowA).toEqual({ conversation_id: "conv-a", agent_id: "agent-a" });
    expect(rowB).toEqual({ conversation_id: "conv-b", agent_id: "agent-b" });

    db.close();
  });
});
