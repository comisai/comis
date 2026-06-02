// SPDX-License-Identifier: Apache-2.0
/**
 * Env-gated REGRESSION-GATE harness (Phase 116, GATE-01) — the per-release
 * benchmark regression gate, wired for the SCHEDULED CI job
 * (`.github/workflows/bench-regression.yml`) via the `gate` mode of
 * `scripts/bench-memory.sh`.
 *
 * THE TWO MODES (the honesty split — mirrors head-to-head.bench.test.ts):
 *
 *   1. KEYLESS MECHANISM PROOF (always, $0, deterministic): read the COMMITTED J1
 *      baseline (`benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-a.json`,
 *      judge A = gpt-4o, the LongMemEval reference judge) and prove
 *      {@link compareToBaseline} works end-to-end:
 *        - an IDENTICAL current run (the baseline compared to itself) → NO
 *          regression (every deltaPts 0),
 *        - a SYNTHETIC regressed current (one category dropped by a large,
 *          statistically-significant margin) → the gate DETECTS the regression.
 *      This proves the MECHANISM that the costed scheduled run relies on, at $0.
 *      It writes NO success-shaped "the release passed the regression gate" text —
 *      a keyless run has no real current manifest, so it can only prove the
 *      machine, never a pass (the §gate honesty rule, WR-01).
 *
 *   2. COSTED REAL GATE (only when COMIS_GATE_CURRENT_MANIFEST points at a real
 *      run's manifest): read that manifest's per-category accuracy, compare it to
 *      the committed baseline, and FAIL THE JOB (a failing `expect`, → non-zero
 *      exit) on a REAL category regression. This is the operator-costed pass: the
 *      scheduled CI job, with secrets in scripts/bench-memory.env, runs the costed
 *      benchmark, points this env at the fresh manifest, and the gate red-lights
 *      the run on a regression vs the committed baseline.
 *
 * THE BASELINE IS A COMMITTED ARTIFACT, NOT A SECRET: both the baseline manifest
 * and (when present) the current manifest are STRUCTURALLY secret-free by
 * construction (qa-report.ts rebuilds them field-by-field; a grep sweep gates the
 * commit). This harness reads only their numeric per-category accuracy counts; it
 * never reads, logs, or echoes any credential, and {@link compareToBaseline}
 * additionally drops any off-contract non-numeric (secret-shaped) field.
 *
 * ARCHITECTURE CUT (the single escape hatch): this *.bench.test.ts MAY import
 * @comis/memory etc. — the agent->memory cut excludes the `.test.ts` suffix
 * (source-rules.test.ts `excludeFileSuffixes: [".test.ts"]`). Here it imports ONLY
 * the in-package pure module + types, so no cross-package edge is even exercised.
 *
 * SECURITY: reads only committed, secret-free manifests; the operator current
 * manifest path is `resolve`d and read read-only; the verdict carries pure
 * numbers + booleans + a category-name summary; the secret-shape assertion proves
 * no credential substring is ever in the comparison output.
 *
 * @module
 */

import { describe, it, expect, beforeAll } from "vitest";
import { compareToBaseline, type RegressionVerdict } from "./regression-gate.js";
import type { CategoryAccuracy } from "./qa-accuracy.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// ── ENV GATES (read ONLY at the .test.ts boundary; the globals rule scopes to src/**) ──
const COMIS_BENCH = process.env.COMIS_BENCH;
/**
 * The OPTIONAL path to a CURRENT run's manifest (the operator-costed pass). When
 * set, the gate reads its per-category accuracy and FAILS on a real regression vs
 * the committed baseline. Unset → only the keyless mechanism proof runs. This is a
 * committed-results path pointer, NEVER a secret.
 */
const COMIS_GATE_CURRENT_MANIFEST = process.env.COMIS_GATE_CURRENT_MANIFEST;

/** The committed J1 baseline manifest, resolved relative to this harness file. */
const BASELINE_REL = "../../../../../benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-a.json";

/**
 * The minimal shape we read out of a (secret-free) qa-report manifest: the
 * per-category accuracy block under `results`. We parse defensively — the JSON is
 * untrusted file content, and `compareToBaseline` further drops any non-numeric
 * (secret-shaped) field — so this only needs the `results.perCategory` map.
 */
interface QaReportManifestShape {
  results?: { perCategory?: Record<string, CategoryAccuracy> };
}

/** Read + JSON-parse a manifest's `results.perCategory` map (empty map when absent). */
function readPerCategory(path: string): Record<string, CategoryAccuracy> {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as QaReportManifestShape;
  return parsed.results?.perCategory ?? {};
}

describe.skipIf(!COMIS_BENCH)("regression gate vs the committed J1 baseline (GATE-01, keyless-gated)", () => {
  let baseline: Record<string, CategoryAccuracy> = {};

  beforeAll(() => {
    baseline = readPerCategory(fileURLToPath(new URL(BASELINE_REL, import.meta.url)));
  });

  it("MECHANISM: the committed baseline compared to ITSELF shows no regression (every deltaPts 0)", () => {
    // The committed baseline is a real, non-empty per-category map.
    expect(Object.keys(baseline).length, "the committed J1 baseline has categories").toBeGreaterThan(0);
    const verdict: RegressionVerdict = compareToBaseline(baseline, baseline);
    expect(verdict.regressed, "a run identical to baseline never regresses").toBe(false);
    for (const c of verdict.perCategory) {
      expect(c.deltaPts, `deltaPts is 0 for ${c.category} (identical to baseline)`).toBeCloseTo(0, 6);
      expect(c.regressed).toBe(false);
    }
    // The verdict is structurally secret-free (it feeds a manifest written outside Pino's net).
    expect(JSON.stringify(verdict)).not.toMatch(/apiKey|sk-|Bearer/);
  });

  it("MECHANISM: a synthetic large+significant per-category drop IS detected as a regression", () => {
    // Pick the first baseline category and synthesize a current run that drops it
    // to 0% over a comparable N — a large, statistically-significant regression the
    // gate MUST catch. This proves the detection path, keyless, at $0.
    const [firstCategory] = Object.keys(baseline);
    expect(firstCategory, "the baseline has at least one category to perturb").toBeDefined();
    const baselineBucket = baseline[firstCategory];
    // A real baseline category has a meaningful N (the j1 baseline is n=20/category).
    expect(baselineBucket.total, "the baseline category has a real N").toBeGreaterThan(0);

    const regressedCurrent: Record<string, CategoryAccuracy> = { ...baseline };
    // Drop the chosen category to 0 correct over the same N (0% accuracy).
    regressedCurrent[firstCategory] = {
      correct: 0,
      total: baselineBucket.total,
      invalid: 0,
      accuracy: 0,
    };
    const verdict = compareToBaseline(regressedCurrent, baseline);
    expect(verdict.regressed, "a 0%-vs-baseline drop on a real category is a regression").toBe(true);
    const dropped = verdict.perCategory.find((c) => c.category === firstCategory);
    expect(dropped?.current).toBe(0);
    expect(dropped?.deltaPts).toBeLessThan(0);
    expect(dropped?.significant, "the synthetic drop is statistically significant").toBe(true);
    expect(dropped?.regressed).toBe(true);
    // The summary names the regressed category (and carries no secret).
    expect(verdict.summary).toContain(firstCategory);
    expect(verdict.summary).not.toMatch(/apiKey|sk-|Bearer/);
  });

  // The COSTED real gate: ONLY when the operator points COMIS_GATE_CURRENT_MANIFEST
  // at a fresh run's manifest. Skipped keyless (no success-shaped pass text — the
  // keyless run has no real current manifest, so it proves only the mechanism above).
  it.skipIf(!COMIS_GATE_CURRENT_MANIFEST)(
    "COSTED GATE: the current run's per-category accuracy does NOT regress vs the committed baseline",
    () => {
      const currentPath = resolve(COMIS_GATE_CURRENT_MANIFEST as string);
      const current = readPerCategory(currentPath);
      expect(Object.keys(current).length, "the current manifest has per-category results").toBeGreaterThan(0);

      const verdict = compareToBaseline(current, baseline);

      // The committed baseline is the gate's anchor; this is the operator-costed PASS.
      // A real category regression (below baseline beyond the tolerance band AND
      // statistically significant) FAILS this expectation → the CI job exits non-zero.
      expect(
        verdict.regressed,
        `current run regressed vs the committed J1 baseline — ${verdict.summary}`,
      ).toBe(false);

      // The verdict carries no credential substring (it may be surfaced in CI logs).
      expect(JSON.stringify(verdict)).not.toMatch(/apiKey|sk-|Bearer/);

      // eslint-disable-next-line no-console -- gated bench harness reports its verdict (this is a .test.ts, not packages/cli)
      console.log("BENCH regression-gate", JSON.stringify({ regressed: verdict.regressed, summary: verdict.summary }));
    },
  );
});
