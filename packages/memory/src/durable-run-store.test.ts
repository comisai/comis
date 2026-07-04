// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { parseDurableRunRecord, type DurableRunRecord } from "@comis/core";
import { initSchema } from "./schema.js";
import { ensureDurableRunTable } from "./schema-durable-runs.js";
import { createSqliteDurableRunStore } from "./durable-run-store.js";
import type { DurableRunPort } from "@comis/core";

// The durable checkpoint store — the SQLite-backed DurableRunPort the resume
// engine scans on boot. Modeled on the crash-safe video-job store
// (video-job-store.test.ts): an in-memory :memory: db, ensureDurableRunTable to
// create the table, then the frozen factory with an INJECTED fake clock so
// updated_at_ms / created_at_ms are deterministic.

describe("createSqliteDurableRunStore (DurableRunPort)", () => {
  let db: Database.Database;
  let store: DurableRunPort;
  let now: number;
  const nowMs = () => now;

  /** Build a minimal checkpoint record (defaults to a healthy running run). */
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
    // Create the table directly via ensureDurableRunTable rather than the full
    // initSchema wiring, so these tests depend only on the durable_runs DDL.
    ensureDurableRunTable(db);
    now = 1_700_000_000_000;
    store = createSqliteDurableRunStore(db, { nowMs });
  });

  // -----------------------------------------------------------------------
  // upsertCheckpoint + getByRootRun round-trip
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
      // A never-allocated run surfaces the -1 sentinel.
      expect(r.stepIndex).toBe(-1);
    });

    it("round-trips a non-null cronOrigin and a DAG (object-entry) spawnTree shape without coercing it", async () => {
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
  // Resumable-orchestrate columns: {scriptRef, checkpointRef}. Additive,
  // nullable, content-free (a workspace-relative script path + a ResultRef id;
  // NO script bytes / checkpoint body / bearer — INV-5). They ride the same
  // durable_runs store the boot sweep scans so orchestrate becomes the first
  // RE-RUNNABLE durable kind. outward_step stays owned solely by
  // allocateOutwardStep — a checkpoint upsert must never touch it.
  // -----------------------------------------------------------------------

  describe("{scriptRef, checkpointRef} resumable columns", () => {
    it("round-trips a checkpoint carrying scriptRef + checkpointRef (both read back intact)", async () => {
      const rec = makeRecord({
        rootRunId: "r-refs",
        scriptRef: "orch-abc123.py",
        checkpointRef: "cp-9f3a2b",
      });
      const up = await store.upsertCheckpoint(rec);
      expect(up.ok).toBe(true);

      const got = await store.getByRootRun("r-refs");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.scriptRef).toBe("orch-abc123.py");
      expect(got.value.checkpointRef).toBe("cp-9f3a2b");
      // The round-tripped record is a valid domain record (new fields optional).
      expect(parseDurableRunRecord(got.value).ok).toBe(true);
    });

    it("a checkpoint written with NEITHER ref reads back both undefined and still parses (legacy row)", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-no-refs", status: "running" }));
      const got = await store.getByRootRun("r-no-refs");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      // NULL columns map to undefined at the domain boundary (?? undefined).
      expect(got.value.scriptRef).toBeUndefined();
      expect(got.value.checkpointRef).toBeUndefined();
      // Every pre-existing (neither-column) row must still parse — the new fields
      // are optional/nullable so the closed-union resume gate is unweakened.
      expect(parseDurableRunRecord(got.value).ok).toBe(true);
    });

    it("adds both columns to a PRE-EXISTING (old-DDL) durable_runs via a guarded ALTER, idempotently", () => {
      const legacyDb = new Database(":memory:");
      // Seed the OLD DDL — durable_runs as a PRIOR build created it, WITHOUT
      // script_ref/checkpoint_ref. `CREATE TABLE IF NOT EXISTS` in
      // ensureDurableRunTable is a no-op on this existing table, so ONLY the
      // guarded PRAGMA-checked ALTER can add the columns (the silent-regression
      // path: a fresh CREATE would hide it).
      legacyDb.exec(`
        CREATE TABLE durable_runs (
          root_run_id        TEXT PRIMARY KEY,
          spawn_tree         TEXT NOT NULL,
          caps               TEXT NOT NULL,
          lease_ids          TEXT NOT NULL,
          budget_consumed    REAL NOT NULL DEFAULT 0,
          cron_origin        TEXT,
          outward_step       INTEGER NOT NULL DEFAULT -1,
          status             TEXT NOT NULL CHECK(status IN ('running','orphaned','completed','revoked')),
          orphan_reason      TEXT,
          last_heartbeat_at  INTEGER NOT NULL,
          created_at_ms      INTEGER NOT NULL,
          updated_at_ms      INTEGER NOT NULL
        )
      `);
      // A row written under the OLD schema (neither new column).
      legacyDb
        .prepare(
          `INSERT INTO durable_runs (root_run_id, spawn_tree, caps, lease_ids, budget_consumed,
             cron_origin, outward_step, status, last_heartbeat_at, created_at_ms, updated_at_ms)
           VALUES ('r-legacy', '["n"]', '["orch:read"]', '["lz"]', 0, NULL, 5, 'running',
             1700000000000, 1700000000000, 1700000000000)`,
        )
        .run();

      const colNames = (): Set<string> =>
        new Set(
          (legacyDb.prepare("PRAGMA table_info(durable_runs)").all() as Array<{ name: string }>).map(
            (r) => r.name,
          ),
        );
      const before = colNames();
      expect(before.has("script_ref")).toBe(false);
      expect(before.has("checkpoint_ref")).toBe(false);

      // The migration under test.
      ensureDurableRunTable(legacyDb);
      const after = colNames();
      expect(after.has("script_ref")).toBe(true);
      expect(after.has("checkpoint_ref")).toBe(true);

      // Idempotent: a SECOND (and third) run is a no-op — a duplicate ADD COLUMN
      // would throw. This is the re-run-safe boot path.
      expect(() => ensureDurableRunTable(legacyDb)).not.toThrow();
      expect(() => ensureDurableRunTable(legacyDb)).not.toThrow();

      // The pre-existing row survived; its new columns read back NULL and its
      // outward_step counter is untouched by the migration.
      const legacy = legacyDb
        .prepare(
          "SELECT script_ref, checkpoint_ref, outward_step FROM durable_runs WHERE root_run_id = 'r-legacy'",
        )
        .get() as { script_ref: string | null; checkpoint_ref: string | null; outward_step: number };
      expect(legacy.script_ref).toBeNull();
      expect(legacy.checkpoint_ref).toBeNull();
      expect(legacy.outward_step).toBe(5);

      legacyDb.close();
    });

    it("upsert with only ONE ref set preserves the other (COALESCE) and NEVER mutates outward_step", async () => {
      // 1. Seed a running run with an initial checkpointRef, no scriptRef.
      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-coalesce", status: "running", checkpointRef: "cp-1" }),
      );
      // Allocate an outward step so outward_step = 0 (proves later checkpoint
      // upserts do NOT reset the exactly-once counter).
      const a = await store.allocateOutwardStep("r-coalesce");
      expect(a.ok).toBe(true);
      if (a.ok) expect(a.value).toBe(0);

      // 2. Upsert with ONLY scriptRef → the runner (plan 03) sets scriptRef
      //    without clobbering the checkpoint core's (plan 02) checkpointRef.
      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-coalesce", status: "running", scriptRef: "orch-x.py" }),
      );
      let got = await store.getByRootRun("r-coalesce");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.scriptRef).toBe("orch-x.py");
      expect(got.value.checkpointRef).toBe("cp-1"); // COALESCE-preserved
      expect(got.value.stepIndex).toBe(0); // outward_step untouched

      // 3. Vice-versa: upsert with ONLY checkpointRef → scriptRef preserved.
      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-coalesce", status: "running", checkpointRef: "cp-2" }),
      );
      got = await store.getByRootRun("r-coalesce");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.scriptRef).toBe("orch-x.py"); // COALESCE-preserved
      expect(got.value.checkpointRef).toBe("cp-2");
      expect(got.value.stepIndex).toBe(0); // still untouched

      // 4. The counter was never reset by the two checkpoint upserts.
      const next = await store.allocateOutwardStep("r-coalesce");
      expect(next.ok).toBe(true);
      if (next.ok) expect(next.value).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Idempotent upsert on the PK
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
  // listResumable — only status='running'
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
  // invalidateForRevoke — revoked never resumable
  // -----------------------------------------------------------------------

  describe("invalidateForRevoke", () => {
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
  // touchHeartbeat
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
  // allocateOutwardStep — atomic monotonic counter
  // -----------------------------------------------------------------------

  describe("allocateOutwardStep (atomic monotonic counter)", () => {
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

    // Regression: a checkpoint between two sends must NOT reset the counter.
    it("upsertCheckpoint between two allocations does NOT clobber the counter (allocate→0, checkpoint, allocate→1)", async () => {
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
      // The bug guarded here: a clobbering checkpoint would make this 0 again.
      if (second.ok) expect(second.value).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // A never-sent run round-trips with stepIndex -1 and parses ok
  // -----------------------------------------------------------------------

  describe("never-sent run stepIndex sentinel", () => {
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
  // countByStatus(sinceMs) — crash-surviving windowed status counts read
  // DIRECTLY from durable_runs (the row IS the durability; an in-process event
  // can be lost across a hard crash). Counts ONLY rows with updated_at_ms >= sinceMs.
  // -----------------------------------------------------------------------

  describe("countByStatus (windowed status counts)", () => {
    it("returns per-status counts read directly from the table (orphaned/revoked/running/completed)", async () => {
      // All writes stamp updated_at_ms at `now` (the injected clock) = the beforeEach value.
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-run-1", status: "running" }));
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-run-2", status: "running" }));
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-done", status: "completed" }));
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-orph", status: "orphaned" }));
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-rev", status: "running" }));
      await store.invalidateForRevoke("r-rev"); // → status 'revoked'

      const res = await store.countByStatus(0); // sinceMs=0 → all rows
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.running).toBe(2);
      expect(res.value.completed).toBe(1);
      expect(res.value.orphaned).toBe(1);
      expect(res.value.revoked).toBe(1);
    });

    it("WINDOWED: excludes rows whose updated_at_ms is OLDER than sinceMs", async () => {
      // An OLD row written at t=now (the beforeEach base).
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-old", status: "running" }));
      // Advance the injected clock; a NEW row lands at the later updated_at_ms.
      now = 1_700_000_900_000;
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-new", status: "running" }));

      // A cutoff BETWEEN the two writes excludes the old row, includes the new one.
      const sinceMs = 1_700_000_500_000;
      const res = await store.countByStatus(sinceMs);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Only r-new (updated_at_ms = 1_700_000_900_000 >= sinceMs) is counted.
      expect(res.value.running).toBe(1);
    });

    it("defaults every status key to 0 (a window with no rows yields all-zero, not undefined)", async () => {
      const res = await store.countByStatus(0);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toEqual({ orphaned: 0, revoked: 0, running: 0, completed: 0 });
    });
  });

  // -----------------------------------------------------------------------
  // Corrupt-row degrade — every read returns Result, never throws
  // -----------------------------------------------------------------------

  describe("corrupt-row degrade to Result.err (no throw)", () => {
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
  // Security: the persisted row carries NO secret column.
  // -----------------------------------------------------------------------

  describe("no-secret schema invariant", () => {
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

  it("countByStatus returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().countByStatus(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });
});

// ===========================================================================
// The real boot path: initSchema — NOT ensureDurableRunTable directly — MUST
// create durable_runs, so the table cannot be defined-but-unwired.
// ===========================================================================
describe("initSchema wires durable_runs on the boot path", () => {
  it("creates the durable_runs table on a fresh db via the real initSchema", () => {
    const db = new Database(":memory:");
    initSchema(db, 384);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='durable_runs'")
      .get();
    expect(row).toBeDefined();
  });
});
