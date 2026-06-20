// SPDX-License-Identifier: Apache-2.0
/**
 * Built-but-not-wired SOURCE GUARD for the OTel/Prometheus metric catalog
 * (CR-01 — the v2.28 "Observability Excellence" code-review finding).
 *
 * "Built but not wired" is THIS program's #1 recurring blocker (caught by code
 * review every prior phase v2.14/v2.18/v2.22/v2.23/v2.24): a surface can exist,
 * compile, and pass its own unit tests while NOTHING produces it at runtime.
 * Phase 178 shipped a 30-entry {@link METRIC_CATALOG} but `wireMetricMapping`
 * only incremented 11 of them + the spend gauges — so a `severity: critical`
 * alert (`ComisAuditSinkFailure`, keyed on `comis_audit_events_total`) could
 * NEVER fire, several other alerts were dead, and most Grafana panels rendered
 * "No data". The drift guard (grafana-dashboard-metrics.test.ts) certified the
 * panels GREEN because it checked catalog MEMBERSHIP, not whether a metric is
 * actually emitted — the exact gap this guard closes.
 *
 * This is the test that would have caught CR-01: EVERY {@link METRIC_CATALOG}
 * entry must have a PRODUCER — either
 *   (a) incremented via `addCounter(instruments, "<otelName>", …)` /
 *       `recordHistogram(instruments, "<otelName>", …)` in metric-mapping.ts, OR
 *   (b) registered as a gauge via `createObservableGauge("<otelName>", …)` /
 *       `createGauge("<otelName>", …)` in metric-mapping.ts, prometheus-surface.ts,
 *       or otel-exporter.ts (the meta/build/up/spend/cardinality gauges).
 *
 * Mold: `audio-wiring-guard.test.ts` / `cache-trace-stages-known.test.ts`'s
 * "≥1 producer" inverse-completeness check — a source-grep with NO allowlist.
 * A refactor that drops a producer (or adds a catalog entry without wiring it)
 * turns this red; the only way to comply is to wire a producer or remove the
 * catalog entry (+ its dashboards/rules — the drift guard enforces that half).
 *
 * @module
 */
import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectProducedOtelNames } from "../support/otel-produced-metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * The catalog comes from the COMPILED extension dist (the same pattern as
 * grafana-dashboard-metrics.test.ts loading EMITTED_METRIC_NAMES) — driving the
 * real dist means a catalog change reshapes this guard's truth, so it tracks the
 * single source of truth. Built by the per-task verify
 * (`pnpm --filter @comis/observability-otel build`).
 */
const EXTENSION_DIST_URL = pathToFileURL(
  resolve(REPO_ROOT, "packages/observability-otel/dist/metric-catalog.js"),
).href;

interface MetricDefLike {
  readonly otelName: string;
  readonly type: string;
}
let METRIC_CATALOG: readonly MetricDefLike[] = [];

beforeAll(async () => {
  const mod = (await import(EXTENSION_DIST_URL)) as {
    METRIC_CATALOG: readonly MetricDefLike[];
  };
  METRIC_CATALOG = mod.METRIC_CATALOG;
});

describe("otel-metric-catalog-wired — every METRIC_CATALOG entry has a producer (CR-01)", () => {
  it("sanity: the catalog loaded and the producer grep found a substantial set", () => {
    expect(METRIC_CATALOG.length, "METRIC_CATALOG not loaded from the extension").toBeGreaterThanOrEqual(29);
    const produced = collectProducedOtelNames();
    // Floor: the producer grep itself works (≥10 producers found) — fail loud on
    // a regex/path miss rather than vacuously passing over an empty set.
    expect(produced.size, "producer grep found too few metrics — regex/path miss?").toBeGreaterThanOrEqual(10);
  });

  it("every catalog metric is incremented in metric-mapping/prometheus-surface OR registered as a gauge", () => {
    const produced = collectProducedOtelNames();
    const unwired = METRIC_CATALOG.filter((d) => !produced.has(d.otelName)).map((d) => d.otelName);
    expect(
      unwired,
      `These METRIC_CATALOG entries have NO producer (neither an addCounter/recordHistogram ` +
        `increment in metric-mapping.ts nor a createObservableGauge/createGauge registration in ` +
        `metric-mapping.ts / prometheus-surface.ts / otel-exporter.ts): ${unwired.join(", ")}. ` +
        `This is the built-but-not-wired blocker (CR-01) — a catalogued metric with no producer ` +
        `means a dead alert/panel ("No data"). Either WIRE a producer (subscribe the carrying bus ` +
        `event in wireMetricMapping and increment the metric with content-free MetricLabel labels, ` +
        `or register a gauge callback), OR REMOVE the entry from METRIC_CATALOG and every Grafana ` +
        `panel + Prometheus rule that references it (the grafana-dashboard-metrics drift guard ` +
        `enforces that half).`,
    ).toEqual([]);
  });
});
