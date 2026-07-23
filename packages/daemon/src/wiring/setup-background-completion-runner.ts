// SPDX-License-Identifier: Apache-2.0
/**
 * Background completion dispatcher + runner wiring for daemon startup.
 *
 * Subscribes the observational dispatcher before the durable completion
 * runner. The runner is the only owner of execution and delivery transitions.
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
  type BackgroundCompletionDeliveryOutcome,
  type BackgroundTaskManager,
  type CompletionDispatcher,
  type NotifyFn,
} from "@comis/agent";
import {
  resolvePlatformDeliveryResult,
  isPermanentError,
  type ChannelPort,
  type DeliveryService,
  type OutwardSendLedgerPort,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok } from "@comis/shared";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor } from "@comis/agent";
import type { RunnerSessionStore } from "@comis/agent";
import { wrapOutwardSend } from "../api/outward-ledger-wrap.js";

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
  taskManager: Pick<
    BackgroundTaskManager,
    "getTask" | "transitionDispatchState" | "persistContinuationOutbox" | "scheduleDispatchRetry"
  >;
  /** bgNotifyFn closure used when the originating session is gone. */
  fallbackNotifyFn: NotifyFn;
  outwardLedger?: OutwardSendLedgerPort;
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
  async function deliver(
    input: Parameters<BackgroundCompletionRunnerDeps["deliverCompletion"]>[0],
  ): Promise<BackgroundCompletionDeliveryOutcome> {
    const { origin, response, idempotencyKey } = input;
    const endpoint = origin.turnScope.endpoint;
    const adapter = deps.adaptersByType.get(endpoint.channelType);
    if (adapter === undefined || adapter.channelId !== endpoint.channelInstanceId) {
      return {
        kind: "retryable_pre_send",
        errorKind: "precondition" as const,
        message: "The originating channel adapter instance is not active",
      };
    }
    const rootRunId = `background-task:${input.taskId}`;
    const allocated = deps.outwardLedger
      ? await deps.outwardLedger.allocateStep(rootRunId, idempotencyKey)
      : ok<number | undefined>(undefined);
    if (!allocated.ok) {
      return {
        kind: "retryable_pre_send",
        errorKind: "dependency",
        message: allocated.error.message,
      };
    }
    const attemptedSend = await fromPromise(wrapOutwardSend({
      ledger: deps.outwardLedger,
      rootRunId,
      outwardStepIndex: allocated.value,
      agentId: origin.turnScope.conversation.agentId,
      channelType: endpoint.channelType,
      channelId: endpoint.conversationId,
      operationKind: "message_send",
      text: response,
      logger: deps.logger,
      doSend: async () => {
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
        if (!attempted.ok) return attempted;
        const resolved = resolvePlatformDeliveryResult(attempted.value);
        if (!resolved.ok) return err(new Error(resolved.error.message));
        if (resolved.value.platform.status !== "accepted") {
          return err(new Error("The response was not fully accepted by the originating platform"));
        }
        const messageId = resolved.value.platform.lastMessageId;
        return messageId
          ? ok({ messageId })
          : deps.outwardLedger
            ? err(new Error("The originating platform did not return a delivery receipt"))
            : ok({ messageId: idempotencyKey });
      },
    }));
    let failure: unknown;
    if (!attemptedSend.ok) {
      failure = attemptedSend.error;
    } else if (!attemptedSend.value.ok) {
      failure = attemptedSend.value.error;
    } else {
      return { kind: "accepted" };
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    if (!deps.outwardLedger || allocated.value === undefined) {
      return isPermanentError(message)
        ? { kind: "permanent", errorKind: "platform", message }
        : { kind: "uncertain", errorKind: "dependency", message };
    }
    const retained = await deps.outwardLedger.lookup(rootRunId, allocated.value);
    if (!retained.ok) {
      return { kind: "uncertain", errorKind: "dependency", message: retained.error.message };
    }
    if (retained.value === undefined) {
      return { kind: "retryable_pre_send", errorKind: "dependency", message };
    }
    switch (retained.value.state) {
      case "committed":
        return { kind: "accepted" };
      case "failed":
        return { kind: "permanent", errorKind: "platform", message };
      case "send_attempt_started":
      case "unknown_after_send":
      case "unresolved":
        return { kind: "uncertain", errorKind: "dependency", message };
      default: {
        const _exhaustive: never = retained.value.state;
        return _exhaustive;
      }
    }
  }
  // LIVE-TURN oracle shared by dispatcher + runner: a tool auto-backgrounded
  // mid-turn is consumed by its own still-running turn (the background_tasks
  // stub protocol), so a completion landing while the origin turn is in
  // flight fires NO raw fallback notice and NO re-entry. The persistent
  // sessionStore below is near-EMPTY in DAG mode, so it cannot be this
  // oracle (the live incident: a raw 'Background task "…" completed.'
  // message mid-conversation, followed by the live turn's real answer).
  const turnFlight = createTurnFlightTracker({ eventBus: deps.eventBus });

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
    deliverCompletion: deliver,
    deliverFallback: deliver,
    deliveryProtection: deps.outwardLedger ? "ledger" : "none",
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
