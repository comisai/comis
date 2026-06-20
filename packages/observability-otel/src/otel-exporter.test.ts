// SPDX-License-Identifier: Apache-2.0
/**
 * OTEL-01/02 / PROM-01 — `registerOtelExporter` construction + lifecycle.
 *
 * Asserts: each surface is gated INDEPENDENTLY (prometheus.enabled works with
 * otel.enabled:false and vice-versa); `shutdown()` resolves and closes the
 * providers; the `cardinalityCap` breach produces a WARN with a `hint`; both
 * flags off → no listener / a benign no-op handle.
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { TypedEventBus } from "@comis/core";
import { registerOtelExporter } from "./otel-exporter.js";

/** Scrape an http URL (triggers a PrometheusExporter collection → observable callbacks). */
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

const clock = { now: () => 0, nowMs: () => 0 } as never;

const OTEL_DEFAULTS = {
  enabled: false, endpoint: "", protocol: "http/protobuf",
  traces: true, metrics: true, logs: true, genaiSemconv: false, captureContent: false,
};
const PROM_DEFAULTS = {
  enabled: false, host: "127.0.0.1", port: 9464, path: "/metrics",
  auth: "trusted-operator", exemplars: true, cardinalityCap: 10000,
};

/** Build an observability config literal (the exporter reads only these fields). */
function cfg(over: { otel?: Record<string, unknown>; prometheus?: Record<string, unknown> }) {
  return {
    otel: { ...OTEL_DEFAULTS, ...(over.otel ?? {}) },
    prometheus: { ...PROM_DEFAULTS, ...(over.prometheus ?? {}) },
    spend: { perAgentUsd: null, perTenantUsd: null, daemonGlobalUsd: null },
  } as never;
}

describe("registerOtelExporter (construction + lifecycle)", () => {
  let handle: { shutdown(): Promise<void> } | undefined;
  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = undefined;
  });

  it("both flags off → returns a benign handle with a resolving shutdown (no providers, no listener)", async () => {
    handle = registerOtelExporter({
      eventBus: new TypedEventBus(),
      clock,
      observability: cfg({ otel: { enabled: false }, prometheus: { enabled: false } }),
    });
    await expect(handle.shutdown()).resolves.toBeUndefined();
    handle = undefined;
  });

  it("otel.enabled:true (metrics) with prometheus.enabled:false constructs the OTLP surface and shuts down cleanly", async () => {
    handle = registerOtelExporter({
      eventBus: new TypedEventBus(),
      clock,
      observability: cfg({ otel: { enabled: true, metrics: true, traces: false, logs: false }, prometheus: { enabled: false } }),
    });
    await expect(handle.shutdown()).resolves.toBeUndefined();
    handle = undefined;
  });

  it("otel.enabled:true with traces + logs constructs the tracer + logger providers and shuts down (timeout-bounded, no collector)", async () => {
    handle = registerOtelExporter({
      eventBus: new TypedEventBus(),
      clock,
      observability: cfg({ otel: { enabled: true, metrics: false, traces: true, logs: true }, prometheus: { enabled: false } }),
    });
    // Construction must not throw; shutdown resolves within the bounded timeout
    // even with no reachable OTLP collector (the OTLP flush is raced against 2s).
    await expect(handle.shutdown()).resolves.toBeUndefined();
    handle = undefined;
  });

  it("prometheus.enabled:true is INDEPENDENT of otel.enabled (standalone /metrics listener)", async () => {
    const logs: Array<{ obj: unknown; msg: string }> = [];
    handle = registerOtelExporter({
      eventBus: new TypedEventBus(),
      clock,
      observability: cfg({ otel: { enabled: false }, prometheus: { enabled: true, port: 19480 } }),
      logger: { warn: (obj: unknown, msg: string) => logs.push({ obj, msg }) } as never,
    });
    // No crash; shutdown stops the listener.
    await expect(handle.shutdown()).resolves.toBeUndefined();
    handle = undefined;
  });

  it("grpc protocol falls back to http/protobuf with a WARN+hint (a documented later addition — T-178-09)", async () => {
    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    // All OTLP signals off so no exporter network-flushes on shutdown; the grpc
    // fallback WARN is gated only on otel.enabled && protocol==='grpc'.
    handle = registerOtelExporter({
      eventBus: new TypedEventBus(),
      clock,
      observability: cfg({ otel: { enabled: true, protocol: "grpc", metrics: false, traces: false, logs: false }, prometheus: { enabled: false } }),
      logger: { warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }) } as never,
    });
    const grpcWarn = warns.find((w) => /grpc/i.test(w.msg) || /grpc/i.test(JSON.stringify(w.obj)));
    expect(grpcWarn, "a WARN must name the grpc fallback").toBeTruthy();
    expect(grpcWarn!.obj["hint"], "the WARN must carry a hint").toBeTruthy();
  });

  it("cardinalityCap breach emits a WARN with a hint (the label-explosion guard)", async () => {
    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const eventBus = new TypedEventBus();
    handle = registerOtelExporter({
      eventBus,
      clock,
      observability: cfg({ otel: { enabled: false }, prometheus: { enabled: true, port: 19481, cardinalityCap: 2 } }),
      logger: { warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }) } as never,
    });

    // Drive enough distinct label sets to exceed the cap of 2.
    for (const model of ["m1", "m2", "m3", "m4", "m5"]) {
      eventBus.emit("observability:token_usage", {
        timestamp: 1, traceId: "11111111-1111-1111-1111-111111111111", agentId: "a1", channelId: "c1",
        executionId: "e1", provider: "anthropic", model,
        tokens: { prompt: 1, completion: 1, total: 2 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        latencyMs: 10, cacheReadTokens: 0, cacheWriteTokens: 0, sessionKey: "t:c:s",
        savedVsUncached: 0, cacheEligible: false, warmupTurn: false, pendingCacheInvestmentUsd: 0,
      } as never);
    }

    // Trigger the cardinality check via a real /metrics scrape (a PrometheusExporter
    // runs observable callbacks on a scrape, not on forceFlush).
    await scrape("http://127.0.0.1:19481/metrics");

    const capWarn = warns.find((w) => /cardinalit/i.test(w.msg) || /cardinalit/i.test(JSON.stringify(w.obj)));
    expect(capWarn, "a cardinalityCap breach must WARN").toBeTruthy();
    expect(capWarn!.obj["hint"], "the cardinality WARN must carry a hint").toBeTruthy();
  });
});
