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
 * ## The load-bearing security boundary
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
import { randomUUID } from "node:crypto";
import type { MemoryConfig, MemoryEntry, SessionKey } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { ensureMemoryColumns } from "./schema.js";
import {
  createSqliteMemoryLifecycleStore,
  type MemoryLifecyclePolicy,
} from "./sqlite-memory-lifecycle-store.js";
import { createRowMapper } from "./row-mapper.js";
import { MemoryLifecycleRowSchema } from "./row-schemas.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  enabled: true,
  dbPath: ":memory:",
  walMode: false,
  // Phase 226: the recall keepers nest under memory.recall (design §5).
  recall: {
    embeddingModel: "test-model",
    embeddingDimensions: 4,
    rerankerModel: "hf:test/reranker.gguf",
  },
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0 },
  rerankerModelsDir: "models",
  rerankerGpu: "false",
  rerankerThreads: 4,
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
    pinned?: boolean;
  },
): void {
  target
    .prepare(
      `INSERT INTO memories
        (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, occurred_at, proof_count, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
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
      opts.pinned ? 1 : 0,
    );
}

/**
 * Seed `memory_usefulness.failure_count` for a memory (the FORGET-02 wrongness
 * signal the lifecycle sweep reads). Scoped to the same (tenant, agent) + the
 * given intent bucket ('' = global). The sweep SUMs failure_count across intents.
 */
function seedFailureCount(
  target: Database.Database,
  opts: {
    memoryId: string;
    tenantId?: string;
    agentId?: string;
    intent?: string;
    failureCount: number;
  },
): void {
  target
    .prepare(
      `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, failure_count)
       VALUES (?, ?, ?, ?, 0, 0, ?)
       ON CONFLICT(tenant_id, agent_id, memory_id, intent) DO UPDATE SET failure_count = excluded.failure_count`,
    )
    .run(
      opts.tenantId ?? "tenant_a",
      opts.agentId ?? "agent_x",
      opts.memoryId,
      opts.intent ?? "",
      opts.failureCount,
    );
}

/**
 * Seed `memory_usefulness.last_useful_at` (the last-recall recency signal) for a
 * memory — WR-02: the dormancy branch must key off ACTUAL disuse (last recall),
 * not `occurred_at` (event time). Scoped to the same (tenant, agent) + intent bucket.
 */
function seedLastUseful(
  target: Database.Database,
  opts: {
    memoryId: string;
    tenantId?: string;
    agentId?: string;
    intent?: string;
    lastUsefulAt: number;
    usedCount?: number;
  },
): void {
  target
    .prepare(
      `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, last_useful_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(tenant_id, agent_id, memory_id, intent) DO UPDATE SET used_count = excluded.used_count, last_useful_at = excluded.last_useful_at`,
    )
    .run(
      opts.tenantId ?? "tenant_a",
      opts.agentId ?? "agent_x",
      opts.memoryId,
      opts.intent ?? "",
      opts.usedCount ?? 1,
      opts.lastUsefulAt,
    );
}

/** Read the evicted_at marker for a memory id (NULL = live, non-NULL = soft-evicted). */
function evictedAtOf(target: Database.Database, id: string): number | null {
  return (
    target.prepare("SELECT evicted_at FROM memories WHERE id = ?").get(id) as {
      evicted_at: number | null;
    }
  ).evicted_at;
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
          pinned: 0,
          trust_level: "learned",
          failure_count: null,
          last_useful_at: null,
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
          pinned: 1,
          trust_level: "system",
          failure_count: 4,
          last_useful_at: 7000,
        },
      ]);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value).toHaveLength(2);
        expect(parsed.value[0]?.evicted_at).toBeNull();
        expect(parsed.value[0]?.last_useful_at).toBeNull();
        expect(parsed.value[1]?.strength).toBe(0.42);
        expect(parsed.value[1]?.last_useful_at).toBe(7000);
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

  // ── LIVE soft eviction (FORGET-01/02/03/04) — gated on the eviction policy ──
  // The DORMANT scaffold above acts on nothing. With an EVICTION-ENABLED policy
  // the sweep applies REAL soft eviction: it sets evicted_at (never DELETE) on a
  // candidate that is DORMANT past T_max OR corroborated-wrong (failure_count >=
  // failureEvictionFloor), exempts high-proof/system/pinned, and is reversible.
  //
  // POST-224-02: the FadeMem strength-decay disjunct is DELETED. Eviction is driven
  // by the two reachable disjuncts ONLY — dormancy and the corroborated-failure
  // floor. These tests therefore drive wrongness eviction via `failureEvictionFloor`
  // (NOT a strengthThreshold), matching the post-collapse candidacy form.
  describe("runLifecycleSweep (LIVE soft eviction — eviction policy enabled)", () => {
    let adapter: SqliteMemoryAdapter;
    let db: Database.Database;
    let store: ReturnType<typeof createSqliteMemoryLifecycleStore>;

    // The eviction-enabled policy (the post-collapse shape — no strength/decay
    // fields): the corroborated-failure floor drives wrongness eviction; the
    // dormancy window drives age eviction; highProofFloor exempts well-corroborated
    // memories. `failureEvictionFloor: 3` is the realistic default the daemon threads.
    const EVICTION_POLICY: MemoryLifecyclePolicy = {
      maxDormantDays: 90,
      evictionEnabled: true,
      highProofFloor: 5,
      failureEvictionFloor: 3,
    };

    beforeEach(() => {
      adapter = new SqliteMemoryAdapter(memoryConfig);
      db = adapter.getDb();
      store = createSqliteMemoryLifecycleStore({ db, policy: EVICTION_POLICY });
    });

    afterEach(() => {
      adapter.close();
    });

    it("FORGET-04 keystone: a wrong-but-RECENT memory evicts BEFORE an old-but-CORRECT one", async () => {
      // A: RECENT (1 day → not dormant) but WRONG (failure_count >= floor) →
      //    the corroborated-failure disjunct evicts it.
      // B: OLD (60 days, within T_max) but CORRECT (high proof_count, zero failures).
      //    Its proof importance (above highProofFloor) exempts it → NOT evicted.
      insertMemory(db, { id: "A-wrong-recent", content: "recent but wrong", memoryType: "semantic", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
      seedLastUseful(db, { memoryId: "A-wrong-recent", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "A-wrong-recent", failureCount: 8 });
      insertMemory(db, { id: "B-correct-old", content: "old but correct", memoryType: "semantic", occurredAt: T0 - 60 * DAY_MS, proofCount: 9 });
      seedLastUseful(db, { memoryId: "B-correct-old", lastUsefulAt: T0 - 60 * DAY_MS });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // At least the wrong-but-recent one was evicted; the old-but-correct one survives.
        expect(res.value.evicted).toBeGreaterThanOrEqual(1);
      }
      expect(evictedAtOf(db, "A-wrong-recent"), "wrong-but-recent must be evicted").not.toBeNull();
      expect(evictedAtOf(db, "B-correct-old"), "old-but-correct must survive").toBeNull();
    });

    it("recall-exclusion contract: an evicted row is SOFT-closed (evicted_at set, NOT deleted)", async () => {
      // The store side of the recall-exclusion contract: eviction is a marker, the
      // raw row remains in the table (resolvable via a direct/asOf read). The
      // FORGET-02-reachability describe below proves the recall-exclusion half
      // end-to-end through the real adapter's vec + FTS lanes.
      insertMemory(db, { id: "evict-soft", content: "weak", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null });
      seedLastUseful(db, { memoryId: "evict-soft", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "evict-soft", failureCount: 6 });

      const before = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE tenant_id='tenant_a' AND agent_id='agent_x'").get() as { c: number }).c;
      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);

      // SOFT: the row count is UNCHANGED (no DELETE) and evicted_at is set.
      const after = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE tenant_id='tenant_a' AND agent_id='agent_x'").get() as { c: number }).c;
      expect(after).toBe(before);
      expect(evictedAtOf(db, "evict-soft")).not.toBeNull();
      // The raw row still resolves via a direct read (the asOf/inspect audit path).
      const raw = db.prepare("SELECT id, content FROM memories WHERE id = 'evict-soft'").get() as { id: string; content: string };
      expect(raw.id).toBe("evict-soft");
      expect(raw.content).toBe("weak");
    });

    it("FORGET-03 exemption: a single failure does NOT evict a HIGH-proof memory", async () => {
      // The anti-induced-eviction guarantee: a high proof_count memory is exempt
      // from eviction even when a failure is recorded against it. A poisoner cannot
      // evict a well-corroborated memory by inducing one failure (also < floor).
      insertMemory(db, { id: "high-proof", content: "well corroborated", memoryType: "semantic", occurredAt: T0 - 1 * DAY_MS, proofCount: 20 });
      seedLastUseful(db, { memoryId: "high-proof", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "high-proof", failureCount: 1 });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "high-proof"), "high-proof memory must be exempt").toBeNull();
    });

    it("FORGET-03 exemption: pinned + system memories are NEVER evicted (failures >= floor)", async () => {
      // pinned=1 and trust_level='system' are hard exemptions regardless of the
      // corroborated-failure floor (here 9 >> floor 3).
      insertMemory(db, { id: "pinned-weak", content: "pinned", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null, pinned: true });
      seedLastUseful(db, { memoryId: "pinned-weak", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "pinned-weak", failureCount: 9 });
      insertMemory(db, { id: "system-weak", content: "system", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null, trustLevel: "system" });
      seedLastUseful(db, { memoryId: "system-weak", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "system-weak", failureCount: 9 });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "pinned-weak"), "pinned must be exempt").toBeNull();
      expect(evictedAtOf(db, "system-weak"), "system must be exempt").toBeNull();
    });

    it("EVI-STRENGTH-FLOOR (224-02): a recent, recalled, zero-failure aged-event memory is NOT evicted by the (deleted) strength disjunct", async () => {
      // The GENUINE RED for the strength-disjunct deletion. A `working`-type memory whose
      // EVENT is 80 days old (within T_max 90 → NOT dormant) but RECALLED yesterday
      // (disuse ~1 → NOT dormant) with ZERO failures (failure disjunct OFF). On the PRE-patch
      // 3-disjunct code this memory is evicted SOLELY because its decayed `working`-decay
      // strength dips below the strengthThreshold — so this assertion (survives) FAILS pre-patch
      // (RED). POST-patch the strength disjunct is DELETED: neither the dormancy nor the
      // corroborated-failure disjunct reaches it, so it SURVIVES (GREEN). The strengthThreshold
      // 0.99 is the value the legacy LIVE suite used to force the strength branch; it is removed
      // in the GREEN step when the field itself is deleted (the assertion is unchanged).
      const strengthStore = createSqliteMemoryLifecycleStore({
        db,
        policy: {
          thetaPromote: 0.7,
          thetaDemote: 0.3,
          epsilonPrune: 0.05,
          maxDormantDays: 90,
          evictionEnabled: true,
          strengthThreshold: 0.99,
          failurePenalty: 0.5,
          highProofFloor: 5,
          failureEvictionFloor: 3,
        },
      });
      insertMemory(db, { id: "aged-recalled-clean", content: "an 80-day-old fact recalled yesterday, never wrong", memoryType: "working", occurredAt: T0 - 80 * DAY_MS, proofCount: null });
      seedLastUseful(db, { memoryId: "aged-recalled-clean", lastUsefulAt: T0 - 1 * DAY_MS });
      const res = await strengthStore.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(
        evictedAtOf(db, "aged-recalled-clean"),
        "a recent-recall, zero-failure memory must NOT evict once the dead strength disjunct is removed",
      ).toBeNull();
    });

    it("FORGET-02 coupling: two RECENT memories identical except failure_count — only the >=floor one evicts", async () => {
      // Both RECENT (not dormant), same proof_count (below the high-proof floor). The
      // ONLY difference is failure_count. The corroborated-failure floor evicts the
      // high-failure one; the zero-failure one survives (no eviction without wrongness).
      insertMemory(db, { id: "fc-high", content: "wrong", memoryType: "semantic", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
      seedLastUseful(db, { memoryId: "fc-high", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "fc-high", failureCount: 10 });
      insertMemory(db, { id: "fc-zero", content: "fine", memoryType: "semantic", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
      seedLastUseful(db, { memoryId: "fc-zero", lastUsefulAt: T0 - 1 * DAY_MS });
      // fc-zero: no failure row at all → failure_count 0.

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "fc-high"), "failure_count >= floor must evict").not.toBeNull();
      expect(evictedAtOf(db, "fc-zero"), "zero failure_count must survive (no eviction without wrongness)").toBeNull();
    });

    it("reversibility (FORGET-04): unevict clears evicted_at, restoring the row", async () => {
      insertMemory(db, { id: "revivable", content: "weak then useful", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null });
      seedLastUseful(db, { memoryId: "revivable", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "revivable", failureCount: 6 });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "revivable")).not.toBeNull();

      // Renewed usefulness → un-evict. The port exposes the reversal.
      const un = await store.unevict("revivable", { tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(un.ok).toBe(true);
      expect(evictedAtOf(db, "revivable"), "evicted_at must be cleared after unevict").toBeNull();
    });

    it("unevict is (tenant, agent)-scoped: it does NOT clear a foreign-scope eviction", async () => {
      // A foreign-scope row that is already evicted; an unevict under a different
      // scope must NOT touch it (the isolation boundary holds on the reversal too).
      insertMemory(db, { id: "foreign-evicted", content: "theirs", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null, tenantId: "tenant_b", agentId: "agent_x" });
      db.prepare("UPDATE memories SET evicted_at = ? WHERE id = 'foreign-evicted'").run(T0);

      const un = await store.unevict("foreign-evicted", { tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(un.ok).toBe(true);
      // Still evicted — the foreign scope was not reached.
      expect(evictedAtOf(db, "foreign-evicted")).not.toBeNull();
    });

    it("dead-branch-live: an off-policy fixture that WAS evicted=0 now evicts >=1 (the LIVE eviction branch executes)", async () => {
      // The exact off-policy fixture the DORMANT Test 2 asserts evicts 0 — under the
      // eviction-enabled policy it now evicts >=1 via the DORMANT-age disjunct (10y
      // dormant, never recalled), proving the previously-dormant LIVE_EVICTION branch executes.
      insertMemory(db, {
        id: "evict-me",
        content: "stale, ignored, ancient — the live policy would prune this",
        memoryType: "working",
        occurredAt: T0 - 3650 * DAY_MS,
        proofCount: null,
      });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.evicted).toBeGreaterThanOrEqual(1);
      expect(evictedAtOf(db, "evict-me")).not.toBeNull();
    });

    it("eviction is (tenant, agent)-scoped: a foreign-scope weak row is never evicted", async () => {
      insertMemory(db, { id: "mine-weak", content: "mine", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null, tenantId: "tenant_a", agentId: "agent_x" });
      seedLastUseful(db, { memoryId: "mine-weak", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "mine-weak", failureCount: 6 });
      insertMemory(db, { id: "foreign-weak", content: "theirs", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null, tenantId: "tenant_b", agentId: "agent_x" });
      // Even seed a failure for the foreign one under ITS scope — still must not be reached.
      seedFailureCount(db, { memoryId: "foreign-weak", tenantId: "tenant_b", failureCount: 9 });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "foreign-weak"), "foreign scope must be untouched").toBeNull();
    });

    it("default policy (no eviction config) stays DORMANT — byte-identity guarantee", async () => {
      // A store built WITHOUT the eviction policy (the default) must evict NOTHING,
      // even for a row the eviction-enabled policy would prune. This is the
      // default-off byte-identity guarantee.
      const dormantStore = createSqliteMemoryLifecycleStore({ db });
      insertMemory(db, { id: "would-evict", content: "weak", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null });
      seedFailureCount(db, { memoryId: "would-evict", failureCount: 9 });

      const res = await dormantStore.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.evicted).toBe(0);
      expect(evictedAtOf(db, "would-evict"), "default policy must not evict").toBeNull();
    });

    it("FORGET-06 per-call policy: a scope.policy override activates eviction on a DORMANT-constructed store (the daemon's per-agent path)", async () => {
      // The store is built DORMANT (no constructor policy), but the daemon threads the
      // per-agent learningForgetting policy on the SWEEP CALL. The per-call policy must
      // activate eviction so a different agent on the SAME shared store can run with its
      // own policy (per-agent, not a constructor-frozen global).
      const dormantStore = createSqliteMemoryLifecycleStore({ db });
      insertMemory(db, { id: "evict-via-call", content: "weak", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null });
      seedLastUseful(db, { memoryId: "evict-via-call", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "evict-via-call", failureCount: 8 });

      const res = await dormantStore.runLifecycleSweep({
        tenantId: "tenant_a",
        agentId: "agent_x",
        now: T0,
        policy: { evictionEnabled: true, failureEvictionFloor: 3 },
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.evicted).toBeGreaterThanOrEqual(1);
      expect(evictedAtOf(db, "evict-via-call"), "per-call policy must evict").not.toBeNull();
    });

    it("FORGET-06 per-call policy absent → the DORMANT-constructed store still evicts NOTHING (byte-identity preserved)", async () => {
      const dormantStore = createSqliteMemoryLifecycleStore({ db });
      insertMemory(db, { id: "stays-live", content: "weak", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null });
      seedFailureCount(db, { memoryId: "stays-live", failureCount: 9 });
      // No scope.policy → falls back to the constructor (DORMANT) policy → evicts nothing.
      const res = await dormantStore.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.evicted).toBe(0);
      expect(evictedAtOf(db, "stays-live")).toBeNull();
    });

    // ── WR-02: the dormant-AGE branch must key off DISUSE (last recall), not EVENT age ──
    // FORGET-04: "wrong fades faster than merely OLD" — a recently-USEFUL memory about an
    // OLD event must NOT be reaped on event-age alone. The candidacy disjunct bases dormancy
    // on last_useful_at (last-recall recency), so a recently-useful old-event memory is NOT
    // "dormant". With NO failures and NO high-proof exemption, the dormant-age disjunct is the
    // SOLE possible eviction cause here, so the test pins the age path in isolation.
    describe("WR-02: dormant-age eviction keys off DISUSE, not EVENT age", () => {
      // The post-collapse policy shape: dormancy + failure floor only (no strength fields).
      const AGE_POLICY: MemoryLifecyclePolicy = {
        maxDormantDays: 90,
        evictionEnabled: true,
        highProofFloor: 5,
        failureEvictionFloor: 3,
      };

      it("a RECENTLY-USEFUL memory about an OLD event is NOT evicted by age alone (FORGET-04)", async () => {
        const ageStore = createSqliteMemoryLifecycleStore({ db, policy: AGE_POLICY });
        // OLD event (200 days ago → dormantDays-by-occurred_at >> 90) but recalled-useful
        // YESTERDAY (last_useful_at = T0 - 1 day). proof below the high-proof floor + NO
        // failures so neither the exemption nor the failure floor masks the fix — the
        // disuse-based dormancy is what saves it.
        insertMemory(db, { id: "old-event-recently-useful", content: "an old but still-true fact", memoryType: "semantic", occurredAt: T0 - 200 * DAY_MS, proofCount: 2 });
        seedLastUseful(db, { memoryId: "old-event-recently-useful", lastUsefulAt: T0 - 1 * DAY_MS, usedCount: 12 });

        const res = await ageStore.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
        expect(res.ok).toBe(true);
        expect(
          evictedAtOf(db, "old-event-recently-useful"),
          "a recently-recalled old-event memory must NOT be reaped on event-age alone",
        ).toBeNull();
      });

      it("a genuinely DORMANT old memory (never recalled) IS still evicted on age (the branch stays live)", async () => {
        const ageStore = createSqliteMemoryLifecycleStore({ db, policy: AGE_POLICY });
        // OLD event AND never recalled (no usefulness row → last_useful_at absent) → it is
        // genuinely dormant past T_max → still a candidate (the age reaper is not disabled,
        // only re-based on disuse; an absent last_useful_at falls back to event age).
        insertMemory(db, { id: "old-and-untouched", content: "an ancient, never-recalled note", memoryType: "semantic", occurredAt: T0 - 200 * DAY_MS, proofCount: 2 });

        const res = await ageStore.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
        expect(res.ok).toBe(true);
        expect(
          evictedAtOf(db, "old-and-untouched"),
          "a genuinely dormant (never-recalled) old memory is still reaped on age",
        ).not.toBeNull();
      });
    });
  });

  // ── RC-3: corroborated-failure eviction at the REALISTIC strengthThreshold ──
  // (EVI-STRENGTH-FLOOR fix, live 2026-06-25). The LIVE tests above use an artificial
  // strengthThreshold:0.99 — at the DEFAULT 0.2 the recall-shape strength (floored >0.25)
  // can NEVER drop below threshold, so a failure-implicated memory could only ever evict
  // via the 90-day dormant-age disjunct (proven inert live). These pin the new
  // corroborated-failure disjunct: a LOW-proof, non-exempt memory implicated in failures
  // >= failureEvictionFloor is soft-evicted; a HIGH-proof / pinned / system one NEVER
  // (the FORGET-03 anti-induced-eviction belt holds — each failure_count increment is
  // itself corroboration-gated).
  describe("runLifecycleSweep (RC-3: corroborated-failure eviction at the realistic threshold)", () => {
    let adapter: SqliteMemoryAdapter;
    let db: Database.Database;
    let store: ReturnType<typeof createSqliteMemoryLifecycleStore>;
    // POST-224-02: the strength disjunct is DELETED, so the corroborated-failure floor
    // is the SOLE wrongness-eviction path (the EVI-STRENGTH-FLOOR fix made permanent).
    const REALISTIC_POLICY: MemoryLifecyclePolicy = {
      maxDormantDays: 90, evictionEnabled: true, highProofFloor: 5,
      failureEvictionFloor: 3,
    };
    beforeEach(() => { adapter = new SqliteMemoryAdapter(memoryConfig); db = adapter.getDb(); store = createSqliteMemoryLifecycleStore({ db, policy: REALISTIC_POLICY }); });
    afterEach(() => { adapter.close(); });

    it("evicts a LOW-proof RECENT memory with corroborated failures >= floor (strength alone could NOT — EVI-STRENGTH-FLOOR)", async () => {
      // Recent (1 day → base strength ~1.0) + low-proof + 3 corroborated failures: strength
      // stays >0.25 (>threshold 0.2) and it is NOT dormant → the ONLY eviction path is the
      // corroborated-failure disjunct. RED pre-fix (no disjunct → the memory survives).
      insertMemory(db, { id: "wrong-recent-lowproof", content: "repeatedly wrong", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
      seedLastUseful(db, { memoryId: "wrong-recent-lowproof", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "wrong-recent-lowproof", failureCount: 3 });
      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.evicted).toBeGreaterThanOrEqual(1);
      expect(evictedAtOf(db, "wrong-recent-lowproof"), "low-proof sustained-wrong must evict").not.toBeNull();
    });

    it("NEVER evicts a HIGH-proof memory with the SAME failures (FORGET-03 anti-induced-eviction holds)", async () => {
      insertMemory(db, { id: "wrong-but-corroborated", content: "wrong but well-proven", occurredAt: T0 - 1 * DAY_MS, proofCount: 5 });
      seedLastUseful(db, { memoryId: "wrong-but-corroborated", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "wrong-but-corroborated", failureCount: 8 });
      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "wrong-but-corroborated"), "high-proof memory must survive induced failures").toBeNull();
    });

    it("NEVER evicts a PINNED memory with failures >= floor (pinned exemption holds)", async () => {
      insertMemory(db, { id: "wrong-but-pinned", content: "wrong but pinned", occurredAt: T0 - 1 * DAY_MS, proofCount: 1, pinned: true });
      seedLastUseful(db, { memoryId: "wrong-but-pinned", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "wrong-but-pinned", failureCount: 8 });
      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "wrong-but-pinned"), "pinned memory must survive induced failures").toBeNull();
    });

    it("NEVER evicts a SYSTEM-trust memory with the SAME failures (FORGET-03 direction B)", async () => {
      // INV-4 direction B: trust_level='system' is a hard exemption. A poisoner who
      // drives failures >= floor on a system memory still cannot evict it.
      insertMemory(db, { id: "wrong-but-system", content: "wrong but system-trust", occurredAt: T0 - 1 * DAY_MS, proofCount: 1, trustLevel: "system" });
      seedLastUseful(db, { memoryId: "wrong-but-system", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "wrong-but-system", failureCount: 8 });
      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "wrong-but-system"), "system-trust memory must survive induced failures").toBeNull();
    });

    it("does NOT evict below the floor: a recent low-proof memory with failures < floor survives", async () => {
      insertMemory(db, { id: "few-failures", content: "occasionally wrong", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
      seedLastUseful(db, { memoryId: "few-failures", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "few-failures", failureCount: 2 }); // < floor 3 → not a candidate
      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "few-failures"), "below-floor failures must not evict").toBeNull();
    });

    it("a DORMANT policy (evictionEnabled off) ignores the failure floor — byte-identity", async () => {
      const dormant = createSqliteMemoryLifecycleStore({ db, policy: { ...REALISTIC_POLICY, evictionEnabled: false } });
      insertMemory(db, { id: "wrong-dormant-policy", content: "wrong", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
      seedLastUseful(db, { memoryId: "wrong-dormant-policy", lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: "wrong-dormant-policy", failureCount: 8 });
      const res = await dormant.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.evicted).toBe(0);
      expect(evictedAtOf(db, "wrong-dormant-policy")).toBeNull();
    });
  });

  // ── FORGET-02 END-TO-END reachability: evicted row gone from BOTH recall lanes ──
  // The EVI-STRENGTH-FLOOR fix made permanent (224-02). The RC-3 describe above proves
  // the STORE-side soft-eviction (evicted_at set). This proves the RECONCILIATION
  // end-to-end through the REAL SqliteMemoryAdapter.search(): a recently-recalled (so the
  // dormancy disjunct CANNOT fire), corroborated-wrong (failure_count >= floor), LOW-proof,
  // non-exempt memory ACTUALLY soft-evicts via runLifecycleSweep AND then disappears from
  // BOTH the vector-only lane (search(sk, number[])) and the FTS/hybrid lane
  // (search(sk, string)). The `evicted_at IS NULL` exclusion is already wired on both lanes
  // (hybrid-search.ts + sqlite-memory-adapter.ts) — this drives it, it does NOT add a filter.
  describe("FORGET-02 reachability: a soft-evicted row is absent from BOTH recall lanes (end-to-end)", () => {
    let adapter: SqliteMemoryAdapter;
    let db: Database.Database;
    let store: ReturnType<typeof createSqliteMemoryLifecycleStore>;
    const REALISTIC_POLICY: MemoryLifecyclePolicy = {
      maxDormantDays: 90, evictionEnabled: true, highProofFloor: 5, failureEvictionFloor: 3,
    };
    const QUERY_VEC = [0.1, 0.2, 0.3, 0.4]; // matches memoryConfig.embeddingDimensions = 4
    const sk: SessionKey = { tenantId: "tenant_a", userId: "u1", channelId: "c1", agentId: "agent_x" };

    beforeEach(() => {
      adapter = new SqliteMemoryAdapter(memoryConfig);
      db = adapter.getDb();
      store = createSqliteMemoryLifecycleStore({ db, policy: REALISTIC_POLICY });
    });
    afterEach(() => {
      adapter.close();
    });

    /** Store via the REAL adapter so BOTH a FTS row AND a vec embedding exist for the id. */
    async function storeRecallable(id: string, content: string): Promise<void> {
      const entry: MemoryEntry = {
        id,
        tenantId: "tenant_a",
        agentId: "agent_x",
        userId: "u1",
        content,
        trustLevel: "learned",
        memoryType: "semantic",
        source: { who: "agent" },
        tags: [],
        createdAt: T0 - 1 * DAY_MS,
        occurredAt: T0 - 1 * DAY_MS,
        proofCount: 1, // LOW proof (below highProofFloor 5) → not exempt
        embedding: QUERY_VEC,
      };
      const res = await adapter.store(entry);
      expect(res.ok, res.ok ? "" : `store failed: ${res.error.message}`).toBe(true);
    }

    it("a recent-recall + corroborated-failure memory soft-evicts and vanishes from the vec AND FTS lanes", async () => {
      const id = randomUUID();
      await storeRecallable(id, "the quick brown fox jumps over the lazy dog");
      // Recently recalled → NOT dormant (the dormancy disjunct CANNOT be the cause) +
      // corroborated failures >= floor → the ONLY eviction path is the failure disjunct.
      seedLastUseful(db, { memoryId: id, lastUsefulAt: T0 - 1 * DAY_MS });
      seedFailureCount(db, { memoryId: id, failureCount: 3 });

      // BEFORE: recalled by BOTH lanes (proves the row is genuinely recallable, so a later
      // absence is eviction, not a never-indexed artifact).
      const ftsBefore = await adapter.search(sk, "fox", { agentId: "agent_x" });
      const vecBefore = await adapter.search(sk, QUERY_VEC, { agentId: "agent_x" });
      expect(ftsBefore.ok && vecBefore.ok).toBe(true);
      if (ftsBefore.ok) expect(ftsBefore.value.map((r) => r.entry.id)).toContain(id);
      if (vecBefore.ok) expect(vecBefore.value.map((r) => r.entry.id)).toContain(id);

      // SWEEP under the realistic-default policy → the corroborated-failure disjunct evicts it.
      const sweep = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(sweep.ok).toBe(true);
      if (sweep.ok) expect(sweep.value.evicted).toBeGreaterThanOrEqual(1);
      expect(evictedAtOf(db, id), "the corroborated-wrong low-proof memory must soft-evict").not.toBeNull();

      // AFTER: ABSENT from BOTH recall lanes (the vec + FTS reconciliation, in lockstep).
      const ftsAfter = await adapter.search(sk, "fox", { agentId: "agent_x" });
      const vecAfter = await adapter.search(sk, QUERY_VEC, { agentId: "agent_x" });
      expect(ftsAfter.ok && vecAfter.ok).toBe(true);
      if (ftsAfter.ok) expect(ftsAfter.value.map((r) => r.entry.id), "evicted row must be gone from the FTS lane").not.toContain(id);
      if (vecAfter.ok) expect(vecAfter.value.map((r) => r.entry.id), "evicted row must be gone from the vec lane").not.toContain(id);

      // SOFT: the raw row still resolves via a direct read (eviction is a marker, not a DELETE).
      const raw = db.prepare("SELECT id FROM memories WHERE id = ?").get(id) as { id: string } | undefined;
      expect(raw?.id, "the evicted row is soft-closed, still present for asOf/audit").toBe(id);
    });
  });

  // ── FORGET-01 candidacy PARITY: the two-disjunct form, the strength term was dead ──
  // A matrix proving the eviction candidacy equals exactly
  //   !exempt && (disuseDays > maxDormantDays || (liveEviction && failureCount >= floor))
  // i.e. the deleted `strength < strengthThreshold` disjunct contributed nothing reachable.
  // We assert the OBSERVABLE candidacy (a non-exempt candidate soft-evicts iff the expected
  // predicate holds) across a small input matrix — the store has no public candidacy fn, so
  // the sweep's eviction decision IS the candidacy oracle.
  describe("FORGET-01 candidacy parity: candidacy === dormancy || (live && failure>=floor), minus exempt", () => {
    let adapter: SqliteMemoryAdapter;
    let db: Database.Database;
    let store: ReturnType<typeof createSqliteMemoryLifecycleStore>;
    const FLOOR = 3;
    const MAX_DORMANT = 90;
    const POLICY: MemoryLifecyclePolicy = {
      maxDormantDays: MAX_DORMANT, evictionEnabled: true, highProofFloor: 5, failureEvictionFloor: FLOOR,
    };

    beforeEach(() => {
      adapter = new SqliteMemoryAdapter(memoryConfig);
      db = adapter.getDb();
      store = createSqliteMemoryLifecycleStore({ db, policy: POLICY });
    });
    afterEach(() => {
      adapter.close();
    });

    // A non-exempt input matrix over (disuseDays, failureCount). proof=1 (< highProofFloor),
    // not pinned, not system → never exempt, so candidacy = dormancy || failure>=floor.
    interface Case {
      name: string;
      disuseDays: number;
      failureCount: number;
    }
    const cases: Case[] = [
      { name: "recent+no-failures → survives", disuseDays: 1, failureCount: 0 },
      { name: "recent+below-floor → survives", disuseDays: 1, failureCount: FLOOR - 1 },
      { name: "recent+at-floor → evicts (failure disjunct)", disuseDays: 1, failureCount: FLOOR },
      { name: "recent+above-floor → evicts (failure disjunct)", disuseDays: 1, failureCount: FLOOR + 5 },
      { name: "dormant+no-failures → evicts (dormancy disjunct)", disuseDays: MAX_DORMANT + 10, failureCount: 0 },
      { name: "dormant+above-floor → evicts (both disjuncts)", disuseDays: MAX_DORMANT + 10, failureCount: FLOOR + 1 },
      { name: "at-dormancy-boundary+no-failures → survives (strict >)", disuseDays: MAX_DORMANT, failureCount: 0 },
    ];

    for (const c of cases) {
      it(`parity: ${c.name}`, async () => {
        const id = `case-${c.disuseDays}-${c.failureCount}`;
        // occurred_at long ago so the row exists; last_useful_at = now - disuseDays controls dormancy.
        insertMemory(db, { id, content: "matrix row", memoryType: "semantic", occurredAt: T0 - 400 * DAY_MS, proofCount: 1 });
        seedLastUseful(db, { memoryId: id, lastUsefulAt: T0 - c.disuseDays * DAY_MS });
        if (c.failureCount > 0) seedFailureCount(db, { memoryId: id, failureCount: c.failureCount });

        const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
        expect(res.ok).toBe(true);

        const expectedEvict = c.disuseDays > MAX_DORMANT || c.failureCount >= FLOOR;
        const actuallyEvicted = evictedAtOf(db, id) !== null;
        expect(
          actuallyEvicted,
          `${c.name}: expected evicted=${expectedEvict} (disuse ${c.disuseDays} > ${MAX_DORMANT} || failures ${c.failureCount} >= ${FLOOR})`,
        ).toBe(expectedEvict);
      });
    }
  });
});
