// SPDX-License-Identifier: Apache-2.0
/**
 * OTEL-02 / PROM-01 — the bus-event → OTel-instrument subscriber.
 *
 * `wireMetricMapping(deps)` builds one instrument per `METRIC_CATALOG` entry off
 * the injected `meter`, subscribes the source bus events (the `wireAuditSink`
 * shape — one `eventBus.on` per event), and maps each typed payload to a
 * CONTENT-FREE, low-cardinality instrument increment (catalog labels only — no
 * traceId/sessionKey/userId in the label object). The spend `observableGauge`s
 * read `spendAccumulator.getSnapshot()` (Pitfall 3); headroom = ceiling − spend.
 *
 * Driven here with a FAKE meter (capturing `.add`/`.record`/observable
 * callbacks) + a REAL `TypedEventBus`, so the assertions are deterministic with
 * no collector and no SDK MeterProvider.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { TypedEventBus } from "@comis/core";
import { wireMetricMapping } from "./metric-mapping.js";

// ---------------------------------------------------------------------------
// Fake meter — captures every instrument operation for assertion.
// ---------------------------------------------------------------------------

interface CapturedOp {
  instrument: string;
  value: number;
  attributes: Record<string, unknown>;
}

interface FakeMeter {
  ops: CapturedOp[];
  observableCallbacks: Array<{ instruments: string[]; cb: (result: FakeObservableResult) => void }>;
  // The OTel Meter surface wireMetricMapping uses.
  createCounter(name: string): { add(value: number, attributes?: Record<string, unknown>): void };
  createHistogram(name: string): { record(value: number, attributes?: Record<string, unknown>): void };
  createUpDownCounter(name: string): { add(value: number, attributes?: Record<string, unknown>): void };
  createObservableGauge(name: string): {
    addCallback(cb: (result: FakeObservableResult) => void): void;
  };
}

interface FakeObservableResult {
  observed: Array<{ value: number; attributes: Record<string, unknown> }>;
  observe(value: number, attributes?: Record<string, unknown>): void;
}

function makeFakeMeter(): FakeMeter {
  const ops: CapturedOp[] = [];
  const observableCallbacks: FakeMeter["observableCallbacks"] = [];
  return {
    ops,
    observableCallbacks,
    createCounter(name) {
      return { add: (value, attributes = {}) => ops.push({ instrument: name, value, attributes }) };
    },
    createHistogram(name) {
      return { record: (value, attributes = {}) => ops.push({ instrument: name, value, attributes }) };
    },
    createUpDownCounter(name) {
      return { add: (value, attributes = {}) => ops.push({ instrument: name, value, attributes }) };
    },
    createObservableGauge(name) {
      return {
        addCallback: (cb) => observableCallbacks.push({ instruments: [name], cb }),
      };
    },
  };
}

/** Drive every registered observable callback and collect what it observed. */
function collectObservations(
  meter: FakeMeter,
): Array<{ instruments: string[]; value: number; attributes: Record<string, unknown> }> {
  const out: Array<{ instruments: string[]; value: number; attributes: Record<string, unknown> }> = [];
  for (const { instruments, cb } of meter.observableCallbacks) {
    const result: FakeObservableResult = {
      observed: [],
      observe(value, attributes = {}) {
        this.observed.push({ value, attributes });
      },
    };
    cb(result);
    for (const o of result.observed) out.push({ instruments, value: o.value, attributes: o.attributes });
  }
  return out;
}

const HIGH_CARDINALITY_LABELS = ["session", "trace", "user", "sessionKey", "traceId", "userId"];

function assertNoHighCardinalityLabel(attributes: Record<string, unknown>): void {
  for (const k of Object.keys(attributes)) {
    expect(
      HIGH_CARDINALITY_LABELS,
      `instrument label '${k}' must not be a high-cardinality id (ids ride as exemplars, never labels)`,
    ).not.toContain(k);
  }
}

function tokenUsagePayload(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: 1000,
    traceId: "11111111-1111-1111-1111-111111111111",
    agentId: "a1",
    channelId: "c1",
    executionId: "e1",
    provider: "anthropic",
    model: "claude-opus",
    tokens: { prompt: 100, completion: 50, total: 150 },
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.05 },
    latencyMs: 1500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessionKey: "tenant1:c1:s1",
    savedVsUncached: 0,
    cacheEligible: false,
    warmupTurn: false,
    pendingCacheInvestmentUsd: 0,
    ...overrides,
  };
}

describe("wireMetricMapping (OTEL-02 — bus → content-free instruments)", () => {
  it("token_usage → comis_cost_usd_total with the CORRECTED cost.total + content-free labels", () => {
    const meter = makeFakeMeter();
    const eventBus = new TypedEventBus();
    wireMetricMapping({ meter: meter as never, eventBus });

    eventBus.emit("observability:token_usage", tokenUsagePayload() as never);

    const cost = meter.ops.find((o) => o.instrument === "comis.cost.usd");
    expect(cost, "comis.cost.usd counter must fire on token_usage").toBeTruthy();
    expect(cost!.value).toBe(0.05); // the CORRECTED cost.total
    // Content-free labels only.
    assertNoHighCardinalityLabel(cost!.attributes);
    expect(cost!.attributes["provider"]).toBe("anthropic");
    expect(cost!.attributes["model"]).toBe("claude-opus");
    expect(cost!.attributes["agent"]).toBe("a1");
  });

  it("token_usage → comis_tokens_total fires (the token counter)", () => {
    const meter = makeFakeMeter();
    const eventBus = new TypedEventBus();
    wireMetricMapping({ meter: meter as never, eventBus });

    eventBus.emit("observability:token_usage", tokenUsagePayload() as never);

    const tokens = meter.ops.filter((o) => o.instrument === "comis.tokens");
    expect(tokens.length, "comis.tokens must fire on token_usage").toBeGreaterThanOrEqual(1);
    for (const t of tokens) assertNoHighCardinalityLabel(t.attributes);
  });

  it("token_usage → comis_run_duration_seconds histogram records latency in SECONDS (base unit)", () => {
    const meter = makeFakeMeter();
    const eventBus = new TypedEventBus();
    wireMetricMapping({ meter: meter as never, eventBus });

    eventBus.emit("observability:token_usage", tokenUsagePayload({ latencyMs: 2500 }) as never);

    const dur = meter.ops.find((o) => o.instrument === "comis.run.duration.seconds");
    expect(dur, "comis.run.duration.seconds must record on token_usage").toBeTruthy();
    expect(dur!.value).toBeCloseTo(2.5, 5); // 2500ms ÷ 1000 = 2.5s
  });

  it("cache_break → comis_cache_break_total{reason} fires content-free", () => {
    const meter = makeFakeMeter();
    const eventBus = new TypedEventBus();
    wireMetricMapping({ meter: meter as never, eventBus });

    eventBus.emit("observability:cache_break", {
      provider: "anthropic",
      reason: "tools_changed",
      tokenDrop: 1000,
      tokenDropRelative: 0.5,
      previousCacheRead: 2000,
      currentCacheRead: 1000,
      callCount: 3,
      changes: {
        systemChanged: false, toolsChanged: true, metadataChanged: false, modelChanged: false,
        retentionChanged: false, addedTools: [], removedTools: [], changedSchemaTools: [],
        headersChanged: false, extraBodyChanged: false,
      },
      toolsChanged: [],
      ttlCategory: undefined,
      agentId: "a1",
      sessionKey: "tenant1:c1:s1",
      timestamp: 1000,
    } as never);

    const cb = meter.ops.find((o) => o.instrument === "comis.cache.break");
    expect(cb, "comis.cache.break must fire on cache_break").toBeTruthy();
    expect(cb!.value).toBe(1);
    expect(cb!.attributes["reason"]).toBe("tools_changed");
    assertNoHighCardinalityLabel(cb!.attributes);
  });

  it("spend_warning/exceeded/unpriceable → the matching content-free counters fire", () => {
    const meter = makeFakeMeter();
    const eventBus = new TypedEventBus();
    wireMetricMapping({ meter: meter as never, eventBus });

    eventBus.emit("observability:spend_warning", {
      timestamp: 1, agentId: "a1", sessionKey: "t:c:s", scope: "agent", spentUsd: 8, capUsd: 10, fraction: 0.8,
    } as never);
    eventBus.emit("observability:spend_exceeded", {
      timestamp: 1, agentId: "a1", sessionKey: "t:c:s", scope: "tenant", spentUsd: 11, capUsd: 10, estUsd: 0.5,
    } as never);
    eventBus.emit("observability:spend_unpriceable", {
      timestamp: 1, agentId: "a1", sessionKey: "t:c:s", provider: "x", model: "y",
    } as never);

    const warn = meter.ops.find((o) => o.instrument === "comis.spend.warning");
    const exceeded = meter.ops.find((o) => o.instrument === "comis.spend.exceeded");
    const unpriceable = meter.ops.find((o) => o.instrument === "comis.spend.unpriceable");
    expect(warn?.attributes["scope"]).toBe("agent");
    expect(exceeded?.attributes["scope"]).toBe("tenant");
    expect(unpriceable, "comis.spend.unpriceable must fire").toBeTruthy();
    for (const op of [warn, exceeded, unpriceable]) assertNoHighCardinalityLabel(op!.attributes);
  });

  it("injection_detected → comis_injection_detected_total fires content-free (counts only, no patterns body)", () => {
    const meter = makeFakeMeter();
    const eventBus = new TypedEventBus();
    wireMetricMapping({ meter: meter as never, eventBus });

    eventBus.emit("security:injection_detected", {
      timestamp: 1, source: "user_input", patterns: ["ignore previous instructions"], riskLevel: "high", agentId: "a1",
    } as never);

    const inj = meter.ops.find((o) => o.instrument === "comis.injection_detected");
    expect(inj, "comis.injection_detected must fire").toBeTruthy();
    expect(inj!.value).toBe(1);
    // No pattern body leaks into a label.
    expect(JSON.stringify(inj!.attributes)).not.toContain("ignore previous instructions");
    assertNoHighCardinalityLabel(inj!.attributes);
  });

  it("registers spend observableGauges reading getSnapshot — usd + headroom (ceiling − spend) per scope", () => {
    const meter = makeFakeMeter();
    const eventBus = new TypedEventBus();
    wireMetricMapping({
      meter: meter as never,
      eventBus,
      spendAccumulator: {
        getSnapshot: () => ({
          perAgent: new Map([["tenant1 a1", 4]]),
          perTenant: new Map([["tenant1", 4]]),
          global: 4,
        }),
      },
      ceilings: { perAgentUsd: 10, perTenantUsd: 20, daemonGlobalUsd: 100 },
    });

    const observed = collectObservations(meter);
    // comis.spend.usd for the global scope reflects the snapshot total.
    const globalSpend = observed.find(
      (o) => o.instruments.includes("comis.spend.usd") && o.attributes["scope"] === "global",
    );
    expect(globalSpend?.value).toBe(4);
    // comis.spend.headroom.usd for global = 100 − 4 = 96.
    const globalHeadroom = observed.find(
      (o) => o.instruments.includes("comis.spend.headroom.usd") && o.attributes["scope"] === "global",
    );
    expect(globalHeadroom?.value).toBe(96);
    // No high-cardinality label on any gauge observation.
    for (const o of observed) assertNoHighCardinalityLabel(o.attributes);
  });

  it("omits the spend gauges entirely when no accumulator is provided (no callback registered)", () => {
    const meter = makeFakeMeter();
    const eventBus = new TypedEventBus();
    wireMetricMapping({ meter: meter as never, eventBus });
    const observed = collectObservations(meter);
    const spendObs = observed.filter((o) => o.instruments.some((i) => i.startsWith("comis.spend.")));
    expect(spendObs, "no spend gauge should observe without an accumulator").toHaveLength(0);
  });
});
