// SPDX-License-Identifier: Apache-2.0
/**
 * plan-stream — derives plan-update events from the Silent Execution Planner
 * (SEP) without introducing a new tool.
 *
 * SEP is the canonical plan-state source. The bus already emits
 * `sep:plan_extracted` whenever the agent extracts a plan, and the live
 * `ExecutionPlan` is read through the core `ExecutionPlanPort`. This stream:
 *
 *   - subscribes `sep:plan_extracted` → reads `executionPlanPort.getCurrentPlan()`
 *     and emits a {@link PlanUpdate} whose entries map from `ExecutionPlan.steps`.
 *   - subscribes `tool:executed` → re-reads the plan and re-emits, so checkbox
 *     transitions (derived by SEP via `PlanStep.completedBy`) surface as the
 *     tools complete. `completedBy: undefined` ⇒ "no completions yet".
 *   - registers NO new plan-state tool; SEP
 *     remains the single source of truth.
 *
 * Mirrors the cache-trace `event-bus-bridge.ts` subscription-bag idiom: a
 * subscriptions array, `bus.on(...)` per event, a single returned
 * `unsubscribe()` that `bus.off`s all. Logger is injected via Deps (never
 * `getLogger()` in-module). Never imports `channels`.
 *
 * @module
 */
import type {
  ComisLogger,
  EventMap,
  TypedEventBus,
  ExecutionPlanPort,
  ReadonlyExecutionPlan,
} from "@comis/core";

/** A single plan entry projected from a SEP `PlanStep` (renderer-ready). */
export interface PlanEntry {
  /** 1-based step index. */
  readonly index: number;
  /** Brief imperative step description. */
  readonly description: string;
  /** SEP step status. */
  readonly status: "pending" | "in_progress" | "done" | "skipped";
  /** Convenience boolean: true iff `status === "done"`. */
  readonly completed: boolean;
}

/** A plan-update derived from SEP (one per `sep:plan_extracted` / correlated `tool:executed`). */
export interface PlanUpdate {
  readonly agentId: string;
  readonly sessionKey: string;
  /** Total declared steps (from `ExecutionPlan.steps.length`). */
  readonly stepCount: number;
  /** Steps marked done (from `ExecutionPlan.completedCount`). */
  readonly completedCount: number;
  /** The projected entries, in plan order. */
  readonly entries: readonly PlanEntry[];
}

/** Dependencies for {@link createPlanStream}. */
export interface CreatePlanStreamDeps {
  readonly eventBus: TypedEventBus;
  /** Read-only accessor for the live SEP plan. */
  readonly executionPlanPort: ExecutionPlanPort;
  /** Injected bound logger. Optional — DEBUG plan-update traces. */
  readonly logger?: ComisLogger;
}

/** A subscribed plan stream — call `subscribe(onPlanUpdate)` to start. */
export interface PlanStream {
  /**
   * Start deriving plan-updates. `onPlanUpdate` fires once per
   * `sep:plan_extracted` (and per correlated `tool:executed`) while a plan is
   * active. Returns an `unsubscribe()` that detaches both bus handlers.
   */
  subscribe(onPlanUpdate: (update: PlanUpdate) => void): () => void;
}

/**
 * Create the SEP plan-stream. NO new tool is registered.
 */
export function createPlanStream(deps: CreatePlanStreamDeps): PlanStream {
  return {
    subscribe(onPlanUpdate: (update: PlanUpdate) => void): () => void {
      const subscriptions: Array<{
        eventName: keyof EventMap;
        handler: (payload: unknown) => void;
      }> = [];

      const emitFromPlan = (agentId: string, sessionKey: string): void => {
        const plan = deps.executionPlanPort.getCurrentPlan();
        if (plan === undefined || !plan.active) {
          // SEP inactive for this turn — nothing to project.
          return;
        }
        const update = projectPlan(plan, agentId, sessionKey);
        deps.logger?.debug?.(
          {
            agentId,
            sessionKey,
            stepCount: update.stepCount,
            completedCount: update.completedCount,
            submodule: "plan-stream",
            step: "plan-update",
          },
          "plan update derived from SEP",
        );
        onPlanUpdate(update);
      };

      // sep:plan_extracted → derive the initial plan-update.
      const planHandler = (payload: EventMap["sep:plan_extracted"]): void => {
        emitFromPlan(payload.agentId, payload.sessionKey);
      };
      deps.eventBus.on("sep:plan_extracted", planHandler);
      subscriptions.push({
        eventName: "sep:plan_extracted",
        handler: planHandler as (p: unknown) => void,
      });

      // tool:executed → re-read the plan and re-emit (checkbox transitions
      // derived by SEP via PlanStep.completedBy). agentId/sessionKey are
      // optional on the payload; skip the re-emit when absent.
      const toolHandler = (payload: EventMap["tool:executed"]): void => {
        if (payload.agentId === undefined || payload.sessionKey === undefined) return;
        emitFromPlan(payload.agentId, payload.sessionKey);
      };
      deps.eventBus.on("tool:executed", toolHandler);
      subscriptions.push({
        eventName: "tool:executed",
        handler: toolHandler as (p: unknown) => void,
      });

      return function unsubscribe(): void {
        for (const sub of subscriptions) {
          deps.eventBus.off(
            sub.eventName,
            sub.handler as (p: EventMap[keyof EventMap]) => void,
          );
        }
        subscriptions.length = 0;
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Projection (pure)
// ---------------------------------------------------------------------------

/** Project a live `ExecutionPlan` into a renderer-ready {@link PlanUpdate}. */
function projectPlan(
  plan: ReadonlyExecutionPlan,
  agentId: string,
  sessionKey: string,
): PlanUpdate {
  const entries: PlanEntry[] = plan.steps.map((step) => ({
    index: step.index,
    description: step.description,
    status: step.status,
    // completedBy undefined ⇒ no completions yet; the authoritative
    // "done" signal is the SEP-maintained status.
    completed: step.status === "done",
  }));
  return {
    agentId,
    sessionKey,
    stepCount: plan.steps.length,
    completedCount: plan.completedCount,
    entries,
  };
}
