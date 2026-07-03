// SPDX-License-Identifier: Apache-2.0
/**
 * `@comis/observability-otel` — the monorepo's first OPT-IN extension package.
 *
 * Maps the existing `@comis/core` event bus (the `observability:*` /
 * `security:*` signals other layers already emit) onto OpenTelemetry instruments,
 * exposed on two surfaces from ONE metric definition: OTLP push (traces /
 * metrics / logs) and a Prometheus `/metrics` pull. The daemon loads this
 * package ONLY when `observability.otel.enabled || observability.prometheus.enabled`
 * via a config-gated `await import("@comis/observability-otel")` — core and
 * daemon build with this package's `dist/` absent (see
 * `test/architecture/build-without-extension.test.ts`).
 *
 * This barrel exposes:
 *   - {@link OtelExporterDeps} — the type-only contract the daemon seam imports
 *     (`import type { OtelExporterDeps } from "@comis/observability-otel"`), so
 *     the daemon types the `await import()` result WITHOUT a static value-import
 *     or a tsconfig project-reference.
 *   - the single metric catalog (`METRIC_CATALOG` / `MetricDef` / `promNameFor`)
 *     consumed by both the OTLP and Prometheus surfaces (one mapping,
 *     two readers).
 *   - the build-time exemplar-capability probe (`PROMETHEUS_EXEMPLARS_SUPPORTED`).
 *
 * The runtime registration entry-point (`registerOtelExporter`) and the
 * bus→instrument subscriber are exposed below.
 *
 * @module
 */
// The single metric definition (name/type/unit/labels) — consumed by BOTH the
// OTLP push and Prometheus pull surfaces, so the two readers can
// never drift. The closed MetricLabel union is the no-high-cardinality guard.
export {
  METRIC_CATALOG,
  METRIC_LABELS,
  promNameFor,
} from "./metric-catalog.js";
export type {
  MetricDef,
  MetricInstrumentType,
  MetricLabel,
} from "./metric-catalog.js";

// The emitted-metric-name SET (derived from METRIC_CATALOG, histograms expanded
// to their _bucket/_sum/_count families) — the truth set the Grafana/Prometheus
// expr↔metric drift guard (`test/architecture/grafana-dashboard-metrics.test.ts`)
// checks every panel + rule `expr` against. One catalog, one
// set, no second definition to drift.
export {
  EMITTED_METRIC_NAMES,
  EMITTED_METRIC_NAMES_SORTED,
} from "./dashboard-metric-names.js";

// The build-time probe of the installed @opentelemetry/exporter-prometheus —
// records whether the `/metrics` surface can render OpenMetrics exemplars.
export {
  PROMETHEUS_EXEMPLARS_SUPPORTED,
  EXEMPLAR_CAPABILITY_NOTE,
} from "./exemplar-capability.js";

// The runtime registration entry-point (the config-gated daemon seam imports
// `OtelExporterDeps` type-only + calls `registerOtelExporter` via the dynamic
// await import()) + the bus→instrument subscriber, the content-free re-redaction
// boundary, and the span helpers. Loaded ONLY via the daemon's config-gated
// await import() — core/daemon never value-import this.
export { registerOtelExporter } from "./otel-exporter.js";
export type { OtelExporterDeps, OtelExporterHandle } from "./otel-exporter.js";
export { wireMetricMapping } from "./metric-mapping.js";
export type { WireMetricMappingDeps, SpendCeilingsView } from "./metric-mapping.js";
export { redactAttributes } from "./redact-attributes.js";
export { emitTurnSpan } from "./traces.js";
export type { TurnSpanArgs, SpanMessage } from "./traces.js";

// The structural read-only spend-snapshot contract (the comis_spend_* gauge
// source the daemon injects from the SpendAccumulator).
export type { SpendSnapshotReader } from "./spend-snapshot.js";
