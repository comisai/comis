// SPDX-License-Identifier: Apache-2.0
import type { TypedEventBus } from "@comis/core";
import type { SchedulerLogger } from "../shared-types.js";
import {
  projectCronTerminalOutcome,
  type CronExecutionStartedRow,
  type CronExecutionTerminalRow,
  type CronTerminalOutcome,
} from "./cron-execution-record.js";

export function emitDurableCronStarted(input: {
  eventBus: TypedEventBus;
  logger: SchedulerLogger;
  start: CronExecutionStartedRow;
}): void {
  const { start } = input;
  const emitted = input.eventBus.emitSafely("scheduler:cron_execution_started", {
    executionId: start.executionId,
    bootId: start.bootId,
    jobId: start.jobId,
    agentId: start.agentId,
    scheduledForMs: start.scheduledForMs,
    trigger: start.trigger,
    workKind: start.workKind,
    rootRunId: start.rootRunId,
    startedAtMs: start.startedAtMs,
  });
  logSubscriberFailures(input.logger, "scheduler:cron_execution_started", emitted.failures.length);
}

export function emitDurableCronTerminal(input: {
  eventBus: TypedEventBus;
  logger: SchedulerLogger;
  terminal: CronExecutionTerminalRow;
}): void {
  const { terminal } = input;
  const projection = projectCronTerminalOutcome(terminal.outcome);
  const delivery = deliveryCounts(terminal.outcome);
  const disposition = queueDisposition(terminal.outcome);
  const emitted = input.eventBus.emitSafely("scheduler:cron_execution_terminal", {
    executionId: terminal.executionId,
    bootId: terminal.bootId,
    jobId: terminal.jobId,
    agentId: terminal.agentId,
    scheduledForMs: terminal.scheduledForMs,
    trigger: terminal.trigger,
    workKind: terminal.workKind,
    terminalAtMs: terminal.terminalAtMs,
    durationMs: terminal.durationMs,
    outcomeKind: terminal.outcome.kind,
    executionStatus: projection.status,
    deliveryStatus: projection.deliveryStatus,
    continuationStatus: continuationStatus(terminal.outcome),
    ...(disposition === undefined ? {} : { queueDisposition: disposition }),
    deliveredChunks: delivery.deliveredChunks,
    failedChunks: delivery.failedChunks,
    ambiguousChunks: delivery.ambiguousChunks,
    ...(projection.errorKind === undefined ? {} : { errorKind: projection.errorKind }),
  });
  logSubscriberFailures(input.logger, "scheduler:cron_execution_terminal", emitted.failures.length);
}

function logSubscriberFailures(logger: SchedulerLogger, event: string, count: number): void {
  if (count === 0) return;
  logger.warn({
    event,
    subscriberFailures: count,
    step: "event_emit",
    hint: "Inspect the failing observational subscriber; cron ownership remains in the durable store and ledger",
    errorKind: "internal" as const,
  }, "Cron observational event subscriber failed");
}

function deliveryCounts(outcome: CronTerminalOutcome): {
  deliveredChunks: number;
  failedChunks: number;
  ambiguousChunks: number;
} {
  const delivery = outcome.kind === "agent_turn" || outcome.kind === "wake_gate_skip" || outcome.kind === "delivery_only"
    ? outcome.delivery
    : undefined;
  if (delivery === undefined) return { deliveredChunks: 0, failedChunks: 0, ambiguousChunks: 0 };
  switch (delivery.status) {
    case "accepted": return { deliveredChunks: delivery.deliveredChunks, failedChunks: 0, ambiguousChunks: 0 };
    case "partial": return { deliveredChunks: delivery.deliveredChunks, failedChunks: delivery.failedChunks, ambiguousChunks: 0 };
    case "rejected": return { deliveredChunks: 0, failedChunks: delivery.failedChunks, ambiguousChunks: 0 };
    case "unknown": return {
      deliveredChunks: delivery.deliveredChunks,
      failedChunks: delivery.failedChunks,
      ambiguousChunks: delivery.ambiguousChunks,
    };
    case "not_requested":
    case "suppressed":
    case "pre_send_failed": return { deliveredChunks: 0, failedChunks: 0, ambiguousChunks: 0 };
    default: {
      const _exhaustive: never = delivery;
      return _exhaustive;
    }
  }
}

function continuationStatus(outcome: CronTerminalOutcome):
  | "not_requested" | "admitted" | "skipped" | "failed" | "appended" | "already_present" {
  if (outcome.kind !== "agent_turn" && outcome.kind !== "wake_gate_skip" && outcome.kind !== "agent_turn_pre_model_skip") {
    return "not_requested";
  }
  return outcome.continuation.status;
}

function queueDisposition(outcome: CronTerminalOutcome): "accepted" | "accepted_oldest_dropped" | "duplicate" | undefined {
  if (outcome.kind === "heartbeat_event") return outcome.queueDisposition;
  if (
    (outcome.kind === "agent_turn" || outcome.kind === "wake_gate_skip")
    && outcome.continuation.mode === "heartbeat_excerpt"
    && outcome.continuation.status === "admitted"
  ) return outcome.continuation.queueDisposition;
  return undefined;
}
