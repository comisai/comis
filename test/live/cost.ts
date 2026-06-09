// SPDX-License-Identifier: Apache-2.0
/**
 * Cost Governor — budget ceiling enforcement and secret-sweep utilities.
 *
 * Reused by cassette.ts, report.ts, and log-oracle.ts in later plans.
 *
 * Cost tiers (declared per-scenario):
 *   "$0"    — keyless: local embeddings, DuckDuckGo, structural checks, cassette replay
 *   "cent"  — 1–2 cheapest-model calls (e.g., Haiku/gpt-4o-mini/gemini-flash)
 *   "dollar" — judged multi-turn / modality round-trip
 *   "double" — matrix sweep / soak (Phase 148 territory)
 *
 * The governor checks budget BEFORE spawning each scenario and aborts with
 * SKIPPED(budget-exceeded) on breach. Default budget: $2.00, overridable via
 * COMIS_LIVE_BUDGET_USD env var.
 *
 * @module
 */

/**
 * Cost tier union — declared per-scenario, mapped to USD estimate.
 */
export type CostTier = "$0" | "cent" | "dollar" | "double";

/**
 * USD estimate per cost tier. Conservative values — actual usage flows back
 * via obs.billing.total RPC and is recorded in the ledger.
 */
const TIER_USD: Record<CostTier, number> = {
  "$0": 0,
  "cent": 0.02,
  "dollar": 1.00,
  "double": 2.50,
};

/**
 * Secret-sweep regex — ports bench-memory.sh `sweep_tier_report` pattern to TypeScript.
 * Matches: sk-* API keys (case-insensitive — canary token uses uppercase SK-),
 * Bearer tokens, apiKey key-value assignments with non-empty values.
 *
 * The apiKey branch matches "apiKey": "..." or apiKey: "..." (key=value form) but NOT
 * bare field names in serialized JSON like `"apiKey":null` or `"apiKey":"<param-name>"`.
 * A minimum value length of 4 chars avoids matching parameter-name placeholders.
 *
 * CR-01 fix: added `i` flag so `SK-CANARY-9F3X-DO-NOT-REVEAL` (uppercase) is matched
 * in addition to the lowercase `sk-` prefix. Canary token format is SK-XXXXXXXX.
 */
const SECRET_PATTERN =
  /sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]+|(?:"apiKey"|apiKey)\s*[=:]\s*["'][^"']{4,}/gi;

/**
 * Scan a string for credential-shaped patterns.
 * Returns an array of matched strings (redact before logging).
 */
export function scanForSecrets(content: string): string[] {
  return Array.from(content.matchAll(SECRET_PATTERN), (m) => m[0]);
}

/**
 * Assert no secrets are present in content, throwing on detection.
 * Matched values are REDACTED in the thrown error to prevent secondary leakage.
 *
 * T-134-02 (Information Disclosure): matched strings are never echoed.
 */
export function assertNoSecrets(content: string, context = "content"): void {
  const found = scanForSecrets(content);
  if (found.length > 0) {
    throw new Error(
      `SECRET LEAK detected in ${context}: ${found.map(() => "[REDACTED]").join(", ")}`,
    );
  }
}

/**
 * Cost Governor — accumulates declared scenario cost tiers and enforces the
 * COMIS_LIVE_BUDGET_USD ceiling before any scenario spawns.
 *
 * T-134-03 (Elevation of Privilege): parseFloat + isFinite guard; non-finite or
 * negative budget falls back to $2.00 — no negative budget bypass.
 */
export class CostGovernor {
  private tally_usd = 0;
  private readonly budget: number;
  private readonly scenarios: Array<{ tier: CostTier; id: string }> = [];

  constructor(budget?: number) {
    if (budget !== undefined) {
      this.budget = Number.isFinite(budget) && budget >= 0 ? budget : 2.00;
    } else {
      const env = process.env["COMIS_LIVE_BUDGET_USD"];
      const parsed = env !== undefined && env !== "" ? parseFloat(env) : NaN;
      this.budget = Number.isFinite(parsed) && parsed >= 0 ? parsed : 2.00;
    }
  }

  /**
   * Declare a scenario with its cost tier, adding it to the running tally.
   * Call before any real invocation of the scenario.
   */
  declare(tier: CostTier, scenarioId: string): void {
    this.scenarios.push({ tier, id: scenarioId });
    this.tally_usd += TIER_USD[tier];
  }

  /**
   * Check if the current tally has exceeded the budget ceiling.
   * Returns "SKIPPED(budget-exceeded)" when over budget, null otherwise.
   * Call BEFORE spawning the next scenario.
   */
  check(): "SKIPPED(budget-exceeded)" | null {
    return this.tally_usd > this.budget ? "SKIPPED(budget-exceeded)" : null;
  }

  /**
   * Returns the current tally in USD.
   */
  tally(): number {
    return this.tally_usd;
  }

  /**
   * Returns a dry-run plan: each declared scenario as a labelled string
   * showing its cost tier. For --dry mode output.
   */
  dryRunPlan(scenarioIds: string[]): string[] {
    return scenarioIds.map((id) => {
      const s = this.scenarios.find((sc) => sc.id === id);
      return s ? `[${s.tier}] ${id}` : `[?] ${id}`;
    });
  }
}
