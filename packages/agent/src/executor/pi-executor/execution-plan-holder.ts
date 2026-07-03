// SPDX-License-Identifier: Apache-2.0
/**
 * Holder-backed `ExecutionPlanPort` implementation.
 *
 * The Silent Execution Planner (SEP) stores the live plan for the active turn
 * in a mutable `executionPlanRef` created per-execute in `session-bootstrap.ts`
 * (`{ current: ExecutionPlan | undefined }`). The gateway/ACP plan bridge needs
 * a `@comis/core` `ExecutionPlanPort` to read that plan WITHOUT importing
 * `@comis/agent`. This holder bridges the two: the agent runtime publishes its
 * per-turn ref into the holder, and the holder — which IS an `ExecutionPlanPort`
 * — is handed to the gateway at the composition root.
 *
 * The holder reads the ref LIVE (it stores the ref object, not a snapshot), so
 * per-turn mutations SEP makes to the active plan (step status flips,
 * `completedCount` bumps) are reflected by the next `getCurrentPlan()` call —
 * no re-publish needed. `clear()` drops the active ref at turn end so
 * `getCurrentPlan()` returns `undefined` between turns (prevents a stale plan
 * from a previous turn leaking into a new session).
 *
 * The agent `ExecutionPlan` / `PlanStep` types are STRUCTURALLY identical to the
 * core `ReadonlyExecutionPlan` / `ReadonlyPlanStep` (same field names + the same
 * `"pending" | "in_progress" | "done" | "skipped"` status union — see
 * `planner/types.ts` vs `core/ports/execution-plan-port.ts`), so returning the
 * live agent plan as the core port's return type is sound with no mapping.
 *
 * Pure holder — no I/O, no logger, no infra dependency.
 *
 * @module
 */

import type { ExecutionPlanPort, ReadonlyExecutionPlan } from "@comis/core";
import type { ExecutionPlan } from "../../planner/types.js";

/**
 * An `ExecutionPlanPort` plus the agent-side publish/clear seam the runtime
 * uses to point the port at the active turn's plan.
 */
export interface ExecutionPlanHolder extends ExecutionPlanPort {
  /**
   * Publish the active turn's mutable plan ref. The port reads `ref.current`
   * LIVE (it does not snapshot), so later SEP mutations to the same ref are
   * visible to `getCurrentPlan()`. Overwrites any previously-published ref.
   */
  publish(ref: { current: ExecutionPlan | undefined }): void;
  /**
   * Clear the active ref at turn end so `getCurrentPlan()` returns `undefined`
   * between turns.
   */
  clear(): void;
}

/**
 * Create a holder-backed `ExecutionPlanPort`. The returned object is the port
 * the gateway/ACP plan bridge consumes; the agent runtime calls `publish()` at
 * per-turn ref creation and (optionally) `clear()` at turn end.
 */
export function createExecutionPlanHolder(): ExecutionPlanHolder {
  let activeRef: { current: ExecutionPlan | undefined } | undefined;
  return {
    getCurrentPlan(): ReadonlyExecutionPlan | undefined {
      // Live read: agent ExecutionPlan is structurally ReadonlyExecutionPlan.
      return activeRef?.current;
    },
    publish(ref: { current: ExecutionPlan | undefined }): void {
      activeRef = ref;
    },
    clear(): void {
      activeRef = undefined;
    },
  };
}
