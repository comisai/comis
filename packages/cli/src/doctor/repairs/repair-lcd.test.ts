// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for repair-lcd.ts — DOC-03 (Phase 171-04).
 *
 * Uses an in-memory better-sqlite3 database with the real LCD schema
 * (lcd_context_items / ref_kind, lcd_summaries / summary_id, lcd_messages)
 * to verify all three repair actions.
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
  repairFallbackSummaries,
} from "./repair-lcd.js";

// ── Schema setup ─────────────────────────────────────────────────────────────

function createTestDb(): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE lcd_messages (
      id          TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      tenant_id   TEXT NOT NULL,
      agent_id    TEXT NOT NULL
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
    CREATE VIRTUAL TABLE lcd_messages_fts USING fts5(
      content,
      content=lcd_messages,
      content_rowid=rowid
    );
    CREATE VIRTUAL TABLE lcd_summaries_fts USING fts5(
      content,
      content=lcd_summaries,
      content_rowid=rowid
    );
  `);
  return db;
}

/** Return a simple content fingerprint for F1 assertions */
function lcdMessagesFingerprint(db: Db): string {
  const rows = db
    .prepare("SELECT id, content FROM lcd_messages ORDER BY id")
    .all() as Array<{ id: string; content: string }>;
  return JSON.stringify(rows);
}

// ── repairFtsDrift tests ─────────────────────────────────────────────────────

describe("repairFtsDrift", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("repairFtsDrift rebuilds FTS tables and returns ok with action list", async () => {
    db.prepare("INSERT INTO lcd_messages VALUES (?, ?, 'tenant1', 'agent1')").run(
      "msg-1",
      "hello world",
    );
    const result = await repairFtsDrift(db);
    expect(result.ok).toBe(true);
    expect(result.value).toContain("Rebuilt lcd_messages_fts FTS index");
    expect(result.value).toContain("Rebuilt lcd_summaries_fts FTS index");
  });

  it("repairFtsDrift never modifies lcd_messages table — F1 constraint", async () => {
    db.prepare("INSERT INTO lcd_messages VALUES (?, ?, 'tenant1', 'agent1')").run(
      "msg-f1",
      "protected content",
    );
    const before = lcdMessagesFingerprint(db);

    const result = await repairFtsDrift(db);

    const after = lcdMessagesFingerprint(db);
    expect(result.ok).toBe(true);
    expect(after).toBe(before);
  });

  it("repairFtsDrift returns ok with empty actions when no FTS tables exist", async () => {
    const noFtsDb = new Database(":memory:");
    noFtsDb.exec(`
      CREATE TABLE lcd_messages (id TEXT PRIMARY KEY, content TEXT NOT NULL);
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
    db.prepare("INSERT INTO lcd_messages VALUES (?, ?, 'tenant1', 'agent1')").run(
      "msg-f1",
      "must not be touched",
    );
    const before = lcdMessagesFingerprint(db);

    await repairContextItems(db);

    const after = lcdMessagesFingerprint(db);
    expect(after).toBe(before);
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
    // At least one action string must mention "dangling" and a number
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

// ── repairFallbackSummaries tests ────────────────────────────────────────────

describe("repairFallbackSummaries", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("repairFallbackSummaries with breaker OPEN returns ok without touching database", async () => {
    // Insert a fallback=1 summary
    db.prepare(
      "INSERT INTO lcd_summaries VALUES (?, 1, 'tenant1', 'agent1', 'stale fallback content')",
    ).run("sum-fb-1");

    const openBreakerDeps = {
      summarize: async (_msgs: Array<{ role: string; content: string }>) =>
        "should not be called",
      isBreakerOpen: () => true,
    };

    const result = await repairFallbackSummaries(db, openBreakerDeps);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual([]);

    // Summary must still be fallback=1 (not touched)
    const row = db
      .prepare("SELECT fallback FROM lcd_summaries WHERE summary_id='sum-fb-1'")
      .get() as { fallback: number } | undefined;
    expect(row?.fallback).toBe(1);
  });

  it("repairFallbackSummaries calls summarize for each fallback=1 summary when breaker CLOSED", async () => {
    db.prepare(
      "INSERT INTO lcd_summaries VALUES (?, 1, 'tenant1', 'agent1', 'old content 1')",
    ).run("sum-fb-a");
    db.prepare(
      "INSERT INTO lcd_summaries VALUES (?, 1, 'tenant1', 'agent1', 'old content 2')",
    ).run("sum-fb-b");

    let callCount = 0;
    const closedBreakerDeps = {
      summarize: async (_msgs: Array<{ role: string; content: string }>) => {
        callCount++;
        return "new summary content";
      },
      isBreakerOpen: () => false,
    };

    const result = await repairFallbackSummaries(db, closedBreakerDeps);

    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
    // Both summaries should now have fallback=0
    const fallbackCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM lcd_summaries WHERE fallback=1")
        .get() as { c: number }
    ).c;
    expect(fallbackCount).toBe(0);
  });

  it("repairFallbackSummaries never modifies lcd_messages — F1 absolute constraint", async () => {
    db.prepare(
      "INSERT INTO lcd_messages VALUES (?, ?, 'tenant1', 'agent1')",
    ).run("msg-protected", "raw message must not be touched");
    db.prepare(
      "INSERT INTO lcd_summaries VALUES (?, 1, 'tenant1', 'agent1', 'fallback summary')",
    ).run("sum-fb-f1");

    const before = lcdMessagesFingerprint(db);

    const deps = {
      summarize: async (_msgs: Array<{ role: string; content: string }>) =>
        "new summary",
      isBreakerOpen: () => false,
    };

    await repairFallbackSummaries(db, deps);

    const after = lcdMessagesFingerprint(db);
    expect(after).toBe(before);
  });

  it("repairFallbackSummaries skips summary gracefully when summarize throws", async () => {
    db.prepare(
      "INSERT INTO lcd_summaries VALUES (?, 1, 'tenant1', 'agent1', 'old fallback')",
    ).run("sum-fb-err");

    const throwingDeps = {
      summarize: async (_msgs: Array<{ role: string; content: string }>): Promise<string> => {
        throw new Error("summarizer unavailable");
      },
      isBreakerOpen: () => false,
    };

    const result = await repairFallbackSummaries(db, throwingDeps);

    // Should return ok (not err) — individual failures are non-fatal
    expect(result.ok).toBe(true);
    const joined = result.value!.join(" ");
    expect(joined).toContain("sum-fb-err");
    expect(joined).toContain("Skipped");
  });
});
