// SPDX-License-Identifier: Apache-2.0
/**
 * The expr↔metric DRIFT GUARD.
 *
 * The honesty ledger binding the SHIPPED dashboards-as-code + Prometheus rules to
 * the metrics the exporter can actually emit. It is BIDIRECTIONAL:
 *
 *   (a) **Dashboards** — parse every `grafana/dashboards/*.json`, extract every
 *       panel `targets[].expr`, tokenize the PromQL for `comis_*` metric names,
 *       and assert each is in the exporter's PRODUCED-metric set (the catalog
 *       entries that actually have a runtime producer, histograms expanded to
 *       `_bucket`/`_sum`/`_count`). A panel referencing a renamed/removed/
 *       catalogued-but-UNPRODUCED metric fails CI instead of silently blanking.
 *
 *   (b) **Rules** — parse every `prometheus/rules/*.yml`, extract every
 *       recording/alert `expr`'s `comis_*` metric names, and assert each is
 *       PRODUCED too (catches rule drift). Recorded-series names
 *       (`comis:...` with a colon) are the rules' OWN outputs, not exporter
 *       metrics, and are excluded from the produced-set check.
 *
 * **The corrected invariant.** This guard formerly checked expr metrics
 * against `EMITTED_METRIC_NAMES` — the ENTIRE catalog. That certified a panel/
 * rule on a catalogued-but-unproduced metric GREEN while it rendered "No data"
 * in production (the blind spot: 16 of 30 catalog metrics had no producer,
 * yet `ComisAuditSinkFailure` and friends "passed"). It now checks against the
 * PRODUCED set (catalog ∩ producers, via `buildProducedPromNames`), so a panel/
 * rule on an unproduced metric FAILS — the property the docstring promises.
 *
 * **Data-link presence** — every dashboard panel that has targets MUST carry a
 * data link (`links[]`) whose URL templates a `comis explain` reference (the
 * chart→incident drill-down). Because `PROMETHEUS_EXEMPLARS_SUPPORTED
 * === false`, the `/metrics`-pull surface renders NO OpenMetrics exemplars,
 * so the link keys on the `comis.trace_id` span attribute (a template variable),
 * documented honestly in the doc + the dashboard description.
 *
 * **Sanity floors** — assert ≥5 dashboards parsed, ≥1 panel with targets found,
 * and ≥1 rule file parsed, so a glob/path miss fails loudly rather than vacuously
 * passing over an empty set (the mold's "walker found ≥1" floor).
 *
 * Fully macOS-verifiable: pure file parsing + a static set derived from the
 * compiled catalog. The LIVE exemplar→`comis explain` click-through is honestly
 * operator-deferred (needs a live Grafana + daemon). Walk-extract-assert-against-
 * code-set mold: `test/architecture/trajectory-event-types-known.test.ts`.
 *
 * @module
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { formatViolations } from "../support/architecture-helpers.js";
import { buildProducedPromNames, type CatalogDefLike } from "../support/otel-produced-metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const DASHBOARDS_DIR = resolve(REPO_ROOT, "grafana/dashboards");
const RULES_DIR = resolve(REPO_ROOT, "prometheus/rules");

// The emitted-metric truth set comes from the COMPILED extension dist (the single
// METRIC_CATALOG → EMITTED_METRIC_NAMES, histograms expanded). Driving the real
// dist (not a hand-copied list) is the same pattern as
// audit-metadata-content-free.test.ts — a renamed catalog metric reshapes this
// set, so the guard tracks the source of truth. The extension is built by the
// per-task verify (`pnpm --filter @comis/observability-otel build`).
const EXTENSION_DIST_URL = pathToFileURL(
  resolve(REPO_ROOT, "packages/observability-otel/dist/dashboard-metric-names.js"),
).href;
const CATALOG_DIST_URL = pathToFileURL(
  resolve(REPO_ROOT, "packages/observability-otel/dist/metric-catalog.js"),
).href;

let EMITTED: ReadonlySet<string>;
// PRODUCED = catalog ∩ producers (histograms expanded) — the truth set the
// expr checks consult (NOT the full EMITTED set). A panel/rule on a catalogued-
// but-unproduced metric is in EMITTED but NOT in PRODUCED → it fails.
let PRODUCED: ReadonlySet<string>;
let PRODUCED_SORTED: readonly string[];

beforeAll(async () => {
  const namesMod = (await import(EXTENSION_DIST_URL)) as {
    EMITTED_METRIC_NAMES: ReadonlySet<string>;
    EMITTED_METRIC_NAMES_SORTED: readonly string[];
  };
  EMITTED = namesMod.EMITTED_METRIC_NAMES;
  const catalogMod = (await import(CATALOG_DIST_URL)) as { METRIC_CATALOG: readonly CatalogDefLike[] };
  PRODUCED = buildProducedPromNames(catalogMod.METRIC_CATALOG);
  PRODUCED_SORTED = [...PRODUCED].sort();
});

// ── Artifact walkers ────────────────────────────────────────────────────────

interface DashboardPanel {
  readonly title?: string;
  readonly type?: string;
  readonly targets?: ReadonlyArray<{ expr?: unknown }>;
  readonly links?: ReadonlyArray<{ url?: unknown; title?: unknown }>;
  readonly fieldConfig?: {
    defaults?: { links?: ReadonlyArray<{ url?: unknown }> };
  };
  readonly panels?: readonly DashboardPanel[]; // rows nest panels
}
interface Dashboard {
  readonly uid?: unknown;
  readonly title?: unknown;
  readonly templating?: { list?: ReadonlyArray<{ name?: unknown }> };
  readonly panels?: readonly DashboardPanel[];
}

function safeReaddir(dir: string): string[] {
  // A MISSING artifact dir must surface as a loud, explicit sanity-floor failure
  // ("expected 5 dashboards, got 0") — not a raw ENOENT throw. Return [] so the
  // floor assertions own the failure message (the mold's fail-loud-on-glob-miss).
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function listJsonDashboards(): string[] {
  return safeReaddir(DASHBOARDS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => resolve(DASHBOARDS_DIR, f))
    .sort();
}

function listRuleFiles(): string[] {
  return safeReaddir(RULES_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => resolve(RULES_DIR, f))
    .sort();
}

/** Flatten a dashboard's panels (rows nest child panels under `panels[]`). */
function flattenPanels(panels: readonly DashboardPanel[] | undefined): DashboardPanel[] {
  const out: DashboardPanel[] = [];
  for (const p of panels ?? []) {
    out.push(p);
    if (p.panels) out.push(...flattenPanels(p.panels));
  }
  return out;
}

/**
 * Tokenize a PromQL expr for the `comis_*` metric names it references.
 *
 * - Matches the Prometheus identifier grammar restricted to the `comis_`
 *   namespace: `comis_[a-z0-9_]+`. This deliberately MISSES recorded-series
 *   names (which use a `:` separator, e.g. `comis:cost_usd:rate1h`) — those are
 *   the rules' OWN outputs, not exporter metrics, so they must not be checked
 *   against the emitted set.
 * - Strips out label-VALUE string contents (`{state="unknown"}`) first so a
 *   value that happens to contain `comis_` text can't be mistaken for a metric.
 */
function extractComisMetricNames(expr: string): string[] {
  // Remove the contents of double/single-quoted strings (label values, etc.).
  const withoutStrings = expr.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  const matches = withoutStrings.match(/\bcomis_[a-z0-9_]+\b/g) ?? [];
  return [...new Set(matches)];
}

interface MetricRef {
  readonly file: string;
  readonly metric: string;
  readonly context: string;
}

function repoRel(abs: string): string {
  return abs.startsWith(REPO_ROOT) ? abs.slice(REPO_ROOT.length + 1) : abs;
}

describe("grafana-dashboard-metrics — expr↔metric drift guard (bidirectional)", () => {
  // ── Sanity floors (fail loud on a glob/path miss) ──────────────────────────

  it("sanity: the emitted + PRODUCED metric sets loaded from the compiled catalog and are non-trivial", () => {
    expect(EMITTED, "EMITTED_METRIC_NAMES not loaded from the extension dist — was the extension built?").toBeTypeOf("object");
    // 29 catalog entries (cache.break.cost.usd is not catalogued); 2 histograms
    // each add 3 child series → 35 names.
    expect(EMITTED.size, `expected the catalog-derived set to be substantial, got ${EMITTED.size}`).toBeGreaterThanOrEqual(29);
    // Spot-check a histogram family expanded (the _bucket child the p95 panel uses).
    expect(EMITTED.has("comis_run_duration_seconds_bucket")).toBe(true);
    expect(EMITTED.has("comis_cost_usd_total")).toBe(true);
    // The PRODUCED set (catalog ∩ producers) loaded and is non-trivial —
    // every catalog metric is produced, so PRODUCED == EMITTED in
    // size (the floor guards against a producer-grep/path miss vacuously
    // shrinking it, which would make the drift checks pass over an empty set).
    expect(PRODUCED, "PRODUCED set not built — producer grep / catalog dist miss?").toBeTypeOf("object");
    expect(PRODUCED.size, `expected the produced set to be substantial, got ${PRODUCED.size}`).toBeGreaterThanOrEqual(29);
    expect(PRODUCED.has("comis_audit_events_total"), "the ComisAuditSinkFailure alert source must be PRODUCED").toBe(true);
    expect(PRODUCED.has("comis_run_duration_seconds_bucket")).toBe(true);
  });

  it("sanity: found the 5 dashboards and at least one panel with targets", () => {
    const dashboards = listJsonDashboards();
    expect(dashboards.length, `expected 5 dashboards under grafana/dashboards/, got ${dashboards.length}`).toBe(5);
    let panelsWithTargets = 0;
    for (const file of dashboards) {
      const dash = JSON.parse(readFileSync(file, "utf-8")) as Dashboard;
      for (const panel of flattenPanels(dash.panels)) {
        if ((panel.targets ?? []).some((t) => typeof t.expr === "string")) panelsWithTargets++;
      }
    }
    expect(panelsWithTargets, "no panel with a string targets[].expr found — the walker or the dashboards are wrong").toBeGreaterThan(0);
  });

  it("sanity: found at least the recording + alert rule files", () => {
    expect(listRuleFiles().length, "expected >= 2 prometheus/rules/*.yml files").toBeGreaterThanOrEqual(2);
  });

  // ── (a) Dashboard half: every panel expr → an emitted metric ───────────────

  it("every dashboard panel expr references a metric the exporter emits", () => {
    const refs: MetricRef[] = [];
    for (const file of listJsonDashboards()) {
      const dash = JSON.parse(readFileSync(file, "utf-8")) as Dashboard;
      for (const panel of flattenPanels(dash.panels)) {
        for (const target of panel.targets ?? []) {
          if (typeof target.expr !== "string") continue;
          for (const metric of extractComisMetricNames(target.expr)) {
            refs.push({ file: repoRel(file), metric, context: `panel "${panel.title ?? "?"}": ${target.expr}` });
          }
        }
      }
    }

    const violations = refs.filter((r) => !PRODUCED.has(r.metric));
    expect(
      violations,
      formatViolations({
        description:
          "Grafana drift guard (a/HG-01): every dashboard panel targets[].expr must reference a metric the Comis OTel exporter actually PRODUCES (a catalog entry with a runtime producer — an addCounter/recordHistogram increment or a registered gauge — histograms expanded). A panel referencing a renamed/removed/catalogued-but-UNPRODUCED metric silently blanks in production (T-178-10 / CR-01).",
        violations: violations.map((v) => ({
          file: v.file,
          line: 0,
          snippet: `references "${v.metric}" — NOT in the PRODUCED-metric set\n    ${v.context}`,
        })),
        suggestedFix: `Correct the panel expr to reference a PRODUCED metric, OR wire a producer for it in metric-mapping.ts (subscribe its bus event + increment). Do NOT just widen the catalog — a catalogued-but-unproduced metric is the CR-01 bug. Produced names: ${PRODUCED_SORTED.join(", ")}`,
        designRef: "every dashboard panel expr references a metric with a runtime producer; see metric-catalog.ts + metric-mapping.ts",
      }),
    ).toEqual([]);
  });

  // ── (b) Rule half: every record/alert expr → an emitted metric ─────────────

  it("every prometheus rule expr references a metric the exporter emits (rule drift)", () => {
    const refs: MetricRef[] = [];
    for (const file of listRuleFiles()) {
      const parsed = parseYaml(readFileSync(file, "utf-8")) as {
        groups?: ReadonlyArray<{ rules?: ReadonlyArray<{ record?: string; alert?: string; expr?: unknown }> }>;
      };
      for (const group of parsed.groups ?? []) {
        for (const rule of group.rules ?? []) {
          if (typeof rule.expr !== "string") continue;
          const label = rule.record ?? rule.alert ?? "?";
          for (const metric of extractComisMetricNames(rule.expr)) {
            refs.push({ file: repoRel(file), metric, context: `rule "${label}": ${rule.expr.replace(/\s+/g, " ").trim()}` });
          }
        }
      }
    }

    const violations = refs.filter((r) => !PRODUCED.has(r.metric));
    expect(
      violations,
      formatViolations({
        description:
          "Drift guard (b/HG-01): every prometheus/rules/*.yml recording/alert expr must reference a metric the exporter actually PRODUCES (a catalog entry with a runtime producer). A rule on a catalogued-but-unproduced metric never fires (the dead-alert class — e.g. ComisAuditSinkFailure before CR-01). Recorded series (comis:... with a colon) are the rules' OWN outputs and are correctly excluded by the comis_ tokenizer.",
        violations: violations.map((v) => ({
          file: v.file,
          line: 0,
          snippet: `references "${v.metric}" — NOT in the PRODUCED-metric set\n    ${v.context}`,
        })),
        suggestedFix: `Correct the rule expr to reference a PRODUCED metric, OR wire a producer for it in metric-mapping.ts. Produced names: ${PRODUCED_SORTED.join(", ")}`,
        designRef: "every recording/alert rule expr references a produced metric",
      }),
    ).toEqual([]);
  });

  // ── Dashboard structure + data link ────────────────────────────────────────

  it("each dashboard is valid JSON with uid, title, and the required template vars", () => {
    const REQUIRED_VARS = ["datasource", "tenant", "agent", "provider", "model"];
    for (const file of listJsonDashboards()) {
      const dash = JSON.parse(readFileSync(file, "utf-8")) as Dashboard;
      expect(typeof dash.uid, `${basename(file)}: missing string uid`).toBe("string");
      expect(typeof dash.title, `${basename(file)}: missing string title`).toBe("string");
      const varNames = new Set((dash.templating?.list ?? []).map((v) => String(v.name)));
      for (const required of REQUIRED_VARS) {
        expect(varNames.has(required), `${basename(file)}: missing template var "${required}"`).toBe(true);
      }
    }
  });

  it("every panel with targets carries a data link to comis explain (trace_id-keyed)", () => {
    // Per PROMETHEUS_EXEMPLARS_SUPPORTED===false: the /metrics pull
    // surface has no OpenMetrics exemplars, so the drill-down link keys on the
    // comis.trace_id span attribute (a template variable) → a `comis explain`
    // reference. We assert the link's PRESENCE + shape (it mentions "explain"); the
    // LIVE click-through is operator-deferred.
    const offenders: MetricRef[] = [];
    for (const file of listJsonDashboards()) {
      const dash = JSON.parse(readFileSync(file, "utf-8")) as Dashboard;
      for (const panel of flattenPanels(dash.panels)) {
        const hasTargets = (panel.targets ?? []).some((t) => typeof t.expr === "string");
        if (!hasTargets) continue;
        const panelLinks = panel.links ?? [];
        const fieldLinks = panel.fieldConfig?.defaults?.links ?? [];
        const allLinks = [...panelLinks, ...fieldLinks];
        const hasExplainLink = allLinks.some(
          (l) => typeof l.url === "string" && /explain/i.test(l.url),
        );
        if (!hasExplainLink) {
          offenders.push({ file: repoRel(file), metric: panel.title ?? "?", context: "panel has targets but no comis-explain data link" });
        }
      }
    }
    expect(
      offenders,
      formatViolations({
        description:
          "E7 drill-down: every dashboard panel with targets must carry a data link (panel links[] or fieldConfig.defaults.links[]) whose url references `comis explain` — the chart→incident pivot, keyed on the comis.trace_id span attribute (PROMETHEUS_EXEMPLARS_SUPPORTED===false → no /metrics exemplars; the link uses a template variable).",
        violations: offenders.map((v) => ({ file: v.file, line: 0, snippet: `panel "${v.metric}": ${v.context}` })),
        suggestedFix: "Add a links[] entry to the panel (or fieldConfig.defaults.links) with a url like \"/observe/explain?ref=${__data.fields.comis_trace_id}\" or a comis explain CLI reference.",
        designRef: "every panel with targets carries a chart→explain drill-down link",
      }),
    ).toEqual([]);
  });
});
