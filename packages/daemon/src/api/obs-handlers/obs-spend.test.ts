// SPDX-License-Identifier: Apache-2.0
/**
 * `obs.spend.snapshot` handler acceptance tests.
 *
 * Drives the REAL handler over (a) a threaded LIVE spend reader (the
 * `spendAccumulator.getSnapshot()` shape, NOT the lagging SQL) and (b) a seeded
 * `:memory:` ObservabilityStore for the pricing-coverage GROUP BY. Mirrors the
 * `obs-audit.test.ts` / `obs-cache-breaks.test.ts` seam.
 *
 * Cases pinned:
 *   1. LIVE — the snapshot reflects an in-flight reservation the accumulator holds
 *      (the kill-switch value, not a lagging re-sum).
 *   2. HEADROOM — headroom = ceiling - spend per scope (null ceiling ⇒ no headroom).
 *   3. PRICING-COVERAGE — {priced, free, unknown} counts from obs_token_usage.
 *   4. Admin gate — a non-admin `_trustLevel` is rejected.
 *   5. DISABLED — neither source present ⇒ an honest `enabled:false` shape (NOT a
 *      blank/misleading $0 success).
 *   6. CONTENT-FREE — dollar counts + scope enums + pricing-state counts ONLY.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema, createObservabilityStore } from "@comis/memory";
import type { ObservabilityStore } from "@comis/memory";
import { createSpendAccumulator } from "@comis/agent";
import { bindObsSpendHandlers } from "./obs-spend.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";

/** A fresh `:memory:` ObservabilityStore with the full schema initialized. */
function makeStore(): ObservabilityStore {
  const db = new Database(":memory:");
  initSchema(db, 1536);
  return createObservabilityStore(db);
}

/** A frozen clock for the accumulator (no wall-clock dependence). */
const clock = { now: () => 1_000, nowDate: () => new Date(1_000) };

/**
 * Build the handler bound to the given live-snapshot reader + store. Either may be
 * undefined to drive the disabled / soft-fail postures.
 */
function makeHandler(opts: {
  spendSnapshot?: ObsHandlerDeps["spendSnapshot"];
  store?: ObservabilityStore;
}) {
  const deps = {
    spendSnapshot: opts.spendSnapshot,
    obsStore: opts.store,
  } as unknown as ObsHandlerDeps;
  return bindObsSpendHandlers(deps)["obs.spend.snapshot"];
}

describe("obs.spend.snapshot handler", () => {
  it("reflects the LIVE accumulator (an in-flight reservation), not a lagging SQL re-sum", async () => {
    // A real accumulator with a per-agent ceiling; reserve spend through it so the
    // snapshot sees the in-flight reservation.
    const acc = createSpendAccumulator({
      clock,
      ceilings: { perAgentUsd: 10, perTenantUsd: null, daemonGlobalUsd: 100, warnAtFraction: 0.8 },
    });
    acc.checkAndReserve({ tenantId: "t1", agentId: "a1" }, 3);

    const handler = makeHandler({
      spendSnapshot: () => ({ ...acc.getSnapshot(), ceilings: { perAgentUsd: 10, perTenantUsd: null, daemonGlobalUsd: 100 } }),
    });
    const result = (await handler({ _trustLevel: "admin" })) as {
      snapshot: { enabled: boolean; global: number; perAgent: Array<{ scope: string; spentUsd: number; capUsd: number | null; headroomUsd: number | null }> };
    };

    expect(result.snapshot.enabled).toBe(true);
    expect(result.snapshot.global).toBeCloseTo(3, 10);
    const agentRow = result.snapshot.perAgent.find((r) => r.scope === "t1 a1");
    expect(agentRow?.spentUsd).toBeCloseTo(3, 10);
    // Headroom = ceiling (10) - spent (3).
    expect(agentRow?.capUsd).toBe(10);
    expect(agentRow?.headroomUsd).toBeCloseTo(7, 10);
  });

  it("reports null headroom for a disabled (null) ceiling dimension", async () => {
    const acc = createSpendAccumulator({
      clock,
      ceilings: { perAgentUsd: null, perTenantUsd: null, daemonGlobalUsd: null, warnAtFraction: 0.8 },
    });
    acc.checkAndReserve({ tenantId: "t1", agentId: "a1" }, 2);

    const handler = makeHandler({
      spendSnapshot: () => ({ ...acc.getSnapshot(), ceilings: { perAgentUsd: null, perTenantUsd: null, daemonGlobalUsd: null } }),
    });
    const result = (await handler({ _trustLevel: "admin" })) as {
      snapshot: { perAgent: Array<{ scope: string; capUsd: number | null; headroomUsd: number | null }> };
    };
    const agentRow = result.snapshot.perAgent.find((r) => r.scope === "t1 a1");
    expect(agentRow?.capUsd).toBeNull();
    expect(agentRow?.headroomUsd).toBeNull();
  });

  it("surfaces the three-state pricing-coverage counts from obs_token_usage", async () => {
    const store = makeStore();
    const base = {
      traceId: "tr1",
      agentId: "a1",
      sessionKey: "s1",
      provider: "openai",
      model: "gpt-4",
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costInput: 0.005,
      costOutput: 0.005,
      costTotal: 0.01,
      costCacheRead: 0,
      costCacheWrite: 0,
      cacheSaved: 0,
      latencyMs: 10,
    } as const;
    // 2 priced, 1 free, 1 unknown (NULL pricing_state).
    store.insertTokenUsage({ ...base, timestamp: 1, pricingState: "priced" });
    store.insertTokenUsage({ ...base, timestamp: 2, pricingState: "priced" });
    store.insertTokenUsage({ ...base, timestamp: 3, pricingState: "free" });
    store.insertTokenUsage({ ...base, timestamp: 4 }); // no pricingState → unknown

    const handler = makeHandler({
      spendSnapshot: () => ({ perAgent: new Map(), perTenant: new Map(), global: 0, ceilings: { perAgentUsd: null, perTenantUsd: null, daemonGlobalUsd: null } }),
      store,
    });
    const result = (await handler({ _trustLevel: "admin" })) as {
      snapshot: { pricingCoverage: { priced: number; free: number; unknown: number } };
    };
    expect(result.snapshot.pricingCoverage.priced).toBe(2);
    expect(result.snapshot.pricingCoverage.free).toBe(1);
    expect(result.snapshot.pricingCoverage.unknown).toBe(1);
  });

  it("rejects a non-admin _trustLevel (dual-layer admin gate)", async () => {
    const handler = makeHandler({
      spendSnapshot: () => ({ perAgent: new Map(), perTenant: new Map(), global: 0, ceilings: { perAgentUsd: null, perTenantUsd: null, daemonGlobalUsd: null } }),
    });
    await expect(handler({ _trustLevel: "guest" })).rejects.toThrow(/admin access required/i);
    await expect(handler({})).rejects.toThrow(/admin access required/i);
  });

  it("returns an honest disabled shape when neither source is present (no misleading $0 success)", async () => {
    const handler = makeHandler({ spendSnapshot: undefined, store: undefined });
    const result = (await handler({ _trustLevel: "admin" })) as {
      snapshot: { enabled: boolean };
    };
    expect(result.snapshot.enabled).toBe(false);
  });

  it("is content-free — scope keys + dollar/count numbers ONLY (no body/secret marker)", async () => {
    const acc = createSpendAccumulator({
      clock,
      ceilings: { perAgentUsd: 10, perTenantUsd: null, daemonGlobalUsd: null, warnAtFraction: 0.8 },
    });
    acc.checkAndReserve({ tenantId: "t1", agentId: "a1" }, 1);
    const handler = makeHandler({
      spendSnapshot: () => ({ ...acc.getSnapshot(), ceilings: { perAgentUsd: 10, perTenantUsd: null, daemonGlobalUsd: null } }),
    });
    const result = await handler({ _trustLevel: "admin", _smuggled: "OPENAI_API_KEY" });
    const json = JSON.stringify(result);
    expect(json).not.toContain("OPENAI_API_KEY");
    expect(json).not.toContain("_trustLevel");
  });
});
