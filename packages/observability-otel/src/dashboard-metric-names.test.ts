// SPDX-License-Identifier: Apache-2.0
/**
 * Unit pins for the emitted-metric-name set (the drift-guard truth set).
 *
 * The set is DERIVED from the single METRIC_CATALOG (no second definition), with
 * histogram stems expanded to their `_bucket`/`_sum`/`_count` families. These
 * tests pin that derivation so a future catalog change reshapes the set
 * predictably and the Grafana/Prometheus drift guard stays anchored to the
 * source of truth.
 *
 * @module
 */
import { describe, it, expect } from "vitest";

import { EMITTED_METRIC_NAMES, EMITTED_METRIC_NAMES_SORTED } from "./dashboard-metric-names.js";
import { METRIC_CATALOG } from "./metric-catalog.js";

const HISTOGRAM_SUFFIXES = ["_bucket", "_sum", "_count"] as const;

describe("dashboard-metric-names — the drift-guard emitted set (derived from the catalog)", () => {
  it("is a non-empty frozen set", () => {
    expect(EMITTED_METRIC_NAMES).toBeInstanceOf(Set);
    expect(EMITTED_METRIC_NAMES.size).toBeGreaterThan(0);
    expect(Object.isFrozen(EMITTED_METRIC_NAMES)).toBe(true);
  });

  it("contains every catalog promName verbatim (counters carry their _total)", () => {
    for (const def of METRIC_CATALOG) {
      expect(EMITTED_METRIC_NAMES.has(def.promName), `missing catalog metric ${def.promName}`).toBe(true);
    }
    // Spot-check a counter renders with _total and is present.
    expect(EMITTED_METRIC_NAMES.has("comis_cost_usd_total")).toBe(true);
    // Gauges are present by bare name.
    expect(EMITTED_METRIC_NAMES.has("comis_spend_headroom_usd")).toBe(true);
    expect(EMITTED_METRIC_NAMES.has("comis_up")).toBe(true);
  });

  it("expands every histogram stem to its _bucket/_sum/_count families", () => {
    const histograms = METRIC_CATALOG.filter((d) => d.type === "histogram");
    expect(histograms.length, "expected at least one histogram in the catalog").toBeGreaterThan(0);
    for (const hist of histograms) {
      // The stem itself is admitted...
      expect(EMITTED_METRIC_NAMES.has(hist.promName), `missing histogram stem ${hist.promName}`).toBe(true);
      // ...plus each child series.
      for (const suffix of HISTOGRAM_SUFFIXES) {
        const child = `${hist.promName}${suffix}`;
        expect(EMITTED_METRIC_NAMES.has(child), `missing histogram child ${child}`).toBe(true);
      }
    }
    // The exact name the p95 panels reference.
    expect(EMITTED_METRIC_NAMES.has("comis_run_duration_seconds_bucket")).toBe(true);
    expect(EMITTED_METRIC_NAMES.has("comis_cache_read_ratio_count")).toBe(true);
  });

  it("does NOT expand non-histogram metrics into _bucket/_sum/_count children", () => {
    // A counter must not have phantom histogram children in the set.
    expect(EMITTED_METRIC_NAMES.has("comis_cost_usd_total_bucket")).toBe(false);
    expect(EMITTED_METRIC_NAMES.has("comis_spend_usd_sum")).toBe(false);
  });

  it("size equals catalog count + 3 per histogram", () => {
    const histogramCount = METRIC_CATALOG.filter((d) => d.type === "histogram").length;
    expect(EMITTED_METRIC_NAMES.size).toBe(METRIC_CATALOG.length + histogramCount * HISTOGRAM_SUFFIXES.length);
  });

  it("EMITTED_METRIC_NAMES_SORTED is the sorted array view of the set", () => {
    expect(Object.isFrozen(EMITTED_METRIC_NAMES_SORTED)).toBe(true);
    expect(EMITTED_METRIC_NAMES_SORTED.length).toBe(EMITTED_METRIC_NAMES.size);
    expect([...EMITTED_METRIC_NAMES_SORTED]).toEqual([...EMITTED_METRIC_NAMES].sort());
    // Every sorted entry is in the set and vice-versa.
    for (const name of EMITTED_METRIC_NAMES_SORTED) {
      expect(EMITTED_METRIC_NAMES.has(name)).toBe(true);
    }
  });
});
