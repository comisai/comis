// SPDX-License-Identifier: Apache-2.0
/**
 * The OTLP + Prometheus exporter registration (OTEL-01/02 / PROM-01).
 *
 * `registerOtelExporter` builds the OTel SDK surface from ONE metric definition
 * (the Plan 01 catalog, via `wireMetricMapping`) and TWO readers on a SINGLE
 * `MeterProvider` (decision #3 / Pitfall 2 — the OTLP `PeriodicExportingMetricReader`
 * AND the `PrometheusExporter`, each gated on its OWN enable flag so `/metrics`
 * serves STANDALONE with `otel.enabled:false`). It also wires a `NodeTracerProvider`
 * (OTLP traces, gated on `otel.enabled && otel.traces`) and a `LoggerProvider`
 * (OTLP logs, gated on `otel.enabled && otel.logs`).
 *
 * The `PrometheusExporter` opens its OWN loopback HTTP listener (host/port from
 * config — NOT the gateway; Pitfall 5). Transport: only the `-proto`
 * (HTTP/protobuf) exporters ship this phase; `protocol:'grpc'` falls back to
 * `-proto` with a WARN+hint (honest degradation — T-178-09). Exemplars are NOT
 * rendered on the pull surface (`PROMETHEUS_EXEMPLARS_SUPPORTED===false`); the
 * `traceId` rides as the `comis.trace_id` span attribute instead (Pitfall 4/6).
 *
 * Returns `{ shutdown }` so the daemon shutdown chain flushes + closes every
 * provider (the OTLP batches drain; the /metrics listener stops).
 *
 * @module
 */
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { AppConfig, ClockPort, TypedEventBus, ComisLogger } from "@comis/core";
import { wireMetricMapping } from "./metric-mapping.js";
import type { SpendSnapshotReader } from "./spend-snapshot.js";
import { wireSeriesCardinality } from "./prometheus-surface.js";

/** The dependency contract the daemon's config-gated load seam passes in (Plan 03 wires it). */
export interface OtelExporterDeps {
  /** The typed event bus the extension subscribes for live metric increments. */
  readonly eventBus: TypedEventBus;
  /** The injected clock (the package never calls wall-clock APIs directly). */
  readonly clock: ClockPort;
  /** The resolved observability config (the `otel` / `prometheus` keys gate everything). */
  readonly observability: AppConfig["observability"];
  /** The 177 spend accumulator's read accessor — the `comis_spend_*` gauge source. */
  readonly spendAccumulator?: SpendSnapshotReader;
  /** Object-first logger for the grpc-fallback / cardinality WARNs (optional). */
  readonly logger?: ComisLogger;
}

/** The registration handle — `shutdown` flushes + closes every provider. */
export interface OtelExporterHandle {
  shutdown(): Promise<void>;
}

/**
 * Bound each provider shutdown so an enabled-but-UNREACHABLE OTLP collector can
 * never hang the daemon's shutdown chain: the OTLP HTTP exporter's flush retries
 * for ~10s+ against a dead endpoint, which would stall every daemon stop. We race
 * each disposal against this cap and move on — the telemetry on the wire is
 * best-effort, daemon liveness is not. (T-178-06's sibling: enabled-but-unavailable
 * must degrade, never block.)
 */
const SHUTDOWN_STEP_TIMEOUT_MS = 2_000;

function withTimeout(fn: () => Promise<void>): Promise<void> {
  return Promise.race([
    fn().catch(() => undefined),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, SHUTDOWN_STEP_TIMEOUT_MS);
      // Do not keep the event loop alive on this guard timer.
      if (typeof t === "object" && t !== null && "unref" in t) (t as { unref(): void }).unref();
    }),
  ]);
}

/**
 * Register the OTLP + Prometheus exporter. Gates each surface independently;
 * returns a `shutdown()` that disposes whatever was constructed (a benign no-op
 * when both flags are off).
 */
export function registerOtelExporter(deps: OtelExporterDeps): OtelExporterHandle {
  const { eventBus, observability, logger } = deps;
  const otel = observability.otel;
  const prometheus = observability.prometheus;

  // Honest degradation (T-178-09): only the -proto transport ships; grpc warns + falls back.
  if (otel.enabled && otel.protocol === "grpc") {
    logger?.warn(
      {
        hint: "OTLP grpc transport is not shipped yet; falling back to http/protobuf. Set observability.otel.protocol: 'http/protobuf' to silence this. grpc is a documented later addition.",
        protocol: otel.protocol,
      },
      "otel-grpc-fallback-to-proto",
    );
  }

  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: "comis" });
  const shutdownFns: Array<() => Promise<void>> = [];

  // ── Metrics: ONE MeterProvider, readers:[otlp?, prometheus?] (Pitfall 2) ──
  const readers: MetricReader[] = [];
  let prometheusExporter: PrometheusExporter | undefined;

  if (otel.enabled && otel.metrics) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(otel.endpoint ? { url: otel.endpoint } : {}),
        exportIntervalMillis: 30_000,
      }),
    );
  }
  if (prometheus.enabled) {
    // PrometheusExporter IS a MetricReader; it opens its OWN loopback listener.
    prometheusExporter = new PrometheusExporter({
      host: prometheus.host,
      port: prometheus.port,
      endpoint: prometheus.path,
    });
    readers.push(prometheusExporter);
  }

  let meterProvider: MeterProvider | undefined;
  if (readers.length > 0) {
    meterProvider = new MeterProvider({ resource, readers });
    const provider = meterProvider;
    const meter = provider.getMeter("comis");

    // The single metric mapping (one definition, both readers render it).
    wireMetricMapping({
      meter,
      eventBus,
      ...(deps.spendAccumulator !== undefined ? { spendAccumulator: deps.spendAccumulator } : {}),
      ceilings: {
        perAgentUsd: observability.spend.perAgentUsd,
        perTenantUsd: observability.spend.perTenantUsd,
        daemonGlobalUsd: observability.spend.daemonGlobalUsd,
      },
    });

    // PROM-01: the comis_prometheus_series self-cardinality gauge + the
    // cardinalityCap WARN-with-hint (the label-explosion guard, T-178-07).
    wireSeriesCardinality({
      meter,
      eventBus,
      cardinalityCap: prometheus.cardinalityCap,
      ...(logger !== undefined ? { logger } : {}),
    });

    shutdownFns.push(() =>
      withTimeout(async () => {
        await provider.forceFlush().catch(() => undefined);
        await provider.shutdown().catch(() => undefined);
      }),
    );
  }

  // ── Traces: NodeTracerProvider (gated on otel.enabled && otel.traces) ──
  if (otel.enabled && otel.traces) {
    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(otel.endpoint ? { url: otel.endpoint } : {}))],
    });
    tracerProvider.register();
    shutdownFns.push(() => withTimeout(() => tracerProvider.shutdown()));
  }

  // ── Logs: LoggerProvider (gated on otel.enabled && otel.logs) ──
  if (otel.enabled && otel.logs) {
    const loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(new OTLPLogExporter(otel.endpoint ? { url: otel.endpoint } : {}))],
    });
    shutdownFns.push(() => withTimeout(() => loggerProvider.shutdown()));
  }

  return {
    shutdown: async () => {
      for (const fn of shutdownFns) await fn();
    },
  };
}
