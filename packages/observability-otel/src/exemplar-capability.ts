// SPDX-License-Identifier: Apache-2.0
/**
 * Build-time exemplar-capability probe.
 *
 * Exemplars (a `trace_id` riding on a sample) are the Grafana → `comis explain`
 * drill-down primitive on the Prometheus PULL surface. They are exported
 * ONLY in OpenMetrics format, and only when the exporter is configured for it —
 * the OTel Collector's Prometheus exporter has an `enable_open_metrics` switch,
 * but the JS SDK's `@opentelemetry/exporter-prometheus` has historically lagged.
 *
 * This module PROBES the installed exporter for an OpenMetrics/exemplar affordance
 * and records the verdict in {@link PROMETHEUS_EXEMPLARS_SUPPORTED}. The verdict
 * The verdict gates the exemplar test:
 *   - `true`  → a STRICT exemplar-presence assertion on `/metrics`.
 *   - `false` → the `/metrics`-pull limitation is documented and the
 *               chart→explain drill-down is realized via a panel data-link templated
 *               on a `trace_id`-bearing alternative (the OTLP→collector path carries
 *               exemplars regardless).
 *
 * The probe is conservative and NON-THROWING: a missing affordance is a `false`,
 * never an error. It positively looks for an OpenMetrics/exemplar switch on the
 * exporter's config options, its `DEFAULT_OPTIONS`, and its serializer surface;
 * absence ⇒ `false`.
 *
 * Verified result for `@opentelemetry/exporter-prometheus@0.219.0` (its
 * `ExporterConfig` = `{ prefix?, appendTimestamp?, endpoint?, host?, port?,
 * preventServerStart?, metricProducers?, withResourceConstantLabels?,
 * withoutScopeInfo?, withoutTargetInfo? }`, and the `PrometheusSerializer`
 * constructor takes `(prefix?, appendTimestamp?, withResourceConstantLabels?,
 * withoutTargetInfo?, withoutScopeInfo?)`): NO OpenMetrics / exemplar affordance →
 * `PROMETHEUS_EXEMPLARS_SUPPORTED === false`.
 *
 * @module
 */
import {
  PrometheusExporter,
  PrometheusSerializer,
} from "@opentelemetry/exporter-prometheus";

/**
 * Affordance tokens that, if present on the exporter's option keys / default
 * options / serializer surface, would indicate OpenMetrics-exemplar support.
 */
const OPENMETRICS_AFFORDANCE_TOKENS: readonly string[] = [
  "openmetrics",
  "exemplar",
];

/** True if any own/proto property name on `obj` contains an affordance token. */
function hasAffordanceName(obj: object | undefined): boolean {
  if (!obj) return false;
  const names = new Set<string>();
  for (const k of Object.keys(obj)) names.add(k.toLowerCase());
  const proto = Object.getPrototypeOf(obj) as object | null;
  if (proto && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) names.add(k.toLowerCase());
  }
  for (const name of names) {
    if (OPENMETRICS_AFFORDANCE_TOKENS.some((tok) => name.includes(tok))) {
      return true;
    }
  }
  return false;
}

/**
 * Probe the installed `@opentelemetry/exporter-prometheus` for an
 * OpenMetrics/exemplar affordance. Returns `true` only on a POSITIVE find;
 * any error or absence ⇒ `false`. Never throws.
 */
function probePrometheusExemplarSupport(): { supported: boolean; note: string } {
  try {
    // 1. The exporter's static DEFAULT_OPTIONS enumerate every config key.
    const defaultOptions = (
      PrometheusExporter as unknown as { DEFAULT_OPTIONS?: Record<string, unknown> }
    ).DEFAULT_OPTIONS;
    const optionKeys = defaultOptions ? Object.keys(defaultOptions) : [];
    const optionHasAffordance = optionKeys.some((k) =>
      OPENMETRICS_AFFORDANCE_TOKENS.some((tok) => k.toLowerCase().includes(tok)),
    );

    // 2. The exporter instance / prototype (request handler, force-flush, etc.).
    const exporterProtoHasAffordance = hasAffordanceName(
      PrometheusExporter.prototype as unknown as object,
    );

    // 3. The serializer surface (where an OpenMetrics rendering path would live).
    const serializerProtoHasAffordance = hasAffordanceName(
      PrometheusSerializer.prototype as unknown as object,
    );

    const supported =
      optionHasAffordance ||
      exporterProtoHasAffordance ||
      serializerProtoHasAffordance;

    const note = supported
      ? `OpenMetrics/exemplar affordance DETECTED on @opentelemetry/exporter-prometheus (option keys: [${optionKeys.join(", ")}]) — Plan 03 may write a strict exemplar-presence test on /metrics.`
      : `No OpenMetrics/exemplar affordance on @opentelemetry/exporter-prometheus (ExporterConfig keys: [${optionKeys.join(
          ", ",
        )}]); the /metrics pull surface renders counters/histograms WITHOUT exemplars. Plan 03 must document this limitation and realize the chart→explain drill-down via a panel data-link (the OTLP→collector path carries exemplars).`;

    return { supported, note };
  } catch (err) {
    // A probe failure is an honest `false` (never claim support we can't verify).
    return {
      supported: false,
      note: `exemplar-capability probe could not inspect @opentelemetry/exporter-prometheus (${
        err instanceof Error ? err.message : String(err)
      }); defaulting PROMETHEUS_EXEMPLARS_SUPPORTED to false.`,
    };
  }
}

const PROBE = probePrometheusExemplarSupport();

/**
 * Whether the installed Prometheus pull surface can render OpenMetrics exemplars
 * (a `trace_id` on a sample). Derived at build/load time by probing the installed
 * exporter; `false` for `@opentelemetry/exporter-prometheus@0.219.0`. Gates the
 * exemplar test (strict vs documented-limitation).
 */
export const PROMETHEUS_EXEMPLARS_SUPPORTED: boolean = PROBE.supported;

/** Human-readable description of what the probe inspected and the verdict it reached. */
export const EXEMPLAR_CAPABILITY_NOTE: string = PROBE.note;
