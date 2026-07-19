// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createConversationRef, parseDurableRunRecord, type DurableRunRecord } from "@comis/core";
import { initSchema } from "./schema.js";
import { ensureDurableRunTable } from "./schema-durable-runs.js";
import { createSqliteDurableRunStore } from "./durable-run-store.js";
import type { DurableRunPort } from "@comis/core";

const conversationScope = {
  tenantId: "tenant-a",
  agentId: "agent-a",
  partition: { kind: "principal" as const, principalId: "user-a" },
};
const conversationReference = createConversationRef(conversationScope);
if (!conversationReference.ok) throw conversationReference.error;
const conversationRef = conversationReference.value;

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
    const rootRunId = overrides.rootRunId ?? "run-root-1";
    const budgetConsumed = overrides.budgetConsumed ?? overrides.rootBudget?.usdConsumed ?? 1.25;
    return {
      tenantId: "tenant-a",
      agentId: "agent-a",
      conversationRef,
      conversationScope,
      principalId: "user-a",
      deliveryOrigin: {
        channelType: "telegram",
        channelId: "chat-a",
        userId: "user-a",
        tenantId: "tenant-a",
      },
      spawnTree: ["node-a", "node-b"],
      caps: ["orch:read", "orch:analyze"],
      leaseIds: ["lease-1", "lease-2"],
      budgetConsumed,
      rootBudget: overrides.rootBudget ?? {
        startedAtMs: 1_699_999_990_000,
        tokensConsumed: 100,
        usdConsumed: budgetConsumed,
      },
      cronOrigin: null,
      trustLevel: "user",
      status: "running",
      lastHeartbeatAt: 1_700_000_000_000,
      scriptRef: null,
      checkpointRef: null,
      workspacePolicyHash: "b".repeat(64),
      ...overrides,
      checkpointId: overrides.checkpointId ?? rootRunId,
      rootRunId,
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    // Create the table directly via ensureDurableRunTable rather than the full
    // initSchema wiring, so these tests depend only on the durable checkpoint DDL.
    ensureDurableRunTable(db);
    now = 1_700_000_000_000;
    store = createSqliteDurableRunStore(db, { nowMs });
  });

  describe("checkpoint identity isolation", () => {
    it("round-trips the immutable workspace policy hash with checkpoint metadata", async () => {
      const record = makeRecord({ checkpointId: "checkpoint-policy-provenance" });

      expect((await store.upsertCheckpoint(record)).ok).toBe(true);
      const persisted = await store.getByCheckpoint(record.checkpointId);

      expect(persisted.ok && persisted.value?.workspacePolicyHash).toBe("b".repeat(64));
    });

    it("rejects a checkpoint update that moves its persisted heartbeat backward", async () => {
      const current = makeRecord({
        checkpointId: "checkpoint-heartbeat-floor",
        rootRunId: "root-heartbeat-floor",
        lastHeartbeatAt: 1_700_000_000_000,
      });
      expect((await store.upsertCheckpoint(current)).ok).toBe(true);

      const stale = await store.upsertCheckpoint({ ...current, lastHeartbeatAt: 1_699_999_999_999 });

      expect(stale.ok).toBe(false);
      const persisted = await store.getByCheckpoint(current.checkpointId);
      expect(persisted.ok && persisted.value?.lastHeartbeatAt).toBe(1_700_000_000_000);
    });

    it("persists an explicitly revoked checkpoint and tombstones its durable root", async () => {
      const revoked = makeRecord({
        checkpointId: "checkpoint-explicit-revoke",
        rootRunId: "root-explicit-revoke",
        status: "revoked",
      });

      expect((await store.upsertCheckpoint(revoked)).ok).toBe(true);
      expect(await store.getByCheckpoint(revoked.checkpointId)).toEqual({ ok: true, value: revoked });
      expect((await store.upsertCheckpoint({
        ...revoked,
        checkpointId: "checkpoint-after-explicit-revoke",
        status: "running",
      })).ok).toBe(false);
    });

    it("stores sibling checkpoints independently and revokes every checkpoint in one root", async () => {
      const first = makeRecord({ checkpointId: "checkpoint-a", rootRunId: "tree-root" });
      const second = makeRecord({
        checkpointId: "checkpoint-b",
        rootRunId: "tree-root",
        spawnTree: ["other-node"],
      });

      expect((await store.upsertCheckpoint(first)).ok).toBe(true);
      expect((await store.upsertCheckpoint(second)).ok).toBe(true);

      const firstStored = await store.getByCheckpoint("checkpoint-a");
      const secondStored = await store.getByCheckpoint("checkpoint-b");
      expect(firstStored.ok && firstStored.value?.spawnTree).toEqual(["node-a", "node-b"]);
      expect(secondStored.ok && secondStored.value?.spawnTree).toEqual(["other-node"]);
      expect(db.prepare("SELECT COUNT(*) AS c FROM durable_run_checkpoints").get()).toEqual({ c: 2 });

      expect((await store.markCompleted("checkpoint-a")).ok).toBe(true);
      expect((await store.invalidateForRevoke("tree-root")).ok).toBe(true);
      const afterFirst = await store.getByCheckpoint("checkpoint-a");
      const afterSecond = await store.getByCheckpoint("checkpoint-b");
      expect(afterFirst.ok && afterFirst.value?.status).toBe("revoked");
      expect(afterSecond.ok && afterSecond.value?.status).toBe("revoked");
    });

    it("persists canonical conversation authority origin trust ceiling and cap ceiling", async () => {
      const record = makeRecord({ checkpointId: "checkpoint-principal" });
      expect((await store.upsertCheckpoint(record)).ok).toBe(true);

      const stored = await store.getByCheckpoint("checkpoint-principal");
      expect(stored).toEqual({ ok: true, value: record });
      const columns = new Set(
        (db.prepare("PRAGMA table_info(durable_run_checkpoints)").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      for (const column of [
        "checkpoint_id",
        "root_run_id",
        "tenant_id",
        "agent_id",
        "conversation_ref",
        "canonical_scope",
        "principal_id",
        "delivery_origin",
      ]) {
        expect(columns.has(column)).toBe(true);
      }
      expect(columns.has("outward_step")).toBe(false);
      const checkpointColumn = (
        db.prepare("PRAGMA table_info(durable_run_checkpoints)").all() as Array<{
          name: string;
          notnull: number;
        }>
      ).find((column) => column.name === "checkpoint_id");
      expect(checkpointColumn?.notnull).toBe(1);
    });

    it("rejects a sibling checkpoint that would reset the root budget authority", async () => {
      const rootRunId = "tree-budget-root";
      const authoritative = makeRecord({
        checkpointId: "checkpoint-budget-a",
        rootRunId,
        budgetConsumed: 3,
        rootBudget: {
          startedAtMs: 1_699_999_000_000,
          tokensConsumed: 900,
          usdConsumed: 3,
        },
      });
      expect((await store.upsertCheckpoint(authoritative)).ok).toBe(true);

      const staleSibling = makeRecord({
        checkpointId: "checkpoint-budget-b",
        rootRunId,
        budgetConsumed: 0.5,
        rootBudget: {
          startedAtMs: 1_699_999_500_000,
          tokensConsumed: 100,
          usdConsumed: 0.5,
        },
      });
      expect((await store.upsertCheckpoint(staleSibling)).ok).toBe(false);
      expect(await store.getByCheckpoint(staleSibling.checkpointId)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await store.getByCheckpoint(authoritative.checkpointId)).toEqual({
        ok: true,
        value: authoritative,
      });
    });
  });

  // -----------------------------------------------------------------------
  // upsertCheckpoint + getByCheckpoint round-trip
  // -----------------------------------------------------------------------

  describe("upsertCheckpoint + getByCheckpoint round-trip", () => {
    it("persists a checkpoint and reads ALL fields back identically (JSON arrays round-trip)", async () => {
      const rec = makeRecord({
        spawnTree: ["n1", "n2", "n3"],
        caps: ["orch:read", "orch:write"],
        leaseIds: ["lz-1"],
        budgetConsumed: 3.5,
        cronOrigin: null,
        trustLevel: "admin",
        lastHeartbeatAt: 1_700_000_001_000,
      });
      const up = await store.upsertCheckpoint(rec);
      expect(up.ok).toBe(true);

      const got = await store.getByCheckpoint("run-root-1");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      const r = got.value;
      expect(r.rootRunId).toBe("run-root-1");
      expect(r.spawnTree).toEqual(["n1", "n2", "n3"]);
      expect(r.caps).toEqual(["orch:read", "orch:write"]);
      expect(r.leaseIds).toEqual(["lz-1"]);
      expect(r.budgetConsumed).toBe(3.5);
      expect(r.cronOrigin).toBeNull();
      expect(r.trustLevel).toBe("admin");
      expect(r.status).toBe("running");
      expect(r.lastHeartbeatAt).toBe(1_700_000_001_000);
    });

    it("round-trips a non-null cronOrigin and the authoritative DAG checkpoint without coercing it", async () => {
      const rec = makeRecord({
        rootRunId: "run-dag",
        cronOrigin: "cron-nightly",
        spawnTree: [
          { nodeId: "a", status: "completed", runId: "r-a" },
          { nodeId: "b", status: "running", runId: "r-b" },
        ],
        checkpointRef: "graph-runs/run-dag/durable-checkpoint.json",
      });
      const up = await store.upsertCheckpoint(rec);
      expect(up.ok).toBe(true);

      const got = await store.getByCheckpoint("run-dag");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.cronOrigin).toBe("cron-nightly");
      expect(got.value.spawnTree).toEqual([
        { nodeId: "a", status: "completed", runId: "r-a" },
        { nodeId: "b", status: "running", runId: "r-b" },
      ]);
      expect(got.value.checkpointRef).toBe("graph-runs/run-dag/durable-checkpoint.json");
      // The round-tripped record is a valid domain record.
      expect(parseDurableRunRecord(got.value).ok).toBe(true);
    });

    it("preserves graph routing metadata and root-budget state after a real SQLite close and reopen", async () => {
      const dir = mkdtempSync(join(tmpdir(), "comis-durable-graph-"));
      const path = join(dir, "memory.db");
      const firstDb = new Database(path);
      try {
        ensureDurableRunTable(firstDb);
        const firstStore = createSqliteDurableRunStore(firstDb, { nowMs });
        const record = makeRecord({
          checkpointId: "graph-before-restart",
          rootRunId: "root-before-restart",
          budgetConsumed: 2.75,
          rootBudget: { startedAtMs: 1234, tokensConsumed: 4321, usdConsumed: 2.75 },
          spawnTree: [
            { nodeId: "prepare", status: "completed" },
            { nodeId: "publish", status: "running", runId: "old-publish" },
          ],
          checkpointRef: "graph-runs/graph-before-restart/durable-checkpoint.json",
        });
        expect((await firstStore.upsertCheckpoint(record)).ok).toBe(true);
        const raw = firstDb.prepare(
          "SELECT spawn_tree FROM durable_run_checkpoints WHERE checkpoint_id = ?",
        ).get(record.checkpointId) as { spawn_tree: string };
        expect(raw.spawn_tree).not.toContain("publish {{prepare.result}}");
        expect(raw.spawn_tree).not.toContain("artifact");
      } finally {
        firstDb.close();
      }

      try {
        const reopenedDb = new Database(path);
        ensureDurableRunTable(reopenedDb);
        const reopened = await createSqliteDurableRunStore(reopenedDb, { nowMs })
          .getByCheckpoint("graph-before-restart");
        expect(reopened.ok).toBe(true);
        if (!reopened.ok || reopened.value === undefined) return;
        expect(reopened.value.rootBudget).toEqual({
          startedAtMs: 1234,
          tokensConsumed: 4321,
          usdConsumed: 2.75,
        });
        expect(reopened.value.spawnTree[1]).toEqual(expect.objectContaining({
          status: "running",
          runId: "old-publish",
        }));
        expect(reopened.value.checkpointRef).toBe(
          "graph-runs/graph-before-restart/durable-checkpoint.json",
        );
        reopenedDb.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns ok(undefined) for an absent run (not an error)", async () => {
      const got = await store.getByCheckpoint("no-such-run");
      expect(got.ok).toBe(true);
      if (got.ok) expect(got.value).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Resumable-orchestrate columns: {scriptRef, checkpointRef}. Both are
  // content-free pointers; no script bytes, checkpoint body, or bearer is stored.
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

      const got = await store.getByCheckpoint("r-refs");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.scriptRef).toBe("orch-abc123.py");
      expect(got.value.checkpointRef).toBe("cp-9f3a2b");
      // The round-tripped record is a valid domain record (new fields optional).
      expect(parseDurableRunRecord(got.value).ok).toBe(true);
    });

    it("a checkpoint written with neither ref reads back both null and still parses", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-no-refs", status: "running" }));
      const got = await store.getByCheckpoint("r-no-refs");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.scriptRef).toBeNull();
      expect(got.value.checkpointRef).toBeNull();
      expect(parseDurableRunRecord(got.value).ok).toBe(true);
    });

    it("creates an authoritative trust-bound table without reading or altering an unrelated durable_runs table", async () => {
      const existingDb = new Database(":memory:");
      existingDb.exec(`
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
      existingDb
        .prepare(
          `INSERT INTO durable_runs (root_run_id, spawn_tree, caps, lease_ids, budget_consumed,
             cron_origin, outward_step, status, last_heartbeat_at, created_at_ms, updated_at_ms)
           VALUES ('untrusted-existing-row', '["n"]', '["orch:read"]', '["lz"]', 0, NULL, 5, 'running',
             1700000000000, 1700000000000, 1700000000000)`,
        )
        .run();

      const existingColumnNames = (): Set<string> =>
        new Set(
          (existingDb.prepare("PRAGMA table_info(durable_runs)").all() as Array<{ name: string }>).map(
            (r) => r.name,
          ),
        );
      const columnsBefore = existingColumnNames();

      ensureDurableRunTable(existingDb);
      expect(() => ensureDurableRunTable(existingDb)).not.toThrow();

      expect(existingColumnNames()).toEqual(columnsBefore);
      const existing = existingDb
        .prepare(
          "SELECT outward_step FROM durable_runs WHERE root_run_id = 'untrusted-existing-row'",
        )
        .get() as { outward_step: number };
      expect(existing.outward_step).toBe(5);

      const authoritativeColumns = new Set(
        (
          existingDb.prepare("PRAGMA table_info(durable_run_checkpoints)").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      expect(authoritativeColumns.has("trust_level")).toBe(true);

      const isolatedStore = createSqliteDurableRunStore(existingDb, { nowMs });
      const absent = await isolatedStore.getByCheckpoint("untrusted-existing-row");
      expect(absent).toEqual({ ok: true, value: undefined });
      expect(
        (
          await isolatedStore.upsertCheckpoint(
            makeRecord({ rootRunId: "trusted-new-row", trustLevel: "guest" }),
          )
        ).ok,
      ).toBe(true);

      existingDb.close();
    });

    it("upsert with only one ref set preserves the other", async () => {
      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-coalesce", status: "running", checkpointRef: "cp-1" }),
      );

      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-coalesce", status: "running", scriptRef: "orch-x.py" }),
      );
      let got = await store.getByCheckpoint("r-coalesce");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.scriptRef).toBe("orch-x.py");
      expect(got.value.checkpointRef).toBe("cp-1");

      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-coalesce", status: "running", checkpointRef: "cp-2" }),
      );
      got = await store.getByCheckpoint("r-coalesce");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.scriptRef).toBe("orch-x.py");
      expect(got.value.checkpointRef).toBe("cp-2");
    });
  });

  // -----------------------------------------------------------------------
  // Idempotent upsert on the PK
  // -----------------------------------------------------------------------

  describe("idempotent upsert", () => {
    it("rejects an inconsistent runtime checkpoint before it reaches SQLite", async () => {
      const inconsistent = makeRecord({ principalId: "different-user" });

      const result = await store.upsertCheckpoint(inconsistent);

      expect(result.ok).toBe(false);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM durable_run_checkpoints").get(),
      ).toEqual({ c: 0 });
    });

    it("persists child assembly attenuation while rejecting a later capability widening", async () => {
      const initial = makeRecord({
        rootRunId: "r-cap-attenuation",
        caps: ["orch:read", "orch:message"],
      });
      expect((await store.upsertCheckpoint(initial)).ok).toBe(true);

      const attenuated = await store.upsertCheckpoint({
        ...initial,
        caps: ["orch:read"],
      });
      expect(attenuated.ok).toBe(true);

      const afterAttenuation = await store.getByCheckpoint("r-cap-attenuation");
      expect(afterAttenuation.ok && afterAttenuation.value?.caps).toEqual(["orch:read"]);

      const widened = await store.upsertCheckpoint({
        ...initial,
        caps: ["orch:read", "orch:spawn"],
      });
      expect(widened.ok).toBe(false);

      const afterWidening = await store.getByCheckpoint("r-cap-attenuation");
      expect(afterWidening.ok && afterWidening.value?.caps).toEqual(["orch:read"]);
    });

    it("keeps the first authenticated trust immutable across a forged checkpoint upsert", async () => {
      expect((await store.upsertCheckpoint(makeRecord({ rootRunId: "r-immutable", trustLevel: "guest" }))).ok).toBe(true);
      const forged = await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-immutable", trustLevel: "admin", budgetConsumed: 99 }),
      );
      expect(forged.ok).toBe(false);

      const got = await store.getByCheckpoint("r-immutable");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) {
        expect(got.value.trustLevel).toBe("guest");
        expect(got.value.budgetConsumed).toBe(1.25);
      }
    });

    it("upserting twice on the same rootRunId UPDATES the row (no duplicate)", async () => {
      await store.upsertCheckpoint(makeRecord({ budgetConsumed: 1, status: "running" }));
      await store.upsertCheckpoint(makeRecord({ budgetConsumed: 9, status: "running" }));

      const got = await store.getByCheckpoint("run-root-1");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.budgetConsumed).toBe(9);

      // Exactly one physical row for the PK.
      const count = db
        .prepare(
          "SELECT COUNT(*) AS c FROM durable_run_checkpoints WHERE root_run_id = 'run-root-1'",
        )
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
      const ids = res.value.records.map((r) => r.rootRunId);
      expect(ids).toContain("r-running");
      expect(ids).not.toContain("r-completed");
      expect(ids).not.toContain("r-orphaned");
      expect(res.value.records.every((r) => r.status === "running")).toBe(true);
      expect(res.value.invalid).toEqual([]);
    });

    it("quarantines an inconsistent principal without blocking other resumable checkpoints", async () => {
      await store.upsertCheckpoint(
        makeRecord({ checkpointId: "checkpoint-valid", rootRunId: "root-valid" }),
      );
      await store.upsertCheckpoint(
        makeRecord({ checkpointId: "checkpoint-corrupt", rootRunId: "root-corrupt" }),
      );
      db.prepare(
        "UPDATE durable_run_checkpoints SET principal_id = ? WHERE checkpoint_id = ?",
      ).run("different-user", "checkpoint-corrupt");

      const scan = await store.listResumable();

      expect(scan.ok).toBe(true);
      if (!scan.ok) return;
      expect(scan.value.records.map((record) => record.checkpointId)).toEqual([
        "checkpoint-valid",
      ]);
      expect(scan.value.invalid).toEqual([
        {
          checkpointId: "checkpoint-corrupt",
          rootRunId: "root-corrupt",
          reason: "record_validation_failed",
        },
      ]);
    });

    it("returns an empty text identity for quarantine instead of blocking the entire scan", async () => {
      await store.upsertCheckpoint(
        makeRecord({ checkpointId: "checkpoint-to-corrupt", rootRunId: "root-to-corrupt" }),
      );
      db.prepare(
        "UPDATE durable_run_checkpoints SET checkpoint_id = '', root_run_id = '' WHERE checkpoint_id = ?",
      ).run("checkpoint-to-corrupt");

      const scan = await store.listResumable();

      expect(scan).toEqual({
        ok: true,
        value: {
          records: [],
          invalid: [{ checkpointId: "", rootRunId: "", reason: "record_validation_failed" }],
        },
      });
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

      const got = await store.getByCheckpoint("r-revoke");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) expect(got.value.status).toBe("revoked");

      const res = await store.listResumable();
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.records.map((r) => r.rootRunId)).not.toContain("r-revoke");
    });

    it("a subsequent upsertCheckpoint(status:'running') does NOT resurrect a revoked row", async () => {
      // A timeout markResumable or a raced jailed checkpoint() upserts status:'running'.
      // Landing after a revoke it must NOT clobber the terminal 'revoked' back to
      // 'running' — else the boot sweep re-surfaces + re-anchors a run the operator
      // explicitly revoked, defeating invalidateForRevoke.
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-race", status: "running" }));
      await store.invalidateForRevoke("r-race");

      // The clobber vector: a running upsert (markResumable / checkpoint) after revoke.
      const up = await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-race", status: "running", scriptRef: "orch-x.ts" }),
      );
      expect(up.ok).toBe(false);

      const got = await store.getByCheckpoint("r-race");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) expect(got.value.status).toBe("revoked");
      // And it stays out of the resume set.
      const res = await store.listResumable();
      if (res.ok) expect(res.value.records.map((r) => r.rootRunId)).not.toContain("r-race");
    });

    it("a subsequent upsertCheckpoint(status:'running') does NOT resurrect a completed or orphaned row", async () => {
      // The same terminal-preserve holds for completed/orphaned — a late checkpoint
      // upsert must not flip a finished run back to a resumable 'running'.
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-comp", status: "running" }));
      await store.markCompleted("r-comp");
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-comp", status: "running" }));
      const comp = await store.getByCheckpoint("r-comp");
      if (comp.ok && comp.value) expect(comp.value.status).toBe("completed");

      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-orph2", status: "running" }));
      await store.markOrphaned("r-orph2", "no live lease on boot");
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-orph2", status: "running" }));
      const orph = await store.getByCheckpoint("r-orph2");
      if (orph.ok && orph.value) expect(orph.value.status).toBe("orphaned");
    });

    it("rejects a post-revoke pointer update without mutating the revoked checkpoint", async () => {
      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-ref", status: "running", scriptRef: "orch-y.ts" }),
      );
      await store.invalidateForRevoke("r-ref");
      const update = await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-ref", status: "running", checkpointRef: "cp-9" }),
      );
      expect(update.ok).toBe(false);
      const got = await store.getByCheckpoint("r-ref");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) {
        expect(got.value.status).toBe("revoked");
        expect(got.value.scriptRef).toBe("orch-y.ts");
        expect(got.value.checkpointRef).toBeNull();
      }
    });
  });

  describe("atomic resume authority", () => {
    it("rejects a resume claim that reuses the source checkpoint identity", async () => {
      const invalid = await store.claimForResume({
        checkpointId: "checkpoint-same",
        replacementCheckpointId: "checkpoint-same",
        principal: {
          agentId: "agent-a",
          tenantId: "tenant-a",
          conversationRef,
          conversationScope,
          principalId: "user-a",
          deliveryOrigin: null,
          trustLevel: "user",
          caps: [],
        },
        claimedAtMs: now,
      });

      expect(invalid.ok).toBe(false);
    });

    it("returns closed resume outcomes without creating replacement checkpoints", async () => {
      const missing = await store.claimForResume({
        checkpointId: "checkpoint-missing",
        replacementCheckpointId: "checkpoint-missing-replacement",
        principal: {
          agentId: "agent-a",
          tenantId: "tenant-a",
          conversationRef,
          conversationScope,
          principalId: "user-a",
          deliveryOrigin: null,
          trustLevel: "user",
          caps: [],
        },
        claimedAtMs: now,
      });
      expect(missing).toEqual({ ok: true, value: { kind: "not_found" } });

      const terminal = makeRecord({
        checkpointId: "checkpoint-terminal",
        rootRunId: "root-terminal",
        status: "completed",
      });
      expect((await store.upsertCheckpoint(terminal)).ok).toBe(true);
      const notResumable = await store.claimForResume({
        checkpointId: terminal.checkpointId,
        replacementCheckpointId: "checkpoint-terminal-replacement",
        principal: {
          agentId: terminal.agentId,
          tenantId: terminal.tenantId,
          conversationRef: terminal.conversationRef,
          conversationScope: terminal.conversationScope,
          principalId: terminal.principalId,
          deliveryOrigin: terminal.deliveryOrigin,
          trustLevel: terminal.trustLevel,
          caps: terminal.caps,
        },
        claimedAtMs: now,
      });
      expect(notResumable).toEqual({ ok: true, value: { kind: "not_resumable" } });
    });

    it("rejects a downgraded or origin-mismatched resume principal", async () => {
      const source = makeRecord({
        checkpointId: "checkpoint-admin-source",
        rootRunId: "root-admin-source",
        trustLevel: "admin",
      });
      expect((await store.upsertCheckpoint(source)).ok).toBe(true);

      const denied = await store.claimForResume({
        checkpointId: source.checkpointId,
        replacementCheckpointId: "checkpoint-admin-replacement",
        principal: {
          agentId: source.agentId,
          tenantId: source.tenantId,
          conversationRef: source.conversationRef,
          conversationScope: source.conversationScope,
          principalId: source.principalId,
          deliveryOrigin: null,
          trustLevel: "guest",
          caps: source.caps,
        },
        claimedAtMs: now,
      });

      expect(denied).toEqual({ ok: true, value: { kind: "authorization_denied" } });
      expect(await store.getByCheckpoint("checkpoint-admin-replacement")).toEqual({
        ok: true,
        value: undefined,
      });
    });

    it("claims a null-origin guest checkpoint for an elevated matching principal", async () => {
      const source = makeRecord({
        checkpointId: "checkpoint-null-origin",
        rootRunId: "root-null-origin",
        deliveryOrigin: null,
        trustLevel: "guest",
      });
      expect((await store.upsertCheckpoint(source)).ok).toBe(true);

      const claimed = await store.claimForResume({
        checkpointId: source.checkpointId,
        replacementCheckpointId: "checkpoint-null-origin-replacement",
        principal: {
          agentId: source.agentId,
          tenantId: source.tenantId,
          conversationRef: source.conversationRef,
          conversationScope: source.conversationScope,
          principalId: source.principalId,
          deliveryOrigin: null,
          trustLevel: "admin",
          caps: source.caps,
        },
        claimedAtMs: now,
      });

      expect(claimed.ok && claimed.value.kind).toBe("claimed");
    });

    it("does not replace a source when the requested replacement already exists", async () => {
      const source = makeRecord({ checkpointId: "checkpoint-source-existing", rootRunId: "root-existing" });
      const target = makeRecord({ checkpointId: "checkpoint-target-existing", rootRunId: "root-existing" });
      expect((await store.upsertCheckpoint(source)).ok).toBe(true);
      expect((await store.upsertCheckpoint(target)).ok).toBe(true);

      const claimed = await store.claimForResume({
        checkpointId: source.checkpointId,
        replacementCheckpointId: target.checkpointId,
        principal: {
          agentId: source.agentId,
          tenantId: source.tenantId,
          conversationRef: source.conversationRef,
          conversationScope: source.conversationScope,
          principalId: source.principalId,
          deliveryOrigin: source.deliveryOrigin,
          trustLevel: source.trustLevel,
          caps: source.caps,
        },
        claimedAtMs: now,
      });

      expect(claimed).toEqual({ ok: true, value: { kind: "not_resumable" } });
    });

    it("fails closed when the root authority row is missing", async () => {
      const source = makeRecord({ checkpointId: "checkpoint-missing-root", rootRunId: "root-missing" });
      expect((await store.upsertCheckpoint(source)).ok).toBe(true);
      db.prepare("DELETE FROM durable_run_roots WHERE root_run_id = ?").run(source.rootRunId);

      const claimed = await store.claimForResume({
        checkpointId: source.checkpointId,
        replacementCheckpointId: "checkpoint-should-not-exist",
        principal: {
          agentId: source.agentId,
          tenantId: source.tenantId,
          conversationRef: source.conversationRef,
          conversationScope: source.conversationScope,
          principalId: source.principalId,
          deliveryOrigin: source.deliveryOrigin,
          trustLevel: source.trustLevel,
          caps: source.caps,
        },
        claimedAtMs: now,
      });

      expect(claimed.ok).toBe(false);
      expect(await store.getByCheckpoint("checkpoint-should-not-exist")).toEqual({
        ok: true,
        value: undefined,
      });
    });

    it("rejects a replacement heartbeat older than the claimed source", async () => {
      const source = makeRecord({
        checkpointId: "checkpoint-newer-heartbeat",
        rootRunId: "root-heartbeat-claim",
        lastHeartbeatAt: now,
      });
      expect((await store.upsertCheckpoint(source)).ok).toBe(true);

      const claimed = await store.claimForResume({
        checkpointId: source.checkpointId,
        replacementCheckpointId: "checkpoint-older-heartbeat",
        principal: {
          agentId: source.agentId,
          tenantId: source.tenantId,
          conversationRef: source.conversationRef,
          conversationScope: source.conversationScope,
          principalId: source.principalId,
          deliveryOrigin: source.deliveryOrigin,
          trustLevel: source.trustLevel,
          caps: source.caps,
        },
        claimedAtMs: now - 1,
      });

      expect(claimed.ok).toBe(false);
      const persistedSource = await store.getByCheckpoint(source.checkpointId);
      expect(persistedSource.ok && persistedSource.value?.status).toBe("running");
      expect(await store.getByCheckpoint("checkpoint-older-heartbeat")).toEqual({
        ok: true,
        value: undefined,
      });
    });

    it("preserves the source heartbeat across replacement claims until execution reports progress", async () => {
      const source = makeRecord({
        checkpointId: "checkpoint-no-progress-source",
        rootRunId: "root-no-progress",
        lastHeartbeatAt: 1_000,
        rootBudget: {
          startedAtMs: 500,
          tokensConsumed: 0,
          usdConsumed: 0,
        },
      });
      expect((await store.upsertCheckpoint(source)).ok).toBe(true);
      const principal = {
        agentId: source.agentId,
        tenantId: source.tenantId,
        conversationRef: source.conversationRef,
        conversationScope: source.conversationScope,
        principalId: source.principalId,
        deliveryOrigin: source.deliveryOrigin,
        trustLevel: source.trustLevel,
        caps: source.caps,
      };

      const first = await store.claimForResume({
        checkpointId: source.checkpointId,
        replacementCheckpointId: "checkpoint-no-progress-a",
        principal,
        claimedAtMs: 2_000,
      });
      expect(first.ok && first.value.kind === "claimed" && first.value.record.lastHeartbeatAt).toBe(1_000);
      const firstPersisted = await store.getByCheckpoint("checkpoint-no-progress-a");
      expect(firstPersisted.ok && firstPersisted.value?.lastHeartbeatAt).toBe(1_000);

      const second = await store.claimForResume({
        checkpointId: "checkpoint-no-progress-a",
        replacementCheckpointId: "checkpoint-no-progress-b",
        principal,
        claimedAtMs: 3_000,
      });
      expect(second.ok && second.value.kind === "claimed" && second.value.record.lastHeartbeatAt).toBe(1_000);
      const secondPersisted = await store.getByCheckpoint("checkpoint-no-progress-b");
      expect(secondPersisted.ok && secondPersisted.value?.lastHeartbeatAt).toBe(1_000);
    });

    it("allows exactly one SQLite connection to replace a resumable checkpoint", async () => {
      const dir = mkdtempSync(join(tmpdir(), "comis-durable-claim-"));
      const path = join(dir, "memory.db");
      const firstDb = new Database(path);
      const secondDb = new Database(path);
      try {
        ensureDurableRunTable(firstDb);
        ensureDurableRunTable(secondDb);
        const firstStore = createSqliteDurableRunStore(firstDb, { nowMs });
        const secondStore = createSqliteDurableRunStore(secondDb, { nowMs });
        const source = makeRecord({
          checkpointId: "checkpoint-source",
          rootRunId: "root-concurrent",
          scriptRef: "orch-source.ts",
          checkpointRef: "results/checkpoint-source.json",
        });
        expect((await firstStore.upsertCheckpoint(source)).ok).toBe(true);

        const principal = {
          agentId: source.agentId,
          tenantId: source.tenantId,
          conversationRef: source.conversationRef,
          conversationScope: source.conversationScope,
          principalId: source.principalId,
          deliveryOrigin: source.deliveryOrigin,
          trustLevel: source.trustLevel,
          caps: ["orch:read" as const],
        };
        const [firstClaim, secondClaim] = await Promise.all([
          firstStore.claimForResume({
            checkpointId: source.checkpointId,
            replacementCheckpointId: "checkpoint-replacement-a",
            principal,
            claimedAtMs: now,
          }),
          secondStore.claimForResume({
            checkpointId: source.checkpointId,
            replacementCheckpointId: "checkpoint-replacement-b",
            principal,
            claimedAtMs: now,
          }),
        ]);

        const outcomes = [firstClaim, secondClaim];
        expect(outcomes.filter((outcome) => outcome.ok && outcome.value.kind === "claimed")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.ok && outcome.value.kind === "not_resumable")).toHaveLength(1);
      } finally {
        firstDb.close();
        secondDb.close();
      }

      const reopenedDb = new Database(path);
      try {
        ensureDurableRunTable(reopenedDb);
        const reopenedStore = createSqliteDurableRunStore(reopenedDb, { nowMs });
        const source = await reopenedStore.getByCheckpoint("checkpoint-source");
        expect(source.ok && source.value?.status).toBe("completed");
        const scan = await reopenedStore.listResumable();
        expect(scan.ok && scan.value.records.map((record) => record.checkpointId)).toHaveLength(1);
        expect(scan.ok && scan.value.records[0]?.caps).toEqual(["orch:read"]);
      } finally {
        reopenedDb.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("carries the root-wide budget maximum into a replacement claimed from a stale sibling", async () => {
      const rootRunId = "root-claim-budget";
      const staleSource = makeRecord({
        checkpointId: "checkpoint-stale-source",
        rootRunId,
        budgetConsumed: 1,
        rootBudget: {
          startedAtMs: 1_699_999_000_000,
          tokensConsumed: 100,
          usdConsumed: 1,
        },
      });
      const currentSibling = makeRecord({
        checkpointId: "checkpoint-current-sibling",
        rootRunId,
        budgetConsumed: 4,
        rootBudget: {
          startedAtMs: 1_699_999_000_000,
          tokensConsumed: 900,
          usdConsumed: 4,
        },
      });
      expect((await store.upsertCheckpoint(staleSource)).ok).toBe(true);
      expect((await store.upsertCheckpoint(currentSibling)).ok).toBe(true);

      const claimed = await store.claimForResume({
        checkpointId: staleSource.checkpointId,
        replacementCheckpointId: "checkpoint-budget-replacement",
        principal: {
          agentId: staleSource.agentId,
          tenantId: staleSource.tenantId,
          conversationRef: staleSource.conversationRef,
          conversationScope: staleSource.conversationScope,
          principalId: staleSource.principalId,
          deliveryOrigin: staleSource.deliveryOrigin,
          trustLevel: staleSource.trustLevel,
          caps: staleSource.caps,
        },
        claimedAtMs: now,
      });

      expect(claimed.ok).toBe(true);
      expect(claimed.ok && claimed.value.kind === "claimed" && claimed.value.record.rootBudget).toEqual({
        startedAtMs: 1_699_999_000_000,
        tokensConsumed: 900,
        usdConsumed: 4,
      });
      const replacement = await store.getByCheckpoint("checkpoint-budget-replacement");
      expect(replacement.ok && replacement.value?.rootBudget).toEqual({
        startedAtMs: 1_699_999_000_000,
        tokensConsumed: 900,
        usdConsumed: 4,
      });
      expect(replacement.ok && replacement.value?.budgetConsumed).toBe(4);
    });

    it("persists a revoked-root tombstone that rejects a new sibling after restart", async () => {
      const dir = mkdtempSync(join(tmpdir(), "comis-durable-revoke-"));
      const path = join(dir, "memory.db");
      const initialDb = new Database(path);
      try {
        ensureDurableRunTable(initialDb);
        const initialStore = createSqliteDurableRunStore(initialDb, { nowMs });
        expect(
          (
            await initialStore.upsertCheckpoint(
              makeRecord({ checkpointId: "checkpoint-before-revoke", rootRunId: "root-revoked" }),
            )
          ).ok,
        ).toBe(true);
        expect((await initialStore.invalidateForRevoke("root-revoked")).ok).toBe(true);
      } finally {
        initialDb.close();
      }

      const reopenedDb = new Database(path);
      try {
        ensureDurableRunTable(reopenedDb);
        const reopenedStore = createSqliteDurableRunStore(reopenedDb, { nowMs });
        const resurrect = await reopenedStore.upsertCheckpoint(
          makeRecord({ checkpointId: "checkpoint-after-revoke", rootRunId: "root-revoked" }),
        );
        expect(resurrect.ok).toBe(false);
        expect(await reopenedStore.getByCheckpoint("checkpoint-after-revoke")).toEqual({
          ok: true,
          value: undefined,
        });
        expect(
          reopenedDb
            .prepare("SELECT revoked_at_ms FROM durable_run_roots WHERE root_run_id = ?")
            .get("root-revoked"),
        ).toEqual({ revoked_at_ms: now });
      } finally {
        reopenedDb.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // -----------------------------------------------------------------------
  // markOrphaned / markCompleted
  // -----------------------------------------------------------------------

  describe("markOrphaned / markCompleted", () => {
    it("never overwrites a concurrent revocation with an orphaned or completed status", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-terminal-race" }));
      await store.invalidateForRevoke("r-terminal-race");

      expect((await store.markOrphaned("r-terminal-race", "invalid durable record")).ok).toBe(
        true,
      );
      expect((await store.markCompleted("r-terminal-race")).ok).toBe(true);

      const stored = await store.getByCheckpoint("r-terminal-race");
      expect(stored.ok && stored.value?.status).toBe("revoked");
    });

    it("markOrphaned sets status='orphaned' and persists the orphan reason", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-orph", status: "running" }));

      const m = await store.markOrphaned("r-orph", "no live lease on boot");
      expect(m.ok).toBe(true);

      const got = await store.getByCheckpoint("r-orph");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) expect(got.value.status).toBe("orphaned");

      // The reason is durable on the row (read at the SQL layer — not a domain field).
      const row = db
        .prepare(
          "SELECT orphan_reason FROM durable_run_checkpoints WHERE root_run_id = 'r-orph'",
        )
        .get() as { orphan_reason: string | null };
      expect(row.orphan_reason).toBe("no live lease on boot");
    });

    it("markCompleted sets status='completed' (resume skips it)", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-done", status: "running" }));
      const m = await store.markCompleted("r-done");
      expect(m.ok).toBe(true);
      const got = await store.getByCheckpoint("r-done");
      expect(got.ok).toBe(true);
      if (got.ok && got.value) expect(got.value.status).toBe("completed");
    });
  });

  // -----------------------------------------------------------------------
  // touchHeartbeat
  // -----------------------------------------------------------------------

  describe("touchHeartbeat", () => {
    it("updates last_heartbeat_at without changing checkpoint status", async () => {
      await store.upsertCheckpoint(
        makeRecord({ rootRunId: "r-hb", status: "running", lastHeartbeatAt: 1_700_000_000_000 }),
      );

      const beat = await store.touchHeartbeat("r-hb", 1_700_000_555_000);
      expect(beat.ok).toBe(true);

      const got = await store.getByCheckpoint("r-hb");
      expect(got.ok).toBe(true);
      if (!got.ok || !got.value) return;
      expect(got.value.lastHeartbeatAt).toBe(1_700_000_555_000);
      expect(got.value.status).toBe("running");
    });

    it("refuses to refresh a terminal or missing checkpoint", async () => {
      await store.upsertCheckpoint(makeRecord({ checkpointId: "r-terminal-hb" }));
      await store.markCompleted("r-terminal-hb");
      expect((await store.touchHeartbeat("r-terminal-hb", 1_700_000_555_000)).ok).toBe(false);
      expect((await store.touchHeartbeat("missing-hb", 1_700_000_555_000)).ok).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // countByStatus(sinceMs) — crash-surviving windowed status counts read
  // DIRECTLY from durable_run_checkpoints (the row IS the durability; an in-process event
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
    it("an invalid checkpoint payload shape degrades to Result.err", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-bad-payload", status: "running" }));
      db.prepare(
        "UPDATE durable_run_checkpoints SET spawn_tree = ? WHERE root_run_id = ?",
      ).run(JSON.stringify({ spawnTree: [], rootBudget: { tokensConsumed: "invalid" } }), "r-bad-payload");

      const got = await store.getByCheckpoint("r-bad-payload");

      expect(got.ok).toBe(false);
    });

    it("a corrupt caps JSON degrades getByCheckpoint to err (JSON parse guard, no throw)", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-bad-json", status: "running" }));
      // Hand-corrupt the caps JSON column to non-parseable text.
      db.prepare(
        "UPDATE durable_run_checkpoints SET caps = '{not-json' WHERE root_run_id = 'r-bad-json'",
      ).run();

      const got = await store.getByCheckpoint("r-bad-json");
      expect(got.ok).toBe(false);
    });

    it("an unknown status / non-numeric column degrades to err via the row mapper", async () => {
      await store.upsertCheckpoint(makeRecord({ rootRunId: "r-bad-row", status: "running" }));
      // A z.number() column set to TEXT the strictObject schema rejects.
      db.prepare(
        "UPDATE durable_run_checkpoints SET last_heartbeat_at = 'not-a-number' WHERE root_run_id = 'r-bad-row'",
      ).run();

      const got = await store.getByCheckpoint("r-bad-row");
      expect(got.ok).toBe(false);

      const res = await store.listResumable();
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.records).toEqual([]);
        expect(res.value.invalid).toEqual([
          {
            checkpointId: "r-bad-row",
            rootRunId: "r-bad-row",
            reason: "record_validation_failed",
          },
        ]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Security: the persisted row carries NO secret column.
  // -----------------------------------------------------------------------

  describe("no-secret schema invariant", () => {
    it("durable_run_checkpoints has no key/token/secret/bearer/password column", () => {
      const cols = db.prepare("PRAGMA table_info(durable_run_checkpoints)").all() as Array<{
        name: string;
      }>;
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
    checkpointId: "run-err",
    rootRunId: "run-err",
    agentId: "agent-a",
    tenantId: "tenant-a",
    conversationRef,
    conversationScope,
    principalId: "user-a",
    deliveryOrigin: null,
    spawnTree: ["n"],
    caps: ["orch:read"],
    leaseIds: ["lease-err"],
    budgetConsumed: 0,
    rootBudget: { startedAtMs: 1_700_000_000_000, tokensConsumed: 0, usdConsumed: 0 },
    cronOrigin: null,
    trustLevel: "user",
    status: "running",
    lastHeartbeatAt: 1_700_000_000_000,
    scriptRef: null,
    checkpointRef: null,
  };

  it("upsertCheckpoint returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().upsertCheckpoint(rec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("getByCheckpoint returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().getByCheckpoint("run-err");
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

  it("claimForResume returns err on a driver failure (no throw)", async () => {
    const r = await makeClosedStore().claimForResume({
      checkpointId: "run-err",
      replacementCheckpointId: "run-replacement",
      principal: {
        agentId: rec.agentId,
        tenantId: rec.tenantId,
        conversationRef: rec.conversationRef,
        conversationScope: rec.conversationScope,
        principalId: rec.principalId,
        deliveryOrigin: rec.deliveryOrigin,
        trustLevel: rec.trustLevel,
        caps: rec.caps,
      },
      claimedAtMs: rec.lastHeartbeatAt,
    });
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
// create durable_run_checkpoints, so the table cannot be defined-but-unwired.
// ===========================================================================
describe("initSchema wires durable_run_checkpoints on the boot path", () => {
  it("creates the durable_run_checkpoints table on a fresh db via the real initSchema", () => {
    const db = new Database(":memory:");
    initSchema(db, 384);
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='durable_run_checkpoints'",
      )
      .get();
    expect(row).toBeDefined();
  });
});
