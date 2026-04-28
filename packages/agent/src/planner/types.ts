// SPDX-License-Identifier: Apache-2.0
/**
 * Silent Execution Planner (SEP) types.
 *
 * Defines the in-memory plan structures used to track multi-step execution
 * progress within a single agent execute() call. Plans are extracted from
 * the LLM's first response and updated by the PiEventBridge during tool
 * execution events.
 *
 * @module
 */

/** A single step in the agent's execution plan. */
export interface PlanStep {
  /** Sequential index (1-based). */
  index: number;
  /** Brief imperative description (extracted from LLM's first response). */
  description: string;
  /** Current status. */
  status: "pending" | "in_progress" | "done" | "skipped";
  /** Tool name(s) associated with this step (matched heuristically). */
  associatedTools?: string[];
  /** Tool call IDs that contributed to completing this step. */
  completedBy?: string[];
}

/** Execution plan state, scoped to a single execute() call. */
export interface ExecutionPlan {
  /** Whether plan extraction was attempted and succeeded. */
  active: boolean;
  /** Original user request (truncated, for context). */
  request: string;
  /** Ordered steps. */
  steps: PlanStep[];
  /** Number of steps marked "done". */
  completedCount: number;
  /** Timestamp of plan creation. */
  createdAtMs: number;
}
