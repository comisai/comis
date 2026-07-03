// SPDX-License-Identifier: Apache-2.0
/**
 * The emitted-metric-name SET — the truth set for the Grafana/Prometheus drift
 * guard.
 *
 * Derived ENTIRELY from the single {@link METRIC_CATALOG} so there is
 * NO second definition to drift: the dashboards' panel `expr`s and the Prometheus
 * recording/alert rule `expr`s are checked against {@link EMITTED_METRIC_NAMES},
 * which is exactly the set of Prometheus series the exporter can actually emit.
 * A renamed or removed catalog metric fails `grafana-dashboard-metrics.test.ts`
 * instead of silently blanking a panel or a rule.
 *
 * **Histogram expansion.** A catalog histogram's `promName` is the STEM (e.g.
 * `comis_run_duration_seconds`); at scrape time the exporter renders three child
 * series — `<stem>_bucket`, `<stem>_sum`, `<stem>_count` — plus the bare stem is
 * itself NOT a queryable series (PromQL references the children, e.g.
 * `histogram_quantile(0.95, sum(rate(comis_run_duration_seconds_bucket[5m])))`).
 * So for every `type: "histogram"` entry this set admits the stem AND its three
 * families. Counters already carry the rendered `_total` suffix in `promName`
 * (via {@link promNameFor}); gauges/observableGauges are their bare name.
 *
 * This is the ONE set both halves of the bidirectional drift guard consult:
 *   (a) every dashboard panel `targets[].expr` metric ∈ this set, and
 *   (b) every `prometheus/rules/*.yml` record/alert `expr` metric ∈ this set.
 *
 * @module
 */
import { METRIC_CATALOG } from "./metric-catalog.js";

/** The three child series a Prometheus histogram renders at scrape time. */
const HISTOGRAM_SUFFIXES = ["_bucket", "_sum", "_count"] as const;

/**
 * Build the emitted-metric-name set from {@link METRIC_CATALOG}, expanding each
 * histogram stem to admit its `_bucket`/`_sum`/`_count` families. Deterministic —
 * a pure function of the frozen catalog.
 */
function buildEmittedMetricNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const def of METRIC_CATALOG) {
    names.add(def.promName);
    if (def.type === "histogram") {
      for (const suffix of HISTOGRAM_SUFFIXES) {
        names.add(`${def.promName}${suffix}`);
      }
    }
  }
  return names;
}

/**
 * The set of Prometheus metric names the exporter actually emits — counters with
 * their `_total` suffix, gauges/observableGauges by name, and every histogram
 * stem PLUS its `_bucket`/`_sum`/`_count` children. The drift guard asserts every
 * dashboard panel `expr` and every recording/alert rule `expr` references ONLY a
 * name in this set.
 */
export const EMITTED_METRIC_NAMES: ReadonlySet<string> = Object.freeze(
  buildEmittedMetricNames(),
) as ReadonlySet<string>;

/**
 * Sorted array view of {@link EMITTED_METRIC_NAMES} — convenient for failure
 * messages and the drift-guard's "did you mean" suggestions.
 */
export const EMITTED_METRIC_NAMES_SORTED: readonly string[] = Object.freeze(
  [...EMITTED_METRIC_NAMES].sort(),
);
