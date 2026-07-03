// SPDX-License-Identifier: Apache-2.0
/**
 * Statistical gating — pass-rate, binomial CI, baseline comparison, scenario×model grid.
 *
 * Default gating parameters:
 *   N = 3 runs per stochastic scenario (overridable per scenario)
 *   Frontier models: pass-rate >= 0.90
 *   Mid models:      pass-rate >= 0.80
 *   Small/local:     pass-rate >= 0.70
 *   Confidence: binomial 95% CI must not straddle the threshold
 *
 * @module
 */

/**
 * Model capability tier — determines which pass-rate threshold applies.
 *
 * frontier: Claude Opus/Sonnet, GPT-4o, Gemini Pro
 * mid:      Claude Haiku, GPT-4o-mini, Gemini Flash
 * small:    Ollama 3B–7B and other local models
 */
export type PassRateTier = "frontier" | "mid" | "small";

/**
 * Default pass-rate thresholds per capability tier (env-overridable per scenario).
 */
export const PASS_RATE_THRESHOLDS: Record<PassRateTier, number> = {
  frontier: 0.90,
  mid: 0.80,
  small: 0.70,
};

/** Default number of runs per stochastic scenario. */
export const DEFAULT_N_RUNS = 3;

/** Result of a pass-rate computation over N boolean outcomes. */
export interface PassRateResult {
  /** Fraction of passing runs: passes / n. */
  rate: number;
  /** Total number of runs measured. */
  n: number;
}

/** Result of a baseline comparison gate. */
export interface RegressionResult {
  /** True when the current rate is within tolerance of the baseline. */
  passed: boolean;
  /** Current observed pass-rate. */
  current: number;
  /** Baseline pass-rate used for comparison. */
  baseline: number;
  /** Signed delta: current − baseline (negative = regression). */
  delta: number;
}

/**
 * Compute pass-rate from an array of boolean run outcomes.
 *
 * Returns { rate: 0, n: 0 } for an empty array so callers can safely gate
 * on n === 0 before trusting the rate.
 */
export function computePassRate(results: boolean[]): PassRateResult {
  if (results.length === 0) return { rate: 0, n: 0 };
  const passes = results.filter(Boolean).length;
  return { rate: passes / results.length, n: results.length };
}

/**
 * Compute a Clopper-Pearson exact confidence interval for a binomial proportion.
 *
 * Uses a closed-form beta distribution quantile approximation that handles
 * degenerate cases (0 successes, all successes) correctly — unlike Wilson score,
 * which produces [>0, >0.5] for 0/n at 95% confidence.
 *
 * For the n=3..10 range used by live-fire statistical gates this approximation
 * is sufficient; we need the correct ordering at the extremes (0/n, n/n) more
 * than sub-0.1% quantile precision.
 *
 * Formula: lower = Beta(α/2; k, n−k+1), upper = Beta(1−α/2; k+1, n−k)
 * Approximated via the incomplete beta function identity with the regularized
 * incomplete beta function evaluated using a series expansion.
 *
 * @param successes - number of successful outcomes
 * @param n         - total number of trials
 * @param confidence - confidence level (e.g. 0.95 for 95% CI)
 * @returns [lower, upper] — both clamped to [0, 1]
 */
export function computeBinomialCI(
  successes: number,
  n: number,
  confidence: number,
): [number, number] {
  if (n === 0) return [0, 1];
  const alpha = 1 - confidence;

  // Clopper-Pearson exact interval:
  //   lower = betaQuantile(alpha/2,     k,     n-k+1)
  //   upper = betaQuantile(1-alpha/2,   k+1,   n-k  )
  // Edge cases: all-fail → lower=0; all-pass → upper=1
  const k = successes;
  const lower = k === 0 ? 0 : betaQuantile(alpha / 2, k, n - k + 1);
  const upper = k === n ? 1 : betaQuantile(1 - alpha / 2, k + 1, n - k);

  return [Math.max(0, lower), Math.min(1, upper)];
}

/**
 * Beta distribution quantile (inverse CDF) via the continued-fraction
 * representation of the regularized incomplete beta function.
 *
 * Iterative Halley's method on I_x(a,b) — converges in <30 steps for
 * the parameter ranges we use (a,b ∈ [1,15]).
 *
 * Reference: Abramowitz & Stegun §26.5.
 */
function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;

  // Initial estimate via Normal approximation
  let x = a / (a + b);

  // Newton-Raphson on I_x(a,b) = p
  for (let i = 0; i < 64; i++) {
    const fx = incompleteBeta(x, a, b) - p;
    // Derivative: pdf of Beta(a,b) at x
    const dfx =
      Math.pow(x, a - 1) * Math.pow(1 - x, b - 1) * Math.exp(logBeta(a, b)) ** -1;
    if (dfx === 0 || !isFinite(dfx)) break;
    const xNew = Math.max(1e-10, Math.min(1 - 1e-10, x - fx / dfx));
    if (Math.abs(xNew - x) < 1e-9) { x = xNew; break; }
    x = xNew;
  }
  return x;
}

/**
 * Regularized incomplete beta function I_x(a,b) via continued fraction.
 * Lentz's algorithm — numerically stable for 0 < x < 1, a,b > 0.
 */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const lbeta = logBeta(a, b);
  const front =
    Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;

  // Use symmetry identity when x > (a+1)/(a+b+2)
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }

  // Continued fraction via Lentz
  const TINY = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 200; m++) {
    // Even step
    let aa =
      (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    // Odd step
    aa =
      (-(a + m) * (a + b + m) * x) /
      ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;

    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return front * h;
}

/** log(Beta(a,b)) = log Γ(a) + log Γ(b) − log Γ(a+b) via Lanczos (delegated to logGamma). */
function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/** log Γ(x) via Lanczos approximation (g=7). Accurate to ~15 significant digits. */
function logGamma(x: number): number {
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = p[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += p[i]! / (x + i);
  return (
    0.5 * Math.log(2 * Math.PI) +
    (x + 0.5) * Math.log(t) -
    t +
    Math.log(a)
  );
}

/**
 * Gate the current pass-rate against a committed baseline.
 *
 * A result is a REGRESSION when:
 *   current.rate < baseline.rate − tolerancePct
 *
 * The significanceThreshold parameter is reserved for future use (e.g.
 * Fisher's exact p-value guard at large N). Currently unused in the comparison
 * logic — callers may pass any positive number.
 *
 * @param current    - pass-rate result from the current run
 * @param baseline   - committed baseline pass-rate (from ledger or baseline file)
 * @param tolerancePct - allowed regression band (e.g. 0.05 = 5 pp tolerance)
 * @param significanceThreshold - reserved; minimum statistical significance (unused)
 */
export function compareToBaseline(
  current: PassRateResult,
  baseline: PassRateResult,
  tolerancePct: number,
  _significanceThreshold: number,
): RegressionResult {
  const delta = current.rate - baseline.rate;
  const passed = delta >= -tolerancePct;
  return {
    passed,
    current: current.rate,
    baseline: baseline.rate,
    delta,
  };
}

/** A single run-row for grid aggregation. */
export interface RunRow {
  scenarioId: string;
  model: string;
  passed: boolean;
}

/** 2-D pass/fail tally keyed by scenarioId → model. */
export interface Grid2D {
  [scenarioId: string]: {
    [model: string]: { passed: number; failed: number };
  };
}

/**
 * Build a scenario × model pass/fail grid from an array of run-rows.
 *
 * Used to render the per-model reliability table in READINESS.md and stored
 * as a 2-D JSON object in the ledger row.
 */
export function buildScenarioModelGrid(rows: RunRow[]): Grid2D {
  const grid: Grid2D = {};
  for (const row of rows) {
    if (!grid[row.scenarioId]) grid[row.scenarioId] = {};
    const cell = grid[row.scenarioId]!;
    if (!cell[row.model]) cell[row.model] = { passed: 0, failed: 0 };
    if (row.passed) {
      cell[row.model]!.passed += 1;
    } else {
      cell[row.model]!.failed += 1;
    }
  }
  return grid;
}
