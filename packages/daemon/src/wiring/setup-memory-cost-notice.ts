// SPDX-License-Identifier: Apache-2.0
/**
 * First-run cost-disclosure notice (opt-out posture).
 *
 * On daemon startup, when the master cost-feature kill switch (`memory.enabled`)
 * is ON (the default)
 * AND at least one LLM cost-bearing memory feature is actually active for some
 * agent, emit ONE prominent WARN that:
 *   - names the active cost features,
 *   - states they spend the operator's OWN LLM/API budget,
 *   - gives the exact one-line config to turn them ALL off
 *     (`memory.enabled: false`).
 *
 * Emitted once per startup (this function is called once from the daemon boot
 * sequence). When the kill switch is OFF, or when NO cost feature is active
 * (today's default bare config), it emits NOTHING. It never logs a secret/key —
 * only feature names and a count.
 *
 * Scope of "cost-bearing" mirrors the kill switch exactly: the cost-bearing crons
 * (memoryReview, memoryUsefulnessJudge) and the query-time dialectic tool
 * (`memory_ask`). The $0 keyless memoryLifecycle sweep is NOT a cost feature here
 * (lifecycle is keyless), so it does not trigger the notice.
 *
 * @module
 */

import type { ComisLogger } from "@comis/infra";

/** A per-agent config slice carrying only the cost-feature opt-in flags this notice reads. */
interface CostFeatureAgentSlice {
  memoryReview?: { enabled?: boolean };
  memoryUsefulnessJudge?: { enabled?: boolean };
  dialectic?: { enabled?: boolean };
}

/**
 * The cost-feature catalog: the per-agent config key → the operator-facing label
 * that appears in the disclosure notice. Order is the disclosure display order.
 * Kept in lock-step with the kill-switch gated set in setup-schedulers.ts +
 * setup-dialectic.ts (the dialectic is the query-time `memory_ask` tool).
 */
const COST_FEATURE_CATALOG: ReadonlyArray<{ key: keyof CostFeatureAgentSlice; label: string }> = [
  { key: "memoryReview", label: "memoryReview (cron)" },
  { key: "memoryUsefulnessJudge", label: "memoryUsefulnessJudge (cron)" },
  { key: "dialectic", label: "dialectic / memory_ask (query-time tool)" },
];

/** Inputs for the first-run cost-disclosure notice. */
export interface MemoryCostFeatureNoticeDeps {
  /** All per-agent configs (the same `container.config.agents` map). */
  agents: Record<string, CostFeatureAgentSlice>;
  /** The master kill switch (`memory.enabled`). When false ⇒ no notice. */
  costFeaturesEnabled: boolean;
  /** Counts/names-only structural logger — never a secret/key. */
  logger: ComisLogger;
}

/**
 * Emit the one-shot first-run cost-disclosure WARN, or nothing.
 *
 * Returns the sorted list of active cost-feature labels (for the caller's own
 * observability / testing). An empty array means no notice was emitted.
 */
export function emitMemoryCostFeatureNotice(deps: MemoryCostFeatureNoticeDeps): readonly string[] {
  const { agents, costFeaturesEnabled, logger } = deps;

  // Switch off ⇒ every cost feature is force-disabled at its registration site ⇒ nothing to
  // disclose (and emitting would be misleading — the operator already opted out).
  if (!costFeaturesEnabled) return [];

  // Collect the DISTINCT active cost features across all agents (a feature on for any agent is
  // disclosed once, by label — never per-agent, and never a secret value).
  const active = new Set<string>();
  for (const agentConfig of Object.values(agents)) {
    if (!agentConfig) continue;
    for (const { key, label } of COST_FEATURE_CATALOG) {
      if (agentConfig[key]?.enabled === true) active.add(label);
    }
  }

  if (active.size === 0) return [];

  // Stable display order (catalog order, filtered to the active subset).
  const activeFeatures = COST_FEATURE_CATALOG.map((f) => f.label).filter((l) => active.has(l));

  // ONE prominent WARN. The message states the budget impact; the structured fields name the
  // active features and carry the exact one-line off-switch in the operator-actionable hint
  // (§2.7 — WARN requires hint + errorKind). Names + count only — never a key/body.
  logger.warn(
    {
      activeCostFeatures: activeFeatures,
      activeCostFeatureCount: activeFeatures.length,
      disableWith: "memory.enabled: false",
      errorKind: "config" as const,
      hint: "These memory features make LLM/API calls that spend YOUR configured provider budget. To turn ALL of them off in one place, set `memory.enabled: false` in your config.",
    },
    "LLM cost-bearing memory features are ACTIVE and will spend your own LLM/API budget",
  );

  return activeFeatures;
}
