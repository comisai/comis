// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `ensureTunedAlphaIntent` — the v2.26 Verified Learning (WS3,
 * RANK-05) transactional PK-widening REBUILD of the `tuned_alpha` table. The
 * rebuild widens the PK from the legacy 2-col `(tenant_id, agent_id)` to the
 * per-intent 3-col `(tenant_id, agent_id, intent)` and adds the bandit-posterior
 * columns `outcome_reward_sum` / `outcome_n` — WITHOUT a trust column (belt #3
 * survives the rebuild, RANK-04).
 *
 * SQLite has NO `ALTER ADD PRIMARY KEY`: a bare `ADD COLUMN intent` would leave a
 * broken 2-col PK and the adapter's 3-col `ON CONFLICT(...,intent)` would abort
 * the second intent bucket. So the migration mirrors `ensureUsefulnessTable`
 * VERBATIM — a `_new` table with the genuine 3-col PK, copy every row into the
 * `''` bucket (`COALESCE(intent,'')`), drop, rename — bracketed by a
 * `foreign_keys` toggle and run inside `db.transaction` (atomic — no row loss).
 *
 * These tests build a POPULATED legacy (pre-intent) `tuned_alpha` table via raw
 * DDL, INSERT rows, then call the new ensure fn and assert: rows preserved +
 * `intent=''` backfill + 3-col PK + outcome columns + NO trust column. Plus a
 * fresh-DB path (the 3-col PK directly) and migration idempotency (a second call
 * is a no-op).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureTunedAlphaIntent } from "./schema-tuned-alpha.js";

// The legacy (pre-intent) 2-col-PK DDL — VERBATIM from the pre-v2.26
// `ensureTunedAlphaTable` (schema.ts), the table this migration rebuilds.
const LEGACY_TUNED_ALPHA_DDL = `
  CREATE TABLE tuned_alpha (
    tenant_id        TEXT NOT NULL,
    agent_id         TEXT NOT NULL,
    recency_alpha    REAL NOT NULL,
    temporal_alpha   REAL NOT NULL,
    proof_alpha      REAL NOT NULL,
    usefulness_alpha REAL NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, agent_id)
  );
`;

interface ColInfo {
  name: string;
  pk: number;
}

function tableInfo(db: Database.Database): ColInfo[] {
  return db.prepare("PRAGMA table_info(tuned_alpha)").all() as ColInfo[];
}

describe("ensureTunedAlphaIntent (RANK-05 transactional rebuild)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // =====================================================================
  // The POPULATED legacy-DB rebuild — preserve rows + backfill intent=''
  // =====================================================================

  describe("rebuild on a POPULATED pre-intent DB", () => {
    beforeEach(() => {
      // Build the legacy 2-col-PK table and seed two DISTINCT-agent rows with
      // real (distinct-per-field) alpha values so a column shuffle would surface.
      db.exec(LEGACY_TUNED_ALPHA_DDL);
      db.prepare(
        "INSERT INTO tuned_alpha (tenant_id, agent_id, recency_alpha, temporal_alpha, proof_alpha, usefulness_alpha, updated_at) VALUES (?,?,?,?,?,?,?)",
      ).run("tenant_a", "agent_x", 0.31, 0.41, 0.21, 0.51, 1_700_000_000_000);
      db.prepare(
        "INSERT INTO tuned_alpha (tenant_id, agent_id, recency_alpha, temporal_alpha, proof_alpha, usefulness_alpha, updated_at) VALUES (?,?,?,?,?,?,?)",
      ).run("tenant_b", "agent_y", 0.12, 0.22, 0.32, 0.42, 1_700_000_001_000);
    });

    it("preserves EVERY existing alpha row (no data loss) and backfills intent=''", () => {
      ensureTunedAlphaIntent(db);

      const rows = db
        .prepare("SELECT * FROM tuned_alpha ORDER BY tenant_id")
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(2);

      // Row A — alphas intact, intent backfilled to the global '' bucket.
      expect(rows[0]).toMatchObject({
        tenant_id: "tenant_a",
        agent_id: "agent_x",
        recency_alpha: 0.31,
        temporal_alpha: 0.41,
        proof_alpha: 0.21,
        usefulness_alpha: 0.51,
        intent: "",
        updated_at: 1_700_000_000_000,
      });
      // Row B — alphas intact, intent=''.
      expect(rows[1]).toMatchObject({
        tenant_id: "tenant_b",
        agent_id: "agent_y",
        recency_alpha: 0.12,
        usefulness_alpha: 0.42,
        intent: "",
      });
    });

    it("widens the PK to 3-col (tenant_id, agent_id, intent) — intent is a PK member", () => {
      ensureTunedAlphaIntent(db);
      const info = tableInfo(db);
      const intentCol = info.find((c) => c.name === "intent");
      expect(intentCol).toBeDefined();
      // pk>0 marks a PRIMARY KEY member (ADD COLUMN cannot do this — a bare add
      // would leave intent.pk === 0).
      expect(intentCol?.pk).toBeGreaterThan(0);
      // All three isolation/bucket columns are PK members.
      const pkNames = info.filter((c) => c.pk > 0).map((c) => c.name).sort();
      expect(pkNames).toEqual(["agent_id", "intent", "tenant_id"]);
    });

    it("adds the bandit-posterior columns outcome_reward_sum + outcome_n (default 0)", () => {
      ensureTunedAlphaIntent(db);
      const names = tableInfo(db).map((c) => c.name);
      expect(names).toContain("outcome_reward_sum");
      expect(names).toContain("outcome_n");

      // Backfilled rows default the posterior to 0 (no observed reward yet).
      const row = db
        .prepare("SELECT outcome_reward_sum, outcome_n FROM tuned_alpha WHERE tenant_id='tenant_a'")
        .get() as { outcome_reward_sum: number; outcome_n: number };
      expect(row.outcome_reward_sum).toBe(0);
      expect(row.outcome_n).toBe(0);
    });

    it("preserves belt #3 — NO trust column survives the rebuild (RANK-04)", () => {
      ensureTunedAlphaIntent(db);
      const info = tableInfo(db);
      // Belt #3 at the schema layer: not one column name carries a trust weight.
      expect(info.every((c) => !/trust/i.test(c.name))).toBe(true);
    });

    it("is idempotent — a second call is a no-op (PK already 3-col), rows unchanged", () => {
      ensureTunedAlphaIntent(db);
      ensureTunedAlphaIntent(db);
      const rows = db.prepare("SELECT COUNT(*) AS c FROM tuned_alpha").get() as { c: number };
      expect(rows.c).toBe(2);
      // The PK is still 3-col after the redundant call (no double-rebuild damage).
      const pkNames = tableInfo(db).filter((c) => c.pk > 0).map((c) => c.name).sort();
      expect(pkNames).toEqual(["agent_id", "intent", "tenant_id"]);
    });
  });

  // =====================================================================
  // The FRESH-DB path — the 3-col PK directly (no rebuild)
  // =====================================================================

  describe("fresh DB", () => {
    it("creates the 3-col-PK table directly with outcome columns and NO trust column", () => {
      ensureTunedAlphaIntent(db);
      const info = tableInfo(db);
      const names = info.map((c) => c.name).sort();
      expect(names).toEqual(
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
      const pkNames = info.filter((c) => c.pk > 0).map((c) => c.name).sort();
      expect(pkNames).toEqual(["agent_id", "intent", "tenant_id"]);
      expect(info.every((c) => !/trust/i.test(c.name))).toBe(true);
    });

    it("allows two intent buckets under the same (tenant, agent) — distinct rows", () => {
      ensureTunedAlphaIntent(db);
      const ins = db.prepare(
        "INSERT INTO tuned_alpha (tenant_id, agent_id, intent, recency_alpha, temporal_alpha, proof_alpha, usefulness_alpha, outcome_reward_sum, outcome_n, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      // Two intents under ONE (tenant, agent) — would COLLIDE on a 2-col PK.
      ins.run("t", "a", "", 0.1, 0.1, 0.1, 0.1, 0, 0, 1);
      ins.run("t", "a", "temporal", 0.9, 0.9, 0.9, 0.9, 0, 0, 1);
      const c = db
        .prepare("SELECT COUNT(*) AS c FROM tuned_alpha WHERE tenant_id='t' AND agent_id='a'")
        .get() as { c: number };
      expect(c.c).toBe(2);
    });
  });

  // =====================================================================
  // Belt #3 (the trust freeze) restated at the migration source — grep-0
  // =====================================================================

  describe("trust-freeze belt #3 (migration source)", () => {
    it("the migration DDL source names no trust column (the rebuilt table cannot store a trust weight)", () => {
      const src = readFileSync(
        fileURLToPath(new URL("./schema-tuned-alpha.ts", import.meta.url)),
        "utf8",
      );
      // The source may MENTION "trust" only in a "no trust column" comment, never
      // as a column in the DDL. Assert no `trust_alpha`/`trust_weight`-style column.
      expect(/trust_alpha|trust_weight|trust_level/i.test(src)).toBe(false);
    });
  });
});
