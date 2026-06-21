// SPDX-License-Identifier: Apache-2.0
/**
 * OTEL-02 / PROM-01 — corrected-cost parity.
 *
 * `comis.cost.usd` (the OTLP counter, and the rendered `comis_cost_usd_total`)
 * MUST equal `SELECT SUM(cost_total) FROM obs_token_usage`. This seeds an
 * in-process `obs_token_usage` table with known `cost_total` rows, emits the
 * MATCHING `observability:token_usage` events through the in-memory metric
 * surface (the same instrument the exporter builds via `wireMetricMapping`), and
 * asserts the collected counter total equals the SQL sum to the cent.
 *
 * The invariant holds because both the counter increment and the persisted row
 * derive from the SAME `cost.total` value (the SDK-reconciled corrected cost) —
 * the test proves the exporter reads `cost.total` (not an estimate) and never
 * double-counts.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { TypedEventBus } from "@comis/core";
import { makeMetricFixture, sumCounter, type MetricFixture } from "./test-harness.js";
import { wireMetricMapping } from "./metric-mapping.js";

interface CostRow {
  provider: string;
  model: string;
  costTotal: number;
}

describe("cost parity — comis.cost.usd == SUM(cost_total) (OTEL-02)", () => {
  let db: Database.Database;
  let fx: MetricFixture;

  beforeEach(() => {
    db = new Database(":memory:");
    // Minimal obs_token_usage shape — just the column the parity sum reads.
    db.exec(`
      CREATE TABLE obs_token_usage (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        cost_total REAL NOT NULL
      );
    `);
    fx = makeMetricFixture();
  });

  afterEach(async () => {
    await fx.shutdown();
    db.close();
  });

  it("the cost counter total equals SELECT SUM(cost_total) to the cent", async () => {
    const rows: CostRow[] = [
      { provider: "anthropic", model: "claude-opus", costTotal: 0.05 },
      { provider: "anthropic", model: "claude-opus", costTotal: 0.123 },
      { provider: "openai", model: "gpt-5", costTotal: 0.2 },
      { provider: "anthropic", model: "claude-haiku", costTotal: 0.0007 },
    ];

    const insert = db.prepare(
      "INSERT INTO obs_token_usage (provider, model, cost_total) VALUES (?, ?, ?)",
    );
    for (const r of rows) insert.run(r.provider, r.model, r.costTotal);

    // Wire the SAME instrument the exporter builds, off the in-memory fixture.
    const eventBus = new TypedEventBus();
    wireMetricMapping({ meter: fx.provider.getMeter("comis"), eventBus });

    // Emit the MATCHING token_usage events (cost.total === the seeded cost_total).
    for (const r of rows) {
      eventBus.emit("observability:token_usage", {
        timestamp: 1, traceId: "11111111-1111-1111-1111-111111111111", agentId: "a1", channelId: "c1",
        executionId: "e1", provider: r.provider, model: r.model,
        tokens: { prompt: 10, completion: 5, total: 15 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: r.costTotal },
        latencyMs: 100, cacheReadTokens: 0, cacheWriteTokens: 0, sessionKey: "t:c:s",
        savedVsUncached: 0, cacheEligible: false, warmupTurn: false, pendingCacheInvestmentUsd: 0,
      } as never);
    }

    const sqlSum = (db.prepare("SELECT SUM(cost_total) AS s FROM obs_token_usage").get() as { s: number }).s;
    const metrics = await fx.collect();
    const counterTotal = sumCounter(metrics, "comis.cost.usd");

    expect(counterTotal).toBeCloseTo(sqlSum, 6);
    // Sanity: a non-zero, non-trivial total (not a vacuous 0 === 0 pass).
    expect(sqlSum).toBeCloseTo(0.05 + 0.123 + 0.2 + 0.0007, 6);
  });
});
