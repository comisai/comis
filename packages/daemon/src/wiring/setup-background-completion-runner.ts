// SPDX-License-Identifier: Apache-2.0
/**
 * Background completion dispatcher + runner wiring for daemon startup.
 *
 * Subscribes the dispatcher BEFORE the runner so its synchronous
 * `transitionDispatchState` runs first; the runner's handler then reads
 * the updated `task.dispatchState` and skips when state is "notified"
 * (the dispatcher already fired fallback). Subscription order matters
 * because the event bus fires handlers in registration order; the
 * dispatcher MUST come first.
 *
 * Per AGENTS §2.4: composition root + factories. This wiring lives in
 * @comis/daemon (composition root); the actual factory bodies live in
 * @comis/agent.
 *
 * @module
 */

import {
  createBackgroundCompletionRunner,
  createCompletionDispatcher,
  createTurnFlightTracker,
  type BackgroundCompletionRunner,
  type BackgroundCompletionRunnerDeps,
  type BackgroundTaskManager,
  type CompletionDispatcher,
  type NotifyFn,
} from "@comis/agent";
import {
  resolvePlatformDeliveryResult,
  type ChannelPort,
  type DeliveryService,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok } from "@comis/shared";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor } from "@comis/agent";
import type { RunnerSessionStore } from "@comis/agent";

/** Result of setupBackgroundCompletionRunner -- exposed to the daemon for shutdown. */
export interface BackgroundCompletionRunnerContext {
  runner: BackgroundCompletionRunner;
  dispatcher: CompletionDispatcher;
}

/**
 * The taskManager arg widened to require `transitionDispatchState` so the
 * dispatcher can persist state-machine transitions.
 *
 * The runner only consumes `getTask` (existing contract); the dispatcher
 * consumes both `getTask` and `transitionDispatchState`. Daemon callers
 * pass the full BackgroundTaskManager so structural subtyping covers both.
 */
export interface SetupBackgroundCompletionRunnerDeps {
  eventBus: TypedEventBus;
  getExecutor: (agentId: string) => AgentExecutor;
  assembleToolsForAgent: NonNullable<BackgroundCompletionRunnerDeps["assembleToolsForAgent"]>;
  adaptersByType: ReadonlyMap<string, ChannelPort>;
  deliveryService: DeliveryService;
  sessionStore: RunnerSessionStore;
  /**
   * Must support `transitionDispatchState`; the dispatcher persists state
   * machine transitions through it. The runner only needs `getTask`.
   */
  taskManager: Pick<BackgroundTaskManager, "getTask" | "transitionDispatchState">;
  /** bgNotifyFn closure used when the originating session is gone. */
  fallbackNotifyFn: NotifyFn;
  /** From config.backgroundTasks.maxBackgroundHops (default 3). NOT config.workflow.*. */
  maxBackgroundHops: number;
  logger: ComisLogger;
}

/**
 * Wire the dispatcher + completion runner from daemon-level dependencies.
 * Call this AFTER setupNotifications so fallbackNotifyFn is wired.
 *
 * Subscription order: dispatcher first (synchronous transition), runner
 * second (reads updated state). Reverse-order shutdown so the runner
 * stops accepting events before the dispatcher tears down.
 */
export function setupBackgroundCompletionRunner(
  deps: SetupBackgroundCompletionRunnerDeps,
): BackgroundCompletionRunnerContext {
  // LIVE-TURN oracle shared by dispatcher + runner: a tool auto-backgrounded
  // mid-turn is consumed by its own still-running turn (the background_tasks
  // stub protocol), so a completion landing while the origin turn is in
  // flight fires NO raw fallback notice and NO re-entry. The persistent
  // sessionStore below is near-EMPTY in DAG mode, so it cannot be this
  // oracle (the live incident: a raw 'Background task "…" completed.'
  // message mid-conversation, followed by the live turn's real answer).
  const turnFlight = createTurnFlightTracker({ eventBus: deps.eventBus });

  // Dispatcher subscribes FIRST so its synchronous transitionDispatchState
  // runs before the runner's handler reads task.dispatchState within the
  // same event-bus tick.
  const dispatcher = createCompletionDispatcher({
    eventBus: deps.eventBus,
    sessionStore: deps.sessionStore,
    taskManager: deps.taskManager,
    fallbackNotifyFn: deps.fallbackNotifyFn,
    maxBackgroundHops: deps.maxBackgroundHops,
    isTurnInFlight: (key) => turnFlight.isTurnInFlight(key),
    logger: deps.logger,
  });

  const runner = createBackgroundCompletionRunner({
    eventBus: deps.eventBus,
    getExecutor: deps.getExecutor,
    assembleToolsForAgent: deps.assembleToolsForAgent,
    sessionStore: deps.sessionStore,
    taskManager: deps.taskManager,
    deliverCompletion: async ({ origin, response }) => {
      const endpoint = origin.turnScope.endpoint;
      const adapter = deps.adaptersByType.get(endpoint.channelType);
      if (adapter === undefined || adapter.channelId !== endpoint.channelInstanceId) {
        return err({
          errorKind: "precondition" as const,
          message: "The originating channel adapter instance is not active",
        });
      }
      const attempted = await fromPromise(deps.deliveryService.deliverToChannel(
        adapter,
        endpoint.conversationId,
        response,
        {
          completionMode: "settled",
          authority: {
            tenantId: origin.turnScope.conversation.tenantId,
            agentId: origin.turnScope.conversation.agentId,
            conversationRef: origin.conversationRef,
          },
          destinationEndpoint: endpoint,
          ...(endpoint.threadId === undefined ? {} : { threadId: endpoint.threadId }),
          origin: "background-completion",
        },
      ));
      if (!attempted.ok) {
        return err({
          errorKind: "dependency" as const,
          message: attempted.error.message,
        });
      }
      const resolved = resolvePlatformDeliveryResult(attempted.value);
      if (!resolved.ok) {
        return err({
          errorKind: "dependency" as const,
          message: resolved.error.message,
        });
      }
      if (resolved.value.platform.status !== "accepted") {
        return err({
          errorKind: resolved.value.platform.errorKind,
          message: "The completion response was not fully accepted by the originating platform",
        });
      }
      return ok(undefined);
    },
    fallbackNotifyFn: deps.fallbackNotifyFn,
    maxBackgroundHops: deps.maxBackgroundHops,
    isTurnInFlight: (key) => turnFlight.isTurnInFlight(key),
    logger: deps.logger,
  });

  return {
    runner: {
      // Reverse-order shutdown: runner first (stops accepting events), then
      // dispatcher (the at-most-once gate), then the turn-flight tracker
      // (the oracle both consult).
      async shutdown(): Promise<void> {
        await runner.shutdown();
        await dispatcher.shutdown();
        turnFlight.shutdown();
      },
    },
    dispatcher,
  };
}
