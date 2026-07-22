// SPDX-License-Identifier: Apache-2.0
/** Exact-origin preflight and settled delivery for inferred follow-up tasks. */
import {
  BackgroundTaskOriginSchema,
  createConversationLocator,
  emitObservationalEventSafely,
  resolvePlatformDeliveryResult,
  type BackgroundTaskOrigin,
  type ClockPort,
  type ComisLogger,
  type DeliveredAssistantHistoryPort,
  type DeliveryAdapter,
  type DeliveryService,
  type ErrorKind,
  type OutputGuardPort,
  type PlatformDeliveryOutcome,
  type TypedEventBus,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

type TaskDeliveryAdapter = DeliveryAdapter & { readonly channelId: string };

export type TaskDeliveryPrepareError =
  | { readonly code: "invalid_origin"; readonly errorKind: "validation" }
  | { readonly code: "cancelled" | "target_precondition"; readonly errorKind: "precondition" }
  | { readonly code: "output_guard"; readonly errorKind: "auth" | "internal" };

export type TaskSettledDeliveryOutcome =
  | (Extract<PlatformDeliveryOutcome, { status: "accepted" }> & {
    readonly history:
      | { readonly status: "appended" | "already_present" }
      | { readonly status: "failed"; readonly errorKind: ErrorKind };
  })
  | Exclude<PlatformDeliveryOutcome, { status: "accepted" }>;

export interface PreparedTaskDelivery {
  readonly attemptId: string;
  readonly agentExecutionId: string;
  readonly rootRunId: string;
  readonly taskIds: readonly string[];
  readonly origin: BackgroundTaskOrigin;
  readonly adapter: TaskDeliveryAdapter;
  readonly deliveredText: string;
  readonly signal: AbortSignal;
  readonly conversation: ReturnType<typeof createConversationLocator> extends Result<infer T, unknown> ? T : never;
}

export interface TaskSettledDeliveryRequest {
  readonly attemptId: string;
  readonly agentExecutionId: string;
  readonly rootRunId: string;
  readonly taskIds: readonly string[];
  readonly origin: BackgroundTaskOrigin;
  readonly text: string;
  readonly signal: AbortSignal;
}

export interface TaskSettledDeliveryDeps {
  readonly clock: ClockPort;
  readonly adaptersByType: ReadonlyMap<string, TaskDeliveryAdapter>;
  readonly deliveryService: DeliveryService;
  readonly outputGuard: Pick<OutputGuardPort, "scan">;
  readonly deliveredHistory: DeliveredAssistantHistoryPort;
  readonly eventBus: TypedEventBus;
  readonly logger: Pick<ComisLogger, "warn" | "error">;
}

export interface TaskSettledDelivery {
  prepare(request: TaskSettledDeliveryRequest): Result<PreparedTaskDelivery, TaskDeliveryPrepareError>;
  deliver(prepared: PreparedTaskDelivery): Promise<TaskSettledDeliveryOutcome>;
}

export function createTaskSettledDelivery(deps: TaskSettledDeliveryDeps): TaskSettledDelivery {
  return {
    prepare(request) {
      if (request.signal.aborted) return err({ code: "cancelled", errorKind: "precondition" });
      const parsedOrigin = BackgroundTaskOriginSchema.safeParse(request.origin);
      if (!parsedOrigin.success) return err({ code: "invalid_origin", errorKind: "validation" });
      const scanned = deps.outputGuard.scan(request.text);
      if (!scanned.ok || scanned.value.blocked) {
        return err({
          code: "output_guard",
          errorKind: scanned.ok ? "auth" : "internal",
        });
      }
      if (request.signal.aborted) return err({ code: "cancelled", errorKind: "precondition" });
      const endpoint = parsedOrigin.data.turnScope.endpoint;
      const adapter = deps.adaptersByType.get(endpoint.channelType);
      if (adapter === undefined || adapter.channelId !== endpoint.channelInstanceId) {
        deps.logger.warn({
          attemptId: request.attemptId,
          agentId: parsedOrigin.data.turnScope.conversation.agentId,
          channelType: endpoint.channelType,
          channelInstanceId: endpoint.channelInstanceId,
          errorKind: "precondition" as const,
          hint: "Start the exact channel adapter instance captured by the task origin before retrying",
        }, "Task delivery target is not bound");
        return err({ code: "target_precondition", errorKind: "precondition" });
      }
      const conversation = createConversationLocator(parsedOrigin.data.turnScope.conversation);
      if (!conversation.ok || conversation.value.conversationRef !== parsedOrigin.data.conversationRef) {
        return err({ code: "invalid_origin", errorKind: "validation" });
      }
      return ok({
        attemptId: request.attemptId,
        agentExecutionId: request.agentExecutionId,
        rootRunId: request.rootRunId,
        taskIds: [...request.taskIds],
        origin: parsedOrigin.data,
        adapter,
        deliveredText: scanned.value.sanitized,
        signal: request.signal,
        conversation: conversation.value,
      });
    },

    async deliver(prepared) {
      const endpoint = prepared.origin.turnScope.endpoint;
      let delivered: Awaited<ReturnType<DeliveryService["deliverToChannel"]>>;
      try {
        delivered = await deps.deliveryService.deliverToChannel(
          prepared.adapter,
          endpoint.conversationId,
          prepared.deliveredText,
          {
            completionMode: "settled",
            authority: {
              tenantId: prepared.origin.turnScope.conversation.tenantId,
              agentId: prepared.origin.turnScope.conversation.agentId,
              conversationRef: prepared.origin.conversationRef,
            },
            destinationEndpoint: endpoint,
            ...(endpoint.threadId === undefined ? {} : { threadId: endpoint.threadId }),
            origin: "task-check",
            abortSignal: prepared.signal,
          },
        );
      } catch {
        deps.logger.error({
          attemptId: prepared.attemptId,
          agentId: prepared.origin.turnScope.conversation.agentId,
          step: "task_platform_delivery",
          errorKind: "dependency" as const,
          hint: "Inspect the exact channel adapter; the task outcome remains unknown and must not be replayed",
        }, "Task settled delivery rejected");
        return unknownDelivery(deps.clock.now());
      }
      const resolved = resolvePlatformDeliveryResult(delivered);
      if (!resolved.ok) return unknownDelivery(deps.clock.now());
      const platform = resolved.value.platform;
      if (platform.status !== "accepted") return platform;

      const historyStartedAtMs = deps.clock.now();
      const history = await deps.deliveredHistory.append({
        conversation: prepared.conversation,
        deliveredText: prepared.deliveredText,
        sourceExecutionId: prepared.agentExecutionId,
        attemptId: prepared.attemptId,
        ...(platform.lastMessageId === undefined ? {} : { lastPlatformMessageId: platform.lastMessageId }),
        deliveredAtMs: platform.settledAtMs,
      });
      if (history.ok) return { ...platform, history: { status: history.value } };

      deps.logger.warn({
        attemptId: prepared.attemptId,
        agentId: prepared.origin.turnScope.conversation.agentId,
        step: "task_history_append",
        errorKind: history.error.errorKind,
        hint: "Inspect origin session storage; delivery is accepted and will not be replayed",
      }, "Task delivery history append failed");
      const historyFinishedAtMs = deps.clock.now();
      emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "scheduler:task_delivery_history_failed", {
        attemptId: prepared.attemptId,
        agentId: prepared.origin.turnScope.conversation.agentId,
        rootRunId: prepared.rootRunId,
        taskIds: prepared.taskIds,
        errorKind: history.error.errorKind,
        durationMs: Math.max(0, historyFinishedAtMs - historyStartedAtMs),
        timestamp: historyFinishedAtMs,
      });
      return { ...platform, history: { status: "failed", errorKind: history.error.errorKind } };
    },
  };
}

function unknownDelivery(settledAtMs: number): TaskSettledDeliveryOutcome {
  return {
    status: "unknown",
    errorKind: "dependency",
    deliveredChunks: 0,
    failedChunks: 1,
    ambiguousChunks: 1,
    settledAtMs,
  };
}
