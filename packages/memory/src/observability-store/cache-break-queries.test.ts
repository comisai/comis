// SPDX-License-Identifier: Apache-2.0
/**
 * `queryCacheBreakRateByReason` query tests.
 *
 * "rate by reason over time" is a clean `GROUP BY json_extract(details,'$.reason')`
 * over the existing `obs_diagnostics` table + `idx_obs_diag_category` — NO new
 * table. Inserting several `category:'cache_break'` rows then querying
 * returns per-reason counts; an optional since/until window is honored.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../schema.js";
import { createObservabilityStore } from "./index.js";
import { queryCacheBreakRateByReason } from "./cache-break-queries.js";
import type { ObservabilityStore } from "./observability-store-types.js";

function insertCacheBreak(
  store: ObservabilityStore,
  reason: string,
  timestamp: number,
  estCostUsd = 0,
): void {
  store.insertDiagnostic({
    timestamp,
    category: "cache_break",
    severity: "warning",
    agentId: "agent-1",
    message: "observability:cache_break",
    details: JSON.stringify({ reason, delta: 100, estCostUsd }),
  });
}

describe("queryCacheBreakRateByReason (rate by reason via GROUP BY)", () => {
  let db: Database.Database;
  let store: ObservabilityStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
    store = createObservabilityStore(db);
  });

  it("returns per-reason counts over the existing obs_diagnostics index", () => {
    insertCacheBreak(store, "tools_changed", 1_000);
    insertCacheBreak(store, "tools_changed", 2_000);
    insertCacheBreak(store, "tools_changed", 3_000);
    insertCacheBreak(store, "system_changed", 4_000);
    insertCacheBreak(store, "ttl_expiry", 5_000);

    const rows = queryCacheBreakRateByReason(db, {});
    const byReason = new Map(rows.map((r) => [r.reason, r.count]));
    expect(byReason.get("tools_changed")).toBe(3);
    expect(byReason.get("system_changed")).toBe(1);
    expect(byReason.get("ttl_expiry")).toBe(1);
  });

  it("does NOT count non-cache_break diagnostic rows (category-scoped)", () => {
    insertCacheBreak(store, "tools_changed", 1_000);
    // A health_signal row with a 'reason' must be ignored (different category).
    store.insertDiagnostic({
      timestamp: 2_000,
      category: "health_signal",
      severity: "warning",
      message: "noise",
      details: JSON.stringify({ reason: "tools_changed" }),
    });

    const rows = queryCacheBreakRateByReason(db, {});
    const byReason = new Map(rows.map((r) => [r.reason, r.count]));
    expect(byReason.get("tools_changed")).toBe(1);
  });

  it("honors the since/until window", () => {
    insertCacheBreak(store, "tools_changed", 1_000);
    insertCacheBreak(store, "tools_changed", 5_000);
    insertCacheBreak(store, "tools_changed", 9_000);

    const rows = queryCacheBreakRateByReason(db, { since: 2_000, until: 8_000 });
    const byReason = new Map(rows.map((r) => [r.reason, r.count]));
    expect(byReason.get("tools_changed")).toBe(1);
  });

  it("returns an empty array when there are no cache_break rows", () => {
    expect(queryCacheBreakRateByReason(db, {})).toEqual([]);
  });

  // The $-lost SUM is derived from the details JSON. The IncidentReport
  // `cacheBreaks?` type declares estCostUsd (incident-report.ts), so the query
  // must surface it too.
  it("sums the per-reason estCostUsd ($ lost) from the details JSON", () => {
    insertCacheBreak(store, "tools_changed", 1_000, 0.002);
    insertCacheBreak(store, "tools_changed", 2_000, 0.003);
    insertCacheBreak(store, "system_changed", 3_000, 0.01);
    insertCacheBreak(store, "ttl_expiry", 4_000, 0); // a 0-cost (unknown-priced model) row stays 0

    const rows = queryCacheBreakRateByReason(db, {});
    const byReason = new Map(rows.map((r) => [r.reason, r]));
    // tools_changed: 0.002 + 0.003 summed per reason.
    expect(byReason.get("tools_changed")?.estCostUsd).toBeCloseTo(0.005, 10);
    expect(byReason.get("tools_changed")?.count).toBe(2);
    expect(byReason.get("system_changed")?.estCostUsd).toBeCloseTo(0.01, 10);
    expect(byReason.get("ttl_expiry")?.estCostUsd).toBe(0);
  });

  it("coalesces a missing estCostUsd to 0 (honest — never NaN/null)", () => {
    // A row whose details lacks $.estCostUsd (a pre-extension cache_break row).
    store.insertDiagnostic({
      timestamp: 1_000,
      category: "cache_break",
      severity: "warning",
      agentId: "agent-1",
      message: "observability:cache_break",
      details: JSON.stringify({ reason: "no_cost_field", delta: 100 }),
    });
    const rows = queryCacheBreakRateByReason(db, {});
    const row = rows.find((r) => r.reason === "no_cost_field");
    expect(row?.estCostUsd).toBe(0);
    expect(row?.count).toBe(1);
  });
});
