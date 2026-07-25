// SPDX-License-Identifier: Apache-2.0
/** Exact, idempotent origin-history append after positively accepted cron delivery. */
import type {
  ComisLogger,
  DeliveredAssistantHistoryPort,
} from "@comis/core";
import type {
  CronContinuationOutcome,
  CronDeliveryOutcome,
  CronRuntimeExecutionInput,
} from "@comis/scheduler";
import { fromPromise } from "@comis/shared";

type AgentTurnInput = Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }>;

export interface CronOriginHistoryContinuationDeps {
  history: DeliveredAssistantHistoryPort;
  logger: Pick<ComisLogger, "warn">;
}

export interface CronOriginHistoryContinuationRequest {
  input: AgentTurnInput;
  sourceExecutionId: string;
  visibleText: string;
  delivery: CronDeliveryOutcome;
}

export function createCronOriginHistoryContinuation(
  deps: CronOriginHistoryContinuationDeps,
) {
  return async function continueOriginHistory(
    request: CronOriginHistoryContinuationRequest,
  ): Promise<CronContinuationOutcome> {
    const target = request.input.job.deliveryTarget;
    if (request.delivery.status !== "accepted" || target === undefined) {
      return {
        mode: "origin_history",
        status: "skipped",
        reason: "delivery_not_accepted",
      };
    }
    const appended = await fromPromise(deps.history.append({
      conversation: target.conversation,
      deliveredText: request.visibleText,
      sourceExecutionId: request.sourceExecutionId,
      attemptId: request.input.executionId,
      ...(request.delivery.lastMessageId === undefined
        ? {}
        : { lastPlatformMessageId: request.delivery.lastMessageId }),
      deliveredAtMs: request.delivery.settledAtMs,
    }));
    if (!appended.ok) {
      deps.logger.warn({
        executionId: request.input.executionId,
        jobId: request.input.job.id,
        agentId: request.input.job.agentId,
        step: "origin_history",
        historyErrorCode: "append_rejected",
        errorKind: "internal" as const,
        hint: "Inspect the locked delivered-history adapter; the accepted platform delivery must not be resent.",
      }, "Cron origin-history continuation failed");
      return { mode: "origin_history", status: "failed", errorKind: "internal" };
    }
    if (!appended.value.ok) {
      deps.logger.warn({
        executionId: request.input.executionId,
        jobId: request.input.job.id,
        agentId: request.input.job.agentId,
        step: "origin_history",
        historyErrorCode: appended.value.error.code,
        errorKind: appended.value.error.errorKind,
        hint: "Inspect the locked delivered-history adapter; the accepted platform delivery must not be resent.",
      }, "Cron origin-history continuation failed");
      return {
        mode: "origin_history",
        status: "failed",
        errorKind: appended.value.error.errorKind,
      };
    }
    return { mode: "origin_history", status: appended.value.value };
  };
}
