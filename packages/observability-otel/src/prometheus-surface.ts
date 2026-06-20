// SPDX-License-Identifier: Apache-2.0
/**
 * PROM-01 — the Prometheus pull-surface guards: the `comis_prometheus_series`
 * self-cardinality gauge + the `cardinalityCap` ENFORCEMENT (the label-explosion
 * DoS guard, T-178-07).
 *
 * The OTel `PrometheusExporter` itself (the loopback `/metrics` listener) is
 * constructed in `otel-exporter.ts` as one of the `MeterProvider` readers. This
 * module owns the cardinality DISCIPLINE that rides alongside it: a tap on the
 * same bus events records the distinct CONTENT-FREE series keys the catalog
 * instruments produce, an `observableGauge` reports that count as
 * `comis_prometheus_series` on every scrape, and a breach of `cardinalityCap`
 * emits a single WARN with a `hint` (re-armed when the count drops back below).
 *
 * The cap ACTUALLY BOUNDS the estimate (MD-02): once the distinct-key set
 * reaches `cardinalityCap`, NEW distinct keys are no longer admitted — the excess
 * collapses into a single `"_overflow"` bucket — so the tracker's own memory and
 * the reported series count stay bounded at `cardinalityCap + 1` regardless of
 * how many distinct labels arrive. (A WARN alone leaves the unbounded Set growing
 * — the very DoS the cap exists to prevent.)
 *
 * The series-key estimate is content-free by construction — it is built from the
 * SAME low-cardinality labels the instruments use (provider/model/reason/scope/…),
 * NEVER a session/trace/user id. An exploding count therefore signals a label
 * mistake (or genuine fan-out), exactly what the cap is meant to catch.
 *
 * @module
 */
import type { Meter } from "@opentelemetry/api";
import type { TypedEventBus, ComisLogger } from "@comis/core";

/** Dependencies for {@link wireSeriesCardinality}. */
export interface WireSeriesCardinalityDeps {
  /** The meter the self-gauge registers on (the same single MeterProvider). */
  readonly meter: Meter;
  /** The bus whose events drive the distinct-series estimate. */
  readonly eventBus: TypedEventBus;
  /** Max active series before a WARN-with-hint fires. */
  readonly cardinalityCap: number;
  /** Object-first logger for the breach WARN (optional). */
  readonly logger?: ComisLogger;
}

/**
 * Tap the catalog source events to estimate distinct content-free series, expose
 * the count as `comis_prometheus_series`, and WARN once on a `cardinalityCap`
 * breach (re-armed on recovery). Returns nothing — the caller owns the meter.
 */
export function wireSeriesCardinality(deps: WireSeriesCardinalityDeps): void {
  const { meter, eventBus, cardinalityCap, logger } = deps;

  // The distinct content-free series keys seen so far (provider|model|reason|…).
  // Bounded by the label cardinality, NEVER by ids — this is the guard, not a leak.
  const seriesKeys = new Set<string>();
  let breachWarned = false;
  // The sentinel bucket every key past the cap collapses into (MD-02). Counts as
  // ONE series, so the set size is hard-bounded at cardinalityCap + 1.
  const OVERFLOW_KEY = "_overflow";

  const track = (instrument: string, labels: readonly string[]): void => {
    const key = `${instrument}{${labels.join("|")}}`;
    // Already tracked (a re-seen series) — a no-op add either way.
    if (seriesKeys.has(key)) return;
    // MD-02: ENFORCE the cap. Once the distinct-key set is full, do NOT admit a
    // new key — route it to the single "_overflow" bucket so the set (and thus
    // the tracker's memory + the reported count) cannot grow without bound. A
    // WARN alone would leave the Set growing, which is the DoS the cap prevents.
    if (seriesKeys.size >= cardinalityCap) {
      seriesKeys.add(OVERFLOW_KEY);
      return;
    }
    seriesKeys.add(key);
  };

  eventBus.on("observability:token_usage", (p) => {
    track("comis.cost.usd", [p.agentId, p.provider, p.model, "interactive"]);
    track("comis.tokens", [p.agentId, p.provider, p.model, "interactive", "prompt"]);
    track("comis.tokens", [p.agentId, p.provider, p.model, "interactive", "completion"]);
    track("comis.run.duration.seconds", [p.agentId, "interactive"]);
  });
  eventBus.on("observability:cache_break", (p) => {
    track("comis.cache.break", [p.reason, "agent"]);
  });
  eventBus.on("observability:spend_warning", (p) => track("comis.spend.warning", [p.scope]));
  eventBus.on("observability:spend_exceeded", (p) => track("comis.spend.exceeded", [p.scope]));
  eventBus.on("observability:spend_unpriceable", () => track("comis.spend.unpriceable", []));
  eventBus.on("security:injection_detected", () => track("comis.injection_detected", ["denied"]));

  const seriesGauge = meter.createObservableGauge("comis.prometheus_series", {
    description: "Self-reported active series count (the cardinalityCap guard).",
    unit: "",
  });
  seriesGauge.addCallback((result) => {
    const count = seriesKeys.size;
    result.observe(count);
    if (count > cardinalityCap) {
      if (!breachWarned) {
        breachWarned = true;
        logger?.warn(
          {
            hint: `Prometheus series count (${count}) exceeded cardinalityCap (${cardinalityCap}); a label may be high-cardinality. Review the catalog label set or raise observability.prometheus.cardinalityCap.`,
            seriesCount: count,
            cardinalityCap,
          },
          "prometheus-cardinality-cap-exceeded",
        );
      }
    } else {
      breachWarned = false; // re-arm once back under the cap
    }
  });
}
