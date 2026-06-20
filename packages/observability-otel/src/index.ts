// SPDX-License-Identifier: Apache-2.0
/**
 * `@comis/observability-otel` — the monorepo's first OPT-IN extension package.
 *
 * Maps the existing `@comis/core` event bus (the `observability:*` /
 * `security:*` signals 176/177 already emit) onto OpenTelemetry instruments,
 * exposed on two surfaces from ONE metric definition: OTLP push (traces /
 * metrics / logs) and a Prometheus `/metrics` pull. The daemon loads this
 * package ONLY when `observability.otel.enabled || observability.prometheus.enabled`
 * via a config-gated `await import("@comis/observability-otel")` — core and
 * daemon build with this package's `dist/` absent (N2; see
 * `test/architecture/build-without-extension.test.ts`).
 *
 * This barrel exposes:
 *   - {@link OtelExporterDeps} — the type-only contract the daemon seam imports
 *     (`import type { OtelExporterDeps } from "@comis/observability-otel"`), so
 *     the daemon types the `await import()` result WITHOUT a static value-import
 *     or a tsconfig project-reference.
 *   - the single metric catalog (`METRIC_CATALOG` / `MetricDef` / `promNameFor`)
 *     consumed by both the OTLP and Prometheus surfaces (Plan 02 — one mapping,
 *     two readers).
 *   - the build-time exemplar-capability probe (`PROMETHEUS_EXEMPLARS_SUPPORTED`).
 *
 * The runtime registration entry-point (`registerOtelExporter`) lands in Plan 02;
 * this plan ships the skeleton, the catalog, and the probe.
 *
 * @module
 */
import type { TypedEventBus, ClockPort, AppConfig } from "@comis/core";

// The single metric definition (name/type/unit/labels) — consumed by BOTH the
// OTLP push and Prometheus pull surfaces in Plan 02, so the two readers can
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

// The build-time probe of the installed @opentelemetry/exporter-prometheus —
// records whether the `/metrics` surface can render OpenMetrics exemplars
// (gates Plan 03's PROM-04 test).
export {
  PROMETHEUS_EXEMPLARS_SUPPORTED,
  EXEMPLAR_CAPABILITY_NOTE,
} from "./exemplar-capability.js";

// The bus → instrument subscriber + the content-free re-redaction boundary (E3).
// Loaded ONLY via the daemon's config-gated await import() (N2 — core/daemon
// never value-import this). The registration entry-point (registerOtelExporter)
// is added in Plan 02 Task 2.
export { wireMetricMapping } from "./metric-mapping.js";
export type { WireMetricMappingDeps, SpendCeilingsView } from "./metric-mapping.js";
export { redactAttributes } from "./redact-attributes.js";

// The structural read-only spend-snapshot contract (the comis_spend_* gauge
// source the daemon injects from the 177 SpendAccumulator).
export type { SpendSnapshotReader } from "./spend-snapshot.js";
import type { SpendSnapshotReader } from "./spend-snapshot.js";

/**
 * The dependency contract the daemon's config-gated load seam passes into the
 * extension's `registerOtelExporter` (Plan 02). Type-only on the daemon side —
 * importing it forces NO runtime dependency and NO tsconfig project-reference
 * (the N2 clean-build invariant).
 *
 * The shape is intentionally minimal in this plan (the seam + the registration
 * function land in Plan 02); the fields below are the verified seam inputs from
 * the 178-RESEARCH "config-gated load seam" code block.
 */
export interface OtelExporterDeps {
  /** The typed event bus the extension subscribes for live metric increments. */
  readonly eventBus: TypedEventBus;
  /** The injected clock (the package never calls wall-clock APIs directly). */
  readonly clock: ClockPort;
  /** The resolved observability config (the `otel` / `prometheus` keys gate everything). */
  readonly observability: AppConfig["observability"];
  /** The 177 spend accumulator's read accessor — the `comis_spend_*` gauge source. */
  readonly spendAccumulator?: SpendSnapshotReader;
}
