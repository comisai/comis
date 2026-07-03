// SPDX-License-Identifier: Apache-2.0
/**
 * goal-planner.ts — pre-execution planner (deliberately a stub).
 *
 * The planner builds the GoalChecklist that seeds the GoalAnchor and the
 * verification critic. Measured false-success in isolation was 0%, which
 * suggests the GoalAnchor alone suffices. This stub preserves
 * the "planning" operation type wiring and provides the correct
 * module boundary; a full implementation is deferred until evidence shows
 * the GoalAnchor is insufficient.
 *
 * Do NOT use: any external LLM call, compatibility shims, or deprecated annotations.
 */

export interface GoalChecklist {
  items: Array<{ id: string; description: string }>;
}

// Reserved for the full planner implementation — will mirror CriticDeps
// (provider, modelId, apiKey, clock, logger, agentId, modelProfile)
export type GoalPlannerDeps = Record<string, never>;

/**
 * createGoalPlanner — factory returning a planner function.
 *
 * STUB: currently returns an empty checklist (no LLM call).
 * The "planning" operation type is registered; the full
 * completeSimple seam implementation is deferred (see the module JSDoc).
 */
export function createGoalPlanner(_deps: GoalPlannerDeps) {
  return async function buildChecklist(_request: string): Promise<GoalChecklist> {
    // Deferred: return an empty checklist so callers degrade gracefully.
    // The GoalAnchor already provides the checklist from the executor plan;
    // the critic reads executionPlanRef.current.steps directly (see verification-gate.ts).
    return { items: [] };
  };
}
