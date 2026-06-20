// SPDX-License-Identifier: Apache-2.0
/**
 * OTEL-02 / PROM-01 — the bus-event → OTel-instrument subscriber.
 *
 * `wireMetricMapping(deps)` is the extension's whole metric INPUT surface. It
 * follows the `obs-audit-sink.ts` `wireAuditSink` shape (one `eventBus.on` per
 * source event), but maps each typed payload to a CONTENT-FREE OTel instrument
 * increment off the single {@link METRIC_CATALOG} (Plan 01 — one definition, two
 * readers, so the OTLP push and Prometheus pull surfaces can never drift).
 *
 * Two invariants are upheld HERE:
 *   1. **Content-free / low-cardinality labels.** Every label is a catalog
 *      {@link MetricLabel} (ids/enums/counts only). The AsyncLocalStorage
 *      `traceId` is a UUID and rides as a span ATTRIBUTE / exemplar value
 *      (Pitfall 4) — NEVER a metric label. Every attribute bag is additionally
 *      routed through {@link redactAttributes} (E3 defense-in-depth) before it
 *      reaches an instrument.
 *   2. **No new emit (N1).** The extension only SUBSCRIBES the existing
 *      `observability:*` / `security:*` signals 176/177 already emit.
 *
 * The spend `observableGauge`s (`comis.spend.{usd,ceiling.usd,headroom.usd}`)
 * read `spendAccumulator.getSnapshot()` (Pitfall 3) through `addCallback` —
 * headroom = ceiling − current spend per scope (ceiling from the injected
 * config). They register ONLY when an accumulator is provided.
 *
 * @module
 */
import type { Meter, Counter, Histogram, Attributes } from "@opentelemetry/api";
import type { TypedEventBus } from "@comis/core";
import type { MetricInstrumentType } from "./metric-catalog.js";
import { METRIC_CATALOG } from "./metric-catalog.js";
import { redactAttributes } from "./redact-attributes.js";
import type { SpendSnapshotReader } from "./spend-snapshot.js";

/** The closed spend scopes the gauges observe (matches `SpendScopeKind`). */
type SpendScopeName = "agent" | "tenant" | "global";

/** The per-scope ceilings the headroom gauge subtracts from (from config). */
export interface SpendCeilingsView {
  readonly perAgentUsd: number | null;
  readonly perTenantUsd: number | null;
  readonly daemonGlobalUsd: number | null;
}

/** Dependencies for {@link wireMetricMapping} (the `wireAuditSink` shape). */
export interface WireMetricMappingDeps {
  /** The OTel meter (built once off the single MeterProvider in the exporter). */
  readonly meter: Meter;
  /** The typed event bus — the extension's only input (subscribe, never emit). */
  readonly eventBus: TypedEventBus;
  /** The 177 spend accumulator's read accessor — the `comis_spend_*` gauge source. */
  readonly spendAccumulator?: SpendSnapshotReader;
  /** The per-scope spend ceilings (config) the headroom gauge subtracts from. */
  readonly ceilings?: SpendCeilingsView;
}

/**
 * Build every catalog instrument off the meter, keyed by `otelName`. Counters and
 * up/down counters expose `.add`; histograms expose `.record`; observable gauges
 * are registered separately (their values are pulled via callbacks, not pushed).
 */
interface BuiltInstruments {
  counters: Map<string, Counter>;
  histograms: Map<string, Histogram>;
}

function buildInstruments(meter: Meter): BuiltInstruments {
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();
  for (const def of METRIC_CATALOG) {
    const type: MetricInstrumentType = def.type;
    const opts = { description: def.description, unit: def.unit };
    if (type === "counter") {
      counters.set(def.otelName, meter.createCounter(def.otelName, opts));
    } else if (type === "histogram") {
      histograms.set(def.otelName, meter.createHistogram(def.otelName, opts));
    }
    // gauges + observableGauges are pull-based (registered in wireSpendGauges /
    // the exporter's meta gauges) — not push instruments built here.
  }
  return { counters, histograms };
}

/** Increment a catalog counter with content-free, re-redacted labels. */
function addCounter(
  instruments: BuiltInstruments,
  otelName: string,
  value: number,
  labels: Record<string, unknown>,
): void {
  const counter = instruments.counters.get(otelName);
  if (counter === undefined) return;
  // redactAttributes returns a content-free Record; the catalog labels are flat
  // scalars (ids/enums/counts) so the bag is a valid OTel Attributes set.
  counter.add(value, redactAttributes(labels) as Attributes);
}

/** Record a catalog histogram observation with content-free, re-redacted labels. */
function recordHistogram(
  instruments: BuiltInstruments,
  otelName: string,
  value: number,
  labels: Record<string, unknown>,
): void {
  const histogram = instruments.histograms.get(otelName);
  if (histogram === undefined) return;
  histogram.record(value, redactAttributes(labels) as Attributes);
}

/**
 * Register the spend `observableGauge`s reading `getSnapshot()` (Pitfall 3). The
 * snapshot's `perAgent`/`perTenant`/`global` totals feed `comis.spend.usd`; the
 * config ceilings feed `comis.spend.ceiling.usd`; headroom = ceiling − spend per
 * scope feeds `comis.spend.headroom.usd`. Content-free: a closed `scope` label +
 * a dollar number only. Omitted entirely when no accumulator is provided.
 */
function wireSpendGauges(deps: WireMetricMappingDeps): void {
  const { meter, spendAccumulator } = deps;
  if (spendAccumulator === undefined) return;
  const ceilings = deps.ceilings;

  const usdGauge = meter.createObservableGauge("comis.spend.usd", {
    description: "Current cumulative spend per scope (agent/tenant/global).",
    unit: "usd",
  });
  const ceilingGauge = meter.createObservableGauge("comis.spend.ceiling.usd", {
    description: "Configured spend ceiling per scope.",
    unit: "usd",
  });
  const headroomGauge = meter.createObservableGauge("comis.spend.headroom.usd", {
    description: "Remaining headroom (ceiling − current spend) per scope.",
    unit: "usd",
  });

  // Aggregate the per-key maps to a single per-scope total (the gauge label is
  // the closed `scope`, never the high-cardinality `${tenant} ${agent}` key).
  const sumValues = (m: ReadonlyMap<string, number>): number => {
    let total = 0;
    for (const v of m.values()) total += v;
    return total;
  };
  const ceilingFor = (scope: SpendScopeName): number | null => {
    if (ceilings === undefined) return null;
    if (scope === "agent") return ceilings.perAgentUsd;
    if (scope === "tenant") return ceilings.perTenantUsd;
    return ceilings.daemonGlobalUsd;
  };

  usdGauge.addCallback((result) => {
    const snap = spendAccumulator.getSnapshot();
    result.observe(sumValues(snap.perAgent), { scope: "agent" });
    result.observe(sumValues(snap.perTenant), { scope: "tenant" });
    result.observe(snap.global, { scope: "global" });
  });

  ceilingGauge.addCallback((result) => {
    for (const scope of ["agent", "tenant", "global"] as const) {
      const cap = ceilingFor(scope);
      if (cap !== null) result.observe(cap, { scope });
    }
  });

  headroomGauge.addCallback((result) => {
    const snap = spendAccumulator.getSnapshot();
    const spendByScope: Record<SpendScopeName, number> = {
      agent: sumValues(snap.perAgent),
      tenant: sumValues(snap.perTenant),
      global: snap.global,
    };
    for (const scope of ["agent", "tenant", "global"] as const) {
      const cap = ceilingFor(scope);
      // Headroom only meaningful when a ceiling is configured for the scope.
      if (cap !== null) result.observe(cap - spendByScope[scope], { scope });
    }
  });
}

/**
 * Subscribe the bus → instrument mapping. Returns nothing — the caller (the
 * exporter) owns the MeterProvider's lifecycle. Each handler maps a typed payload
 * to a content-free catalog instrument; the `traceId` (when present) rides as a
 * span attribute / exemplar elsewhere, never as a metric label here.
 */
export function wireMetricMapping(deps: WireMetricMappingDeps): void {
  const { eventBus } = deps;
  const instruments = buildInstruments(deps.meter);

  // ── observability:token_usage → tokens / cost / cost-correction / cache / duration ──
  eventBus.on("observability:token_usage", (payload) => {
    const base = {
      agent: payload.agentId,
      provider: payload.provider,
      model: payload.model,
      operation: "interactive",
    };
    // Tokens by type (content-free: type is a closed label).
    addCounter(instruments, "comis.tokens", payload.tokens.prompt, { ...base, type: "prompt" });
    addCounter(instruments, "comis.tokens", payload.tokens.completion, { ...base, type: "completion" });
    // Corrected USD cost — the parity source (== SQLite SUM(cost_total)).
    addCounter(instruments, "comis.cost.usd", payload.cost.total, base);
    // Cost-correction delta (omitted by the emit site when 0; guard here too).
    if (payload.costCorrection && payload.costCorrection.delta !== 0) {
      addCounter(instruments, "comis.cost_correction.usd", payload.costCorrection.delta, {
        provider: payload.provider,
        model: payload.model,
      });
    }
    // Cache savings + read-ratio.
    if (payload.savedVsUncached !== 0) {
      addCounter(instruments, "comis.cache.saved.usd", payload.savedVsUncached, {
        agent: payload.agentId,
        provider: payload.provider,
        model: payload.model,
      });
    }
    if (payload.tokens.total > 0) {
      recordHistogram(instruments, "comis.cache.read_ratio", payload.cacheReadTokens / payload.tokens.total, {
        provider: payload.provider,
        model: payload.model,
      });
    }
    // Run duration in SECONDS (base unit) — latencyMs ÷ 1000.
    recordHistogram(instruments, "comis.run.duration.seconds", payload.latencyMs / 1000, {
      agent: payload.agentId,
      operation: "interactive",
    });
  });

  // ── observability:cache_break → cache-break by reason + scope ──
  eventBus.on("observability:cache_break", (payload) => {
    addCounter(instruments, "comis.cache.break", 1, {
      reason: payload.reason,
      // The cache-break event is per-turn; scope is the agent dimension.
      scope: "agent",
    });
  });

  // ── observability:spend_warning / _exceeded / _unpriceable → content-free counters ──
  eventBus.on("observability:spend_warning", (payload) => {
    addCounter(instruments, "comis.spend.warning", 1, { scope: payload.scope });
  });
  eventBus.on("observability:spend_exceeded", (payload) => {
    addCounter(instruments, "comis.spend.exceeded", 1, { scope: payload.scope });
  });
  eventBus.on("observability:spend_unpriceable", (_payload) => {
    // Content-free: a single count (provider/model are config ids but kept off
    // the label set here — the catalog's spend.unpriceable carries `scope` only;
    // an unpriceable turn is not scoped by a ceiling, so emit the bare count).
    addCounter(instruments, "comis.spend.unpriceable", 1, {});
  });

  // ── security:injection_detected → counts only (NEVER the patterns body) ──
  eventBus.on("security:injection_detected", (payload) => {
    addCounter(instruments, "comis.injection_detected", 1, { outcome: "denied" });
    void payload; // payload.patterns is content — deliberately NOT read into a label.
  });

  // The spend gauges (pull-based) — registered last so the accumulator ref is set.
  wireSpendGauges(deps);
}
