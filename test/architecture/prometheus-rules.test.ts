// SPDX-License-Identifier: Apache-2.0
/**
 * Prometheus RULES validity + single-source-threshold guard (PROM-02; design §6 WS7).
 *
 * Two macOS-verifiable invariants over `prometheus/rules/*.yml`:
 *
 *   1. **Structure validity.** Every rule file parses as valid YAML and conforms
 *      to the Prometheus rule shape: a top-level `groups:` array, each group with
 *      a `name` + a `rules:` array, each rule being EITHER a recording rule
 *      (`record` + `expr`) OR an alerting rule (`alert` + `expr`, plus `labels`
 *      and `annotations`). This is the structural half of what `promtool check
 *      rules` validates.
 *
 *   2. **Single source of truth for the 80% spend line.** The
 *      `ComisSpendApproachingCeiling` alert threshold literal (0.8) EQUALS
 *      `ObservabilityConfigSchema.parse({}).spend.warnAtFraction` (the in-process
 *      kill-switch `spend_warning` line, WS3). The dashboard alert and the
 *      kill-switch MUST fire off the same number (threat T-178-12).
 *
 * **Operator/CI-deferred (NOT faked here):** `promtool check rules` — the
 * *semantic* PromQL lint (does the expr parse as PromQL? do the recorded series
 * round-trip?) — runs on Linux/CI; `promtool` is absent on the authoring host.
 * This test asserts YAML STRUCTURE + the threshold equality, never shelling out
 * to promtool. The expr↔metric mapping (every rule expr references an emitted
 * metric) is the bidirectional half of `grafana-dashboard-metrics.test.ts`.
 *
 * @module
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const RULES_DIR = resolve(REPO_ROOT, "prometheus/rules");

// `ObservabilityConfigSchema` lives on the `@comis/core/config` subpath barrel,
// which the architecture vitest alias (bare `@comis/core` → dist) does not route.
// Drive the COMPILED schema dist directly (the same pattern the drift guard uses
// for the extension catalog) so the threshold-equality assertion reads the actual
// runtime default, not an AST.
const SCHEMA_DIST_URL = pathToFileURL(
  resolve(REPO_ROOT, "packages/core/dist/config/schema-observability.js"),
).href;

let ObservabilityConfigSchema: { parse: (v: unknown) => { spend: { warnAtFraction: number } } };

beforeAll(async () => {
  const mod = (await import(SCHEMA_DIST_URL)) as {
    ObservabilityConfigSchema: typeof ObservabilityConfigSchema;
  };
  ObservabilityConfigSchema = mod.ObservabilityConfigSchema;
});

interface PromRule {
  readonly record?: string;
  readonly alert?: string;
  readonly expr?: unknown;
  readonly for?: unknown;
  readonly labels?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}
interface PromRuleGroup {
  readonly name?: unknown;
  readonly rules?: readonly PromRule[];
}
interface PromRuleFile {
  readonly groups?: readonly PromRuleGroup[];
}

function listRuleFiles(): string[] {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => resolve(RULES_DIR, f))
    .sort();
}

function parseRuleFile(file: string): PromRuleFile {
  return parseYaml(readFileSync(file, "utf-8")) as PromRuleFile;
}

describe("prometheus-rules — PROM-02 rule-file validity + single-source threshold", () => {
  const ruleFiles = listRuleFiles();

  it("sanity: found at least the recording + alert rule files", () => {
    // A glob/path miss must fail loudly rather than vacuously passing the
    // per-file assertions below over an empty set.
    expect(ruleFiles.length, `expected >= 2 rule files under prometheus/rules/, got ${ruleFiles.length}`).toBeGreaterThanOrEqual(2);
  });

  it("every rule file parses as valid YAML with a well-formed groups[].rules[] structure", () => {
    for (const file of ruleFiles) {
      const parsed = parseRuleFile(file);
      expect(parsed, `${file}: did not parse to an object`).toBeTypeOf("object");
      expect(Array.isArray(parsed.groups), `${file}: missing top-level groups[]`).toBe(true);
      expect((parsed.groups ?? []).length, `${file}: groups[] is empty`).toBeGreaterThan(0);

      for (const group of parsed.groups ?? []) {
        expect(typeof group.name, `${file}: a group is missing a string name`).toBe("string");
        expect(Array.isArray(group.rules), `${file}: group ${String(group.name)} missing rules[]`).toBe(true);
        expect((group.rules ?? []).length, `${file}: group ${String(group.name)} has no rules`).toBeGreaterThan(0);

        for (const rule of group.rules ?? []) {
          const isRecording = typeof rule.record === "string";
          const isAlerting = typeof rule.alert === "string";
          expect(
            isRecording !== isAlerting,
            `${file}: a rule must be EITHER a recording rule (record+expr) OR an alert (alert+expr), not both/neither`,
          ).toBe(true);
          expect(typeof rule.expr, `${file}: rule ${String(rule.record ?? rule.alert)} missing a string expr`).toBe("string");
          expect((rule.expr as string).trim().length, `${file}: rule ${String(rule.record ?? rule.alert)} has an empty expr`).toBeGreaterThan(0);

          if (isAlerting) {
            // Alerts MUST carry severity + an operator-actionable annotation set.
            expect(rule.labels, `${file}: alert ${String(rule.alert)} missing labels`).toBeTypeOf("object");
            expect(typeof rule.labels?.severity, `${file}: alert ${String(rule.alert)} missing labels.severity`).toBe("string");
            expect(rule.annotations, `${file}: alert ${String(rule.alert)} missing annotations`).toBeTypeOf("object");
            expect(typeof rule.annotations?.summary, `${file}: alert ${String(rule.alert)} missing annotations.summary`).toBe("string");
          }
        }
      }
    }
  });

  it("the ComisSpendApproachingCeiling alert threshold EQUALS warnAtFraction (single source, T-178-12)", () => {
    const warnAtFraction = ObservabilityConfigSchema.parse({}).spend.warnAtFraction;
    expect(warnAtFraction, "warnAtFraction default changed — keep the alert in lockstep").toBe(0.8);

    // Locate the alert across all rule files.
    let alertExpr: string | undefined;
    for (const file of listRuleFiles()) {
      for (const group of parseRuleFile(file).groups ?? []) {
        for (const rule of group.rules ?? []) {
          if (rule.alert === "ComisSpendApproachingCeiling") {
            alertExpr = rule.expr as string;
          }
        }
      }
    }
    expect(alertExpr, "ComisSpendApproachingCeiling alert not found in any rule file").toBeTypeOf("string");

    // Extract every numeric literal in the alert expr and assert the spend
    // fraction threshold (warnAtFraction) is present verbatim. The expr also
    // carries a tiny clamp_min epsilon (0.000001) to avoid divide-by-zero, so we
    // assert the threshold is AMONG the literals — not that it is the only one.
    const literals = (alertExpr ?? "").match(/\d+\.\d+|\d+/g)?.map(Number) ?? [];
    expect(
      literals,
      `the alert expr must contain the warnAtFraction threshold (${warnAtFraction}) verbatim so it tracks the config default; expr was: ${alertExpr}`,
    ).toContain(warnAtFraction);
  });
});
