// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteTunedAlphaStore` — the SOLE @comis/memory adapter
 * for the `TunedAlphaStore` port. It owns ALL the
 * per-(tenant, agent) tuned-alpha SQL over the additive `tuned_alpha` table.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `initSchema` runs — the `tuned_alpha` table is created on boot) and gets
 * `adapter.getDb()` (mirrors the usefulness/user-representation store tests).
 *
 * ## The load-bearing security boundary (the §5.2 invariant)
 *
 * Comis runs many agents and many tenants in ONE DB. Every adapter statement —
 * the UPSERT, the SELECT — filters/keys on `(tenant_id, agent_id)`. A tuned vector
 * written under one (tenant, agent) MUST NEVER be returned for another scope —
 * proven by the cross-tenant AND cross-agent isolation tests (Tests 3/4), each of
 * which FAILS if the WHERE drops the respective filter column.
 *
 * ## The trust freeze (the OD2 ship-gate, structural belt #3)
 *
 * The `tuned_alpha` table carries ONLY the 4 tunable boost alphas + `updated_at` —
 * NO trust-weight column. The adapter source contains no `trust` token (Test 6,
 * grep-0) — the bandit can never move the trust weight; trust stays config-sourced
 * at the apply site.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MemoryConfig } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteTunedAlphaStore } from "./sqlite-tuned-alpha-store.js";
import type Database from "better-sqlite3";

const memoryConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false,
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
};

const T0 = 1_700_000_000_000;
// The in-scope write/read scopes (the positive control + the isolation baseline).
const SCOPE_A = { tenantId: "tenant_a", agentId: "agent_x", now: T0 } as const;
const READ_A = { tenantId: "tenant_a", agentId: "agent_x" } as const;
// The two foreign read scopes — each differs from SCOPE_A on EXACTLY one axis.
const READ_FOREIGN_TENANT = { tenantId: "tenant_b", agentId: "agent_x" } as const;
const READ_FOREIGN_AGENT = { tenantId: "tenant_a", agentId: "agent_y" } as const;

// A representative 4-alpha vector (distinct values per field so a column-order
// shuffle in the row map would surface as a field mismatch).
const VEC = {
  recencyAlpha: 0.3,
  temporalAlpha: 0.4,
  proofAlpha: 0.2,
  usefulnessAlpha: 0.5,
} as const;

describe("createSqliteTunedAlphaStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteTunedAlphaStore>;

  /** Count rows for a given scope (idempotency / one-row-per-scope assertions). */
  function rowCount(tenantId: string, agentId: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM tuned_alpha WHERE tenant_id = ? AND agent_id = ?")
        .get(tenantId, agentId) as { c: number }
    ).c;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteTunedAlphaStore({ db });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // =====================================================================
  // DDL — the additive table exists on boot + has NO trust column (belt #3)
  // =====================================================================

  describe("DDL (tuned_alpha table)", () => {
    it("creates the tuned_alpha table on boot (initSchema ran)", () => {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tuned_alpha'")
        .get();
      expect(row).toBeDefined();
    });

    it("has exactly the 10 expected columns (intent + bandit posterior) and NO trust-weight column (belt #3)", () => {
      const cols = (
        db.prepare("PRAGMA table_info(tuned_alpha)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(cols.sort()).toEqual(
        [
          "tenant_id",
          "agent_id",
          "recency_alpha",
          "temporal_alpha",
          "proof_alpha",
          "usefulness_alpha",
          "intent",
          "outcome_reward_sum",
          "outcome_n",
          "updated_at",
        ].sort(),
      );
      // Belt #3 at the schema layer: no column name carries a trust weight.
      expect(cols.some((c) => c.includes("trust"))).toBe(false);
    });

    it("the PK is the 3-col (tenant_id, agent_id, intent) — per-intent partition (RANK-02)", () => {
      const pkNames = (
        db.prepare("PRAGMA table_info(tuned_alpha)").all() as { name: string; pk: number }[]
      )
        .filter((c) => c.pk > 0)
        .map((c) => c.name)
        .sort();
      expect(pkNames).toEqual(["agent_id", "intent", "tenant_id"]);
    });
  });

  // =====================================================================
  // CRUD — scoped round-trip + absent->undefined + idempotent overwrite
  // =====================================================================

  describe("CRUD (scoped upsert/read)", () => {
    it("Test 1 — round-trips the 4-alpha vector byte-identical", async () => {
      const w = await store.upsert(VEC, SCOPE_A);
      expect(w.ok).toBe(true);

      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toEqual(VEC); // deep-equal the 4 written alphas exactly
    });

    it("Test 2 — an absent (tenant, agent) reads back as undefined (NOT a zero-vector, NOT an error)", async () => {
      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // The default-OFF no-op signal: undefined → apply site falls back to config
      // alphas. A pre-patch that returns a zero-vector (or errors) FAILS here.
      expect(res.value).toBeUndefined();
    });

    it("Test 5 — re-upsert overwrites the SAME (tenant, agent) row (idempotent — one row per scope)", async () => {
      await store.upsert(VEC, SCOPE_A);
      const second = {
        recencyAlpha: 0.9,
        temporalAlpha: 0.1,
        proofAlpha: 0.8,
        usefulnessAlpha: 0.2,
      } as const;
      await store.upsert(second, { ...SCOPE_A, now: T0 + 5000 });

      // Exactly ONE row for the scope (never duplicated).
      expect(rowCount(SCOPE_A.tenantId, SCOPE_A.agentId)).toBe(1);
      // The read returns the SECOND vector.
      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toEqual(second);
    });

    it("persists updated_at from the injected clock scope.now (NOT Date.now())", async () => {
      await store.upsert(VEC, { ...SCOPE_A, now: T0 + 1234 });
      const persisted = db
        .prepare("SELECT updated_at FROM tuned_alpha WHERE tenant_id = ? AND agent_id = ?")
        .get(SCOPE_A.tenantId, SCOPE_A.agentId) as { updated_at: number };
      expect(persisted.updated_at).toBe(T0 + 1234);
    });

    it("parses the row through createRowMapper — the read returns exactly the 4 camelCase alpha keys (no drift)", async () => {
      await store.upsert(VEC, SCOPE_A);
      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(Object.keys(res.value ?? {}).sort()).toEqual(
        ["proofAlpha", "recencyAlpha", "temporalAlpha", "usefulnessAlpha"].sort(),
      );
    });

    it("never throws on a forced upsert fault — an upsert after db.close() returns err + WARNs counts-only", async () => {
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const localStore = createSqliteTunedAlphaStore({ db: localDb, logger });
      localDb.close(); // force the prepared UPSERT to fault inside the try/catch

      const r = await localStore.upsert(VEC, SCOPE_A);
      expect(r.ok).toBe(false); // the outer try/catch caught it -> err, never a throw
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "tuned-alpha-upsert");
      expect(warn?.[0]).toMatchObject({ step: "tuned-alpha-upsert", errorKind: "internal" });
    });

    it("never throws on a forced read fault — a read after db.close() returns err", async () => {
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const localStore = createSqliteTunedAlphaStore({ db: localDb });
      localDb.close();

      const res = await localStore.read(READ_A);
      expect(res.ok).toBe(false);
    });

    it("logs counts/ids-only on upsert — never an alpha VALUE in the payload", async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const loggingStore = createSqliteTunedAlphaStore({ db, logger });
      // A recognizable sentinel alpha value that must NOT appear in the log payload.
      await loggingStore.upsert({ ...VEC, recencyAlpha: 0.123456789 }, SCOPE_A);
      const call = logger.debug.mock.calls.find((c) => c[0]?.step === "tuned-alpha-upsert");
      expect(call?.[0]).toMatchObject({
        step: "tuned-alpha-upsert",
        tenantId: SCOPE_A.tenantId,
        agentId: SCOPE_A.agentId,
      });
      // ids/counts-only: the alpha VALUE must not be in the structured payload.
      expect(JSON.stringify(call?.[0] ?? {})).not.toContain("0.123456789");
    });
  });

  // =====================================================================
  // Scope isolation — the load-bearing 2-way security boundary
  // =====================================================================

  describe("(tenant, agent) scope isolation", () => {
    it("Test 3 — a cross-TENANT read is ABSENT (FAILS if the WHERE drops tenant_id)", async () => {
      await store.upsert(VEC, SCOPE_A);
      const res = await store.read(READ_FOREIGN_TENANT);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toBeUndefined();
    });

    it("Test 4 — a cross-AGENT read is ABSENT (FAILS if the WHERE drops agent_id)", async () => {
      await store.upsert(VEC, SCOPE_A);
      const res = await store.read(READ_FOREIGN_AGENT);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toBeUndefined();
    });

    it("the in-scope read returns the vector (the positive control — isolation is not just 'always undefined')", async () => {
      await store.upsert(VEC, SCOPE_A);
      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toEqual(VEC);
    });

    it("distinct vectors under (tenantA,agentX) and (tenantB,agentX) do not bleed (each scope reads its OWN)", async () => {
      const vecB = {
        recencyAlpha: 0.11,
        temporalAlpha: 0.22,
        proofAlpha: 0.33,
        usefulnessAlpha: 0.44,
      } as const;
      await store.upsert(VEC, SCOPE_A);
      await store.upsert(vecB, { ...READ_FOREIGN_TENANT, now: T0 });

      const a = await store.read(READ_A);
      const b = await store.read(READ_FOREIGN_TENANT);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value).toEqual(VEC);
      expect(b.value).toEqual(vecB);
    });
  });

  // =====================================================================
  // Per-intent partition (RANK-02) — the intent key is ADDITIONAL, never a
  // relaxation of the (tenant, agent) isolation boundary
  // =====================================================================

  describe("per-intent upsert/read (RANK-02)", () => {
    // A second 4-alpha vector distinct from VEC (so a clobber would be visible).
    const VEC_TEMPORAL = {
      recencyAlpha: 0.9,
      temporalAlpha: 0.8,
      proofAlpha: 0.7,
      usefulnessAlpha: 0.6,
    } as const;
    const SCOPE_A_TEMPORAL = { ...SCOPE_A, intent: "temporal" } as const;
    const READ_A_TEMPORAL = { ...READ_A, intent: "temporal" } as const;

    it("a write to intent='temporal' does NOT clobber the global intent='' bucket", async () => {
      // Global bucket (omitted intent → '').
      await store.upsert(VEC, SCOPE_A);
      // Per-intent bucket — a DISTINCT row, must not overwrite the global one.
      await store.upsert(VEC_TEMPORAL, SCOPE_A_TEMPORAL);

      // Two rows now exist for the SAME (tenant, agent) — only possible with the
      // 3-col PK (a 2-col PK would have collapsed/clobbered them).
      expect(rowCount(SCOPE_A.tenantId, SCOPE_A.agentId)).toBe(2);

      // The global read still returns VEC (un-clobbered).
      const global = await store.read(READ_A);
      expect(global.ok).toBe(true);
      if (!global.ok) return;
      expect(global.value).toEqual(VEC);

      // The temporal read returns the temporal vector.
      const temporal = await store.read(READ_A_TEMPORAL);
      expect(temporal.ok).toBe(true);
      if (!temporal.ok) return;
      expect(temporal.value).toEqual(VEC_TEMPORAL);
    });

    it("a cross-TENANT read of a per-intent vector is ABSENT (isolation holds under intent)", async () => {
      await store.upsert(VEC_TEMPORAL, SCOPE_A_TEMPORAL);
      // Same intent, foreign tenant → must be undefined (intent does not relax isolation).
      const res = await store.read({ ...READ_FOREIGN_TENANT, intent: "temporal" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toBeUndefined();
    });

    it("re-upsert of the SAME intent bucket overwrites in place (one row per (tenant, agent, intent))", async () => {
      await store.upsert(VEC_TEMPORAL, SCOPE_A_TEMPORAL);
      const updated = {
        recencyAlpha: 0.15,
        temporalAlpha: 0.25,
        proofAlpha: 0.35,
        usefulnessAlpha: 0.45,
      } as const;
      await store.upsert(updated, { ...SCOPE_A_TEMPORAL, now: T0 + 9000 });

      // Still exactly ONE temporal row (idempotent within the intent bucket).
      const c = (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM tuned_alpha WHERE tenant_id=? AND agent_id=? AND intent='temporal'",
          )
          .get(SCOPE_A.tenantId, SCOPE_A.agentId) as { c: number }
      ).c;
      expect(c).toBe(1);

      const res = await store.read(READ_A_TEMPORAL);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toEqual(updated);
    });
  });

  // =====================================================================
  // Belt #3 (the trust freeze) restated at the ADAPTER layer — grep-0
  // =====================================================================

  describe("trust-freeze belt #3 (adapter source)", () => {
    it("Test 6 — the adapter source contains NO trust token (the bandit cannot move trust)", () => {
      const src = readFileSync(
        fileURLToPath(new URL("./sqlite-tuned-alpha-store.ts", import.meta.url)),
        "utf8",
      );
      expect(src.includes("trust")).toBe(false);
    });
  });
});
