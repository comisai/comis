// SPDX-License-Identifier: Apache-2.0
/**
 * LCD store health check unit tests — DOC-01.
 *
 * Tests all six scan classes with seeded corruption fixtures,
 * absent-DB skip behavior, clean-DB pass behavior, and the
 * content-free discipline invariant (no message text in findings).
 *
 * Uses real temp-file better-sqlite3 DBs to exercise the actual
 * production code path (readonly: true open, busy_timeout pragma,
 * SQL scan queries) rather than mocking the DB layer.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorContext } from "../types.js";
import { lcdHealthCheck } from "./lcd-health.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Track temp dirs for cleanup */
const tempDirs: string[] = [];

/** Create a temp dir + memory.db seeded with LCD schema. Returns { dbPath, dataDir, db }. */
function makeTempDb(): { dbPath: string; dataDir: string; db: Database.Database } {
  const dataDir = mkdtempSync(join(tmpdir(), "comis-test-lcd-"));
  tempDirs.push(dataDir);
  const dbPath = join(dataDir, "memory.db");
  const db = new Database(dbPath);
  seedLcdSchema(db);
  return { dbPath, dataDir, db };
}

/** Build a DoctorContext pointing at the given dataDir. */
function makeCtx(dataDir: string): DoctorContext {
  return {
    configPaths: [],
    dataDir,
    daemonPidFile: join(dataDir, "daemon.pid"),
  };
}

/** Minimal LCD schema DDL — same tables as ensureLcdTables but inlined for test isolation. */
function seedLcdSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lcd_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_key     TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'toolResult')),
      token_count     INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcd_messages_conv_agent_seq
      ON lcd_messages(conversation_id, agent_id, tenant_id, seq);

    CREATE TABLE IF NOT EXISTS lcd_summaries (
      summary_id       TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL,
      tenant_id        TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      session_key      TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('leaf','condensed')),
      depth            INTEGER NOT NULL,
      earliest_at      INTEGER NOT NULL,
      latest_at        INTEGER NOT NULL,
      descendant_count INTEGER NOT NULL,
      token_count      INTEGER NOT NULL,
      content          TEXT NOT NULL,
      file_ids         TEXT NOT NULL DEFAULT '[]',
      taint            INTEGER NOT NULL DEFAULT 0,
      fallback         INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lcd_summaries_conv ON lcd_summaries(conversation_id);

    CREATE TABLE IF NOT EXISTS lcd_summary_messages (
      summary_id TEXT NOT NULL REFERENCES lcd_summaries(summary_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES lcd_messages(id) ON DELETE RESTRICT,
      PRIMARY KEY (summary_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS lcd_context_items (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_key     TEXT NOT NULL,
      ordinal         INTEGER NOT NULL,
      ref_kind        TEXT NOT NULL CHECK (ref_kind IN ('message','summary')),
      ref_id          TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcd_ctx_items_conv_agent_ord
      ON lcd_context_items(conversation_id, agent_id, tenant_id, ordinal);

    CREATE TABLE IF NOT EXISTS lcd_ingest_cursor (
      conversation_id   TEXT    NOT NULL,
      agent_id          TEXT    NOT NULL,
      tenant_id         TEXT    NOT NULL,
      epoch_anchor      TEXT    NOT NULL,
      ingested_live_len INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, agent_id, tenant_id)
    );
  `);
}

/** Seed a valid message row — no corruption. */
function seedMessage(
  db: Database.Database,
  opts: { id?: string; conversationId?: string; tenantId?: string; agentId?: string; role?: string; seq?: number } = {},
): void {
  db.prepare(`INSERT INTO lcd_messages
    (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    opts.id ?? "msg-001",
    opts.conversationId ?? "conv-001",
    opts.tenantId ?? "tenant-001",
    opts.agentId ?? "agent-001",
    "session-001",
    opts.seq ?? 1,
    opts.role ?? "user",
    10,
    1000000,
  );
}

/** Seed a valid summary row — no corruption. */
function seedSummary(
  db: Database.Database,
  opts: { summaryId?: string; conversationId?: string; tenantId?: string; agentId?: string; fallback?: number; content?: string } = {},
): void {
  db.prepare(`INSERT INTO lcd_summaries
    (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
     earliest_at, latest_at, descendant_count, token_count, content, fallback, created_at)
    VALUES (?, ?, ?, ?, ?, 'leaf', 0, ?, ?, ?, ?, ?, ?, ?)`).run(
    opts.summaryId ?? "sum-001",
    opts.conversationId ?? "conv-001",
    opts.tenantId ?? "tenant-001",
    opts.agentId ?? "agent-001",
    "session-001",
    1000000,
    2000000,
    1,
    10,
    opts.content ?? "This is a summary",
    opts.fallback ?? 0,
    1000000,
  );
}

/** Seed a valid context_item row. */
function seedContextItem(
  db: Database.Database,
  opts: { id?: string; refId?: string; refKind?: string; ordinal?: number } = {},
): void {
  db.prepare(`INSERT INTO lcd_context_items
    (id, conversation_id, tenant_id, agent_id, session_key, ordinal, ref_kind, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    opts.id ?? "ci-001",
    "conv-001",
    "tenant-001",
    "agent-001",
    "session-001",
    opts.ordinal ?? 0,
    opts.refKind ?? "message",
    opts.refId ?? "msg-001",
  );
}

afterEach(() => {
  // Remove temp dirs created during tests
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }
});

// ── Test cases ───────────────────────────────────────────────────────────────

describe("lcdHealthCheck", () => {
  // DOC-01-T-1: absent memory.db → silently skip (empty findings)
  it("DOC-01-T-1: returns empty findings when memory.db does not exist (new-install safe)", async () => {
    const ctx = makeCtx("/tmp/comis-nonexistent-dir-xyzzy-" + Date.now());
    const findings = await lcdHealthCheck.run(ctx);
    expect(findings).toHaveLength(0);
  });

  // DOC-01-T-2: clean DB → exactly 1 pass finding
  it("DOC-01-T-2: returns exactly one pass finding on a clean LCD DB with no corruption", async () => {
    const { dataDir, db } = makeTempDb();
    // Seed valid data (no corruption)
    seedMessage(db);
    seedSummary(db);
    // Context item pointing to the message
    seedContextItem(db, { id: "ci-msg", refKind: "message", refId: "msg-001", ordinal: 0 });
    // Context item pointing to the summary (so summary is NOT orphaned)
    seedContextItem(db, { id: "ci-sum", refKind: "summary", refId: "sum-001", ordinal: 1 });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe("pass");
  });

  // DOC-01-T-3: scan class 1 — orphaned lcd_summaries (no matching context_item)
  it("DOC-01-T-3: detects orphaned lcd_summaries with errorKind lcd_orphaned_summary and count in message", async () => {
    const { dataDir, db } = makeTempDb();
    // Seed a summary that has no context_item pointing to it
    seedSummary(db, { summaryId: "orphaned-sum-001" });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.message.includes("orphaned"));
    expect(f).toBeDefined();
    expect(f!.status).toBe("warn");
    // Must include count — the number "1"
    expect(f!.message).toMatch(/\b1\b/);
    expect(f!.repairable).toBe(false);
  });

  // DOC-01-T-4: scan class 2 — dangling context_item refs
  it("DOC-01-T-4: detects dangling context_items refs when ref_id points to a non-existent message", async () => {
    const { dataDir, db } = makeTempDb();
    // Seed a context_item pointing to a non-existent message
    seedContextItem(db, { id: "ci-dangling", refKind: "message", refId: "non-existent-msg" });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.message.includes("dangling"));
    expect(f).toBeDefined();
    expect(f!.status).toBe("warn");
    expect(f!.message).toMatch(/\b1\b/);
    // DOC-03 (Phase 171-04): dangling refs are now repairable via repairContextItems
    expect(f!.repairable).toBe(true);
  });

  // DOC-01-T-5: scan class 3 — fallback-marker summaries
  it("DOC-01-T-5: detects fallback-marker lcd_summaries with status warn and repairable true (DOC-03)", async () => {
    const { dataDir, db } = makeTempDb();
    seedSummary(db, { summaryId: "fallback-sum", fallback: 1 });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.message.includes("fallback"));
    expect(f).toBeDefined();
    expect(f!.status).toBe("warn");
    // DOC-03 (Phase 171-04): fallback summaries are now repairable via repairFallbackSummaries
    expect(f!.repairable).toBe(true);
  });

  // DOC-01-T-6: scan class 6 — lcd_ingest_cursor over-count. Corrected (WR-04): the
  // scan flags ONLY ingested_live_len > persisted msg count (impossible in healthy
  // operation), NOT the old ingested_live_len=0 premise (a normal fresh epoch).
  it("DOC-01-T-6: flags a cursor whose ingested_live_len exceeds the persisted message count", async () => {
    const { dataDir, db } = makeTempDb();
    // 2 persisted messages, but a cursor claiming 5 ingested — impossible/corrupt.
    seedMessage(db, { id: "m1", seq: 1 });
    seedMessage(db, { id: "m2", seq: 2 });
    db.prepare(`INSERT INTO lcd_ingest_cursor
      (conversation_id, agent_id, tenant_id, epoch_anchor, ingested_live_len, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("conv-001", "agent-001", "tenant-001", "user:1000000:abc", 5, 1000000);
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.message.includes("ingested_live_len exceeding"));
    expect(f).toBeDefined();
    expect(f!.status).toBe("warn");
    expect(f!.repairable).toBe(false);
  });

  // DOC-01-T-6b: a fresh-epoch cursor (ingested_live_len=0 with durable messages) is
  // NORMAL under the Phase-164 epoch model and must NOT be flagged (the WR-04 guard).
  it("DOC-01-T-6b: does NOT flag a fresh-epoch cursor (ingested_live_len=0) with durable messages", async () => {
    const { dataDir, db } = makeTempDb();
    seedMessage(db, { id: "m1", seq: 1 });
    seedMessage(db, { id: "m2", seq: 2 });
    seedMessage(db, { id: "m3", seq: 3 });
    db.prepare(`INSERT INTO lcd_ingest_cursor
      (conversation_id, agent_id, tenant_id, epoch_anchor, ingested_live_len, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("conv-001", "agent-001", "tenant-001", "user:1000000:abc", 0, 1000000);
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.check === "Cursor over-count");
    expect(f).toBeUndefined();
  });

  // DOC-01-T-7: scan class 5 — FTS row-count drift (FTS may or may not be available)
  it("DOC-01-T-7: detects FTS row-count drift when lcd_messages_fts has fewer rows than lcd_messages", async () => {
    const { dataDir, db } = makeTempDb();
    // Seed a message in lcd_messages
    seedMessage(db, { id: "msg-fts-test" });

    // Try to create FTS tables — skip test gracefully if FTS5 not available
    let ftsAvailable = false;
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lcd_messages_fts USING fts5(
          content,
          conversation_id UNINDEXED,
          agent_id UNINDEXED,
          message_id UNINDEXED,
          tokenize='porter unicode61'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS lcd_summaries_fts USING fts5(
          content,
          conversation_id UNINDEXED,
          agent_id UNINDEXED,
          summary_id UNINDEXED,
          content='lcd_summaries',
          content_rowid='rowid',
          tokenize='porter unicode61'
        );
      `);
      ftsAvailable = true;
    } catch {
      // FTS5 not available — test will verify the check skips gracefully
    }
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));

    if (ftsAvailable) {
      // With 1 message in lcd_messages but 0 rows in lcd_messages_fts → drift=1
      const f = findings.find((x) => x.message.includes("FTS") || x.message.includes("fts") || x.message.includes("sync"));
      expect(f).toBeDefined();
      expect(f!.status).toBe("warn");
    } else {
      // FTS not available → no FTS finding (check must skip gracefully)
      const ftsFindings = findings.filter((x) => x.message.includes("FTS") || x.message.includes("fts"));
      expect(ftsFindings).toHaveLength(0);
    }
  });

  // DOC-01-T-8: scan class 6 — R4 scope anomalies (NULL tenant_id or agent_id)
  it("DOC-01-T-8: detects R4 scope anomalies — messages with NULL tenant_id produce a fail finding", async () => {
    const { dataDir, db } = makeTempDb();
    // Bypass CHECK constraint by inserting with pragma off to test the scanner
    // Actually the CHECK constraint won't trigger for NULL in SQLite without NOT NULL.
    // The schema has tenant_id TEXT NOT NULL, so we need to drop the constraint.
    // Instead, insert a message where we force null via a raw SQL trick:
    // We'll create a different approach — insert directly with NULL using PRAGMA writable_schema
    // Actually: the NOT NULL constraint will block this. We need to insert without the NOT NULL.
    // For the test, recreate the table without the NOT NULL to test the scanner:
    db.exec(`DROP TABLE IF EXISTS lcd_messages`);
    db.exec(`
      CREATE TABLE lcd_messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        tenant_id       TEXT,
        agent_id        TEXT,
        session_key     TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        role            TEXT NOT NULL,
        token_count     INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
    `);
    db.prepare(`INSERT INTO lcd_messages
      (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at)
      VALUES (?, ?, NULL, 'agent-001', 'session-001', 1, 'user', 10, 1000000)`).run(
      "msg-null-tenant",
      "conv-001",
    );
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.status === "fail" && (x.message.includes("R4") || x.message.includes("NULL") || x.message.includes("anomal")));
    expect(f).toBeDefined();
    expect(f!.status).toBe("fail");
    expect(f!.repairable).toBe(false);
  });

  // DOC-01-T-9: content-free discipline — no finding message contains seeded message content
  it("DOC-01-T-9: finding messages contain only counts/IDs/errorKind strings — no actual message content", async () => {
    const { dataDir, db } = makeTempDb();
    const secretContent = "SUPER_SECRET_USER_MESSAGE_CONTENT_xyzzy_12345";
    // Seed a fallback summary whose content contains the secret text
    seedSummary(db, { summaryId: "secret-sum", fallback: 1, content: secretContent });
    // Seed a dangling context_item
    seedContextItem(db, { id: "ci-dangling-test", refKind: "message", refId: "non-existent" });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));

    // Every finding message must NOT contain the secret content string
    for (const finding of findings) {
      expect(finding.message).not.toContain(secretContent);
    }
    // Must have at least some findings (corruption was seeded)
    expect(findings.length).toBeGreaterThan(0);
  });
});
