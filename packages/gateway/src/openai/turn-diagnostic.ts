// SPDX-License-Identifier: Apache-2.0
import {
  sanitizeLogString,
  systemNowMs,
  type DeliveryFailureStage,
  type DeliveryStatus,
  type ErrorKind,
  type TypedEventBus,
} from "@comis/core";
import { tryCatch } from "@comis/shared";

/** Result metadata needed to describe one gateway turn without message content. */
export interface GatewayTurnResult {
  tokensUsed: { total: number };
  finishReason: string;
  stepsExecuted: number | null;
  llmCalls: number | null;
  status: DeliveryStatus;
  failureStage?: DeliveryFailureStage;
  errorKind?: ErrorKind;
  traceId?: string;
  agentId?: string;
  sessionKey?: string;
}

/** Minimal dependencies shared by OpenAI-compatible lifecycle emitters. */
export interface GatewayTurnDiagnosticDeps {
  eventBus?: Pick<TypedEventBus, "emitSafely">;
  logger: { error(...args: unknown[]): void };
}

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "DOMException",
  "Error",
  "RangeError",
  "TimeoutError",
  "TypeError",
]);

/** Content-free bounded description suitable for ERROR-level structured logs. */
export function formatGatewayErrorForLog(error: unknown): string {
  const classified = tryCatch(() => {
    if (!(error instanceof Error)) return "UnknownError";
    const errorName = error.name;
    return SAFE_ERROR_NAMES.has(errorName) ? errorName : "UnknownError";
  });
  const candidate = classified.ok ? classified.value : "UnknownError";
  return sanitizeLogString(candidate.slice(0, 64));
}

function reportDiagnosticSubscriberFailures(
  deps: GatewayTurnDiagnosticDeps,
  failures: readonly { listenerIndex: number; error: Error }[],
): void {
  for (const failure of failures) {
    void tryCatch(() => deps.logger.error(
      {
        eventName: "diagnostic:message_processed",
        listenerIndex: failure.listenerIndex,
        err: formatGatewayErrorForLog(failure.error),
        hint: "Inspect the named diagnostic subscriber; later observers and the completed gateway turn were preserved",
        errorKind: "internal" as const,
      },
      "Gateway turn diagnostic subscriber failed",
    ));
  }
}

/** Emit one canonical full-lifecycle diagnostic at the gateway boundary. */
export function emitGatewayTurnDiagnostic(
  deps: GatewayTurnDiagnosticDeps,
  args: {
    messageId: string;
    channelId: string;
    channelType: string;
    fallbackAgentId: string;
    fallbackSessionKey: string;
    fallbackTraceId: string;
    result: GatewayTurnResult;
    receivedAt: number;
    executionCompletedAt: number;
    completedAt?: number;
  },
): void {
  if (!deps.eventBus) return;
  const executionCompletedAt = Math.max(args.receivedAt, args.executionCompletedAt);
  const completedAt = Math.max(
    args.receivedAt,
    executionCompletedAt,
    args.completedAt ?? systemNowMs(),
  );
  const emission = deps.eventBus.emitSafely("diagnostic:message_processed", {
      messageId: args.messageId,
      channelId: args.channelId,
      channelType: args.channelType,
      agentId: args.result.agentId ?? args.fallbackAgentId,
      sessionKey: args.result.sessionKey ?? args.fallbackSessionKey,
      traceId: args.result.traceId ?? args.fallbackTraceId,
      toolCalls: args.result.stepsExecuted,
      llmCalls: args.result.llmCalls,
      status: args.result.status,
      ...(args.result.failureStage !== undefined
        ? { failureStage: args.result.failureStage }
        : {}),
      ...(args.result.errorKind !== undefined
        ? { errorKind: args.result.errorKind }
        : {}),
      receivedAt: args.receivedAt,
      executionDurationMs: executionCompletedAt - args.receivedAt,
      deliveryDurationMs: completedAt - executionCompletedAt,
      totalDurationMs: completedAt - args.receivedAt,
      tokensUsed: args.result.tokensUsed.total,
      cost: 0,
      finishReason: args.result.finishReason,
      timestamp: completedAt,
    });
  reportDiagnosticSubscriberFailures(deps, emission.failures);
  if (emission.pendingFailures !== undefined) {
    void emission.pendingFailures.then((failures) => {
      reportDiagnosticSubscriberFailures(deps, failures);
    });
  }
}
