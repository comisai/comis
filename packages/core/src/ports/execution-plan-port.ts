// SPDX-License-Identifier: Apache-2.0
/**
 * ExecutionPlanPort — read-only accessor for the Silent Execution Planner
 * (SEP) `ExecutionPlan`.
 *
 * There is deliberately **no** `plan_state` tool — SEP is the canonical
 * plan-state source. The authoritative `ExecutionPlan` + `PlanStep` types live in
 * `@comis/agent` (`packages/agent/src/planner/types.ts`). This port re-declares
 * the **minimal read-only** shape in core so the gateway/ACP plan bridge can
 * render plan-state (`session/update { sessionUpdate: "plan" }`) and the
 * chat-projection plan renderer can draw checkboxes WITHOUT the gateway
 * depending on `@comis/agent`. The implementation (agent/orchestrator) and the
 * consumer (gateway) are wired separately; this declares only the port
 * shape. Pure type-only file (no I/O, no logger).
 */

/**
 * A single step in the agent's execution plan (read-only projection of the
 * authoritative `PlanStep` in `@comis/agent`).
 */
export interface ReadonlyPlanStep {
  /** Sequential index (1-based). */
  readonly index: number;
  /** Brief imperative description (extracted from the LLM's first response). */
  readonly description: string;
  /** Current status. */
  readonly status: "pending" | "in_progress" | "done" | "skipped";
  /**
   * Tool call IDs that contributed to completing this step. Optional — the
   * projection MUST treat `undefined` as "no completions yet".
   */
  readonly completedBy?: readonly string[];
}

/**
 * Execution plan state, scoped to a single `execute()` call (read-only
 * projection of the authoritative `ExecutionPlan` in `@comis/agent`).
 */
export interface ReadonlyExecutionPlan {
  /** Whether plan extraction was attempted and succeeded. */
  readonly active: boolean;
  /** Original user request (truncated, for context). */
  readonly request: string;
  /** Ordered steps. */
  readonly steps: readonly ReadonlyPlanStep[];
  /** Number of steps marked "done". */
  readonly completedCount: number;
}

/**
 * Read-only accessor the gateway/ACP plan bridge depends on. The concrete
 * implementation reads the live SEP `ExecutionPlan` from the agent runtime and
 * is wired into the composition root.
 */
export interface ExecutionPlanPort {
  /**
   * The current execution plan for the active turn, or `undefined` when no plan
   * has been extracted (SEP inactive for this turn).
   */
  getCurrentPlan(): ReadonlyExecutionPlan | undefined;
}
