// SPDX-License-Identifier: Apache-2.0
/**
 * `obs.cacheBreaks.byReason` handler acceptance tests.
 *
 * Drives the REAL handler over a seeded `:memory:` ObservabilityStore (the real
 * `insertDiagnostic` + the extended `queryCacheBreaksByReason` read), mirroring the
 * `obs-audit.test.ts` seam.
 *
 * Cases pinned:
 *   1. ROUND-TRIP — seeded cache_break rows come back per-reason with the $-lost SUM.
 *   2. Admin gate — a non-admin `_trustLevel` is rejected.
 *   3. WINDOW — the since/until filter narrows the scan.
 *   4. CONTENT-FREE — the rows carry reason(enum)+count+estCostUsd ONLY; a planted
 *      body marker never surfaces.
 *   5. EMPTY STORE — no obsStore ⇒ an honest `{ rows: [] }` (the soft-fail posture).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema, createObservabilityStore } from "@comis/memory";
import type { ObservabilityStore } from "@comis/memory";
import { bindObsCacheBreaksHandlers } from "./obs-cache-breaks.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";

/** A fresh `:memory:` ObservabilityStore with the full schema initialized. */
function makeStore(): ObservabilityStore {
  const db = new Database(":memory:");
  initSchema(db, 1536);
  return createObservabilityStore(db);
}

/** Insert one content-free `category:'cache_break'` diagnostic row. */
function insertCacheBreak(
  store: ObservabilityStore,
  reason: string,
  timestamp: number,
  estCostUsd: number,
  extraDetails: Record<string, unknown> = {},
): void {
  store.insertDiagnostic({
    timestamp,
    category: "cache_break",
    severity: "warning",
    agentId: "agent-1",
    message: "observability:cache_break",
    details: JSON.stringify({ reason, delta: 100, estCostUsd, ...extraDetails }),
  });
}

/** Build the handler bound to a store (or no store for the soft-fail case). */
function makeHandler(store?: ObservabilityStore) {
  const deps = { obsStore: store } as unknown as ObsHandlerDeps;
  return bindObsCacheBreaksHandlers(deps)["obs.cacheBreaks.byReason"];
}

describe("obs.cacheBreaks.byReason handler", () => {
  it("round-trips per-reason cache breaks with the $-lost SUM (admin)", async () => {
    const store = makeStore();
    insertCacheBreak(store, "tools_changed", 1_000, 0.002);
    insertCacheBreak(store, "tools_changed", 2_000, 0.003);
    insertCacheBreak(store, "system_changed", 3_000, 0.01);

    const handler = makeHandler(store);
    const result = (await handler({ _trustLevel: "admin" })) as {
      rows: Array<{ reason: string; count: number; estCostUsd: number }>;
    };

    expect(Array.isArray(result.rows)).toBe(true);
    const byReason = new Map(result.rows.map((r) => [r.reason, r]));
    expect(byReason.get("tools_changed")?.count).toBe(2);
    expect(byReason.get("tools_changed")?.estCostUsd).toBeCloseTo(0.005, 10);
    expect(byReason.get("system_changed")?.estCostUsd).toBeCloseTo(0.01, 10);
  });

  it("rejects a non-admin _trustLevel (dual-layer admin gate)", async () => {
    const store = makeStore();
    insertCacheBreak(store, "tools_changed", 1_000, 0.001);
    const handler = makeHandler(store);

    await expect(handler({ _trustLevel: "guest" })).rejects.toThrow(
      /admin access required/i,
    );
    await expect(handler({})).rejects.toThrow(/admin access required/i);
  });

  it("honors the since/until window", async () => {
    const store = makeStore();
    insertCacheBreak(store, "tools_changed", 1_000, 0.001);
    insertCacheBreak(store, "tools_changed", 5_000, 0.001);
    insertCacheBreak(store, "tools_changed", 9_000, 0.001);
    const handler = makeHandler(store);

    const result = (await handler({ _trustLevel: "admin", since: 2_000, until: 8_000 })) as {
      rows: Array<{ reason: string; count: number; estCostUsd: number }>;
    };
    expect(result.rows.find((r) => r.reason === "tools_changed")?.count).toBe(1);
  });

  it("returns content-free rows — reason/count/estCostUsd ONLY, no planted body", async () => {
    const store = makeStore();
    // A planted secret/body marker in extra details must NEVER reach the wire — the
    // row projection is the GROUP BY columns only (reason/count/estCostUsd).
    insertCacheBreak(store, "tools_changed", 1_000, 0.001, {
      secretMarker: "OPENAI_API_KEY",
      messageBody: "the user's private message",
    });
    const handler = makeHandler(store);

    const result = (await handler({ _trustLevel: "admin" })) as {
      rows: Array<Record<string, unknown>>;
    };
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(Object.keys(row).sort()).toEqual(["count", "estCostUsd", "reason"]);
    expect(JSON.stringify(result.rows)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(result.rows)).not.toContain("private message");
  });

  it("soft-fails to an empty result when no obsStore is present", async () => {
    const handler = makeHandler(undefined);
    const result = (await handler({ _trustLevel: "admin" })) as { rows: unknown[] };
    expect(result.rows).toEqual([]);
  });
});
