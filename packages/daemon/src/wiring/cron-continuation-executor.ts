// SPDX-License-Identifier: Apache-2.0
/** Closed execution of cron continuation modes after computation and delivery settle. */
import type { ComisLogger, ErrorKind } from "@comis/core";
import type {
  CronContinuationOutcome,
  CronDeliveryOutcome,
  CronRuntimeExecutionInput,
  SystemEventWakeAdmissionError,
  SystemEventWakeAdmissionOutcome,
  SystemEventWakeAdmissionRequest,
} from "@comis/scheduler";
import type { Result } from "@comis/shared";

type AgentTurnInput = Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }>;
const MAX_HEARTBEAT_EXCERPT_BYTES = 4 * 1024;

export interface CronContinuationExecutorRequest {
  input: AgentTurnInput;
  sourceExecutionId: string;
  visibleText: string;
  delivery: CronDeliveryOutcome;
  signal: AbortSignal;
}

export interface CronContinuationExecutorDeps {
  continueOriginHistory(request: CronContinuationExecutorRequest): Promise<CronContinuationOutcome>;
  resolveNextPeriodicPhaseMs(
    agentId: string,
  ): Result<number, { message: string; errorKind: "validation" | "precondition" }>;
  coordinator: {
    admitSystemEventWake(
      request: SystemEventWakeAdmissionRequest,
    ): Result<SystemEventWakeAdmissionOutcome, SystemEventWakeAdmissionError>;
  };
  logger: Pick<ComisLogger, "warn">;
}

function utf8Excerpt(value: string): string {
  let result = "";
  let bytes = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > MAX_HEARTBEAT_EXCERPT_BYTES) break;
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

function lengthDelimited(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function createCronContinuationExecutor(deps: CronContinuationExecutorDeps) {
  return async function continueCronTurn(
    request: CronContinuationExecutorRequest,
  ): Promise<CronContinuationOutcome> {
    const mode = request.input.job.continuationMode;
    if (mode === "origin_history") return deps.continueOriginHistory(request);
    if (mode === "none") return { mode: "none", status: "not_requested" };
    if (request.signal.aborted) {
      return { mode, status: "failed", errorKind: "precondition" };
    }
    const nextPhase = deps.resolveNextPeriodicPhaseMs(request.input.job.agentId);
    if (!nextPhase.ok) {
      logFailure(request, nextPhase.error.errorKind, "periodic_phase_unavailable");
      return { mode, status: "failed", errorKind: nextPhase.error.errorKind };
    }
    const excerpt = utf8Excerpt(request.visibleText);
    if (excerpt.length === 0) {
      logFailure(request, "validation", "empty_excerpt");
      return { mode, status: "failed", errorKind: "validation" };
    }
    const continuationKind = "heartbeat_excerpt";
    const admitted = deps.coordinator.admitSystemEventWake({
      target: { kind: "agent", agentId: request.input.job.agentId },
      reason: "cron",
      wakeMode: "next-heartbeat",
      notBeforeMs: nextPhase.value,
      event: {
        trigger: "cron",
        contextKey: `${lengthDelimited(request.input.executionId)}${lengthDelimited(continuationKind)}`,
        text: excerpt,
      },
    });
    if (!admitted.ok) {
      logFailure(request, admitted.error.errorKind, admitted.error.code);
      return { mode, status: "failed", errorKind: admitted.error.errorKind };
    }
    if (admitted.value.queueDisposition === "accepted_oldest_dropped") {
      deps.logger.warn({
        executionId: request.input.executionId,
        jobId: request.input.job.id,
        agentId: request.input.job.agentId,
        step: "heartbeat_excerpt",
        errorKind: "resource" as const,
        hint: "Inspect heartbeat drain frequency; the bounded event queue dropped its oldest unsealed entry.",
      }, "Cron heartbeat excerpt admission degraded");
    }
    return {
      mode,
      status: "admitted",
      correlationId: admitted.value.wake.correlationId,
      queueDisposition: admitted.value.queueDisposition,
    };
  };

  function logFailure(
    request: CronContinuationExecutorRequest,
    errorKind: ErrorKind,
    failureCode: string,
  ): void {
    deps.logger.warn({
      executionId: request.input.executionId,
      jobId: request.input.job.id,
      agentId: request.input.job.agentId,
      step: "heartbeat_excerpt",
      failureCode,
      errorKind,
      hint: "Enable a periodic heartbeat and inspect atomic system-event queue capacity; the cron computation remains terminal.",
    }, "Cron heartbeat excerpt continuation failed");
  }
}
