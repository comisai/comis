// SPDX-License-Identifier: Apache-2.0
/**
 * ActivityStreamPort — keeps the orchestrator independent of observability.
 *
 * The port is declared in `core/activity`; the concrete implementation lives in
 * `@comis/observability` and is wired into the composition root by the daemon.
 * The orchestrator depends on this port shape from `@comis/core` only — it
 * never imports `@comis/observability` (`orchestrator/package.json` gains no
 * observability dependency). Pure type-only file (no I/O, no logger).
 */
import type { ActivityEvent } from "./activity-event.js";
import type { TurnActivityContext } from "./turn-activity-context.js";

/**
 * Subscription handle returned to the coordinator. The coordinator
 * unsubscribes at turn end (or aborted-turn cleanup) to release the bounded
 * queue slot.
 */
export interface ActivitySubscription {
  unsubscribe(): void;
}

/**
 * Port that the orchestrator depends on. The concrete implementation lives in
 * `@comis/observability` and is wired into the composition root by the daemon.
 */
export interface ActivityStreamPort {
  /**
   * Subscribe a coordinator to the canonical activity events scoped to a single
   * turn. The implementation owns the bounded queue and produces events
   * filtered to {ctx.agentId, ctx.sessionKey, ctx.traceId}.
   */
  subscribeForTurn(
    ctx: TurnActivityContext,
    onEvent: (e: ActivityEvent) => void,
  ): ActivitySubscription;
}
