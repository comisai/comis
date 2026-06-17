// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createSqliteUserRepresentationStore` — the SOLE @comis/memory
 * adapter for the `UserRepresentationStore` port. It owns ALL the
 * per-user-representation SQL over the additive `user_representation` table.
 *
 * The harness constructs a real `SqliteMemoryAdapter` over an in-memory DB (so
 * `initSchema` runs — the `user_representation` table is created on boot and
 * `PRAGMA foreign_keys = ON` is set via `openSqliteDatabase`, making the
 * `source_memory_id -> memories(id)` ON DELETE CASCADE fire) and gets
 * `adapter.getDb()`.
 *
 * ## The load-bearing security boundary (the §5.2 isolation pattern,
 *    extended with `userId`)
 *
 * Comis runs many agents and many users in ONE DB. Every adapter statement —
 * INSERT, SELECT — filters `WHERE tenant_id = ? AND agent_id = ? AND user_id = ?`
 * (bound params). A representation entry written under one (tenant, agent, user)
 * MUST NEVER be returned for another scope — proven by the 3-way "scope
 * isolation" describe (cross-agent, cross-tenant, AND cross-user all ABSENT).
 *
 * ## The high-trust floor at the DB layer
 *
 * `trust='external'` can NEVER ENTER the profile: the table's
 * `CHECK(trust IN ('system','learned'))` rejects it at the DB layer, and the
 * adapter's `upsert` rejects below-floor trust at the write boundary BEFORE the
 * INSERT (defense-in-depth — layers 1+3 of the 3-layer anti-poisoning defense;
 * the port-type layer is layer 2).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MemoryConfig, UserRepresentationTrust, UserRepresentationType } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteUserRepresentationStore } from "./sqlite-user-representation-store.js";
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
const SCOPE_A = { tenantId: "tenant_a", agentId: "agent_x", userId: "user_a", now: T0 } as const;
const READ_A = { tenantId: "tenant_a", agentId: "agent_x", userId: "user_a" } as const;
// The three foreign scopes — each differs from SCOPE_A on EXACTLY one axis.
const READ_FOREIGN_AGENT = { tenantId: "tenant_a", agentId: "agent_y", userId: "user_a" } as const;
const READ_FOREIGN_TENANT = { tenantId: "tenant_b", agentId: "agent_x", userId: "user_a" } as const;
const READ_FOREIGN_USER = { tenantId: "tenant_a", agentId: "agent_x", userId: "user_b" } as const;

const ALL_TYPES: UserRepresentationType[] = [
  "identity",
  "preference",
  "relationship",
  "instruction",
];

describe("createSqliteUserRepresentationStore", () => {
  let adapter: SqliteMemoryAdapter;
  let db: Database.Database;
  let store: ReturnType<typeof createSqliteUserRepresentationStore>;

  /** Count ALL rows in user_representation (insert + isolation assertions). */
  function reprCount(): number {
    return (
      db.prepare("SELECT COUNT(*) AS c FROM user_representation").get() as { c: number }
    ).c;
  }

  /**
   * Count CURRENT-TRUTH rows (t_valid_end IS NULL) for a (tenant, agent, user,
   * entryType) slot — the supersession + corroboration assertions read this to
   * prove "no new current-truth row" / "exactly one current-truth survives".
   */
  function currentTruthCount(
    tenantId: string,
    agentId: string,
    userId: string,
    entryType: string,
  ): number {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM user_representation " +
            "WHERE tenant_id=? AND agent_id=? AND user_id=? AND entry_type=? AND t_valid_end IS NULL",
        )
        .get(tenantId, agentId, userId, entryType) as { c: number }
    ).c;
  }

  /** Read the raw bi-temporal columns of the SINGLE current-truth row for a slot. */
  function currentTruthRow(
    tenantId: string,
    agentId: string,
    userId: string,
    entryType: string,
  ): { content: string; trust: string; confidence: number | null; t_valid_end: number | null } | undefined {
    return db
      .prepare(
        "SELECT content, trust, confidence, t_valid_end FROM user_representation " +
          "WHERE tenant_id=? AND agent_id=? AND user_id=? AND entry_type=? AND t_valid_end IS NULL",
      )
      .get(tenantId, agentId, userId, entryType) as
      | { content: string; trust: string; confidence: number | null; t_valid_end: number | null }
      | undefined;
  }

  /** Count SOFT-CLOSED (superseded) rows for a slot — the bounded-history assertion. */
  function closedRowCount(
    tenantId: string,
    agentId: string,
    userId: string,
    entryType: string,
  ): number {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM user_representation " +
            "WHERE tenant_id=? AND agent_id=? AND user_id=? AND entry_type=? AND t_valid_end IS NOT NULL",
        )
        .get(tenantId, agentId, userId, entryType) as { c: number }
    ).c;
  }

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(memoryConfig);
    db = adapter.getDb();
    store = createSqliteUserRepresentationStore({ db });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // =====================================================================
  // DDL — the additive table + the high-trust CHECK + the prefix-type CHECK
  // =====================================================================

  describe("DDL (user_representation table + CHECK constraints)", () => {
    it("creates the user_representation table on boot (initSchema ran)", () => {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='user_representation'",
        )
        .get();
      expect(row).toBeDefined();
    });

    it("REJECTS trust='external' at the DB layer (the high-trust floor — CHECK constraint failed)", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO user_representation (id, tenant_id, agent_id, user_id, entry_type, content, trust, created_at) " +
              "VALUES (?,?,?,?,?,?,?,?)",
          )
          .run("e1", "t", "a", "u", "identity", "x", "external", 1),
      ).toThrow(/CHECK constraint failed/);
    });

    it("REJECTS entry_type='semantic' at the DB layer (the prefix-type vocabulary, NOT the memoryType set)", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO user_representation (id, tenant_id, agent_id, user_id, entry_type, content, trust, created_at) " +
              "VALUES (?,?,?,?,?,?,?,?)",
          )
          .run("e2", "t", "a", "u", "semantic", "x", "learned", 1),
      ).toThrow(/CHECK constraint failed/);
    });

    it("ACCEPTS a high-trust + valid-prefix row (trust='learned', entry_type='preference')", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO user_representation (id, tenant_id, agent_id, user_id, entry_type, content, trust, created_at) " +
              "VALUES (?,?,?,?,?,?,?,?)",
          )
          .run("e3", "t", "a", "u", "preference", "x", "learned", 1),
      ).not.toThrow();
      expect(reprCount()).toBe(1);
    });
  });

  // =====================================================================
  // CRUD — scoped round-trip per prefix-type + write-time external reject
  // =====================================================================

  describe("CRUD (scoped upsert/read + write-time external reject)", () => {
    it("round-trips each prefix-type: upsert(identity|preference|relationship|instruction) then read returns it", async () => {
      for (const entryType of ALL_TYPES) {
        const r = await store.upsert(
          { entryType, content: `c-${entryType}`, trust: "learned" },
          SCOPE_A,
        );
        expect(r.ok).toBe(true);
      }

      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(ALL_TYPES.length);

      for (const entryType of ALL_TYPES) {
        const entry = res.value.find((e) => e.entryType === entryType);
        expect(entry).toBeDefined();
        expect(entry?.content).toBe(`c-${entryType}`);
        expect(entry?.trust).toBe("learned");
        expect(typeof entry?.id).toBe("string");
        expect((entry?.id ?? "").length).toBeGreaterThan(0);
        expect(typeof entry?.createdAt).toBe("number");
        expect(entry?.createdAt).toBe(T0); // the injected-clock now, NOT Date.now()
      }
    });

    it("persists sourceMemoryId provenance when supplied (and omits it when absent)", async () => {
      // Seed a real memory so the source_memory_id FK target exists.
      const memId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, source_who, created_at) " +
          "VALUES (?,?,?,?,?,?,?,?)",
      ).run(memId, SCOPE_A.tenantId, SCOPE_A.agentId, SCOPE_A.userId, "src", "learned", "agent", T0);

      const withSrc = await store.upsert(
        { entryType: "identity", content: "from-memory", trust: "learned", sourceMemoryId: memId },
        SCOPE_A,
      );
      expect(withSrc.ok).toBe(true);
      const noSrc = await store.upsert(
        { entryType: "preference", content: "no-source", trust: "learned" },
        SCOPE_A,
      );
      expect(noSrc.ok).toBe(true);

      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const a = res.value.find((e) => e.entryType === "identity");
      const b = res.value.find((e) => e.entryType === "preference");
      expect(a?.sourceMemoryId).toBe(memId);
      expect(b?.sourceMemoryId).toBeUndefined();
    });

    it("REJECTS a below-floor trust at the WRITE boundary (returns err, never throws; nothing persisted)", async () => {
      // Cast the forbidden value past the compile-time guard to exercise the
      // runtime reject (the port layer makes this unreachable in real callers).
      const r = await store.upsert(
        { entryType: "preference", content: "x", trust: "external" as unknown as UserRepresentationTrust },
        SCOPE_A,
      );
      expect(r.ok).toBe(false);

      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0); // the reject ran BEFORE the INSERT
      expect(reprCount()).toBe(0);
    });

    it("REJECTS a redaction-firewall hit at the WRITE boundary (a secret-shaped body returns err; nothing persisted; WARN logged)", async () => {
      // The adapter's OWN validateMemoryWrite belt — separate from the
      // offline builder's. A non-`clean` verdict is REJECTED (no `external` tier to
      // down-store into); the WARN branch (counts-only) fires with a logger present.
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const loggingStore = createSqliteUserRepresentationStore({ db, logger });
      // A synthetic secret-shaped body the redaction firewall flags (NOT a real key).
      const SECRET_SHAPED = "token sk-abcdefghijklmnop1234 and AKIAIOSFODNN7EXAMPLE";
      const r = await loggingStore.upsert(
        { entryType: "identity", content: SECRET_SHAPED, trust: "learned" },
        SCOPE_A,
      );
      expect(r.ok).toBe(false);

      // Nothing persisted (the reject ran BEFORE the INSERT).
      const res = await loggingStore.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0);
      expect(reprCount()).toBe(0);

      // The WARN branch fired counts-only — and NEVER carries the secret-shaped body.
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "user-repr-upsert");
      expect(warn?.[0]).toMatchObject({ step: "user-repr-upsert", errorKind: "validation" });
      expect(JSON.stringify(warn?.[0] ?? {})).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("never throws on a forced upsert fault — an upsert after db.close() returns err + WARNs counts-only", async () => {
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const localStore = createSqliteUserRepresentationStore({ db: localDb, logger });
      localDb.close(); // force the prepared INSERT to fault inside the try/catch

      const r = await localStore.upsert(
        { entryType: "preference", content: "x", trust: "learned" },
        SCOPE_A,
      );
      expect(r.ok).toBe(false); // the outer try/catch caught it -> err, never a throw
      const warn = logger.warn.mock.calls.find((c) => c[0]?.step === "user-repr-upsert");
      expect(warn?.[0]).toMatchObject({ step: "user-repr-upsert", errorKind: "internal" });
    });

    it("parses rows through createRowMapper — a returned entry has the exact typed shape (no drift)", async () => {
      await store.upsert({ entryType: "instruction", content: "be concise", trust: "system" }, SCOPE_A);
      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const entry = res.value[0];
      expect(entry).toBeDefined();
      // The exact mapped (camelCase) shape — strictObject rejected any extra column.
      // v2.26 WS5 REVISE-02: upsert now stamps t_valid_start, so a current-truth
      // entry carries `validFrom` (validTo stays absent = current truth).
      expect(Object.keys(entry ?? {}).sort()).toEqual(
        ["content", "createdAt", "entryType", "id", "trust", "validFrom"].sort(),
      );
      expect(entry?.validFrom).toBe(T0); // the injected-clock now
    });

    it("never throws on a forced fault — a read after db.close() returns err", async () => {
      const localAdapter = new SqliteMemoryAdapter(memoryConfig);
      const localDb = localAdapter.getDb();
      const localStore = createSqliteUserRepresentationStore({ db: localDb });
      localDb.close(); // force the prepared statement to fault

      const res = await localStore.read(READ_A);
      expect(res.ok).toBe(false);
    });

    it("logs counts/metadata ONLY on a successful read — never the profile content", async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const loggingStore = createSqliteUserRepresentationStore({ db, logger });
      await loggingStore.upsert(
        { entryType: "preference", content: "SECRET-PROFILE-BODY", trust: "learned" },
        SCOPE_A,
      );
      logger.debug.mockClear();
      await loggingStore.read(READ_A);
      const call = logger.debug.mock.calls.find((c) => c[0]?.step === "user-repr-read");
      expect(call?.[0]).toMatchObject({ step: "user-repr-read", count: 1 });
      expect(typeof call?.[0]?.durationMs).toBe("number");
      // Counts-only: the payload must NOT carry the profile body.
      expect(JSON.stringify(call?.[0] ?? {})).not.toContain("SECRET-PROFILE-BODY");
    });
  });

  // =====================================================================
  // Scope isolation — the load-bearing 3-way security boundary
  // =====================================================================

  describe("(tenant, agent, user) scope isolation", () => {
    async function seedUnderScopeA(): Promise<void> {
      const r = await store.upsert(
        { entryType: "identity", content: "in-scope", trust: "learned" },
        SCOPE_A,
      );
      expect(r.ok).toBe(true);
    }

    it("a cross-AGENT read is ABSENT — an entry written under agent_x is not returned for agent_y", async () => {
      await seedUnderScopeA();
      const res = await store.read(READ_FOREIGN_AGENT);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0);
    });

    it("a cross-TENANT read is ABSENT — same agent_id, different tenant", async () => {
      await seedUnderScopeA();
      const res = await store.read(READ_FOREIGN_TENANT);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0);
    });

    it("a cross-USER read is ABSENT — same (tenant, agent), different user_b (the third scope axis)", async () => {
      await seedUnderScopeA();
      const res = await store.read(READ_FOREIGN_USER);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(0);
    });

    it("the in-scope read returns the entry (the positive control — isolation is not just 'always empty')", async () => {
      await seedUnderScopeA();
      const res = await store.read(READ_A);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value).toHaveLength(1);
      expect(res.value[0]?.content).toBe("in-scope");
    });
  });

  // =====================================================================
  // REVISE-01/02/03 — the bi-temporal trust-first supersession (the §12 WS5
  // first-RED) + asOf + anti-poison + bounded history + current-truth read.
  // Mirrors the sqlite-triple-store supersession; MIRRORED, never imported.
  // =====================================================================

  describe("revise() — bi-temporal trust-first supersession + asOf", () => {
    /** A distinct timestamp ladder so asOf windows are unambiguous. */
    const T_SEED = T0; // the incumbent's t_valid_start
    const T_REVISE = T0 + 60_000; // the supersession instant
    const SCOPE_SEED = { ...SCOPE_A, now: T_SEED } as const;
    const SCOPE_REVISE = { ...SCOPE_A, now: T_REVISE } as const;

    it("a HIGHER-trust contradicting fact soft-closes the incumbent and the incumbent stays asOf-resolvable (WS5 first-RED)", async () => {
      // Seed a `learned` preference, then revise() a `system`-trust contradiction.
      const seeded = await store.revise(
        { entryType: "preference", content: "prefers coffee", trust: "learned" },
        SCOPE_SEED,
      );
      expect(seeded.ok).toBe(true);

      const revised = await store.revise(
        { entryType: "preference", content: "prefers tea", trust: "system" },
        SCOPE_REVISE,
      );
      expect(revised.ok).toBe(true);

      // The current-truth read returns ONLY the winner — no superseded belief leaks.
      const now = await store.read(READ_A);
      expect(now.ok).toBe(true);
      if (!now.ok) return;
      const prefs = now.value.filter((e) => e.entryType === "preference");
      expect(prefs).toHaveLength(1);
      expect(prefs[0]?.content).toBe("prefers tea");

      // The incumbent was SOFT-CLOSED (not deleted): one current-truth + one closed row.
      expect(currentTruthCount("tenant_a", "agent_x", "user_a", "preference")).toBe(1);
      expect(closedRowCount("tenant_a", "agent_x", "user_a", "preference")).toBe(1);

      // asOf BEFORE the revision STILL resolves the superseded incumbent.
      const before = await store.asOf(T_SEED + 1, READ_A);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const beforePref = before.value.filter((e) => e.entryType === "preference");
      expect(beforePref).toHaveLength(1);
      expect(beforePref[0]?.content).toBe("prefers coffee");

      // asOf AFTER the revision resolves the new current-truth.
      const after = await store.asOf(T_REVISE + 1, READ_A);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.filter((e) => e.entryType === "preference")[0]?.content).toBe(
        "prefers tea",
      );
    });

    it("a corroborating candidate bumps confidence to a STRICTLY-GREATER value with NO new current-truth row (WS5 first-RED corroboration half)", async () => {
      // Seed with a known confidence (revise inserts at the default seed), then
      // corroborate the SAME belief (normalized-equal content).
      const seeded = await store.revise(
        { entryType: "preference", content: "prefers dark mode", trust: "learned" },
        SCOPE_SEED,
      );
      expect(seeded.ok).toBe(true);

      const beforeRow = currentTruthRow("tenant_a", "agent_x", "user_a", "preference");
      expect(beforeRow).toBeDefined();
      const seedConfidence = beforeRow?.confidence ?? 0.5;

      // Corroboration: same belief slot, content that sameBelief() treats as equal
      // (normalized-trim-lowercase). NO new current-truth row; confidence bumps.
      const corroborated = await store.revise(
        { entryType: "preference", content: "  Prefers Dark Mode  ", trust: "learned" },
        SCOPE_REVISE,
      );
      expect(corroborated.ok).toBe(true);

      // Still exactly ONE current-truth row for the slot — corroboration is in-place.
      expect(currentTruthCount("tenant_a", "agent_x", "user_a", "preference")).toBe(1);
      // No soft-closed row either — corroboration does NOT supersede.
      expect(closedRowCount("tenant_a", "agent_x", "user_a", "preference")).toBe(0);

      // The bump is OBSERVABLE: confidence is STRICTLY GREATER than the seed.
      const afterRow = currentTruthRow("tenant_a", "agent_x", "user_a", "preference");
      expect(afterRow?.confidence ?? 0).toBeGreaterThan(seedConfidence);
      // The content stays the incumbent's (corroboration UPDATEs confidence, not content).
      expect(afterRow?.content).toBe("prefers dark mode");
    });

    it("a LOWER-trust contradiction does NOT supersede a higher-trust incumbent (anti-poison, recorded-not-believed)", async () => {
      // Seed a `system` incumbent, then revise() a `learned` contradiction.
      await store.revise(
        { entryType: "identity", content: "name is Ada", trust: "system" },
        SCOPE_SEED,
      );
      const revised = await store.revise(
        { entryType: "identity", content: "name is Bob", trust: "learned" },
        SCOPE_REVISE,
      );
      expect(revised.ok).toBe(true);

      // The system incumbent STAYS current-truth — the learned claim never wins.
      const now = await store.read(READ_A);
      expect(now.ok).toBe(true);
      if (!now.ok) return;
      const id = now.value.filter((e) => e.entryType === "identity");
      expect(id).toHaveLength(1);
      expect(id[0]?.content).toBe("name is Ada");
      expect(id[0]?.trust).toBe("system");
      expect(currentTruthCount("tenant_a", "agent_x", "user_a", "identity")).toBe(1);
    });

    it("REJECTS trust='external' on the revise() path (REVISE-03 — the high-trust floor reject runs before the txn)", async () => {
      const r = await store.revise(
        { entryType: "preference", content: "x", trust: "external" as unknown as UserRepresentationTrust },
        SCOPE_SEED,
      );
      expect(r.ok).toBe(false);
      expect(reprCount()).toBe(0); // nothing persisted — the reject ran BEFORE the txn
    });

    it("REJECTS a redaction-firewall hit on the revise() path (a secret-shaped body returns err; nothing persisted)", async () => {
      const SECRET_SHAPED = "token sk-abcdefghijklmnop1234 and AKIAIOSFODNN7EXAMPLE";
      const r = await store.revise(
        { entryType: "identity", content: SECRET_SHAPED, trust: "learned" },
        SCOPE_SEED,
      );
      expect(r.ok).toBe(false);
      expect(reprCount()).toBe(0);
    });

    it("read() returns CURRENT-TRUTH only after a supersession — the superseded row is absent from read() but present via asOf() (Pitfall 1)", async () => {
      await store.revise(
        { entryType: "instruction", content: "always be terse", trust: "learned" },
        SCOPE_SEED,
      );
      await store.revise(
        { entryType: "instruction", content: "always be verbose", trust: "system" },
        SCOPE_REVISE,
      );

      // read() never surfaces the superseded "always be terse".
      const now = await store.read(READ_A);
      expect(now.ok).toBe(true);
      if (!now.ok) return;
      const instr = now.value.filter((e) => e.entryType === "instruction");
      expect(instr.map((e) => e.content)).toEqual(["always be verbose"]);

      // But asOf at the seed instant still sees it.
      const before = await store.asOf(T_SEED + 1, READ_A);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      expect(
        before.value.filter((e) => e.entryType === "instruction").map((e) => e.content),
      ).toEqual(["always be terse"]);
    });

    it("topic-distinct same-type facts COEXIST as current-truth (no over-detection collapse, Pitfall 4)", async () => {
      // Two unrelated preferences — sameBelief() must NOT treat them as the same slot.
      await store.revise(
        { entryType: "preference", content: "enjoys hiking on weekends", trust: "learned" },
        SCOPE_SEED,
      );
      await store.revise(
        { entryType: "preference", content: "drinks espresso every morning", trust: "learned" },
        SCOPE_REVISE,
      );

      const now = await store.read(READ_A);
      expect(now.ok).toBe(true);
      if (!now.ok) return;
      const prefs = now.value.filter((e) => e.entryType === "preference");
      expect(prefs).toHaveLength(2); // both stay current-truth — neither superseded
      expect(currentTruthCount("tenant_a", "agent_x", "user_a", "preference")).toBe(2);
    });

    it("bounds per-record history — superseded rows beyond historyCap are trimmed oldest-first (Pitfall 2)", async () => {
      const cap = 3;
      const cappedStore = createSqliteUserRepresentationStore({ db, historyCap: cap });

      // Revise the SAME belief slot cap+2 times with strictly-newer CONTRADICTING
      // values (same topic "prefers <drink>", different value — the supersede band,
      // 0.5 ≤ Dice < 0.9), so each revision soft-closes the prior incumbent and the
      // closed-row history genuinely accumulates (then gets trimmed at the cap).
      const beliefs = [
        "prefers coffee",
        "prefers tea",
        "prefers cocoa",
        "prefers cider",
        "prefers juice",
      ];
      expect(beliefs).toHaveLength(cap + 2);
      for (let i = 0; i < beliefs.length; i++) {
        const r = await cappedStore.revise(
          { entryType: "preference", content: beliefs[i] ?? "", trust: "learned" },
          { ...SCOPE_A, now: T0 + i * 1_000 },
        );
        expect(r.ok).toBe(true);
      }

      // Exactly one current-truth (the last belief); closed history is bounded at
      // historyCap (4 supersessions happened, but only `cap` closed rows are kept).
      expect(currentTruthCount("tenant_a", "agent_x", "user_a", "preference")).toBe(1);
      expect(closedRowCount("tenant_a", "agent_x", "user_a", "preference")).toBeLessThanOrEqual(
        cap,
      );
      // The trim ACTUALLY fired — without it there would be 4 closed rows.
      expect(closedRowCount("tenant_a", "agent_x", "user_a", "preference")).toBe(cap);

      // A recent asOf (within the retained window) still resolves a believed entry.
      const recent = await cappedStore.asOf(T0 + (beliefs.length - 1) * 1_000 + 1, READ_A);
      expect(recent.ok).toBe(true);
      if (!recent.ok) return;
      expect(recent.value.filter((e) => e.entryType === "preference")).toHaveLength(1);
    });

    it("isolation holds on revise()/asOf() — a revise under scope B never reads/closes/returns a scope-A row", async () => {
      // Seed scope A.
      await store.revise(
        { entryType: "preference", content: "prefers coffee", trust: "learned" },
        SCOPE_SEED,
      );
      // Revise the SAME entryType under a foreign agent — must NOT touch scope A's row.
      const scopeB = { tenantId: "tenant_a", agentId: "agent_y", userId: "user_a", now: T_REVISE } as const;
      await store.revise(
        { entryType: "preference", content: "prefers tea", trust: "system" },
        scopeB,
      );

      // Scope A's incumbent is untouched (NOT soft-closed by scope B's contradiction).
      expect(currentTruthCount("tenant_a", "agent_x", "user_a", "preference")).toBe(1);
      expect(closedRowCount("tenant_a", "agent_x", "user_a", "preference")).toBe(0);
      const aNow = await store.read(READ_A);
      expect(aNow.ok && aNow.value.find((e) => e.entryType === "preference")?.content).toBe(
        "prefers coffee",
      );

      // asOf under scope A never returns scope B's row.
      const aAsOf = await store.asOf(T_REVISE + 1, READ_A);
      expect(aAsOf.ok).toBe(true);
      if (!aAsOf.ok) return;
      expect(aAsOf.value.every((e) => e.content !== "prefers tea")).toBe(true);
    });

    it("an empty scope field on revise() RAISES into an err (fail-closed — never widens to a shared pool)", async () => {
      const r = await store.revise(
        { entryType: "preference", content: "x", trust: "learned" },
        { tenantId: "", agentId: "agent_x", userId: "user_a", now: T0 },
      );
      expect(r.ok).toBe(false);
      expect(reprCount()).toBe(0);
    });

    it("revise() with no incumbent INSERTs the candidate as the sole current-truth", async () => {
      const r = await store.revise(
        { entryType: "relationship", content: "married to Carol", trust: "learned" },
        SCOPE_SEED,
      );
      expect(r.ok).toBe(true);
      expect(currentTruthCount("tenant_a", "agent_x", "user_a", "relationship")).toBe(1);
      const now = await store.read(READ_A);
      expect(now.ok && now.value.find((e) => e.entryType === "relationship")?.content).toBe(
        "married to Carol",
      );
    });

    it("logs counts-only on a successful revise — never the profile content body", async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const loggingStore = createSqliteUserRepresentationStore({ db, logger });
      await loggingStore.revise(
        { entryType: "preference", content: "SECRET-REVISE-BODY", trust: "learned" },
        SCOPE_SEED,
      );
      const call = logger.debug.mock.calls.find((c) => c[0]?.step === "user-repr-revise");
      expect(call?.[0]).toMatchObject({ step: "user-repr-revise" });
      expect(typeof call?.[0]?.durationMs).toBe("number");
      expect(JSON.stringify(call?.[0] ?? {})).not.toContain("SECRET-REVISE-BODY");
    });
  });
});
