// SPDX-License-Identifier: Apache-2.0
/**
 * In-memory OTel exporter fixtures (test-only) — the deterministic, collector-free
 * assertion path for the exporter tests.
 *
 * Every test asserts against an `InMemorySpanExporter` / `InMemoryMetricExporter`
 * / `InMemoryLogRecordExporter` rather than a live OTLP collector, so the suite
 * is hermetic and runs on macOS with no network. This module is NOT shipped in
 * the production surface (it imports the OTel SDK test exporters); it lives in
 * `src/` so the package's own tests import it, and it is barrel-EXCLUDED.
 *
 * @module
 */
import { InMemorySpanExporter, SimpleSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import type { ResourceMetrics, MetricData } from "@opentelemetry/sdk-metrics";
import { LoggerProvider, SimpleLogRecordProcessor, InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";

/** A trace fixture: a TracerProvider feeding an in-memory span sink. */
export interface SpanFixture {
  provider: NodeTracerProvider;
  exporter: InMemorySpanExporter;
  shutdown(): Promise<void>;
}

/** Build a TracerProvider whose spans land in an `InMemorySpanExporter`. */
export function makeSpanFixture(): SpanFixture {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return {
    provider,
    exporter,
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}

/** A metric fixture: a MeterProvider feeding an in-memory metric sink. */
export interface MetricFixture {
  provider: MeterProvider;
  exporter: InMemoryMetricExporter;
  /** Force a collection + return the flat list of collected MetricData. */
  collect(): Promise<MetricData[]>;
  shutdown(): Promise<void>;
}

/** Build a MeterProvider whose metrics land in an `InMemoryMetricExporter`. */
export function makeMetricFixture(): MetricFixture {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    provider,
    exporter,
    collect: async () => {
      await provider.forceFlush();
      const all: MetricData[] = [];
      for (const rm of exporter.getMetrics() as ResourceMetrics[]) {
        for (const sm of rm.scopeMetrics) {
          for (const m of sm.metrics) all.push(m);
        }
      }
      return all;
    },
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}

/** A log fixture: a LoggerProvider feeding an in-memory log-record sink. */
export interface LogFixture {
  provider: LoggerProvider;
  exporter: InMemoryLogRecordExporter;
  shutdown(): Promise<void>;
}

/** Build a LoggerProvider whose records land in an `InMemoryLogRecordExporter`. */
export function makeLogFixture(): LogFixture {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
  return {
    provider,
    exporter,
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}

/** Sum a single counter metric's data points whose attributes match `filter`. */
export function sumCounter(
  metrics: MetricData[],
  otelName: string,
  filter?: (attrs: Record<string, unknown>) => boolean,
): number {
  let total = 0;
  for (const m of metrics) {
    if (m.descriptor.name !== otelName) continue;
    for (const dp of m.dataPoints) {
      const attrs = dp.attributes as Record<string, unknown>;
      if (filter && !filter(attrs)) continue;
      total += dp.value as number;
    }
  }
  return total;
}
