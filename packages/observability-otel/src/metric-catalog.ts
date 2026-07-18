// SPDX-License-Identifier: Apache-2.0
/**
 * The SINGLE metric catalog.
 *
 * ONE definition of every Comis metric — its dotted OTel `otelName`, the rendered
 * Prometheus `promName`, the instrument `type`, the base `unit`, and the
 * low-cardinality `labels`. The OTLP push surface (`PeriodicExportingMetricReader`)
 * and Prometheus pull surface (`PrometheusExporter`) BOTH read this catalog, so
 * the two surfaces render the SAME series and can never drift (one
 * `MeterProvider`, two readers, one catalog).
 *
 * Two invariants are enforced HERE, at the source, so later wiring cannot regress them:
 *
 *   1. **No high-cardinality label.** {@link MetricLabel} is a CLOSED union and
 *      deliberately EXCLUDES `session`/`trace`/`user` (and every id variant). The
 *      UUID `traceId` rides as a Prometheus EXEMPLAR / span attribute, never a
 *      series label (a label-cardinality DoS + PII surface).
 *      `metric-catalog.test.ts` asserts no entry uses a forbidden label.
 *
 *   2. **`comis_build_info` carries `version` only — no `commit`.** No
 *      `git rev-parse` runs at daemon boot (verified), so a `commit` label would
 *      be a runtime-unavailable phantom. `version` comes from `pkgJson.version`
 *      (`setup-logging.ts`).
 *
 * The dotted `otelName` ENCODES the Prometheus stem (minus the counter `_total`
 * suffix): e.g. the histogram `comis.run.duration.seconds` renders
 * `comis_run_duration_seconds`; the gauge `comis.build_info` renders
 * `comis_build_info`. {@link promNameFor} is the deterministic dots→underscores +
 * `_total`-on-counters rendering; every entry's `promName` round-trips through it
 * (asserted in the test). The `unit` field is the OTel instrument unit (UCUM-ish:
 * `usd`, `{token}`, `s`, `1`, `By`), distinct from the name's unit suffix.
 *
 * @module
 */

/**
 * The CLOSED low-cardinality label union. Adding a label here is a deliberate act;
 * `session`/`trace`/`user`/`sessionKey`/`traceId`/`userId` are intentionally
 * absent (ids ride as exemplars). The union being closed IS the
 * no-high-cardinality guard at the type level; the catalog test is the runtime guard.
 */
export type MetricLabel =
  | "agent"
  | "tenant"
  | "provider"
  | "model"
  | "channel"
  | "operation"
  | "tool"
  | "reason"
  | "pricing_state"
  | "error_kind"
  | "outcome"
  | "type"
  | "scope"
  | "state"
  | "severity"
  | "kind"
  | "lane"
  | "version";

/**
 * The runtime mirror of {@link MetricLabel} (a frozen tuple). Used by the catalog
 * test + the instrument construction to validate a label set at runtime
 * (the type union is erased at runtime). MUST stay in lockstep with the union.
 */
export const METRIC_LABELS = Object.freeze([
  "agent",
  "tenant",
  "provider",
  "model",
  "channel",
  "operation",
  "tool",
  "reason",
  "pricing_state",
  "error_kind",
  "outcome",
  "type",
  "scope",
  "state",
  "severity",
  "kind",
  "lane",
  "version",
] as const) satisfies readonly MetricLabel[];

/** The OpenTelemetry instrument kind backing a metric. */
export type MetricInstrumentType =
  | "counter"
  | "gauge"
  | "histogram"
  | "observableGauge";

/** One metric's complete, single-source definition. */
export interface MetricDef {
  /** The dotted OTel instrument name (encodes the Prometheus stem). */
  readonly otelName: string;
  /** The rendered Prometheus name (snake_case; `_total` on counters). */
  readonly promName: string;
  /** The OpenTelemetry instrument kind. */
  readonly type: MetricInstrumentType;
  /** The OTel instrument unit (UCUM-ish: `usd`, `{token}`, `s`, `1`, `By`; `""` for dimensionless meta gauges). */
  readonly unit: string;
  /** The closed low-cardinality label set for this series (ids ride as exemplars, never here). */
  readonly labels: readonly MetricLabel[];
  /** One-line human description (renders as Prometheus `# HELP`). */
  readonly description: string;
}

/**
 * Render a dotted OTel instrument name to its Prometheus name: dots → underscores,
 * with a single `_total` suffix appended for counters (idempotent — not re-added
 * if the dotted name already ends in `total`). Histograms/gauges get no suffix
 * here (the exporter adds `_bucket`/`_sum`/`_count` to a histogram at scrape time;
 * the catalog's `promName` is the stem). Deterministic — same input, same output.
 */
export function promNameFor(otelName: string, type: MetricInstrumentType): string {
  const base = otelName.replace(/\./g, "_");
  if (type === "counter" && !base.endsWith("_total")) {
    return `${base}_total`;
  }
  return base;
}

/** Helper: build a {@link MetricDef}, deriving `promName` via {@link promNameFor}. */
function def(
  otelName: string,
  type: MetricInstrumentType,
  unit: string,
  labels: readonly MetricLabel[],
  description: string,
): MetricDef {
  return Object.freeze({
    otelName,
    promName: promNameFor(otelName, type),
    type,
    unit,
    labels: Object.freeze([...labels]),
    description,
  });
}

/**
 * The comprehensive metric catalog. Counts/enums only; every label is a
 * {@link MetricLabel} (no high-cardinality id). The render-time `_total` suffix on
 * counters and the histogram `_bucket`/`_sum`/`_count` sub-series are the
 * exporter's job; this is the source set those derive from.
 */
export const METRIC_CATALOG: readonly MetricDef[] = Object.freeze([
  // ── Tokens & cost ────────────────────────────────────────────────────────
  def(
    "comis.tokens",
    "counter",
    "{token}",
    ["agent", "tenant", "provider", "model", "operation", "type"],
    "Total tokens consumed (prompt/completion/total via the type label).",
  ),
  def(
    "comis.cost.usd",
    "counter",
    "usd",
    ["agent", "tenant", "provider", "model", "operation"],
    "Corrected USD cost (the SDK-reconciled cost.total, not an estimate).",
  ),
  def(
    "comis.cost_correction.usd",
    "counter",
    "usd",
    ["provider", "model"],
    "USD delta between the SDK-reported and Comis-corrected cost (costCorrection.delta).",
  ),
  // ── Cache ────────────────────────────────────────────────────────────────
  def(
    "comis.cache.saved.usd",
    "counter",
    "usd",
    ["agent", "provider", "model"],
    "USD saved versus an uncached prompt (savedVsUncached).",
  ),
  def(
    "comis.cache.read_ratio",
    "histogram",
    "1",
    ["provider", "model"],
    "Distribution of cache-read tokens as a fraction of total tokens per turn.",
  ),
  def(
    "comis.cache.break",
    "counter",
    "1",
    ["reason", "scope"],
    "Prompt-cache breaks by reason (one of the 15 cache-break reasons) and scope.",
  ),
  // NOTE: there is no comis.cache.break.cost.usd metric. The
  // `observability:cache_break` bus event carries NO cost field — `estCostUsd`
  // is COMPUTED downstream in obs-explain-signals.ts from persisted records, not
  // emitted on the bus. Wiring it would require a NEW emit (this extension only
  // subscribes to existing signals), so the metric would be genuinely unsourced;
  // the cost-by-reason view lives in `comis explain`, not here.
  // ── Pricing coverage ─────────────────────────────────────────────────
  def(
    "comis.pricing.turns",
    "counter",
    "1",
    ["state"],
    "Turns by pricing state (priced/free/unknown) — the pricing-coverage signal.",
  ),
  def(
    "comis.pricing.unknown",
    "counter",
    "1",
    ["provider", "model"],
    "Turns whose pricing state is unknown (the pricing-gap subset of pricing.turns).",
  ),
  // ── Spend kill-switch ───────────────────────────────────────────────
  def(
    "comis.spend.usd",
    "observableGauge",
    "usd",
    ["scope"],
    "Current cumulative spend per scope (agent/tenant/global) from the spend accumulator.",
  ),
  def(
    "comis.spend.ceiling.usd",
    "observableGauge",
    "usd",
    ["scope"],
    "Configured spend ceiling per scope (the kill-switch limit).",
  ),
  def(
    "comis.spend.headroom.usd",
    "observableGauge",
    "usd",
    ["scope"],
    "Remaining headroom (ceiling − current spend) per scope.",
  ),
  def(
    "comis.spend.warning",
    "counter",
    "1",
    ["scope"],
    "Spend-warning events (a reserve crossed warnAtFraction) by scope.",
  ),
  def(
    "comis.spend.exceeded",
    "counter",
    "1",
    ["scope"],
    "Spend-exceeded events (a reserve was refused at the ceiling) by scope.",
  ),
  def(
    "comis.spend.unpriceable",
    "counter",
    "1",
    ["scope"],
    "Unpriceable-spend events (a turn could not be priced) by scope.",
  ),
  // ── Runtime / reliability ─────────────────────────────────────────────────
  def(
    "comis.run.duration.seconds",
    "histogram",
    "s",
    ["agent", "operation"],
    "Per-operation run duration in seconds (base unit).",
  ),
  def(
    "comis.turns",
    "counter",
    "1",
    ["agent", "outcome"],
    "Completed turns by agent and outcome.",
  ),
  def(
    "comis.tool_calls",
    "counter",
    "1",
    ["agent", "tool", "outcome", "error_kind"],
    "Tool calls by agent, tool, outcome, and error kind.",
  ),
  def(
    "comis.breaker_trips",
    "counter",
    "1",
    ["agent", "tool"],
    "Circuit-breaker trips by agent and tool.",
  ),
  def(
    "comis.offloads",
    "counter",
    "1",
    ["agent", "tool"],
    "Large-result offloads by agent and tool.",
  ),
  def(
    "comis.sessions",
    "counter",
    "1",
    ["agent", "severity"],
    "Sessions observed by agent and severity (system rollup).",
  ),
  def(
    "comis.sessions.degraded",
    "counter",
    "1",
    ["agent", "severity"],
    "Degraded sessions by agent and severity (system rollup).",
  ),
  // ── Security / audit ────────────────────────────────────────────────
  def(
    "comis.audit_events",
    "counter",
    "1",
    ["kind", "outcome", "severity"],
    "Audit events by kind, outcome, and severity.",
  ),
  def(
    "comis.secret_access",
    "counter",
    "1",
    ["outcome"],
    "Secret-access events by outcome.",
  ),
  def(
    "comis.injection_detected",
    "counter",
    "1",
    ["outcome"],
    "Prompt-injection detections by outcome (counts only — no content).",
  ),
  // ── Recall (memory) ───────────────────────────────────────────────────────
  def(
    "comis.recall",
    "counter",
    "1",
    ["agent", "lane"],
    "Memory recalls by agent and lane.",
  ),
  def(
    "comis.recall.zero_hits",
    "counter",
    "1",
    ["agent", "lane"],
    "Memory recalls that returned zero hits, by agent and lane.",
  ),
  // ── Meta / self-cardinality ───────────────────────────────────────────────
  def(
    "comis.build_info",
    // observableGauge — a constant series can only be emitted via a pull callback
    // (registered in metric-mapping's wireMetaGauges).
    "observableGauge",
    "",
    // version ONLY — NO commit (no git rev-parse at runtime).
    ["version"],
    "Build info gauge (constant 1) carrying the daemon version label.",
  ),
  def(
    "comis.up",
    // observableGauge — constant 1 observed on every scrape (pull callback).
    "observableGauge",
    "",
    [],
    "Exporter liveness gauge (constant 1 while the exporter runs).",
  ),
  def(
    "comis.prometheus_series",
    "gauge",
    "",
    [],
    "Self-reported active series count (the cardinalityCap guard).",
  ),
]);
