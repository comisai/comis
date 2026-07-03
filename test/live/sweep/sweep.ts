// SPDX-License-Identifier: Apache-2.0
/**
 * Sweep orchestrator — iterates PROBE_REGISTRY under the cost governor
 * and credential registry, collects ProbeVerdict[], returns SweepResult.
 *
 * runSweep is a pure async function (no process.exit, no side effects) —
 * importable by tests. Tests inject a mock probe registry via opts.probeRegistry.
 *
 * One minimal LLM-free probe per integration, green|red|skip.
 *
 * Security notes:
 *   - ProbeVerdict.reason may carry API error text — never write to disk without
 *     assertNoSecrets (enforced in gap-report.ts).
 *   - governor.declare() + governor.check() are called before every probe.run()
 *     to enforce the COMIS_LIVE_BUDGET_USD ceiling.
 *
 * @module
 */

import { PROBE_REGISTRY, type Probe } from "./probes.js";
import type { CredentialRegistry } from "../credentials.js";
import type { CostGovernor } from "../cost.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A probe result augmented with the probe's identity metadata.
 * ProbeVerdict = ProbeResult & { id, category }.
 */
export interface ProbeVerdict {
  id: string;
  category: string;
  status: "green" | "red" | "skip";
  reason?: string;
  durationMs: number;
}

/**
 * Aggregate result returned by runSweep().
 * Contains all verdicts, the tally cost, and the run timestamp.
 */
export interface SweepResult {
  /** One verdict per probe that was considered (including budget-skipped). */
  verdicts: ProbeVerdict[];
  /** Running cost tally in USD as returned by governor.tally(). */
  costUsd: number;
  /** ISO 8601 timestamp of when the sweep completed. */
  ranAt: string;
}

/**
 * Options for runSweep().
 */
export interface SweepOpts {
  /** Filter to these probe IDs only. Empty or absent = all probes. */
  probeIds?: string[];
  /**
   * Override the module-level PROBE_REGISTRY.
   * Intended for test injection of mock probes.
   * This parameter is used only in tests; production path always
   * uses the module-level PROBE_REGISTRY.
   */
  probeRegistry?: Map<string, Probe>;
  /**
   * Dry-run mode: governor.declare() is called for all probes (cost accounting)
   * but probe.run() is never called. Every verdict gets status "skip" with
   * reason "dry-run".
   */
  dry?: boolean;
}

// ---------------------------------------------------------------------------
// runSweep
// ---------------------------------------------------------------------------

/**
 * Run all probes in the registry (or the filtered subset) under the cost
 * governor and credential registry, returning a SweepResult.
 *
 * Orchestration loop (budget-ceiling compliance):
 *   1. governor.declare(probe.costTier, probe.id) — accumulate cost
 *   2. governor.check() — if non-null, record skip with that reason and skip run()
 *   3. (unless dry) probe.run(registry, governor) — collect ProbeResult
 *   4. Attach id + category → ProbeVerdict
 *
 * @param registry  - Credential registry for skip-not-fail gate inside probes.
 * @param governor  - Cost governor for budget enforcement.
 * @param opts      - Optional: probeRegistry, probeIds, dry.
 */
export async function runSweep(
  registry: CredentialRegistry,
  governor: CostGovernor,
  opts: SweepOpts = {},
): Promise<SweepResult> {
  const probeMap = opts.probeRegistry ?? PROBE_REGISTRY;
  let probes = [...probeMap.values()];

  // Apply probeIds filter if provided (non-empty).
  // Each token matches a probe if it is an exact probe ID match, a dash-prefix
  // match (e.g. "search" matches "search-brave", "search-tavily", …), or an
  // exact category match. This aligns with the documented example:
  //   COMIS_LIVE_PROBES=search → all search-* probes run.
  if (opts.probeIds && opts.probeIds.length > 0) {
    probes = probes.filter((p) =>
      opts.probeIds!.some(
        (f) => p.id === f || p.id.startsWith(f + "-") || p.category === f,
      ),
    );
  }

  const verdicts: ProbeVerdict[] = [];

  for (const probe of probes) {
    // Declare cost tier BEFORE checking budget
    governor.declare(probe.costTier, probe.id);
    const budgetVerdict = governor.check();

    if (budgetVerdict !== null || opts.dry) {
      // Skip without running — budget exceeded or dry-run mode
      verdicts.push({
        id: probe.id,
        category: probe.category,
        status: "skip",
        reason: opts.dry ? "dry-run" : (budgetVerdict ?? undefined),
        durationMs: 0,
      });
      continue;
    }

    // Run the probe — probe.run() MUST NOT throw (per probes.ts contract)
    const result = await probe.run(registry, governor);
    verdicts.push({
      id: probe.id,
      category: probe.category,
      ...result,
    });
  }

  return {
    verdicts,
    costUsd: governor.tally(),
    ranAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// parseProbeFilter
// ---------------------------------------------------------------------------

/**
 * Parse COMIS_LIVE_PROBES env var → array of probe IDs to run.
 *
 * Empty string / unset → empty array (all probes run).
 * Comma-separated: "llm-anthropic,search-brave" → ["llm-anthropic","search-brave"]
 *
 * Mirrors test/support/test-providers.ts:parseTestProviders idiom.
 * No injection risk — used only as an ID allowlist string comparison.
 */
export function parseProbeFilter(): string[] {
  return (
    process.env["COMIS_LIVE_PROBES"]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}
