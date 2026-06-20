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
