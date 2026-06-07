// SPDX-License-Identifier: Apache-2.0
/**
 * goal-planner.ts — R5 pre-execution planner (DEFERRED on M2).
 *
 * R5 builds the GoalChecklist that seeds R1 (GoalAnchor) and R4 (critic).
 * The Phase 149 gap report showed false-success = 0% in isolation; the M2
 * baseline suggests the GoalAnchor alone may suffice. This stub preserves
 * the "planning" operation type wiring (Plan 01) and provides the correct
 * module boundary; full implementation deferred until M2 gap analysis
 * (Phase 157 or a dedicated fix-forward phase) confirms the GoalAnchor is
 * insufficient.
 *
 * Do NOT use: any external LLM call, compatibility shims, or deprecated annotations.
 */

export interface GoalChecklist {
  items: Array<{ id: string; description: string }>;
}

// Reserved for the full R5 implementation — will mirror CriticDeps
// (provider, modelId, apiKey, clock, logger, agentId, modelProfile)
export type GoalPlannerDeps = Record<string, never>;

/**
 * createGoalPlanner — factory returning a planner function.
 *
 * STUB: currently returns an empty checklist (no LLM call).
 * The "planning" operation type (Plan 01) is registered; the full
 * completeSimple seam implementation is deferred to M2 analysis.
 */
export function createGoalPlanner(_deps: GoalPlannerDeps) {
  return async function buildChecklist(_request: string): Promise<GoalChecklist> {
    // R5 DEFERRED: return empty checklist so callers degrade gracefully.
    // The GoalAnchor (R1) already provides the checklist from the executor plan;
    // the critic reads executionPlanRef.current.steps directly (see verification-gate.ts).
    return { items: [] };
  };
}
