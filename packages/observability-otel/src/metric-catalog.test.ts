// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first contract for the single metric catalog (OTEL-02 / PROM-01).
 *
 * The catalog is the ONE definition of every Comis metric (dotted OTel name,
 * rendered Prometheus name, instrument type, base unit, low-cardinality label
 * set). Plan 02's OTLP push surface and Prometheus pull surface BOTH read it —
 * one mapping, two readers, so the two surfaces can never drift.
 *
 * These pins fail on pre-patch code because `./metric-catalog.js` does not exist
 * (an import/resolution error), and — once the module exists — guard the three
 * load-bearing invariants the design §6 WS7 + the no-high-cardinality threat
 * (T-178-03) require:
 *
 *   (a) CLOSED low-cardinality label union — NO `session`/`trace`/`user` (or any
 *       `sessionKey`/`traceId`/`userId`) label appears on ANY entry. Those ids
 *       ride as EXEMPLARS only (Pitfall 4); defining the union closed HERE means
 *       Plans 02/03 cannot introduce a high-cardinality label.
 *   (b) the FULL design §6 WS7 metric set is present (a minimum count + the
 *       load-bearing names the dashboards/rules key on).
 *   (c) `comis_build_info` carries ONLY a `version` label — NO `commit` (decision
 *       #5 / Pitfall 7: no `git rev-parse` runs at daemon boot, so a commit label
 *       would be a runtime-unavailable phantom).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  METRIC_CATALOG,
  METRIC_LABELS,
  promNameFor,
  type MetricDef,
  type MetricLabel,
} from "./metric-catalog.js";

// The closed low-cardinality label union, restated here as the test's source of
// truth. `session`/`trace`/`user` (and their id variants) are DELIBERATELY
// ABSENT — high-cardinality ids ride as exemplars, never as series labels.
const ALLOWED_LABELS: ReadonlySet<string> = new Set<MetricLabel>([
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
]);

// The high-cardinality labels that must NEVER appear (the T-178-03 PII/DoS guard).
const FORBIDDEN_LABELS: readonly string[] = [
  "session",
  "trace",
  "user",
  "sessionKey",
  "sessionId",
  "traceId",
  "userId",
  "session_id",
  "trace_id",
  "user_id",
];

describe("metric-catalog", () => {
  it("is a frozen, non-empty catalog of MetricDef entries", () => {
    expect(Array.isArray(METRIC_CATALOG)).toBe(true);
    expect(Object.isFrozen(METRIC_CATALOG)).toBe(true);
    // The design §6 WS7 table enumerates ~24 distinct series (cost/tokens/cache/
    // cache-break/pricing/spend×3/spend-events×3/duration/turns/tool_calls/
    // breaker/offload/sessions×2/audit/secret/injection/recall×2/build_info/up/
    // series). A floor of 24 catches a truncated catalog without being brittle to
    // an added metric.
    expect(METRIC_CATALOG.length).toBeGreaterThanOrEqual(24);
  });

  it("(a) every entry's labels are drawn ONLY from the closed low-cardinality union — no session/trace/user", () => {
    const offenders: Array<{ metric: string; badLabel: string }> = [];
    for (const def of METRIC_CATALOG) {
      for (const label of def.labels) {
        if (!ALLOWED_LABELS.has(label)) {
          offenders.push({ metric: def.promName, badLabel: label });
        }
        if (FORBIDDEN_LABELS.includes(label)) {
          offenders.push({ metric: def.promName, badLabel: label });
        }
      }
    }
    expect(
      offenders,
      `high-cardinality / unknown label(s) on metric series (ids must ride as EXEMPLARS, never labels): ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("(a') METRIC_LABELS is the closed union and excludes every high-cardinality id", () => {
    // METRIC_LABELS is the runtime mirror of the MetricLabel type union.
    for (const forbidden of FORBIDDEN_LABELS) {
      expect(
        (METRIC_LABELS as readonly string[]).includes(forbidden),
        `${forbidden} must NOT be a permitted metric label`,
      ).toBe(false);
    }
    // Every label the catalog actually uses is in METRIC_LABELS.
    const used = new Set<string>();
    for (const def of METRIC_CATALOG) for (const l of def.labels) used.add(l);
    for (const label of used) {
      expect(
        (METRIC_LABELS as readonly string[]).includes(label),
        `catalog uses label ${label} not declared in METRIC_LABELS`,
      ).toBe(true);
    }
  });

  it("(b) contains the full design §6 WS7 metric set — the load-bearing Prometheus names", () => {
    const promNames = new Set(METRIC_CATALOG.map((d) => d.promName));
    const required = [
      "comis_tokens_total",
      "comis_cost_usd_total",
      "comis_cost_correction_usd_total",
      "comis_cache_saved_usd_total",
      "comis_cache_read_ratio",
      "comis_cache_break_total",
      // comis_cache_break_cost_usd_total REMOVED (CR-01) — the cache_break bus
      // event carries no cost field; estCostUsd is computed downstream, not
      // emitted, so the metric was unsourced. The $-lost-by-reason view lives in
      // `comis explain`, not on the pull surface.
      "comis_pricing_turns_total",
      "comis_pricing_unknown_total",
      "comis_spend_usd",
      "comis_spend_ceiling_usd",
      "comis_spend_headroom_usd",
      "comis_spend_warning_total",
      "comis_spend_exceeded_total",
      "comis_spend_unpriceable_total",
      "comis_run_duration_seconds",
      "comis_turns_total",
      "comis_tool_calls_total",
      "comis_breaker_trips_total",
      "comis_offloads_total",
      "comis_sessions_total",
      "comis_sessions_degraded_total",
      "comis_audit_events_total",
      "comis_secret_access_total",
      "comis_injection_detected_total",
      "comis_recall_total",
      "comis_recall_zero_hits_total",
      "comis_build_info",
      "comis_up",
      "comis_prometheus_series",
    ];
    const missing = required.filter((n) => !promNames.has(n));
    expect(missing, `catalog missing required metric(s): ${missing.join(", ")}`).toEqual([]);
  });

  it("(b') instrument types match the design (cost/tokens/breaks = counter; spend = gauge; durations + read-ratio = histogram)", () => {
    const byName = new Map(METRIC_CATALOG.map((d) => [d.promName, d]));
    expect(byName.get("comis_cost_usd_total")?.type).toBe("counter");
    expect(byName.get("comis_tokens_total")?.type).toBe("counter");
    expect(byName.get("comis_cache_break_total")?.type).toBe("counter");
    expect(byName.get("comis_run_duration_seconds")?.type).toBe("histogram");
    expect(byName.get("comis_cache_read_ratio")?.type).toBe("histogram");
    // Spend gauges are observableGauge (read from the accumulator's getSnapshot
    // via meter.createObservableGauge — Pitfall 3 / 178-01 Task 3).
    expect(byName.get("comis_spend_usd")?.type).toBe("observableGauge");
    expect(byName.get("comis_spend_headroom_usd")?.type).toBe("observableGauge");
    // comis_up + comis_build_info are observableGauge (CR-01): a constant series
    // can only be emitted via a pull callback (wireMetaGauges), never a sync gauge.
    expect(byName.get("comis_up")?.type).toBe("observableGauge");
    expect(byName.get("comis_build_info")?.type).toBe("observableGauge");
  });

  it("(c) comis_build_info carries ONLY a `version` label — never `commit` (decision #5 / Pitfall 7)", () => {
    const buildInfo = METRIC_CATALOG.find((d) => d.promName === "comis_build_info");
    expect(buildInfo, "comis_build_info must be in the catalog").toBeDefined();
    expect(buildInfo?.labels).toEqual(["version"]);
    expect((buildInfo?.labels as readonly string[]).includes("commit")).toBe(false);
  });

  it("renders dotted OTel counter names to snake_case + _total via promNameFor", () => {
    // The catalog's promName IS the exporter's rendering of the dotted otelName;
    // promNameFor reproduces it for a given dotted name.
    expect(promNameFor("comis.cost.usd", "counter")).toBe("comis_cost_usd_total");
    expect(promNameFor("comis.tokens", "counter")).toBe("comis_tokens_total");
    // Gauges/histograms get no _total suffix.
    expect(promNameFor("comis.spend.headroom.usd", "observableGauge")).toBe(
      "comis_spend_headroom_usd",
    );
    // Every catalog entry's promName is internally consistent with promNameFor.
    for (const def of METRIC_CATALOG) {
      expect(
        promNameFor(def.otelName, def.type),
        `promName drift for ${def.otelName} (${def.type})`,
      ).toBe(def.promName);
    }
  });

  it("every entry has a non-empty description and a base unit", () => {
    for (const def of METRIC_CATALOG) {
      expect(def.description.length, `${def.promName} needs a description`).toBeGreaterThan(0);
      // unit may be "" for dimensionless gauges (build_info/up/series), but the
      // field must be present (string).
      expect(typeof def.unit).toBe("string");
    }
  });
});

// Compile-time guard: MetricDef labels are typed as the closed MetricLabel union.
// (If a future edit widened `labels` to `string[]`, this annotation would still
//  compile, so the runtime test above is the real guard — this just documents the
//  intended type relationship.)
const _typecheck: MetricDef["labels"] extends readonly MetricLabel[] ? true : never = true;
void _typecheck;
