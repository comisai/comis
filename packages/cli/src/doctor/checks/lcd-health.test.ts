// SPDX-License-Identifier: Apache-2.0
/**
 * LCD store health check unit tests.
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
import { createConversationRef, type ContextStoreScope } from "@comis/core";
import { createLcdStore, initSchema } from "@comis/memory";
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
      conversation_ref TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_key     TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'toolResult')),
      token_count     INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcd_messages_conv_agent_seq
      ON lcd_messages(conversation_ref, agent_id, tenant_id, seq);

    CREATE TABLE IF NOT EXISTS lcd_summaries (
      summary_id       TEXT PRIMARY KEY,
      conversation_ref  TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_lcd_summaries_conv ON lcd_summaries(conversation_ref);

    CREATE TABLE IF NOT EXISTS lcd_summary_messages (
      summary_id TEXT NOT NULL REFERENCES lcd_summaries(summary_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES lcd_messages(id) ON DELETE RESTRICT,
      PRIMARY KEY (summary_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS lcd_summary_parents (
      parent_summary_id TEXT NOT NULL REFERENCES lcd_summaries(summary_id) ON DELETE CASCADE,
      child_summary_id  TEXT NOT NULL REFERENCES lcd_summaries(summary_id) ON DELETE RESTRICT,
      PRIMARY KEY (parent_summary_id, child_summary_id)
    );

    CREATE TABLE IF NOT EXISTS lcd_context_items (
      id              TEXT PRIMARY KEY,
      conversation_ref TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_key     TEXT NOT NULL,
      ordinal         INTEGER NOT NULL,
      ref_kind        TEXT NOT NULL CHECK (ref_kind IN ('message','summary')),
      ref_id          TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcd_ctx_items_conv_agent_ord
      ON lcd_context_items(conversation_ref, agent_id, tenant_id, ordinal);

    CREATE TABLE IF NOT EXISTS lcd_ingest_cursor (
      conversation_ref   TEXT    NOT NULL,
      agent_id          TEXT    NOT NULL,
      tenant_id         TEXT    NOT NULL,
      epoch_anchor      TEXT    NOT NULL,
      ingested_live_len INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (conversation_ref, agent_id, tenant_id)
    );
  `);
}

/** Seed a valid message row — no corruption. */
function seedMessage(
  db: Database.Database,
  opts: { id?: string; conversationRef?: string; tenantId?: string; agentId?: string; role?: string; seq?: number } = {},
): void {
  db.prepare(`INSERT INTO lcd_messages
    (id, conversation_ref, tenant_id, agent_id, session_key, seq, role, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    opts.id ?? "msg-001",
    opts.conversationRef ?? "conv-001",
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
  opts: { summaryId?: string; conversationRef?: string; tenantId?: string; agentId?: string; fallback?: number; content?: string } = {},
): void {
  db.prepare(`INSERT INTO lcd_summaries
    (summary_id, conversation_ref, tenant_id, agent_id, session_key, kind, depth,
     earliest_at, latest_at, descendant_count, token_count, content, fallback, created_at)
    VALUES (?, ?, ?, ?, ?, 'leaf', 0, ?, ?, ?, ?, ?, ?, ?)`).run(
    opts.summaryId ?? "sum-001",
    opts.conversationRef ?? "conv-001",
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
  opts: {
    id?: string;
    refId?: string;
    refKind?: string;
    ordinal?: number;
    conversationRef?: string;
    tenantId?: string;
    agentId?: string;
  } = {},
): void {
  db.prepare(`INSERT INTO lcd_context_items
    (id, conversation_ref, tenant_id, agent_id, session_key, ordinal, ref_kind, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    opts.id ?? "ci-001",
    opts.conversationRef ?? "conv-001",
    opts.tenantId ?? "tenant-001",
    opts.agentId ?? "agent-001",
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
  // Absent memory.db → silently skip (empty findings)
  it("returns empty findings when memory.db does not exist (new-install safe)", async () => {
    const ctx = makeCtx("/tmp/comis-nonexistent-dir-xyzzy-" + Date.now());
    const findings = await lcdHealthCheck.run(ctx);
    expect(findings).toHaveLength(0);
  });

  it("scans the configured memory database path outside the data directory", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-test-lcd-data-"));
    const databaseDir = mkdtempSync(join(tmpdir(), "comis-test-lcd-database-"));
    tempDirs.push(dataDir, databaseDir);
    const dbPath = join(databaseDir, "custom-memory.sqlite");
    const db = new Database(dbPath);
    seedLcdSchema(db);
    db.close();

    const findings = await lcdHealthCheck.run({
      ...makeCtx(dataDir),
      memoryDbPath: dbPath,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("pass");
  });

  // Clean DB → exactly 1 pass finding
  it("returns exactly one pass finding on a clean LCD DB with no corruption", async () => {
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

  // Scan class 1 — orphaned lcd_summaries (no matching context_item)
  it("detects orphaned lcd_summaries with errorKind lcd_orphaned_summary and count in message", async () => {
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

  it("does not classify a retained condensed-summary child as an orphan", async () => {
    const { dataDir, db } = makeTempDb();
    seedSummary(db, { summaryId: "child-sum" });
    seedSummary(db, { summaryId: "parent-sum" });
    db.prepare(
      "INSERT INTO lcd_summary_parents(parent_summary_id, child_summary_id) VALUES (?, ?)",
    ).run("parent-sum", "child-sum");
    seedContextItem(db, { id: "ci-parent", refKind: "summary", refId: "parent-sum" });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    expect(findings.find((finding) => finding.check === "Orphaned summaries")).toBeUndefined();
  });

  it("counts an unreachable condensed parent and its child as two orphaned summaries", async () => {
    const { dataDir, db } = makeTempDb();
    seedSummary(db, { summaryId: "unreachable-child" });
    seedSummary(db, { summaryId: "unreachable-parent" });
    db.prepare(
      "INSERT INTO lcd_summary_parents(parent_summary_id, child_summary_id) VALUES (?, ?)",
    ).run("unreachable-parent", "unreachable-child");
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const finding = findings.find((candidate) => candidate.check === "Orphaned summaries");
    expect(finding?.message).toContain("2 orphaned lcd_summaries");
  });

  it("follows a multi-level condensed DAG from its active context root", async () => {
    const { dataDir, db } = makeTempDb();
    seedSummary(db, { summaryId: "leaf" });
    seedSummary(db, { summaryId: "middle" });
    seedSummary(db, { summaryId: "root" });
    const insertEdge = db.prepare(
      "INSERT INTO lcd_summary_parents(parent_summary_id, child_summary_id) VALUES (?, ?)",
    );
    insertEdge.run("middle", "leaf");
    insertEdge.run("root", "middle");
    seedContextItem(db, { id: "ci-root", refKind: "summary", refId: "root" });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    expect(findings.find((finding) => finding.check === "Orphaned summaries")).toBeUndefined();
  });

  it("accepts the real schema and condensed-writer DAG as reachable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-test-lcd-real-"));
    tempDirs.push(dataDir);
    const db = new Database(join(dataDir, "memory.db"));
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const conversationRef = createConversationRef({
      tenantId: "tenant-real",
      agentId: "agent-real",
      partition: { kind: "agent" },
    });
    if (!conversationRef.ok) throw conversationRef.error;
    const scope: ContextStoreScope = {
      conversationRef: conversationRef.value,
      tenantId: "tenant-real",
      agentId: "agent-real",
      sessionKey: "tenant-real:telegram:user-real",
    };
    for (let index = 0; index < 4; index += 1) {
      store.append({
        scope,
        seq: index,
        role: "user",
        tokenCount: 10,
        createdAt: 1_000 + index,
        parts: [{
          kind: "text",
          metadata: { raw: { type: "text", text: `message-${index}` }, rawType: "text" },
        }],
      });
    }
    store.getContextItems(scope);
    const commonSummary = {
      scope,
      tokenCount: 5,
      descendantCount: 0,
      earliestAt: 0,
      latestAt: 0,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 2_000,
    };
    const firstLeaf = store.appendLeafSummary({
      ...commonSummary,
      content: "first leaf",
      startOrdinal: 0,
      endOrdinal: 1,
    });
    const secondLeaf = store.appendLeafSummary({
      ...commonSummary,
      content: "second leaf",
      startOrdinal: 1,
      endOrdinal: 2,
    });
    const condensedRoot = store.appendCondensedSummary({
      ...commonSummary,
      content: "condensed root",
      startOrdinal: 0,
      endOrdinal: 1,
      childSummaryIds: [firstLeaf, secondLeaf],
      depth: 1,
    });
    expect(
      db
        .prepare(
          "SELECT ordinal, ref_kind, ref_id, conversation_ref, tenant_id, agent_id FROM lcd_context_items ORDER BY ordinal",
        )
        .all(),
    ).toEqual([
      {
        ordinal: 0,
        ref_kind: "summary",
        ref_id: condensedRoot,
        conversation_ref: scope.conversationRef,
        tenant_id: scope.tenantId,
        agent_id: scope.agentId,
      },
    ]);
    expect(store.getContextItems(scope)).toEqual([
      { ordinal: 0, refKind: "summary", refId: condensedRoot },
    ]);
    expect(
      db
        .prepare(
          "SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ? ORDER BY child_summary_id",
        )
        .all(condensedRoot),
    ).toEqual(
      [firstLeaf, secondLeaf]
        .sort()
        .map((childSummaryId) => ({ child_summary_id: childSummaryId })),
    );
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    expect(findings.find((finding) => finding.check === "Orphaned summaries")).toBeUndefined();
    expect(findings).toEqual([
      expect.objectContaining({ check: "LCD Store", status: "pass" }),
    ]);
  });

  it("reports the complete orphan count instead of truncating the diagnostic at fifty", async () => {
    const { dataDir, db } = makeTempDb();
    for (let index = 0; index < 51; index += 1) {
      seedSummary(db, { summaryId: `orphan-${index}` });
    }
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const finding = findings.find((candidate) => candidate.check === "Orphaned summaries");
    expect(finding?.message).toContain("51 orphaned lcd_summaries");
  });

  // Scan class 2 — dangling context_item refs
  it("detects dangling context_items refs when ref_id points to a non-existent message", async () => {
    const { dataDir, db } = makeTempDb();
    // Seed a context_item pointing to a non-existent message
    seedContextItem(db, { id: "ci-dangling", refKind: "message", refId: "non-existent-msg" });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.message.includes("dangling"));
    expect(f).toBeDefined();
    expect(f!.status).toBe("warn");
    expect(f!.message).toMatch(/\b1\b/);
    // Dangling refs are repairable offline via repairContextItems
    expect(f!.repairable).toBe(true);
  });

  it("treats a cross-scope summary reference as dangling and leaves the summary orphaned", async () => {
    const { dataDir, db } = makeTempDb();
    seedSummary(db, { summaryId: "scoped-summary", tenantId: "tenant-a" });
    seedContextItem(db, {
      id: "ci-cross-scope",
      refKind: "summary",
      refId: "scoped-summary",
      tenantId: "tenant-b",
    });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    expect(findings.find((finding) => finding.check === "Dangling context refs")?.message)
      .toContain("1 dangling context_items ref");
    expect(findings.find((finding) => finding.check === "Orphaned summaries")?.message)
      .toContain("1 orphaned lcd_summaries");
  });

  it("reports the complete dangling-reference count instead of truncating at fifty", async () => {
    const { dataDir, db } = makeTempDb();
    for (let index = 0; index < 51; index += 1) {
      seedContextItem(db, {
        id: `dangling-${index}`,
        refKind: "message",
        refId: `missing-${index}`,
        ordinal: index,
      });
    }
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    expect(findings.find((finding) => finding.check === "Dangling context refs")?.message)
      .toContain("51 dangling context_items refs");
  });

  // Scan class 3 — fallback-marker summaries
  it("detects fallback-marker lcd_summaries with status warn (repairable:false — offline impossible)", async () => {
    const { dataDir, db } = makeTempDb();
    seedSummary(db, { summaryId: "fallback-sum", fallback: 1 });
    seedContextItem(db, { id: "ci-fallback", refKind: "summary", refId: "fallback-sum" });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.message.includes("fallback"));
    expect(f).toBeDefined();
    expect(f!.status).toBe("warn");
    expect(f!.repairable).toBe(false);
    expect(f!.message).toContain("1 active root");
    expect(f!.suggestion).toContain("does not rewrite them");
    expect(f!.suggestion).toContain("underlying messages remain available");
    expect(f!.suggestion).not.toContain("replace them");
  });

  it("distinguishes retained fallback children from active fallback context refs", async () => {
    const { dataDir, db } = makeTempDb();
    seedSummary(db, { summaryId: "fallback-child", fallback: 1 });
    seedSummary(db, { summaryId: "active-parent", fallback: 0 });
    db.prepare(
      "INSERT INTO lcd_summary_parents(parent_summary_id, child_summary_id) VALUES (?, ?)",
    ).run("active-parent", "fallback-child");
    seedContextItem(db, { id: "ci-active-parent", refKind: "summary", refId: "active-parent" });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const finding = findings.find((candidate) => candidate.check === "Fallback summaries");
    expect(finding?.message).toContain("0 active roots");
    expect(finding?.message).toContain("1 reachable ancestor");
    expect(finding?.message).toContain("0 unreachable");
  });

  // Scan class 6 — lcd_ingest_cursor over-count. The scan flags ONLY
  // ingested_live_len > persisted msg count (impossible in healthy operation),
  // NOT ingested_live_len=0 (a normal fresh epoch).
  it("flags a cursor whose ingested_live_len exceeds the persisted message count", async () => {
    const { dataDir, db } = makeTempDb();
    // 2 persisted messages, but a cursor claiming 5 ingested — impossible/corrupt.
    seedMessage(db, { id: "m1", seq: 1 });
    seedMessage(db, { id: "m2", seq: 2 });
    db.prepare(`INSERT INTO lcd_ingest_cursor
      (conversation_ref, agent_id, tenant_id, epoch_anchor, ingested_live_len, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("conv-001", "agent-001", "tenant-001", "user:1000000:abc", 5, 1000000);
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.message.includes("ingested_live_len exceeding"));
    expect(f).toBeDefined();
    expect(f!.status).toBe("warn");
    expect(f!.repairable).toBe(false);
  });

  it("reports the complete cursor over-count instead of truncating at twenty", async () => {
    const { dataDir, db } = makeTempDb();
    const insertCursor = db.prepare(`INSERT INTO lcd_ingest_cursor
      (conversation_ref, agent_id, tenant_id, epoch_anchor, ingested_live_len, updated_at)
      VALUES (?, 'agent-001', 'tenant-001', 'user:1000000:abc', 1, 1000000)`);
    for (let index = 0; index < 21; index += 1) insertCursor.run(`conv-${index}`);
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    expect(findings.find((finding) => finding.check === "Cursor over-count")?.message)
      .toContain("21 lcd_ingest_cursor rows");
  });

  // A fresh-epoch cursor (ingested_live_len=0 with durable messages) is
  // NORMAL under the epoch model and must NOT be flagged.
  it("does NOT flag a fresh-epoch cursor (ingested_live_len=0) with durable messages", async () => {
    const { dataDir, db } = makeTempDb();
    seedMessage(db, { id: "m1", seq: 1 });
    seedMessage(db, { id: "m2", seq: 2 });
    seedMessage(db, { id: "m3", seq: 3 });
    db.prepare(`INSERT INTO lcd_ingest_cursor
      (conversation_ref, agent_id, tenant_id, epoch_anchor, ingested_live_len, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("conv-001", "agent-001", "tenant-001", "user:1000000:abc", 0, 1000000);
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.check === "Cursor over-count");
    expect(f).toBeUndefined();
  });

  // Scan class 4 — FTS row-count drift (FTS may or may not be available)
  it("detects FTS row-count drift when lcd_messages_fts has fewer rows than lcd_messages", async () => {
    const { dataDir, db } = makeTempDb();
    // Seed a message in lcd_messages
    seedMessage(db, { id: "msg-fts-test" });

    // Try to create FTS tables — skip test gracefully if FTS5 not available
    let ftsAvailable = false;
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lcd_messages_fts USING fts5(
          content,
          conversation_ref UNINDEXED,
          agent_id UNINDEXED,
          message_id UNINDEXED,
          tokenize='porter unicode61'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS lcd_summaries_fts USING fts5(
          content,
          conversation_ref UNINDEXED,
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

  // Scope-integrity scan (NULL tenant_id or agent_id)
  it("reports a clear scope-integrity failure when a message has no tenant id", async () => {
    const { dataDir, db } = makeTempDb();
    // The real schema declares tenant_id/agent_id NOT NULL, so a NULL scope
    // value cannot be inserted directly. Recreate the table without those
    // constraints to seed the exact corruption the scanner must detect.
    db.exec(`DROP TABLE IF EXISTS lcd_messages`);
    db.exec(`
      CREATE TABLE lcd_messages (
        id              TEXT PRIMARY KEY,
        conversation_ref TEXT NOT NULL,
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
      (id, conversation_ref, tenant_id, agent_id, session_key, seq, role, token_count, created_at)
      VALUES (?, ?, NULL, 'agent-001', 'session-001', 1, 'user', 10, 1000000)`).run(
      "msg-null-tenant",
      "conv-001",
    );
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const f = findings.find((x) => x.check === "LCD scope integrity");
    expect(f).toBeDefined();
    expect(f!.status).toBe("fail");
    expect(f!.message).toBe(
      "LCD scope integrity failure: 1 message + 0 summaries have a missing tenant_id or agent_id",
    );
    expect(f!.repairable).toBe(false);
  });

  it("reports a cross-scope condensed-summary edge and does not use it for reachability", async () => {
    const { dataDir, db } = makeTempDb();
    seedSummary(db, { summaryId: "parent-a", tenantId: "tenant-a" });
    seedSummary(db, { summaryId: "child-b", tenantId: "tenant-b" });
    db.prepare(
      "INSERT INTO lcd_summary_parents(parent_summary_id, child_summary_id) VALUES (?, ?)",
    ).run("parent-a", "child-b");
    seedContextItem(db, {
      id: "ci-parent-a",
      refKind: "summary",
      refId: "parent-a",
      tenantId: "tenant-a",
    });
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    expect(findings.find((finding) => finding.check === "LCD scope integrity")?.message)
      .toContain("1 cross-scope summary edge");
    expect(findings.find((finding) => finding.check === "Orphaned summaries")?.message)
      .toContain("1 orphaned lcd_summaries");
  });

  it("reports a missing required LCD table as schema initialization failure", async () => {
    const { dataDir, db } = makeTempDb();
    db.exec("DROP TABLE lcd_summary_parents");
    db.close();

    const findings = await lcdHealthCheck.run(makeCtx(dataDir));
    const finding = findings.find((candidate) => candidate.check === "LCD schema");
    expect(finding?.status).toBe("fail");
    expect(finding?.message).toContain("lcd_summary_parents");
    expect(findings.find((candidate) => candidate.check === "LCD Store open")).toBeUndefined();
  });

  // Content-free discipline — no finding message contains seeded message content
  it("finding messages contain only counts/IDs/errorKind strings — no actual message content", async () => {
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
