// SPDX-License-Identifier: Apache-2.0
/** Daemon-owned direct implementation of the scheduler's awaited runtime seam. */
import type {
  ComisLogger,
} from "@comis/core";
import type {
  CronRuntimeError,
  CronRuntimeExecutionInput,
  CronRuntimeExecutor,
  CronRuntimeOutcome,
} from "@comis/scheduler";
import {
  CronRuntimeExecutionInputSchema,
  CronRuntimeOutcomeSchema,
} from "@comis/scheduler";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import {
  createCronSettledDelivery,
  type CronSettledDeliveryDeps,
} from "./cron-settled-delivery.js";

type HeartbeatInput = Extract<CronRuntimeExecutionInput, { kind: "heartbeat_event" }>;
type AgentTurnInput = Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }>;
type InternalActionInput = Extract<CronRuntimeExecutionInput, { kind: "internal_action" }>;

export interface DaemonCronRuntimeExecutorDeps extends CronSettledDeliveryDeps {
  dispatchHeartbeatEvent: (
    input: HeartbeatInput,
    signal: AbortSignal,
  ) => Promise<Result<{
    correlationId: string;
    queueDisposition: "accepted" | "accepted_oldest_dropped" | "duplicate";
  }, CronRuntimeError>>;
  executeAgentTurn: (
    input: AgentTurnInput,
    signal: AbortSignal,
  ) => Promise<Result<CronRuntimeOutcome, CronRuntimeError>>;
  executeInternalAction: (
    input: InternalActionInput,
    signal: AbortSignal,
  ) => Promise<Result<CronRuntimeOutcome, CronRuntimeError>>;
  logger: ComisLogger;
}

export function createDaemonCronRuntimeExecutor(
  deps: DaemonCronRuntimeExecutorDeps,
): CronRuntimeExecutor {
  const deliverCronText = createCronSettledDelivery(deps);
  return {
    async execute(inputValue, signal) {
      const parsed = CronRuntimeExecutionInputSchema.safeParse(inputValue);
      if (!parsed.success) {
        return err(runtimeError("invalid_input", "validation", "Cron runtime input failed strict validation"));
      }
      const input = parsed.data;
      switch (input.kind) {
        case "heartbeat_event":
          return executeHeartbeat(input, signal);
        case "delivery_only":
          return executeDirectDelivery(input, signal);
        case "agent_turn":
          return executeGoverned("agent_turn", () => deps.executeAgentTurn(input, signal), input.executionId);
        case "internal_action":
          return executeGoverned("internal_action", () => deps.executeInternalAction(input, signal), input.executionId);
        default: {
          const _exhaustive: never = input;
          return err(runtimeError("invalid_input", "validation", `Unsupported cron runtime input: ${String(_exhaustive)}`));
        }
      }
    },
  };

  async function executeHeartbeat(
    input: HeartbeatInput,
    signal: AbortSignal,
  ): Promise<Result<CronRuntimeOutcome, CronRuntimeError>> {
    if (signal.aborted) {
      return err(runtimeError("dispatch_rejected", "precondition", "Cron heartbeat dispatch was cancelled"));
    }
    const dispatched = await invokeBoundary(
      () => deps.dispatchHeartbeatEvent(input, signal),
      input.executionId,
      "heartbeat_dispatch",
    );
    if (!dispatched.ok) return dispatched;
    if (!dispatched.value.ok) return dispatched.value;
    return ok({
      kind: "heartbeat_event",
      status: "dispatched",
      correlationId: dispatched.value.value.correlationId,
      queueDisposition: dispatched.value.value.queueDisposition,
    });
  }

  async function executeDirectDelivery(
    input: Extract<CronRuntimeExecutionInput, { kind: "delivery_only" }>,
    signal: AbortSignal,
  ): Promise<Result<CronRuntimeOutcome, CronRuntimeError>> {
    const delivery = await deliverCronText({
      executionId: input.executionId,
      jobId: input.job.id,
      text: input.job.payload.text,
      target: input.job.deliveryTarget,
      signal,
    });
    return ok({ kind: "delivery_only", delivery });
  }

  async function executeGoverned(
    kind: "agent_turn" | "internal_action",
    operation: () => Promise<Result<CronRuntimeOutcome, CronRuntimeError>>,
    executionId: string,
  ): Promise<Result<CronRuntimeOutcome, CronRuntimeError>> {
    const invoked = await invokeBoundary(operation, executionId, kind);
    if (!invoked.ok) return invoked;
    if (!invoked.value.ok) return invoked.value;
    const parsed = CronRuntimeOutcomeSchema.safeParse(invoked.value.value);
    if (!parsed.success) {
      return err(runtimeError("dispatch_rejected", "validation", "Cron runtime dependency returned invalid terminal evidence"));
    }
    return ok(parsed.data);
  }

  async function invokeBoundary<T>(
    operation: () => Promise<T>,
    executionId: string,
    step: string,
  ): Promise<Result<T, CronRuntimeError>> {
    const invoked = await fromPromise(operation());
    if (invoked.ok) return invoked;
    deps.logger.error({
      executionId,
      step,
      errorKind: "internal" as const,
      hint: "Inspect the daemon cron runtime dependency and preserve the durable claim for reconciliation",
    }, "Cron runtime dependency rejected");
    return err(runtimeError("dispatch_rejected", "internal", "Cron runtime dependency rejected"));
  }
}

function runtimeError(
  code: CronRuntimeError["code"],
  errorKind: CronRuntimeError["errorKind"],
  message: string,
): CronRuntimeError {
  return { code, errorKind, message };
}
