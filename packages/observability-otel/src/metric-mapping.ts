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
  /** The daemon version label for `comis_build_info` (from `pkgJson.version`; "unknown" when absent). */
  readonly version?: string;
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
 * Register the meta gauges `comis_up` (exporter-liveness; constant 1 while the
 * MeterProvider runs) and `comis_build_info{version}` (constant 1 carrying the
 * daemon version label — version ONLY, NO commit; Pitfall 7 / decision #5: no
 * git rev-parse at runtime). Both are pull-based `observableGauge`s — the only
 * way to expose a constant series — observed on every scrape. `comis_up` going
 * absent (no scrape) IS the liveness signal the fleet dashboard alerts on.
 */
function wireMetaGauges(deps: WireMetricMappingDeps): void {
  const { meter } = deps;
  const version = deps.version ?? "unknown";

  const upGauge = meter.createObservableGauge("comis.up", {
    description: "Exporter liveness gauge (constant 1 while the exporter runs).",
    unit: "",
  });
  upGauge.addCallback((result) => result.observe(1));

  const buildGauge = meter.createObservableGauge("comis.build_info", {
    description: "Build info gauge (constant 1) carrying the daemon version label.",
    unit: "",
  });
  // version is a config-derived id (pkgJson.version), NOT user content — a
  // content-free closed-ish label (one value per running daemon).
  buildGauge.addCallback((result) => result.observe(1, { version }));
}

/**
 * Derive a content-free `outcome` for the per-turn counter from the SDK
 * finish/stop signals on `token_usage` — a turn is `error` on a refusal /
 * length-cut / loop-detected / budget-exceeded finish, else `success`. Closed
 * label (NOT free text): the input is the SDK's own closed-ish enum, mapped to
 * the two-value `outcome` the catalog declares.
 */
function turnOutcome(finishReason: string | undefined, stopReason: string | undefined): "success" | "error" {
  const r = (finishReason ?? stopReason ?? "stop").toLowerCase();
  if (r === "stop" || r === "tool_use" || r === "end_turn") return "success";
  return "error";
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
    // Completed-turn counter (one per token_usage = one finished turn). outcome
    // derived from the SDK finish/stop signal — a closed two-value label.
    addCounter(instruments, "comis.turns", 1, {
      agent: payload.agentId,
      outcome: turnOutcome(payload.finishReason, payload.stopReason),
    });
    // Pricing coverage (E1): a turn that billed > $0 is `priced`, a $0 turn is
    // `free` (local-first). The `unknown` state rides spend_unpriceable below.
    addCounter(instruments, "comis.pricing.turns", 1, {
      state: payload.cost.total > 0 ? "priced" : "free",
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
  eventBus.on("observability:spend_unpriceable", (payload) => {
    // Content-free: a single count (provider/model are config ids but kept off
    // the spend.unpriceable label set — the catalog's spend.unpriceable carries
    // `scope` only; an unpriceable turn is not scoped by a ceiling, bare count).
    addCounter(instruments, "comis.spend.unpriceable", 1, {});
    // E1 pricing-coverage: an unpriceable turn is the `unknown` pricing state +
    // the per-(provider,model) pricing-gap counter (provider/model are config
    // ids — a model id is a config value, NOT user content; §2.7).
    addCounter(instruments, "comis.pricing.turns", 1, { state: "unknown" });
    addCounter(instruments, "comis.pricing.unknown", 1, {
      provider: payload.provider,
      model: payload.model,
    });
  });

  // ── security:injection_detected → counts only (NEVER the patterns body) ──
  eventBus.on("security:injection_detected", (payload) => {
    addCounter(instruments, "comis.injection_detected", 1, { outcome: "denied" });
    void payload; // payload.patterns is content — deliberately NOT read into a label.
  });

  // ── tool:executed → comis.tool_calls (agent/tool/outcome/error_kind) ──
  eventBus.on("tool:executed", (payload) => {
    addCounter(instruments, "comis.tool_calls", 1, {
      // agentId may be undefined on some emit sites — sanitizeForPersistence
      // drops undefined keys, so the label is simply absent then (no leak).
      agent: payload.agentId,
      tool: payload.toolName,
      outcome: payload.success ? "success" : "failure",
      // errorKind is the closed ErrorKind union (or absent on success).
      error_kind: payload.errorKind,
    });
  });

  // ── tool:breaker_opened → comis.breaker_trips (tool only — event has no agentId) ──
  eventBus.on("tool:breaker_opened", (payload) => {
    // errorTag is a normalized error tag (content) — deliberately NOT a label.
    addCounter(instruments, "comis.breaker_trips", 1, { tool: payload.toolName });
  });

  // ── tool:result_offloaded → comis.offloads (tool only — diskPathRel is a path, never a label) ──
  eventBus.on("tool:result_offloaded", (payload) => {
    addCounter(instruments, "comis.offloads", 1, { tool: payload.toolName });
  });

  // ── session:summary → comis.sessions + comis.sessions.degraded (fleet rollup) ──
  eventBus.on("session:summary", (payload) => {
    const severity = payload.degraded ? "degraded" : "ok";
    addCounter(instruments, "comis.sessions", 1, { agent: payload.agentId, severity });
    if (payload.degraded) {
      addCounter(instruments, "comis.sessions.degraded", 1, { agent: payload.agentId, severity });
    }
  });

  // ── audit:event → comis.audit_events (the ComisAuditSinkFailure alert source) ──
  eventBus.on("audit:event", (payload) => {
    addCounter(instruments, "comis.audit_events", 1, {
      // kind is the closed AuditKind union (or absent on un-migrated emits).
      kind: payload.kind,
      outcome: payload.outcome,
      // classification (read|mutate|destructive) is the content-free severity proxy.
      severity: payload.classification ?? "unknown",
    });
  });

  // ── secret:accessed → comis.secret_access (outcome only — secretName is never a label) ──
  eventBus.on("secret:accessed", (payload) => {
    addCounter(instruments, "comis.secret_access", 1, { outcome: payload.outcome });
  });

  // ── memory:recalled → comis.recall + comis.recall.zero_hits (lane = the lanes count) ──
  eventBus.on("memory:recalled", (payload) => {
    // `lane` is the closed-ish lane dimension; the event reports a lanes COUNT,
    // so we render it as a bounded string label (1..3) — content-free.
    const lane = String(payload.lanes);
    addCounter(instruments, "comis.recall", 1, { agent: payload.agentId, lane });
    if (payload.finalCount === 0) {
      addCounter(instruments, "comis.recall.zero_hits", 1, { agent: payload.agentId, lane });
    }
  });

  // The spend gauges (pull-based) — registered last so the accumulator ref is set.
  wireSpendGauges(deps);
  // The meta gauges (comis_up + comis_build_info) — pull-based constants.
  wireMetaGauges(deps);
}
