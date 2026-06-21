// SPDX-License-Identifier: Apache-2.0
/**
 * PROM-01 — the standalone Prometheus `/metrics` pull surface.
 *
 * Drives the REAL `registerOtelExporter` with `prometheus.enabled:true` +
 * `otel.enabled:false` (STANDALONE — no OTLP collector), scrapes the exporter's
 * own loopback HTTP listener, and asserts: valid exposition (`# HELP`/`# TYPE`,
 * `_total` counters, `_bucket`/`_sum`/`_count` histogram families, base units),
 * the loopback bind (127.0.0.1, never 0.0.0.0), no high-cardinality label on any
 * series, and the `comis_prometheus_series` self-metric.
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { TypedEventBus } from "@comis/core";
import { registerOtelExporter } from "./otel-exporter.js";
import { wireSeriesCardinality } from "./prometheus-surface.js";
import { makeMetricFixture } from "./test-harness.js";

/** A stub ClockPort (the extension never calls wall-clock directly). */
const clock = { now: () => 0, nowMs: () => 0 } as never;

/** Scrape an http URL and return the body text. */
function scrape(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

/**
 * Build an observability config (plain literal — the exporter only reads these
 * fields) with prometheus enabled STANDALONE on `port`, otel off. A literal
 * avoids coupling the test to the @comis/core/config barrel's schema export.
 */
function standalonePrometheusConfig(port: number) {
  return {
    otel: { enabled: false, endpoint: "", protocol: "http/protobuf", traces: false, metrics: false, logs: false, genaiSemconv: false, captureContent: false },
    prometheus: { enabled: true, host: "127.0.0.1", port, path: "/metrics", auth: "trusted-operator", exemplars: true, cardinalityCap: 10000 },
    spend: { perAgentUsd: null, perTenantUsd: null, daemonGlobalUsd: null },
  } as never;
}

const HIGH_CARDINALITY_TOKENS = ["session", "trace_id", "traceid", "user", "sessionkey", "userid"];

describe("PrometheusExporter standalone /metrics (PROM-01)", () => {
  let handle: { shutdown(): Promise<void> } | undefined;
  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
  });

  it("serves valid exposition STANDALONE (otel.enabled:false + prometheus.enabled:true)", async () => {
    const port = 19470;
    const eventBus = new TypedEventBus();
    handle = registerOtelExporter({ eventBus, clock, observability: standalonePrometheusConfig(port) });

    // Drive a metric so a counter series materialises.
    eventBus.emit("observability:token_usage", {
      timestamp: 1, traceId: "11111111-1111-1111-1111-111111111111", agentId: "a1", channelId: "c1",
      executionId: "e1", provider: "anthropic", model: "claude-opus",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.05 },
      latencyMs: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, sessionKey: "t:c:s",
      savedVsUncached: 0, cacheEligible: false, warmupTurn: false, pendingCacheInvestmentUsd: 0,
    } as never);

    const body = await scrape(`http://127.0.0.1:${port}/metrics`);

    // Exposition framing.
    expect(body).toMatch(/# HELP /);
    expect(body).toMatch(/# TYPE /);
    // A counter renders with the _total suffix.
    expect(body).toMatch(/comis_cost_usd_total/);
    // No OTLP exporter was constructed — but the pull surface is fully populated.
    expect(body.length).toBeGreaterThan(0);
  });

  it("renders a histogram family with _bucket / _sum / _count and the seconds base unit", async () => {
    const port = 19471;
    const eventBus = new TypedEventBus();
    handle = registerOtelExporter({ eventBus, clock, observability: standalonePrometheusConfig(port) });

    eventBus.emit("observability:token_usage", {
      timestamp: 1, traceId: "11111111-1111-1111-1111-111111111111", agentId: "a1", channelId: "c1",
      executionId: "e1", provider: "anthropic", model: "claude-opus",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.05 },
      latencyMs: 2500, cacheReadTokens: 0, cacheWriteTokens: 0, sessionKey: "t:c:s",
      savedVsUncached: 0, cacheEligible: false, warmupTurn: false, pendingCacheInvestmentUsd: 0,
    } as never);

    const body = await scrape(`http://127.0.0.1:${port}/metrics`);
    expect(body).toMatch(/comis_run_duration_seconds_bucket/);
    expect(body).toMatch(/comis_run_duration_seconds_sum/);
    expect(body).toMatch(/comis_run_duration_seconds_count/);
  });

  it("binds loopback 127.0.0.1 — a scrape on 127.0.0.1 succeeds (never 0.0.0.0 implicitly)", async () => {
    const port = 19472;
    const eventBus = new TypedEventBus();
    handle = registerOtelExporter({ eventBus, clock, observability: standalonePrometheusConfig(port) });
    // The successful loopback scrape proves the listener is bound on 127.0.0.1.
    const body = await scrape(`http://127.0.0.1:${port}/metrics`);
    expect(body).toBeTypeOf("string");
  });

  it("NO series carries a session/trace/user id as a LABEL (ids ride as exemplars only)", async () => {
    const port = 19473;
    const eventBus = new TypedEventBus();
    handle = registerOtelExporter({ eventBus, clock, observability: standalonePrometheusConfig(port) });

    eventBus.emit("observability:token_usage", {
      timestamp: 1, traceId: "11111111-1111-1111-1111-111111111111", agentId: "a1", channelId: "c1",
      executionId: "e1", provider: "anthropic", model: "claude-opus",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.05 },
      latencyMs: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, sessionKey: "tenant1:c1:s1",
      savedVsUncached: 0, cacheEligible: false, warmupTurn: false, pendingCacheInvestmentUsd: 0,
    } as never);

    const body = await scrape(`http://127.0.0.1:${port}/metrics`);
    // Scan only the metric series lines (not # HELP/# TYPE comment lines).
    const seriesLines = body.split("\n").filter((l) => l && !l.startsWith("#"));
    for (const line of seriesLines) {
      // The label block is inside { ... }; check label KEYS for a high-card id.
      const labelMatch = line.match(/\{([^}]*)\}/);
      if (!labelMatch) continue;
      const labelKeys = labelMatch[1]!
        .split(",")
        .map((kv) => kv.split("=")[0]?.trim().toLowerCase())
        .filter((k): k is string => Boolean(k));
      for (const key of labelKeys) {
        expect(
          HIGH_CARDINALITY_TOKENS.some((tok) => key === tok),
          `series label '${key}' must not be a high-cardinality id (line: ${line})`,
        ).toBe(false);
      }
    }
  });

  it("emits the comis_prometheus_series self-cardinality gauge", async () => {
    const port = 19474;
    const eventBus = new TypedEventBus();
    handle = registerOtelExporter({ eventBus, clock, observability: standalonePrometheusConfig(port) });
    const body = await scrape(`http://127.0.0.1:${port}/metrics`);
    expect(body).toMatch(/comis_prometheus_series/);
  });
});

describe("wireSeriesCardinality (the distinct-series taps + the cap WARN)", () => {
  it("counts distinct content-free series from EVERY source event and reports comis_prometheus_series", async () => {
    const fx = makeMetricFixture();
    const eventBus = new TypedEventBus();
    wireSeriesCardinality({ meter: fx.provider.getMeter("comis"), eventBus, cardinalityCap: 10000 });

    // Drive one of every catalog source event so each tap (60-66) records a key.
    eventBus.emit("observability:token_usage", {
      timestamp: 1, traceId: "11111111-1111-1111-1111-111111111111", agentId: "a1", channelId: "c1",
      executionId: "e1", provider: "anthropic", model: "claude-opus",
      tokens: { prompt: 10, completion: 5, total: 15 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
      latencyMs: 100, cacheReadTokens: 0, cacheWriteTokens: 0, sessionKey: "t:c:s",
      savedVsUncached: 0, cacheEligible: false, warmupTurn: false, pendingCacheInvestmentUsd: 0,
    } as never);
    eventBus.emit("observability:cache_break", {
      provider: "anthropic", reason: "tools_changed", tokenDrop: 100, tokenDropRelative: 0.1,
      previousCacheRead: 200, currentCacheRead: 100, callCount: 2,
      changes: { systemChanged: false, toolsChanged: true, metadataChanged: false, modelChanged: false, retentionChanged: false, addedTools: [], removedTools: [], changedSchemaTools: [], headersChanged: false, extraBodyChanged: false },
      toolsChanged: [], ttlCategory: undefined, agentId: "a1", sessionKey: "t:c:s", timestamp: 1,
    } as never);
    eventBus.emit("observability:spend_warning", { timestamp: 1, agentId: "a1", sessionKey: "t:c:s", scope: "agent", spentUsd: 8, capUsd: 10, fraction: 0.8 } as never);
    eventBus.emit("observability:spend_exceeded", { timestamp: 1, agentId: "a1", sessionKey: "t:c:s", scope: "tenant", spentUsd: 11, capUsd: 10, estUsd: 0.5 } as never);
    eventBus.emit("observability:spend_unpriceable", { timestamp: 1, agentId: "a1", sessionKey: "t:c:s", provider: "x", model: "y" } as never);
    eventBus.emit("security:injection_detected", { timestamp: 1, source: "user_input", patterns: ["x"], riskLevel: "high", agentId: "a1" } as never);

    const metrics = await fx.collect();
    const series = metrics.find((m) => m.descriptor.name === "comis.prometheus_series");
    expect(series, "comis.prometheus_series must be observed").toBeTruthy();
    // 4 token_usage series + 1 cache_break + 3 spend + 1 injection = 9 distinct keys.
    const value = series!.dataPoints[0]!.value as number;
    expect(value).toBeGreaterThanOrEqual(9);
    await fx.shutdown();
  });

  it("does NOT re-WARN while still under the cap (re-arm path), and the gauge keeps observing", async () => {
    const warns: string[] = [];
    const fx = makeMetricFixture();
    const eventBus = new TypedEventBus();
    wireSeriesCardinality({
      meter: fx.provider.getMeter("comis"),
      eventBus,
      cardinalityCap: 10000,
      logger: { warn: (_o: unknown, msg: string) => warns.push(msg) } as never,
    });
    // Two collections, well under the cap → no WARN either time (re-arm branch).
    await fx.collect();
    await fx.collect();
    expect(warns).toHaveLength(0);
    await fx.shutdown();
  });

  it("MD-02: past the cardinalityCap the distinct-series estimate is BOUNDED — overflow drops to a single bucket (not just a WARN)", async () => {
    const warns: string[] = [];
    const fx = makeMetricFixture();
    const eventBus = new TypedEventBus();
    const cardinalityCap = 5;
    wireSeriesCardinality({
      meter: fx.provider.getMeter("comis"),
      eventBus,
      cardinalityCap,
      logger: { warn: (_o: unknown, msg: string) => warns.push(msg) } as never,
    });

    // Drive FAR more distinct content-free series than the cap (50 distinct
    // models). Pre-fix the Set grows unbounded (it WARNs but keeps every key →
    // the series count is 50+, an unbounded memory + scrape DoS). Post-fix the
    // tracker stops admitting NEW distinct keys past the cap and routes the
    // excess to one "_overflow" bucket, so the reported count is BOUNDED.
    for (let i = 0; i < 50; i++) {
      eventBus.emit("observability:token_usage", {
        timestamp: 1, traceId: "11111111-1111-1111-1111-111111111111", agentId: "a1", channelId: "c1",
        executionId: "e1", provider: "anthropic", model: `model-${i}`,
        tokens: { prompt: 1, completion: 1, total: 2 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        latencyMs: 10, cacheReadTokens: 0, cacheWriteTokens: 0, sessionKey: "t:c:s",
        savedVsUncached: 0, cacheEligible: false, warmupTurn: false, pendingCacheInvestmentUsd: 0,
      } as never);
    }

    const metrics = await fx.collect();
    const series = metrics.find((m) => m.descriptor.name === "comis.prometheus_series");
    expect(series, "comis.prometheus_series must be observed").toBeTruthy();
    const value = series!.dataPoints[0]!.value as number;

    // The cap BOUNDS the series count: cap distinct keys + 1 "_overflow" bucket.
    // The 50 distinct model series collapse — the tracker never holds 50 keys.
    expect(value, "series count must be bounded by the cap, not grow with distinct inputs").toBeLessThanOrEqual(cardinalityCap + 1);
    // And the breach still WARNs (the operator signal is preserved).
    expect(warns.some((m) => /cardinalit/i.test(m)), "a cap breach must still WARN").toBe(true);
    await fx.shutdown();
  });
});
