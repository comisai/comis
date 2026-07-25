// SPDX-License-Identifier: Apache-2.0
/** Atomic cron-event admission into the owning agent's typed heartbeat lane. */
import type { ClockPort, ComisLogger } from "@comis/core";
import type {
  CronRuntimeError,
  CronRuntimeExecutionInput,
  SystemEventWakeAdmissionOutcome,
  SystemEventWakeAdmissionRequest,
  SystemEventWakeAdmissionError,
} from "@comis/scheduler";
import { err, ok, type Result } from "@comis/shared";

type HeartbeatInput = Extract<CronRuntimeExecutionInput, { kind: "heartbeat_event" }>;

export interface CronHeartbeatDispatcherDeps {
  clock: ClockPort;
  coordinator: {
    admitSystemEventWake(
      request: SystemEventWakeAdmissionRequest,
    ): Result<SystemEventWakeAdmissionOutcome, SystemEventWakeAdmissionError>;
  };
  resolveNextPeriodicPhaseMs: (
    agentId: string,
  ) => Result<number, { message: string; errorKind: "validation" | "precondition" }>;
  logger: Pick<ComisLogger, "debug">;
}

export function createCronHeartbeatDispatcher(deps: CronHeartbeatDispatcherDeps) {
  return async (
    input: HeartbeatInput,
    signal: AbortSignal,
  ): Promise<Result<{
    correlationId: string;
    queueDisposition: "accepted" | "accepted_oldest_dropped" | "duplicate";
  }, CronRuntimeError>> => {
    if (signal.aborted) {
      return err(runtimeError("dispatch_rejected", "precondition", "Cron heartbeat dispatch was cancelled"));
    }
    const wakeMode = input.job.payload.wakeMode;
    let notBeforeMs: number;
    if (wakeMode === "next-heartbeat") {
      const nextPhase = deps.resolveNextPeriodicPhaseMs(input.job.agentId);
      if (!nextPhase.ok) {
        return err(runtimeError("precondition_failed", nextPhase.error.errorKind, nextPhase.error.message));
      }
      notBeforeMs = nextPhase.value;
    } else {
      notBeforeMs = deps.clock.now();
    }
    if (signal.aborted) {
      return err(runtimeError("dispatch_rejected", "precondition", "Cron heartbeat dispatch was cancelled"));
    }

    const admitted = deps.coordinator.admitSystemEventWake({
      target: { kind: "agent", agentId: input.job.agentId },
      reason: "cron",
      wakeMode,
      notBeforeMs,
      event: {
        trigger: "cron",
        contextKey: `cron:${input.executionId}`,
        text: input.job.payload.text,
      },
    });
    if (!admitted.ok) return err(mapAdmissionError(admitted.error));
    deps.logger.debug({
      agentId: input.job.agentId,
      executionId: input.executionId,
      correlationId: admitted.value.wake.correlationId,
      queueDisposition: admitted.value.queueDisposition,
      wakeDisposition: admitted.value.wake.status === "coalesced"
        ? "coalesced"
        : admitted.value.wake.disposition,
      wakeMode,
      step: "heartbeat_admission",
    }, "Cron heartbeat event atomically admitted");
    return ok({
      correlationId: admitted.value.wake.correlationId,
      queueDisposition: admitted.value.queueDisposition,
    });
  };
}

function mapAdmissionError(error: SystemEventWakeAdmissionError): CronRuntimeError {
  switch (error.code) {
    case "invalid_request":
    case "invalid_target":
      return runtimeError("invalid_input", "validation", "Cron heartbeat admission failed validation");
    case "not_accepting":
      return runtimeError("precondition_failed", "precondition", "Heartbeat coordinator is not accepting this occurrence");
    case "queue_full":
      return runtimeError("dispatch_rejected", "resource", "Heartbeat event queue has no evictable capacity");
    default: {
      const _exhaustive: never = error;
      return runtimeError("dispatch_rejected", "internal", `Unsupported heartbeat admission error: ${String(_exhaustive)}`);
    }
  }
}

function runtimeError(
  code: CronRuntimeError["code"],
  errorKind: CronRuntimeError["errorKind"],
  message: string,
): CronRuntimeError {
  return { code, errorKind, message };
}
