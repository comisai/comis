// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteMemoryLifecycleStore` — the SOLE @comis/memory
 * adapter for the `MemoryLifecyclePort` port. It
 * owns ALL the per-(tenant, agent) lifecycle SQL over the `memories` table + its
 * additive NON-DESTRUCTIVE marker columns.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `initSchema` → `ensureMemoryColumns` runs — the lifecycle marker columns are
 * added on boot) and gets `adapter.getDb()` (mirrors the tuned-alpha /
 * usefulness store tests).
 *
 * ## The SCAFFOLD-DORMANT gate
 *
 * The sweep is DORMANT: it scans + computes
 * strengths/tiers but its demote/evict/promote step performs NOTHING —
 * `promoted`/`demoted`/`evicted` stay 0, NO row is deleted, every marker column
 * stays NULL — whether the live policy WOULD touch a row or not. The RED for this
 * is a full-eviction mis-implementation; the GREEN is the no-op sweep. Live
 * eviction is the deferred operator step.
 *
 * ## The load-bearing security boundary (the §5.2 invariant)
 *
 * Comis runs many agents and many tenants in ONE DB. Every adapter statement —
 * the candidate SELECT, any read — filters on `(tenant_id, agent_id)`. A sweep
 * run under one (tenant, agent) MUST NEVER read or touch another scope's rows —
 * proven by the isolation test (Test 3), which FAILS if the WHERE drops either
 * filter column.
 *
 * ## The additive marker (the PK-widening lesson)
 *
 * The lifecycle markers are nullable side-columns added via `ALTER TABLE ADD
 * COLUMN` — the `memories` PK is UNCHANGED (no transactional table rebuild). A
 * pre-112 DB's rows survive with a NULL marker (not-evicted = byte-identity).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { ensureMemoryColumns } from "./schema.js";
import { createSqliteMemoryLifecycleStore } from "./sqlite-memory-lifecycle-store.js";
import { createRowMapper } from "./row-mapper.js";
import { MemoryLifecycleRowSchema } from "./row-schemas.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
};

const DAY_MS = 86_400_000;
// A fixed "now" so the dormancy/age math is deterministic (the injected clock —
// never Date.now). T0 is well past any seeded event time so the seeded rows look
// stale/dormant to the live policy the DORMANT scaffold deliberately does NOT run.
const T0 = 1_700_000_000_000;

/** The two lifecycle marker columns + the strength side-column this plan adds. */
const LIFECYCLE_COLS = ["lifecycle_demoted_at", "evicted_at", "strength"];

/**
 * Build a `memories` table at the PRE-112 shape (the observation + typed-
 * observation columns present, the 3 lifecycle marker columns absent) — the shape
 * a live ~/.comis DB has before this phase. Mirrors `createPreObservationTable`
 * in schema.test.ts.
 */
function createPre112Table(target: Database.Database): void {
  target.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'semantic',
      source_who TEXT NOT NULL,
      source_channel TEXT,
      source_session_key TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      occurred_at INTEGER,
      proof_count INTEGER,
      source_ids TEXT,
      consolidated_at INTEGER,
      confidence REAL,
      history TEXT,
      observation_kind TEXT,
      pattern_type TEXT,
      updated_at INTEGER,
      expires_at INTEGER,
      has_embedding INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/** The list of PK column names for the `memories` table (PRAGMA pk > 0). */
function pkColumns(target: Database.Database): string[] {
  return (
    target.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string; pk: number }>
  )
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

/**
 * Insert one `memories` row. The lifecycle markers (lifecycle_demoted_at /
 * evicted_at / strength) are NEVER set on insert — they default to NULL (the
 * pre-feature default; the DORMANT sweep keeps them NULL).
 */
function insertMemory(
  target: Database.Database,
  opts: {
    id: string;
    tenantId?: string;
    agentId?: string;
    content: string;
    memoryType?: string;
    occurredAt: number;
    proofCount?: number | null;
    trustLevel?: string;
  },
): void {
  target
    .prepare(
      `INSERT INTO memories
        (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, occurred_at, proof_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.tenantId ?? "tenant_a",
      opts.agentId ?? "agent_x",
      "u1",
      opts.content,
      opts.trustLevel ?? "learned",
      opts.memoryType ?? "semantic",
      "agent",
      opts.occurredAt, // created_at = occurred_at for the fixtures
      opts.occurredAt,
      opts.proofCount ?? null,
    );
}

describe("createSqliteMemoryLifecycleStore", () => {
  // ── The additive nullable lifecycle marker + the row-schema ─────────
  describe("the additive nullable lifecycle marker (NO PK change)", () => {
    let adapter: SqliteMemoryAdapter;
    let db: Database.Database;

    beforeEach(() => {
      adapter = new SqliteMemoryAdapter(memoryConfig);
      db = adapter.getDb();
    });

    afterEach(() => {
      adapter.close();
    });

    it("Test 1: adds the lifecycle marker column(s) on a fresh DB, nullable, no CHECK", () => {
      const info = db.prepare("PRAGMA table_info(memories)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const byName = new Map(info.map((c) => [c.name, c]));
      for (const col of LIFECYCLE_COLS) {
        const c = byName.get(col);
        expect(c, `column ${col} must exist on a fresh DB`).toBeDefined();
        // Nullable: notnull flag is 0 (NULL = the pre-feature default = byte-identity).
        expect(c?.notnull, `column ${col} must be nullable`).toBe(0);
      }
      // No post-hoc CHECK on the markers — the enum/range is the domain type's job
      // (mirror the consolidated_at no-CHECK precedent). The whole-table SQL must
      // carry no CHECK clause naming a lifecycle marker.
      const tableSql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
          .get() as { sql: string }
      ).sql;
      expect(tableSql).not.toMatch(/CHECK\s*\([^)]*evicted_at/i);
      expect(tableSql).not.toMatch(/CHECK\s*\([^)]*lifecycle_demoted_at/i);
    });

    it("Test 2: a PRE-112 DB's existing row SURVIVES with a NULL marker (additive, no rewrite/backfill)", () => {
      // The headline safety lesson: a CREATE-from-scratch-that-drops-rows
      // mis-implementation would FAIL this; the additive ALTER adds the column
      // WITH no backfill/rewrite/corruption.
      const fresh = new SqliteMemoryAdapter(memoryConfig);
      // Use a separate raw handle so we control the table shape exactly.
      const rawAdapter = new SqliteMemoryAdapter(memoryConfig);
      const raw = rawAdapter.getDb();
      // Drop the auto-created memories table + rebuild it at the pre-112 shape.
      raw.exec("DROP TABLE IF EXISTS memories");
      createPre112Table(raw);
      raw
        .prepare(
          `INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, occurred_at)
           VALUES ('pre-112', 'default', 'default', 'u1', 'an existing raw fact', 'learned', 'semantic', 'agent', '[]', 1000, 1000)`,
        )
        .run();

      const before = (
        raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const col of LIFECYCLE_COLS) expect(before).not.toContain(col);

      expect(() => ensureMemoryColumns(raw)).not.toThrow();

      const after = (
        raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const col of LIFECYCLE_COLS) expect(after).toContain(col);

      // The pre-existing row SURVIVES; every lifecycle marker is NULL (no backfill,
      // not-evicted = byte-identity).
      const row = raw
        .prepare(
          "SELECT id, content, lifecycle_demoted_at, evicted_at, strength FROM memories WHERE id = 'pre-112'",
        )
        .get() as Record<string, unknown>;
      expect(row.id).toBe("pre-112");
      expect(row.content).toBe("an existing raw fact");
      expect(row.lifecycle_demoted_at).toBeNull();
      expect(row.evicted_at).toBeNull();
      expect(row.strength).toBeNull();

      rawAdapter.close();
      fresh.close();
    });

    it("Test 3: the memories PRIMARY KEY is UNCHANGED by the marker add (no PK-widening rebuild)", () => {
      // Pre-112: build the table, snapshot the PK, ensure, snapshot again.
      const rawAdapter = new SqliteMemoryAdapter(memoryConfig);
      const raw = rawAdapter.getDb();
      raw.exec("DROP TABLE IF EXISTS memories");
      createPre112Table(raw);

      const pkBefore = pkColumns(raw);
      ensureMemoryColumns(raw);
      const pkAfter = pkColumns(raw);

      // The single-column `id` PK is unchanged — the markers are nullable
      // side-columns, never part of an identity key.
      expect(pkBefore).toEqual(["id"]);
      expect(pkAfter).toEqual(pkBefore);

      rawAdapter.close();
    });

    it("Test 4: the row-schema parses a row carrying the marker (nullable) via createRowMapper", () => {
      const mapper = createRowMapper(MemoryLifecycleRowSchema);
      // A row with the markers present (a demoted/evicted/strength-computed row)
      // and a row with all markers NULL (the DORMANT default) both parse.
      const parsed = mapper.parseRows([
        {
          id: "m1",
          memory_type: "semantic",
          occurred_at: 1000,
          created_at: 1000,
          proof_count: 3,
          lifecycle_demoted_at: null,
          evicted_at: null,
          strength: null,
        },
        {
          id: "m2",
          memory_type: "episodic",
          occurred_at: null,
          created_at: 2000,
          proof_count: null,
          lifecycle_demoted_at: 5000,
          evicted_at: 6000,
          strength: 0.42,
        },
      ]);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value).toHaveLength(2);
        expect(parsed.value[0]?.evicted_at).toBeNull();
        expect(parsed.value[1]?.strength).toBe(0.42);
      }
    });
  });

  // ── The DORMANT sweep + (tenant, agent) isolation ───────────────────
  describe("runLifecycleSweep (SCAFFOLD-DORMANT — evicts/demotes NOTHING)", () => {
    let adapter: SqliteMemoryAdapter;
    let db: Database.Database;
    let store: ReturnType<typeof createSqliteMemoryLifecycleStore>;

    /** Count rows for a scope (the row-count-unchanged assertions). */
    function rowCount(tenantId: string, agentId: string): number {
      return (
        db
          .prepare("SELECT COUNT(*) AS c FROM memories WHERE tenant_id = ? AND agent_id = ?")
          .get(tenantId, agentId) as { c: number }
      ).c;
    }

    /** Count rows with a non-NULL marker for a scope (must stay 0 — DORMANT). */
    function markedCount(tenantId: string, agentId: string, column: string): number {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM memories WHERE tenant_id = ? AND agent_id = ? AND ${column} IS NOT NULL`,
          )
          .get(tenantId, agentId) as { c: number }
      ).c;
    }

    beforeEach(() => {
      adapter = new SqliteMemoryAdapter(memoryConfig);
      db = adapter.getDb();
      store = createSqliteMemoryLifecycleStore({ db });
    });

    afterEach(() => {
      adapter.close();
    });

    it("Test 1: scans candidates but evicts/demotes NOTHING (report all-0, rows + markers unchanged)", async () => {
      // Seed varied event-ages / memoryTypes / proofs so the COMPUTED tiers and
      // strengths differ — but the DORMANT sweep acts on NONE of it.
      insertMemory(db, { id: "m1", content: "fresh durable", memoryType: "semantic", occurredAt: T0 - 1 * DAY_MS, proofCount: 5 });
      insertMemory(db, { id: "m2", content: "old ephemeral", memoryType: "episodic", occurredAt: T0 - 200 * DAY_MS, proofCount: null });
      insertMemory(db, { id: "m3", content: "mid working", memoryType: "working", occurredAt: T0 - 50 * DAY_MS, proofCount: 1 });

      const before = rowCount("tenant_a", "agent_x");
      expect(before).toBe(3);

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // The sweep MAY report scanned > 0 (it considered the candidates) but
        // promotes/demotes/evicts NOTHING.
        expect(res.value.scanned).toBeGreaterThan(0);
        expect(res.value.promoted).toBe(0);
        expect(res.value.demoted).toBe(0);
        expect(res.value.evicted).toBe(0);
      }

      // Row count UNCHANGED (NO DELETE) + every marker still NULL (NO UPDATE).
      expect(rowCount("tenant_a", "agent_x")).toBe(3);
      expect(markedCount("tenant_a", "agent_x", "evicted_at")).toBe(0);
      expect(markedCount("tenant_a", "agent_x", "lifecycle_demoted_at")).toBe(0);
    });

    it("Test 2: still evicts/demotes NOTHING even for a policy-VIOLATING row the live step WOULD evict", async () => {
      // A row whose computed strength is far below ε_prune AND dormant beyond
      // T_max (default 90d) — the LIVE policy would evict it. The DORMANT scaffold
      // does NOT. This is the RED: a full-eviction impl FAILS here.
      insertMemory(db, {
        id: "evict-me",
        content: "stale, ignored, ancient — the live policy would prune this",
        memoryType: "working", // ephemeral → sharp decay
        occurredAt: T0 - 3650 * DAY_MS, // 10 years dormant, well past T_max
        proofCount: null, // no corroboration → low importance → low strength
      });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.evicted).toBe(0);
        expect(res.value.demoted).toBe(0);
        expect(res.value.promoted).toBe(0);
      }
      // The row is still there + unmarked.
      expect(rowCount("tenant_a", "agent_x")).toBe(1);
      expect(markedCount("tenant_a", "agent_x", "evicted_at")).toBe(0);
      const row = db
        .prepare("SELECT evicted_at, lifecycle_demoted_at FROM memories WHERE id = 'evict-me'")
        .get() as Record<string, unknown>;
      expect(row.evicted_at).toBeNull();
      expect(row.lifecycle_demoted_at).toBeNull();
    });

    it("Test 3: (tenant, agent) isolation — a foreign-scope row is INVISIBLE + untouched (load-bearing)", async () => {
      // A row in (tenant_a, agent_x) and a foreign row in (tenant_b, agent_x) +
      // (tenant_a, agent_y). A sweep under (tenant_a, agent_x) must NOT scan or
      // touch the foreign rows — dropping `tenant_id=? AND agent_id=?` makes this
      // FAIL (mutation-verified).
      insertMemory(db, { id: "in-scope", content: "mine", occurredAt: T0 - 10 * DAY_MS, tenantId: "tenant_a", agentId: "agent_x" });
      insertMemory(db, { id: "foreign-tenant", content: "theirs", occurredAt: T0 - 10 * DAY_MS, tenantId: "tenant_b", agentId: "agent_x" });
      insertMemory(db, { id: "foreign-agent", content: "theirs", occurredAt: T0 - 10 * DAY_MS, tenantId: "tenant_a", agentId: "agent_y" });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // scanned counts ONLY the in-scope row — the foreign rows are invisible.
        expect(res.value.scanned).toBe(1);
      }
      // All three rows survive (DORMANT — nothing touched) AND the foreign rows
      // carry NULL markers (proves the sweep never reached across the scope).
      expect(rowCount("tenant_a", "agent_x")).toBe(1);
      expect(rowCount("tenant_b", "agent_x")).toBe(1);
      expect(rowCount("tenant_a", "agent_y")).toBe(1);
      expect(markedCount("tenant_b", "agent_x", "evicted_at")).toBe(0);
      expect(markedCount("tenant_a", "agent_y", "evicted_at")).toBe(0);
    });

    it("Test 4a: uses scope.now for the dormancy math (a different now still evicts 0 — deterministic, no Date.now)", async () => {
      insertMemory(db, { id: "m1", content: "x", occurredAt: T0 - 100 * DAY_MS });
      // Two different injected nows; the DORMANT sweep returns the same all-0
      // report (it reads scope.now, never the wall clock).
      const a = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      const b = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 + 365 * DAY_MS });
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(a.value.evicted).toBe(0);
        expect(b.value.evicted).toBe(0);
      }
    });

    it("Test 4b: an empty scope returns ok with scanned 0 (no candidates, never throws)", async () => {
      const res = await store.runLifecycleSweep({ tenantId: "nobody", agentId: "nobody", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toEqual({ scanned: 0, promoted: 0, demoted: 0, evicted: 0 });
      }
    });

    it("Test 4c: a DB error returns err(...) (never throws) — the prepared statement runs on a closed handle", async () => {
      // Close the underlying handle so the prepared statement throws inside the
      // sweep; the adapter must catch it and return err, never propagate.
      adapter.close();
      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(false);
      // Re-open for the afterEach close() (idempotent close is fine).
      adapter = new SqliteMemoryAdapter(memoryConfig);
      db = adapter.getDb();
    });
  });
});
