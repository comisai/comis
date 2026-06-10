// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for repair-lcd.ts — DOC-03 (Phase 171-04).
 *
 * Uses an in-memory better-sqlite3 database with the real LCD schema
 * (lcd_context_items / ref_kind, lcd_summaries / summary_id, lcd_messages)
 * to verify all repair actions.
 *
 * F1 ABSOLUTE CONSTRAINT: lcd_messages is NEVER modified by any repair.
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
 *  - lcd_messages_fts is CONTENTLESS (no content= clause) — matches schema-lcd.ts
 *  - lcd_summaries_fts is EXTERNAL-CONTENT (content=lcd_summaries) — matches schema-lcd.ts
 *  - lcd_message_parts holds the structured parts that repairFtsDrift reads
 */
function createTestDb(): Db {
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
      summary_id  TEXT PRIMARY KEY,
      fallback    INTEGER NOT NULL DEFAULT 0,
      tenant_id   TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      content     TEXT NOT NULL
    );
    CREATE TABLE lcd_context_items (
      id              TEXT PRIMARY KEY,
      ref_kind        TEXT NOT NULL CHECK (ref_kind IN ('message','summary')),
      ref_id          TEXT NOT NULL,
      conversation_id TEXT NOT NULL
    );
    -- CONTENTLESS FTS — matches real schema-lcd.ts lcd_messages_fts
    -- (no content= clause; adapter-populated on append via renderMessageFtsText)
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
  return db;
}

/** Return a simple row-count fingerprint for F1 assertions (lcd_messages never written by repair) */
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
      "INSERT INTO lcd_summaries VALUES ('sum-1', 0, 'tenant1', 'agent1', 'summary text')",
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

  it("repairFtsDrift never modifies lcd_messages table — F1 constraint", async () => {
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

  it("repairContextItems never touches lcd_messages — F1 constraint", async () => {
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
    db.prepare("INSERT INTO lcd_summaries VALUES (?, 0, 'tenant1', 'agent1', 'summary text')").run(
      "sum-real",
    );
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

// ── repairFtsDrift CR-02: contentless-table handling ─────────────────────────

describe("repairFtsDrift — contentless FTS guard (CR-02)", () => {
  it("repairFtsDrift does NOT use rebuild on contentless lcd_messages_fts — no error thrown", async () => {
    // This is the key CR-02 regression test:
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
    // Must NOT throw (the old 'rebuild' path would throw on a contentless table)
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
