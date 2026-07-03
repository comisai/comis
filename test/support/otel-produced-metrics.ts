// SPDX-License-Identifier: Apache-2.0
/**
 * The PRODUCED-metric truth set for the OTel/Prometheus arch guards.
 *
 * The single source of "is this metric actually emitted?" — shared by the
 * wiring-completeness guard (`otel-metric-catalog-wired.test.ts`) and the
 * expr↔metric drift guard (`grafana-dashboard-metrics.test.ts`). A metric has a
 * PRODUCER when it is:
 *   (a) incremented via `addCounter(instruments, "<otelName>", …)` /
 *       `recordHistogram(instruments, "<otelName>", …)` in metric-mapping.ts, OR
 *   (b) registered as a gauge via `createObservableGauge("<otelName>", …)` /
 *       `createGauge("<otelName>", …)` in metric-mapping.ts / prometheus-surface.ts /
 *       otel-exporter.ts.
 *
 * The drift guard checks expr metrics against the PRODUCED set (catalog ∩
 * producers, histograms expanded), NOT the ENTIRE catalog
 * (`EMITTED_METRIC_NAMES`): a panel/rule on a CATALOGUED-BUT-UNPRODUCED metric
 * must FAIL rather than pass CI while rendering "No data" in production.
 *
 * Source-grep with NO allowlist (the audio-wiring-guard / cache-trace-stages
 * mold). A refactor that drops a producer reshapes this set, turning the
 * dependent guards red.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const OTEL_SRC = resolve(REPO_ROOT, "packages/observability-otel/src");

/** The producer source files scanned for catalog-metric increments / gauges. */
export const PRODUCER_FILES: ReadonlyArray<string> = [
  resolve(OTEL_SRC, "metric-mapping.ts"),
  resolve(OTEL_SRC, "prometheus-surface.ts"),
  resolve(OTEL_SRC, "otel-exporter.ts"),
] as const;

/** The three child series a Prometheus histogram renders at scrape time. */
const HISTOGRAM_SUFFIXES = ["_bucket", "_sum", "_count"] as const;

/** Strip block + line comments so a metric named only in a comment is NOT a producer. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

/**
 * Collect the set of catalog `otelName`s that have a runtime PRODUCER across the
 * producer files (dotted otelName form, e.g. `comis.cost.usd`).
 */
export function collectProducedOtelNames(): Set<string> {
  const produced = new Set<string>();
  const incRe = /(?:addCounter|recordHistogram)\(\s*instruments\s*,\s*"(comis\.[a-z0-9_.]+)"/g;
  const gaugeRe = /create(?:Observable)?Gauge\(\s*"(comis\.[a-z0-9_.]+)"/g;
  for (const file of PRODUCER_FILES) {
    let src: string;
    try {
      src = stripComments(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    for (const m of src.matchAll(incRe)) produced.add(m[1] ?? "");
    for (const m of src.matchAll(gaugeRe)) produced.add(m[1] ?? "");
  }
  produced.delete("");
  return produced;
}

/** A catalog entry shape (matches MetricDef's `otelName`/`promName`/`type`). */
export interface CatalogDefLike {
  readonly otelName: string;
  readonly promName: string;
  readonly type: string;
}

/**
 * The set of PRODUCED Prometheus metric names — the catalog entries that have a
 * producer, rendered to their `promName`, with each histogram stem expanded to
 * its `_bucket`/`_sum`/`_count` children (the queryable series the panels use).
 *
 * This is the PRODUCED truth set: the drift guard checks expr metrics against THIS
 * (not the full `EMITTED_METRIC_NAMES`), so a panel/rule on a catalogued-but-
 * unproduced metric fails.
 */
export function buildProducedPromNames(catalog: readonly CatalogDefLike[]): Set<string> {
  const producedOtel = collectProducedOtelNames();
  const names = new Set<string>();
  for (const def of catalog) {
    if (!producedOtel.has(def.otelName)) continue;
    names.add(def.promName);
    if (def.type === "histogram") {
      for (const suffix of HISTOGRAM_SUFFIXES) names.add(`${def.promName}${suffix}`);
    }
  }
  return names;
}
