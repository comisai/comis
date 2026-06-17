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
import {
  createSqliteMemoryLifecycleStore,
  type MemoryLifecyclePolicy,
} from "./sqlite-memory-lifecycle-store.js";
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

  // ── LIVE soft eviction (FORGET-01/02/03/04) — gated on the eviction policy ──
  // The DORMANT scaffold above acts on nothing. With an EVICTION-ENABLED policy
  // the sweep applies REAL soft eviction: it sets evicted_at (never DELETE),
  // couples failure_count into strength (wrong-but-recent evicts before
  // old-but-correct), exempts high-proof/system/pinned, and is reversible.
  describe("runLifecycleSweep (LIVE soft eviction — eviction policy enabled)", () => {
    let adapter: SqliteMemoryAdapter;
    let db: Database.Database;
    let store: ReturnType<typeof createSqliteMemoryLifecycleStore>;

    // The eviction-enabled policy: a high strengthThreshold (0.99) so a
    // candidate's recall-shape strength (∈ [0.5, 1]) sits below it UNLESS its
    // proof importance keeps it high — making the failure_count coupling the
    // decisive lever the FORGET-04 keystone needs. failurePenalty drives the
    // wrongness coupling; highProofFloor exempts well-corroborated memories.
    const EVICTION_POLICY: MemoryLifecyclePolicy = {
      thetaPromote: 0.7,
      thetaDemote: 0.3,
      epsilonPrune: 0.05,
      maxDormantDays: 90,
      evictionEnabled: true,
      strengthThreshold: 0.99,
      failurePenalty: 0.5,
      highProofFloor: 5,
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
      // A: RECENT (1 day old → near-max base strength) but WRONG (high failure_count).
      //    The failurePenalty drives its strength below threshold → evicted.
      // B: OLD (60 days) but CORRECT (high proof_count, zero failures). Its proof
      //    importance (above highProofFloor) exempts it → NOT evicted.
      insertMemory(db, { id: "A-wrong-recent", content: "recent but wrong", memoryType: "semantic", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
      seedFailureCount(db, { memoryId: "A-wrong-recent", failureCount: 8 });
      insertMemory(db, { id: "B-correct-old", content: "old but correct", memoryType: "semantic", occurredAt: T0 - 60 * DAY_MS, proofCount: 9 });

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
      // hybrid-search recall filter (its own test) does the recall-exclusion half.
      insertMemory(db, { id: "evict-soft", content: "weak", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null });
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
      // evict a well-corroborated memory by inducing one failure.
      insertMemory(db, { id: "high-proof", content: "well corroborated", memoryType: "semantic", occurredAt: T0 - 1 * DAY_MS, proofCount: 20 });
      seedFailureCount(db, { memoryId: "high-proof", failureCount: 1 });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "high-proof"), "high-proof memory must be exempt").toBeNull();
    });

    it("FORGET-03 exemption: pinned + system memories are NEVER evicted", async () => {
      // pinned=1 and trust_level='system' are hard exemptions regardless of strength.
      insertMemory(db, { id: "pinned-weak", content: "pinned", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null, pinned: true });
      seedFailureCount(db, { memoryId: "pinned-weak", failureCount: 9 });
      insertMemory(db, { id: "system-weak", content: "system", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null, trustLevel: "system" });
      seedFailureCount(db, { memoryId: "system-weak", failureCount: 9 });

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "pinned-weak"), "pinned must be exempt").toBeNull();
      expect(evictedAtOf(db, "system-weak"), "system must be exempt").toBeNull();
    });

    it("FORGET-02 coupling: two memories identical except failure_count — only the high-failure one evicts", async () => {
      // Both RECENT (high base strength), same proof_count (below the high-proof
      // floor). The ONLY difference is failure_count. The failurePenalty drives the
      // high-failure one below threshold; the zero-failure one survives. Proves the
      // coupling is monotone (more failures → lower strength → eviction).
      insertMemory(db, { id: "fc-high", content: "wrong", memoryType: "semantic", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
      seedFailureCount(db, { memoryId: "fc-high", failureCount: 10 });
      insertMemory(db, { id: "fc-zero", content: "fine", memoryType: "semantic", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
      // fc-zero: no failure row at all → failure_count 0.

      const res = await store.runLifecycleSweep({ tenantId: "tenant_a", agentId: "agent_x", now: T0 });
      expect(res.ok).toBe(true);
      expect(evictedAtOf(db, "fc-high"), "high failure_count must evict").not.toBeNull();
      expect(evictedAtOf(db, "fc-zero"), "zero failure_count must survive (no eviction without wrongness)").toBeNull();
    });

    it("reversibility (FORGET-04): unevict clears evicted_at, restoring the row", async () => {
      insertMemory(db, { id: "revivable", content: "weak then useful", memoryType: "working", occurredAt: T0 - 1 * DAY_MS, proofCount: null });
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

    it("dead-branch-live: an off-policy fixture that WAS evicted=0 now evicts >=1 (the c8-ignore branch executes)", async () => {
      // The exact off-policy fixture the DORMANT Test 2 asserts evicts 0 — under the
      // eviction-enabled policy it now evicts >=1, proving the previously-dead
      // LIVE_EVICTION branch executes (coverage of the formerly-/* c8 ignore */ path).
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
  });
});
