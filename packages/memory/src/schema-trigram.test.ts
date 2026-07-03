// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the trigram twin DDL layer (schema-trigram.ts) — the trigram-search
 * table half.
 *
 * Drives the trigram-search layer: three self-contained FTS5 trigram twins
 * (lcd_messages_fts_tri, lcd_summaries_fts_tri, memory_fts_tri) plus the
 * base-table delete-mirror triggers and the WHEN-guarded memories
 * content-update trigger. The twins store their OWN content (self-contained, NOT
 * external-content / "rebuild"-backed) so a rebuild can never re-index RAW
 * pre-normalization text — exactly the wipe mechanism (scoped DELETE on the
 * vtable removes matchable text).
 *
 * Probe-pinned: every assertion here was first executed live against the bundled
 * SQLite 3.53.1 — trigram substring MATCH, per-agent UNINDEXED isolation,
 * scoped-DELETE wipe, and the WHEN guard (a plain AFTER UPDATE OF content fires
 * on the consolidation no-op fold; the guard is mandatory).
 */
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { ensureTrigramTwins } from "./schema-trigram.js";

/**
 * A db with ONLY the three base tables the twins mirror (lcd_messages,
 * lcd_summaries, memories) — the minimal shape ensureTrigramTwins needs. No FTS
 * tables, no other LCD tables: this isolates the twin DDL from the full schema.
 */
function baseTablesDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
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
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', agent_id TEXT,
      content TEXT NOT NULL, proof_count INTEGER
    );
  `);
  return db;
}

function objectExists(db: Database.Database, type: string, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
    .get(type, name);
  return row !== undefined;
}

describe("schema-trigram — twin existence + idempotency", () => {
  it("creates all three trigram twins after ensureTrigramTwins on a base-tables db", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    expect(objectExists(db, "table", "lcd_messages_fts_tri")).toBe(true);
    expect(objectExists(db, "table", "lcd_summaries_fts_tri")).toBe(true);
    expect(objectExists(db, "table", "memory_fts_tri")).toBe(true);
    db.close();
  });

  it("creates all four delete-mirror / update triggers", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    expect(objectExists(db, "trigger", "lcd_messages_tri_ad")).toBe(true);
    expect(objectExists(db, "trigger", "lcd_summaries_tri_ad")).toBe(true);
    expect(objectExists(db, "trigger", "memories_tri_ad")).toBe(true);
    expect(objectExists(db, "trigger", "memories_tri_au")).toBe(true);
    db.close();
  });

  it("the memory twin has NO scope columns (rowid-JOIN lane), the LCD twins DO", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    // memory_fts_tri: single content column (rowid-JOIN to memories supplies scope)
    const memCols = db.prepare("PRAGMA table_info(memory_fts_tri)").all() as Array<{
      name: string;
    }>;
    const memColNames = memCols.map((c) => c.name);
    expect(memColNames).toContain("content");
    expect(memColNames).not.toContain("conversation_id");
    expect(memColNames).not.toContain("agent_id");
    // lcd_messages_fts_tri: carries the UNINDEXED tenant/agent scope columns
    const msgCols = db
      .prepare("PRAGMA table_info(lcd_messages_fts_tri)")
      .all() as Array<{ name: string }>;
    const msgColNames = msgCols.map((c) => c.name);
    expect(msgColNames).toContain("conversation_id");
    expect(msgColNames).toContain("agent_id");
    expect(msgColNames).toContain("message_id");
    db.close();
  });

  it("is idempotent — calling ensureTrigramTwins twice does not throw (IF NOT EXISTS)", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    expect(() => ensureTrigramTwins(db)).not.toThrow();
    // twins + triggers still present after the second call
    expect(objectExists(db, "table", "memory_fts_tri")).toBe(true);
    expect(objectExists(db, "trigger", "memories_tri_au")).toBe(true);
    db.close();
  });
});

describe("schema-trigram — delete-mirror triggers (base DELETE → twin row gone)", () => {
  it("AFTER DELETE on lcd_messages mirrors into lcd_messages_fts_tri by rowid", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    const info = db
      .prepare(
        "INSERT INTO lcd_messages(id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at)" +
          " VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run("msg1", "conv-a", "t", "agentA", "s", 0, "user", 1, 1);
    const rowid = info.lastInsertRowid as number;
    db.prepare(
      "INSERT INTO lcd_messages_fts_tri(rowid, content, conversation_id, agent_id, message_id) VALUES (?,?,?,?,?)",
    ).run(rowid, "the quarterly report", "conv-a", "agentA", "msg1");
    expect(
      (db.prepare("SELECT count(*) AS c FROM lcd_messages_fts_tri").get() as { c: number }).c,
    ).toBe(1);
    db.prepare("DELETE FROM lcd_messages WHERE id = ?").run("msg1");
    expect(
      (db.prepare("SELECT count(*) AS c FROM lcd_messages_fts_tri").get() as { c: number }).c,
    ).toBe(0);
    db.close();
  });

  it("AFTER DELETE on lcd_summaries mirrors into lcd_summaries_fts_tri by rowid", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    const info = db
      .prepare(
        "INSERT INTO lcd_summaries(summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth," +
          " earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("sum1", "conv-a", "t", "agentA", "s", "leaf", 0, 1, 1, 1, 1, "summary text", "[]", 0, 0, 1);
    const rowid = info.lastInsertRowid as number;
    db.prepare(
      "INSERT INTO lcd_summaries_fts_tri(rowid, content, conversation_id, agent_id, summary_id) VALUES (?,?,?,?,?)",
    ).run(rowid, "summary text", "conv-a", "agentA", "sum1");
    expect(
      (db.prepare("SELECT count(*) AS c FROM lcd_summaries_fts_tri").get() as { c: number }).c,
    ).toBe(1);
    db.prepare("DELETE FROM lcd_summaries WHERE summary_id = ?").run("sum1");
    expect(
      (db.prepare("SELECT count(*) AS c FROM lcd_summaries_fts_tri").get() as { c: number }).c,
    ).toBe(0);
    db.close();
  });

  it("AFTER DELETE on memories mirrors into memory_fts_tri by rowid", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    const info = db
      .prepare("INSERT INTO memories(id, tenant_id, agent_id, content, proof_count) VALUES (?,?,?,?,?)")
      .run("mem1", "t", "agentA", "memory body text", null);
    const rowid = info.lastInsertRowid as number;
    db.prepare("INSERT INTO memory_fts_tri(rowid, content) VALUES (?,?)").run(rowid, "memory body text");
    expect((db.prepare("SELECT count(*) AS c FROM memory_fts_tri").get() as { c: number }).c).toBe(1);
    db.prepare("DELETE FROM memories WHERE id = ?").run("mem1");
    expect((db.prepare("SELECT count(*) AS c FROM memory_fts_tri").get() as { c: number }).c).toBe(0);
    db.close();
  });
});

describe("schema-trigram — WHEN-guarded memories update trigger (probe correction #3)", () => {
  it("the consolidation proof-only fold `content = COALESCE(NULL, content)` does NOT de-index", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    const info = db
      .prepare("INSERT INTO memories(id, tenant_id, agent_id, content, proof_count) VALUES (?,?,?,?,?)")
      .run("mem1", "t", "agentA", "the durable observation", 1);
    const rowid = info.lastInsertRowid as number;
    db.prepare("INSERT INTO memory_fts_tri(rowid, content) VALUES (?,?)").run(rowid, "the durable observation");
    // The EXACT growObservation no-op fold shape (content named in SET, value unchanged).
    db.prepare(
      "UPDATE memories SET proof_count = ?, content = COALESCE(NULL, content) WHERE id = ?",
    ).run(2, "mem1");
    // Twin row SURVIVES — the WHEN guard short-circuits on an unchanged content value.
    expect((db.prepare("SELECT count(*) AS c FROM memory_fts_tri").get() as { c: number }).c).toBe(1);
    db.close();
  });

  it("a REAL content change deletes the twin row (fail-safe: de-indexed, re-insert is TS-side)", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    const info = db
      .prepare("INSERT INTO memories(id, tenant_id, agent_id, content, proof_count) VALUES (?,?,?,?,?)")
      .run("mem1", "t", "agentA", "the durable observation", 1);
    const rowid = info.lastInsertRowid as number;
    db.prepare("INSERT INTO memory_fts_tri(rowid, content) VALUES (?,?)").run(rowid, "the durable observation");
    db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("a genuinely rewritten observation", "mem1");
    // Twin row DELETED — old.content IS NOT new.content, so the guard lets the delete fire.
    expect((db.prepare("SELECT count(*) AS c FROM memory_fts_tri").get() as { c: number }).c).toBe(0);
    db.close();
  });
});

describe("schema-trigram — boot safety / trigger pairing (partial schema must not brick base writes)", () => {
  it("does not throw on a db WITHOUT the memories base table, and a later lcd_messages DELETE still works", () => {
    // LCD-only db (no memories table) — the memories twin block must fail-soft
    // (skip its CREATE + its TWO triggers together) without orphaning a trigger
    // that would break the unrelated lcd_messages base-table DELETE.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
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
    `);
    expect(() => ensureTrigramTwins(db)).not.toThrow();
    // The memories twin + its triggers must NOT exist (its block fail-softed)…
    expect(objectExists(db, "table", "memory_fts_tri")).toBe(false);
    expect(objectExists(db, "trigger", "memories_tri_ad")).toBe(false);
    expect(objectExists(db, "trigger", "memories_tri_au")).toBe(false);
    // …but the LCD twins DID get created (independent blocks)…
    expect(objectExists(db, "table", "lcd_messages_fts_tri")).toBe(true);
    expect(objectExists(db, "trigger", "lcd_messages_tri_ad")).toBe(true);
    // …and an lcd_messages base DELETE still works (no orphan trigger broke it).
    db.prepare(
      "INSERT INTO lcd_messages(id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("m1", "conv-a", "t", "agentA", "s", 0, "user", 1, 1);
    expect(() => db.prepare("DELETE FROM lcd_messages WHERE id = ?").run("m1")).not.toThrow();
    expect((db.prepare("SELECT count(*) AS c FROM lcd_messages").get() as { c: number }).c).toBe(0);
    db.close();
  });

  it("a fresh db where ensureTrigramTwins was NEVER called still allows base-table DELETEs (no phantom trigger dependency)", () => {
    const db = baseTablesDb();
    db.prepare("INSERT INTO memories(id, tenant_id, agent_id, content, proof_count) VALUES (?,?,?,?,?)").run(
      "mem1",
      "t",
      "agentA",
      "x",
      null,
    );
    db.prepare(
      "INSERT INTO lcd_messages(id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("m1", "conv-a", "t", "agentA", "s", 0, "user", 1, 1);
    expect(() => db.prepare("DELETE FROM memories WHERE id = ?").run("mem1")).not.toThrow();
    expect(() => db.prepare("DELETE FROM lcd_messages WHERE id = ?").run("m1")).not.toThrow();
    db.close();
  });
});

describe("schema-trigram — tenant/agent isolation mechanics on the raw LCD twin (probe-verified)", () => {
  it("MATCH ? AND conversation_id = ? AND agent_id = ? isolates agents in BOTH directions", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    db.prepare(
      "INSERT INTO lcd_messages_fts_tri(rowid, content, conversation_id, agent_id, message_id) VALUES (?,?,?,?,?)",
    ).run(1, "shared secret alpha", "conv-a", "agentA", "m1");
    db.prepare(
      "INSERT INTO lcd_messages_fts_tri(rowid, content, conversation_id, agent_id, message_id) VALUES (?,?,?,?,?)",
    ).run(2, "shared secret bravo", "conv-a", "agentB", "m2");
    const forA = db
      .prepare(
        "SELECT rowid FROM lcd_messages_fts_tri WHERE lcd_messages_fts_tri MATCH ? AND conversation_id = ? AND agent_id = ? ORDER BY rank",
      )
      .all('"secret"', "conv-a", "agentA") as Array<{ rowid: number }>;
    expect(forA.map((r) => r.rowid)).toEqual([1]);
    const forB = db
      .prepare(
        "SELECT rowid FROM lcd_messages_fts_tri WHERE lcd_messages_fts_tri MATCH ? AND conversation_id = ? AND agent_id = ? ORDER BY rank",
      )
      .all('"secret"', "conv-a", "agentB") as Array<{ rowid: number }>;
    expect(forB.map((r) => r.rowid)).toEqual([2]);
    db.close();
  });
});

describe("schema-trigram — G10 wipe mechanism (scoped DELETE on the FTS5 vtable)", () => {
  it("DELETE FROM lcd_messages_fts_tri WHERE conversation_id = ? AND agent_id = ? removes scoped rows; MATCH then returns zero", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    db.prepare(
      "INSERT INTO lcd_messages_fts_tri(rowid, content, conversation_id, agent_id, message_id) VALUES (?,?,?,?,?)",
    ).run(1, "matchable target text", "conv-a", "agentA", "m1");
    db.prepare(
      "INSERT INTO lcd_messages_fts_tri(rowid, content, conversation_id, agent_id, message_id) VALUES (?,?,?,?,?)",
    ).run(2, "matchable target text", "conv-a", "agentB", "m2");
    db.prepare("DELETE FROM lcd_messages_fts_tri WHERE conversation_id = ? AND agent_id = ?").run(
      "conv-a",
      "agentA",
    );
    // agentA's row is gone…
    const forA = db
      .prepare(
        "SELECT rowid FROM lcd_messages_fts_tri WHERE lcd_messages_fts_tri MATCH ? AND conversation_id = ? AND agent_id = ?",
      )
      .all('"target"', "conv-a", "agentA") as unknown[];
    expect(forA.length).toBe(0);
    // …agentB's row survives (scope was respected).
    const forB = db
      .prepare(
        "SELECT rowid FROM lcd_messages_fts_tri WHERE lcd_messages_fts_tri MATCH ? AND conversation_id = ? AND agent_id = ?",
      )
      .all('"target"', "conv-a", "agentB") as unknown[];
    expect(forB.length).toBe(1);
    db.close();
  });
});

describe("schema-trigram — trigram substring sanity (the tokenizer is really present in this build)", () => {
  it("a twin row with content הספרים matches MATCH '\"ספרים\"' (mid-word substring)", () => {
    const db = baseTablesDb();
    ensureTrigramTwins(db);
    db.prepare(
      "INSERT INTO lcd_messages_fts_tri(rowid, content, conversation_id, agent_id, message_id) VALUES (?,?,?,?,?)",
    ).run(1, "הספרים", "conv-a", "agentA", "m1");
    const hits = db
      .prepare("SELECT rowid FROM lcd_messages_fts_tri WHERE lcd_messages_fts_tri MATCH ?")
      .all('"ספרים"') as unknown[];
    expect(hits.length).toBe(1);
    db.close();
  });
});
