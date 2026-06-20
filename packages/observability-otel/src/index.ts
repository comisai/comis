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
 *   - (Task 2) the single metric catalog (`METRIC_CATALOG` / `MetricDef`) and the
 *     build-time exemplar-capability probe (`PROMETHEUS_EXEMPLARS_SUPPORTED`).
 *
 * The runtime registration entry-point (`registerOtelExporter`) lands in Plan 02;
 * this plan ships the skeleton, the catalog, and the probe.
 *
 * @module
 */
import type { TypedEventBus, ClockPort, AppConfig } from "@comis/core";

/**
 * The read-only spend totals the daemon threads from the 177 `SpendAccumulator`
 * (`@comis/agent`) into this extension's `comis_spend_*` observable gauges.
 *
 * Declared structurally (NOT imported from `@comis/agent`) so the extension does
 * not take a build-graph dependency on `@comis/agent` — the daemon, which owns
 * both references, injects the live accumulator's `getSnapshot()` result shape.
 * Mirrors `SpendAccumulator.getSnapshot()` (added in 178-01 Task 3): content-free
 * dollar counts keyed by the `${tenantId} ${agentId}` / `tenantId` scope keys.
 */
export interface SpendSnapshotReader {
  /** A read-only view of current spend totals (billed + in-flight reservations). */
  getSnapshot(): {
    readonly perAgent: ReadonlyMap<string, number>;
    readonly perTenant: ReadonlyMap<string, number>;
    readonly global: number;
  };
}

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
