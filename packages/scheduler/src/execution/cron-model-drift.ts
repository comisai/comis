// SPDX-License-Identifier: Apache-2.0
import type { EventMap, ModelResolutionSource, TypedEventBus } from "@comis/core";
import type { SchedulerLogger } from "../shared-types.js";
import type { CronExecutionTerminalRow } from "./cron-execution-record.js";
import type { ExecutionTracker } from "./execution-tracker.js";

const MAX_RETAINED_EXECUTIONS = 100_000;

type ModelEvidence = {
  executionId: string;
  modelResolved: string;
  modelResolutionSource: ModelResolutionSource;
  completed: boolean;
} & (
  | { workKind: "agent_turn" }
  | { workKind: "internal_action"; action: "memory_review" | "reflection" }
);

export async function prepareCronModelDriftEvidence(input: {
  tracker: ExecutionTracker;
  logger: SchedulerLogger;
  terminal: CronExecutionTerminalRow;
}): Promise<EventMap["scheduler:cron_model_drift"] | undefined> {
  const current = modelEvidence(input.terminal);
  if (current === undefined) return undefined;
  const history = await input.tracker.listHistory({
    jobId: input.terminal.jobId,
    limit: MAX_RETAINED_EXECUTIONS,
  });
  if (!history.ok) {
    input.logger.warn({
      executionId: input.terminal.executionId,
      jobId: input.terminal.jobId,
      step: "model_drift_lookup",
      hint: "Repair the cron execution ledger so scheduled-model drift can be observed",
      errorKind: history.error.errorKind,
    }, "Cron model drift baseline could not be read");
    return undefined;
  }
  const previous = history.value
    .map((group) => group.terminal === undefined ? undefined : modelEvidence(group.terminal))
    .find((candidate) => candidate !== undefined && candidate.completed && sameWork(current, candidate));
  if (
    previous === undefined
    || (
      previous.modelResolved === current.modelResolved
      && previous.modelResolutionSource === current.modelResolutionSource
    )
  ) return undefined;

  const common = {
    executionId: current.executionId,
    previousExecutionId: previous.executionId,
    jobId: input.terminal.jobId,
    agentId: input.terminal.agentId,
    previousModelResolved: previous.modelResolved,
    modelResolved: current.modelResolved,
    previousModelResolutionSource: previous.modelResolutionSource,
    modelResolutionSource: current.modelResolutionSource,
    timestamp: input.terminal.terminalAtMs,
  };
  return current.workKind === "agent_turn"
    ? { ...common, workKind: current.workKind }
    : { ...common, workKind: current.workKind, action: current.action };
}

export function emitCronModelDrift(input: {
  eventBus: TypedEventBus;
  logger: SchedulerLogger;
  evidence: EventMap["scheduler:cron_model_drift"];
}): void {
  input.logger.info({ ...input.evidence, step: "model_drift" }, "Cron execution model resolution changed");
  const emitted = input.eventBus.emitSafely("scheduler:cron_model_drift", input.evidence);
  if (emitted.failures.length === 0) return;
  input.logger.warn({
    executionId: input.evidence.executionId,
    jobId: input.evidence.jobId,
    event: "scheduler:cron_model_drift",
    subscriberFailures: emitted.failures.length,
    step: "event_emit",
    hint: "Inspect the failing observational subscriber; cron execution and model evidence remain durable",
    errorKind: "internal" as const,
  }, "Cron observational event subscriber failed");
}

function modelEvidence(row: CronExecutionTerminalRow): ModelEvidence | undefined {
  switch (row.outcome.kind) {
    case "agent_turn": return {
      executionId: row.executionId,
      workKind: "agent_turn",
      modelResolved: row.outcome.modelResolved,
      modelResolutionSource: row.outcome.modelResolutionSource,
      completed: row.outcome.execution.status === "completed",
    };
    case "internal_action": {
      if (
        row.outcome.action === "memory_lifecycle"
        || row.outcome.modelResolved === null
        || row.outcome.modelResolutionSource === null
      ) return undefined;
      return {
        executionId: row.executionId,
        workKind: "internal_action",
        action: row.outcome.action,
        modelResolved: row.outcome.modelResolved,
        modelResolutionSource: row.outcome.modelResolutionSource,
        completed: row.outcome.execution.status === "completed",
      };
    }
    case "wake_gate_skip":
    case "agent_turn_pre_model_skip":
    case "heartbeat_event":
    case "delivery_only":
    case "pre_dispatch_failure":
    case "unsettled": return undefined;
    default: {
      const _exhaustive: never = row.outcome;
      return _exhaustive;
    }
  }
}

function sameWork(left: ModelEvidence, right: ModelEvidence): boolean {
  if (left.workKind !== right.workKind) return false;
  return left.workKind === "agent_turn"
    || (right.workKind === "internal_action" && left.action === right.action);
}
