// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { parseDurableRunRecord, type DurableRunRecord } from "@comis/core";
import { initSchema } from "./schema.js";
import { ensureDurableRunTable } from "./schema-durable-runs.js";
import { createSqliteDurableRunStore } from "./durable-run-store.js";
import type { DurableRunPort } from "@comis/core";

// The Phase-216 durable checkpoint store — the SQLite-backed DurableRunPort the
// resume engine scans on boot (DUR-01/DUR-02/DUR-03). Modeled on the production
// crash-safe video-job store (video-job-store.test.ts): an in-memory :memory:
// db, ensureDurableRunTable to create the table, then the frozen factory with an
// INJECTED fake clock so updated_at_ms / created_at_ms are deterministic.

describe("createSqliteDurableRunStore (DurableRunPort)", () => {
  let db: Database.Database;
  let store: DurableRunPort;
  let now: number;
  const nowMs = () => now;

  /** Build a minimal DUR-01 checkpoint record (defaults to a healthy running run). */
  function makeRecord(overrides: Partial<DurableRunRecord> = {}): DurableRunRecord {
    return {
      rootRunId: "run-root-1",
      spawnTree: ["node-a", "node-b"],
      caps: ["orch:read", "orch:analyze"],
      leaseIds: ["lease-1", "lease-2"],
      budgetConsumed: 1.25,
      cronOrigin: null,
      stepIndex: -1,
      status: "running",
      lastHeartbeatAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    // The store's own setup uses ensureDurableRunTable directly so the RED has
    // its table dependency even before the initSchema wiring (Task 3) lands.
    ensureDurableRunTable(db);
    now = 1_700_000_000_000;
    store = createSqliteDurableRunStore(db, { nowMs });
  });

  // -----------------------------------------------------------------------
  // upsertCheckpoint + getByRootRun round-trip (DUR-01)
  // -----------------------------------------------------------------------

  describe("upsertCheckpoint + getByRootRun round-trip", () => {
    it("persists a checkpoint and reads ALL fields back identically (JSON arrays round-trip)", async () => {
      const rec = makeRecord({
        spawnTree: ["n1", "n2", "n3"],
        caps: ["orch:read", "orch:write"],
        leaseIds: ["lz-1"],
        budgetConsumed: 3.5,
        cronOrigin: null,
        lastHeartbeatAt: 1_700_000_001_000,
      });
      const up = await store.upsertCheckpoint(rec);
      expect(up.ok).toBe(true);

      const got = await store.getByRootRun("run-root-1");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      const r = got.value;
      expect(r.rootRunId).toBe("run-root-1");
      expect(r.spawnTree).toEqual(["n1", "n2", "n3"]);
      expect(r.caps).toEqual(["orch:read", "orch:write"]);
      expect(r.leaseIds).toEqual(["lz-1"]);
      expect(r.budgetConsumed).toBe(3.5);
      expect(r.cronOrigin).toBeNull();
      expect(r.status).toBe("running");
      expect(r.lastHeartbeatAt).toBe(1_700_000_001_000);
      // A never-allocated run surfaces the -1 sentinel (NEW-5).
      expect(r.stepIndex).toBe(-1);
    });

    it("round-trips a non-null cronOrigin and a DAG spawnTree shape (LOW-2 discriminator)", async () => {
      const rec = makeRecord({
        rootRunId: "run-dag",
        cronOrigin: "cron-nightly",
        // DAG run: object entries (snapshotToSpawnTree shape) — must NOT be coerced.
        spawnTree: [
          { nodeId: "a", status: "done", runId: "r-a" },
          { nodeId: "b", status: "running" },
        ],
      });
      const up = await store.upsertCheckpoint(rec);
      expect(up.ok).toBe(true);

      const got = await store.getByRootRun("run-dag");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.cronOrigin).toBe("cron-nightly");
      expect(got.value.spawnTree).toEqual([
        { nodeId: "a", status: "done", runId: "r-a" },
        { nodeId: "b", status: "running" },
      ]);
      // The round-tripped record is a valid domain record.
      expect(parseDurableRunRecord(got.value).ok).toBe(true);
    });

    it("returns ok(undefined) for an absent run (not an error)", async () => {
      const got = await store.getByRootRun("no-such-run");
      expect(got.ok).toBe(true);
      if (got.ok) expect(got.value).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Idempotent upsert on the PK (DUR-01)
  // -----------------------------------------------------------------------

  describe("idempotent upsert", () => {
    it("upserting twice on the same rootRunId UPDATES the row (no duplicate)", async () => {
      await store.upsertCheckpoint(makeRecord({ budgetConsumed: 1, status: "running" }));
      await store.upsertCheckpoint(makeRecord({ budgetConsumed: 9, status: "running" }));

      const got = await store.getByRootRun("run-root-1");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.budgetConsumed).toBe(9);

      // Exactly one physical row for the PK.
      const count = db
        .prepare("SELECT COUNT(*) AS c FROM durable_runs WHERE root_run_id = 'run-root-1'")
        .get() as { c: number };
      expect(count.c).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // listResumable — only status='running' (DUR-02)
  // -----------------------------------------------------------------------

  describe("listResumable", () => {
    it("returns ONLY status='running' rows (running + completed + orphaned seeded)", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-running", status: "running" }));
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-completed", status: "completed" }));
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-orphaned", status: "orphaned" }));

      const res = await store.listResumable();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const ids = res.value.map((r) => r.rootRunId);
      expect(ids).toContain("r-running");
      expect(ids).not.toContain("r-completed");
      expect(ids).not.toContain("r-orphaned");
      expect(res.value.every((r) => r.status === "running")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // invalidateForRevoke — revoked never resumable (DUR-03)
  // -----------------------------------------------------------------------

  describe("invalidateForRevoke (DUR-03)", () => {
    it("flips status to 'revoked' and removes the run from listResumable", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-revoke", status: "running" }));

      const inv = await store.invalidateForRevoke("r-revoke");
      expect(inv.ok).toBe(true);

      const got = await store.getByRootRun("r-revoke");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) expect(got.value.status).toBe("revoked");

      const res = await store.listResumable();
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.map((r) => r.rootRunId)).not.toContain("r-revoke");
    });
  });

  // -----------------------------------------------------------------------
  // markOrphaned / markCompleted
  // -----------------------------------------------------------------------

  describe("markOrphaned / markCompleted", () => {
    it("markOrphaned sets status='orphaned' and persists the orphan reason", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-orph", status: "running" }));

      const m = await store.markOrphaned("r-orph", "no live lease on boot");
      expect(m.ok).toBe(true);

      const got = await store.getByRootRun("r-orph");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) expect(got.value.status).toBe("orphaned");

      // The reason is durable on the row (read at the SQL layer — not a domain field).
      const row = db
        .prepare("SELECT orphan_reason FROM durable_runs WHERE root_run_id = 'r-orph'")
        .get() as { orphan_reason: string | null };
      expect(row.orphan_reason).toBe("no live lease on boot");
    });

    it("markCompleted sets status='completed' (resume skips it)", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-done", status: "running" }));
      const m = await store.markCompleted("r-done");
      expect(m.ok).toBe(true);
      const got = await store.getByRootRun("r-done");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) expect(got.value.status).toBe("completed");
    });
  });

  // -----------------------------------------------------------------------
  // touchHeartbeat (HB-01)
  // -----------------------------------------------------------------------

  describe("touchHeartbeat", () => {
    it("updates last_heartbeat_at without changing status or stepIndex", async () => {
      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-hb", status: "running", lastHeartbeatAt: 1_700_000_000_000 }),
      );
      // Allocate once so stepIndex is 0 (so we can prove heartbeat does not move it).
      const alloc = await store.allocateOutwardStep("r-hb");
      expect(alloc.ok).toBe(true);
      if (alloc.ok) expect(alloc.value).toBe(0);

      const beat = await store.touchHeartbeat("r-hb", 1_700_000_555_000);
      expect(beat.ok).toBe(true);

      const got = await store.getByRootRun("r-hb");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.lastHeartbeatAt).toBe(1_700_000_555_000);
      expect(got.value.status).toBe("running");
      // Heartbeat must NOT touch the outward counter.
      expect(got.value.stepIndex).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // allocateOutwardStep — atomic monotonic counter (HIGH-1 / ONCE-02)
  // -----------------------------------------------------------------------

  describe("allocateOutwardStep (HIGH-1 monotonic counter)", () => {
    it("returns 0 then 1 then 2 — strictly monotonic, two calls never return the same index", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-step", status: "running" }));

      const a = await store.allocateOutwardStep("r-step");
      const b = await store.allocateOutwardStep("r-step");
      const c = await store.allocateOutwardStep("r-step");
      expect(a.ok && b.ok && c.ok).toBe(true);
      if (!a.ok || !b.ok || !c.ok) return;
      expect(a.value).toBe(0);
      expect(b.value).toBe(1);
      expect(c.value).toBe(2);
      // The latest counter is persisted and surfaces as record.stepIndex.
      const got = await store.getByRootRun("r-step");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) expect(got.value.stepIndex).toBe(2);
    });

    it("creates a minimal row when none exists, then yields 0 then 1", async () => {
      // No prior upsertCheckpoint for this rootRunId.
      const a = await store.allocateOutwardStep("r-fresh");
      expect(a.ok).toBe(true);
      if (a.ok) expect(a.value).toBe(0);
      const b = await store.allocateOutwardStep("r-fresh");
      expect(b.ok).toBe(true);
      if (b.ok) expect(b.value).toBe(1);

      // The placeholder row is a valid running record (resumable until completed).
      const got = await store.getByRootRun("r-fresh");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) {
        expect(got.value.status).toBe("running");
        expect(parseDurableRunRecord(got.value).ok).toBe(true);
      }
    });

    // NEW-1 REGRESSION — a checkpoint between two sends must NOT reset the counter.
    it("NEW-1: upsertCheckpoint between two allocations does NOT clobber the counter (allocate→0, checkpoint, allocate→1)", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-new1", status: "running" }));

      const first = await store.allocateOutwardStep("r-new1");
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.value).toBe(0);

      // A spawn-boundary / DAG-node checkpoint write — upsertCheckpoint does NOT
      // write outward_step, so it must NOT reset the counter back to -1.
      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-new1", status: "running", budgetConsumed: 4 }),
      );

      const second = await store.allocateOutwardStep("r-new1");
      expect(second.ok).toBe(true);
      // The exact NEW-1 bug: a clobbering checkpoint would make this 0 again.
      if (second.ok) expect(second.value).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // NEW-5 — a never-sent run round-trips with stepIndex -1 and parses ok
  // -----------------------------------------------------------------------

  describe("NEW-5 never-sent sentinel", () => {
    it("a checkpointed-but-never-sent run surfaces stepIndex -1 and parseDurableRunRecord accepts it", async () => {
      // upsertCheckpoint a fresh run; allocateOutwardStep is NEVER called.
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-never-sent", status: "running" }));

      const got = await store.getByRootRun("r-never-sent");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      // The -1 sentinel survives the round trip (not falsely advanced to 0).
      expect(got.value.stepIndex).toBe(-1);
      // The domain schema permits -1 (.min(-1)) so the run is NOT orphaned on resume.
      expect(parseDurableRunRecord(got.value).ok).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Corrupt-row degrade — every read returns Result, never throws (T-216-08)
  // -----------------------------------------------------------------------

  describe("corrupt-row degrade (T-216-08)", () => {
    it("a corrupt caps JSON degrades getByRootRun to err (JSON parse guard, no throw)", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-bad-json", status: "running" }));
      // Hand-corrupt the caps JSON column to non-parseable text.
      db.prepare("UPDATE durable_runs SET caps = '{not-json' WHERE root_run_id = 'r-bad-json'").run();

      const got = await store.getByRootRun("r-bad-json");
      expect(got.ok).toBe(false);
    });

    it("an unknown status / non-numeric column degrades to err via the row mapper", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-bad-row", status: "running" }));
      // A z.number() column set to TEXT the strictObject schema rejects.
      db.prepare(
        "UPDATE durable_runs SET last_heartbeat_at = 'not-a-number' WHERE root_run_id = 'r-bad-row'",
      ).run();

      const got = await store.getByRootRun("r-bad-row");
      expect(got.ok).toBe(false);

      const res = await store.listResumable();
      expect(res.ok).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Threat T-216-05: the persisted row carries NO secret column.
  // -----------------------------------------------------------------------

  describe("no-secret schema invariant (T-216-05)", () => {
    it("durable_runs has no key/token/secret/bearer/password column", () => {
      const cols = db.prepare("PRAGMA table_info(durable_runs)").all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name.toLowerCase());
      expect(names.length).toBeGreaterThan(0);
      for (const forbidden of [
        "key",
        "api_key",
        "apikey",
        "token",
        "secret",
        "bearer",
        "password",
        "authorization",
      ]) {
        expect(names).not.toContain(forbidden);
      }
    });
  });
});

// ===========================================================================
// Store-error resilience: EVERY method returns err() (never throws) when the
// underlying SQLite statement fails. Forced by closing the db connection —
// better-sqlite3 throws "The database connection is not open" on every prepared
// statement run, exercising each catch branch (mirrors VideoJobStore resilience).
// ===========================================================================
describe("createSqliteDurableRunStore — store-error resilience (every method returns err)", () => {
  function makeClosedStore(): DurableRunPort {
    const db = new Database(":memory:");
    ensureDurableRunTable(db);
    const store = createSqliteDurableRunStore(db);
    db.close();
    return store;
  }

  const rec: DurableRunRecord = {
    rootRunId: "run-err",
    spawnTree: ["n"],
    caps: ["orch:read"],
    leaseIds: ["lease-err"],
    budgetConsumed: 0,
    cronOrigin: null,
    stepIndex: -1,
    status: "running",
    lastHeartbeatAt: 1_700_000_000_000,
  };

  it("upsertCheckpoint returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().upsertCheckpoint(rec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("getByRootRun returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().getByRootRun("run-err");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("listResumable returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().listResumable();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("markOrphaned returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().markOrphaned("run-err", "boot");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("markCompleted returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().markCompleted("run-err");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("touchHeartbeat returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().touchHeartbeat("run-err", 1_700_000_000_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("invalidateForRevoke returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().invalidateForRevoke("run-err");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("allocateOutwardStep returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().allocateOutwardStep("run-err");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });
});

// ===========================================================================
// Task 3 (real-layout wiring): initSchema — NOT ensureDurableRunTable directly
// — MUST create durable_runs on the boot path (Pitfall 5: defined-but-unwired).
// ===========================================================================
describe("initSchema wires durable_runs (Pitfall 5)", () => {
  it("creates the durable_runs table on a fresh db via the real initSchema", () => {
    const db = new Database(":memory:");
    initSchema(db, 384);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='durable_runs'")
      .get();
    expect(row).toBeDefined();
  });
});
