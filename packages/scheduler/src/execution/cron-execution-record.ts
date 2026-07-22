// SPDX-License-Identifier: Apache-2.0
import {
  ERROR_KINDS,
  SessionKeySchema,
  type ErrorKind,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";
import {
  CronContinuationOutcomeSchema,
  CronDeliveryOutcomeSchema,
  CronDirectDeliveryOutcomeSchema,
  CronWakeGateOutcomeSchema,
  InternalActionRuntimeOutcomeSchema,
} from "../cron/cron-runtime.js";
import {
  CronTriggerSchema,
  CronWorkKindSchema,
  type CronDependencyOutcome,
} from "../cron/cron-store.js";
import {
  AgentTurnExecutionOutcomeSchema,
  ModelResolutionSourceSchema,
} from "@comis/core";

const IdentifierSchema = z.string().min(1).max(256);
const RootRunIdSchema = z.string().min(1).max(512).startsWith("root-cron-");
const EpochMsSchema = z.number().int().nonnegative().safe();
const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const NonnegativeFiniteSchema = z.number().nonnegative().finite();
const ErrorKindSchema = z.enum(ERROR_KINDS);

export const CronExecutionStatusSchema = z.enum([
  "started",
  "dispatched",
  "completed",
  "failed",
  "aborted",
  "skipped",
  "unknown",
]);
export type CronExecutionStatus = z.infer<typeof CronExecutionStatusSchema>;

export const CronPreDispatchFailureStageSchema = z.enum([
  "start_record_recovery",
  "root_registration",
  "executor_not_bound",
  "executor_invalid_input",
  "executor_precondition",
  "dispatch_rejected",
]);
export type CronPreDispatchFailureStage = z.infer<typeof CronPreDispatchFailureStageSchema>;

const PreDispatchFailureSchema = z.strictObject({
  kind: z.literal("pre_dispatch_failure"),
  stage: CronPreDispatchFailureStageSchema,
  errorKind: ErrorKindSchema,
}).superRefine((outcome, ctx) => {
  const fixed = fixedPreDispatchErrorKind(outcome.stage);
  if (fixed !== undefined && fixed !== outcome.errorKind) {
    ctx.addIssue({ code: "custom", path: ["errorKind"], message: "pre-dispatch stage has a fixed error kind" });
  }
});

export const CronUnsettledOutcomeSchema = z.union([
  z.strictObject({
    kind: z.literal("unsettled"),
    reason: z.literal("deadline_termination_unestablished"),
    rootRunId: RootRunIdSchema.nullable(),
    errorKind: z.literal("timeout"),
  }),
  z.strictObject({
    kind: z.literal("unsettled"),
    reason: z.literal("owner_lost_after_start"),
    rootRunId: RootRunIdSchema.nullable(),
    errorKind: z.literal("internal"),
  }),
  z.strictObject({
    kind: z.literal("unsettled"),
    reason: z.literal("executor_rejected_after_invocation"),
    rootRunId: RootRunIdSchema.nullable(),
    errorKind: z.literal("internal"),
  }),
]);
export type CronUnsettledOutcome = z.infer<typeof CronUnsettledOutcomeSchema>;

const AgentTerminalOutcomeSchema = z.strictObject({
  kind: z.literal("agent_turn"),
  rootRunId: RootRunIdSchema,
  sessionKey: SessionKeySchema,
  agentExecutionId: IdentifierSchema,
  execution: AgentTurnExecutionOutcomeSchema,
  modelResolved: z.string().min(1).max(512),
  modelResolutionSource: ModelResolutionSourceSchema,
  metrics: z.strictObject({
    totalTokens: NonnegativeSafeIntegerSchema,
    costUsd: NonnegativeFiniteSchema,
    toolCalls: NonnegativeSafeIntegerSchema,
    llmCalls: NonnegativeSafeIntegerSchema,
  }),
  wakeGate: CronWakeGateOutcomeSchema,
  delivery: CronDeliveryOutcomeSchema,
  continuation: CronContinuationOutcomeSchema,
});

const WakeGateSkipTerminalOutcomeSchema = z.strictObject({
  kind: z.literal("wake_gate_skip"),
  rootRunId: RootRunIdSchema,
  gateDurationMs: NonnegativeSafeIntegerSchema,
  gateToolCalls: NonnegativeSafeIntegerSchema,
  delivery: CronDeliveryOutcomeSchema,
  continuation: CronContinuationOutcomeSchema,
});

const AgentPreModelSkipTerminalOutcomeSchema = z.strictObject({
  kind: z.literal("agent_turn_pre_model_skip"),
  rootRunId: RootRunIdSchema,
  reason: z.enum(["wake_gate_disabled", "wake_gate_unbound"]),
  errorKind: z.literal("precondition"),
  continuation: CronContinuationOutcomeSchema,
});

const HeartbeatTerminalOutcomeSchema = z.strictObject({
  kind: z.literal("heartbeat_event"),
  correlationId: IdentifierSchema,
  queueDisposition: z.enum(["accepted", "accepted_oldest_dropped", "duplicate"]),
});

const DeliveryOnlyTerminalOutcomeSchema = z.strictObject({
  kind: z.literal("delivery_only"),
  delivery: CronDirectDeliveryOutcomeSchema,
});

export const CronTerminalOutcomeSchema = z.union([
  AgentTerminalOutcomeSchema,
  WakeGateSkipTerminalOutcomeSchema,
  AgentPreModelSkipTerminalOutcomeSchema,
  HeartbeatTerminalOutcomeSchema,
  InternalActionRuntimeOutcomeSchema,
  DeliveryOnlyTerminalOutcomeSchema,
  PreDispatchFailureSchema,
  CronUnsettledOutcomeSchema,
]);
export type CronTerminalOutcome = z.infer<typeof CronTerminalOutcomeSchema>;

const CronExecutionRecordBaseShape = {
  executionId: IdentifierSchema,
  bootId: IdentifierSchema,
  jobId: IdentifierSchema,
  agentId: IdentifierSchema,
  scheduledForMs: EpochMsSchema,
  trigger: CronTriggerSchema,
};

export const CronExecutionStartedRowSchema = z.strictObject({
  ...CronExecutionRecordBaseShape,
  recordType: z.literal("started"),
  workKind: CronWorkKindSchema,
  rootRunId: RootRunIdSchema.nullable(),
  startedAtMs: EpochMsSchema,
}).superRefine((row, ctx) => {
  const governed = row.workKind === "agent_turn" || row.workKind === "internal_action";
  if (governed !== (row.rootRunId !== null)) {
    ctx.addIssue({ code: "custom", path: ["rootRunId"], message: "started-row root legality does not match work kind" });
  }
});
export type CronExecutionStartedRow = z.infer<typeof CronExecutionStartedRowSchema>;

export const CronExecutionTerminalRowSchema = z.strictObject({
  ...CronExecutionRecordBaseShape,
  recordType: z.literal("terminal"),
  workKind: CronWorkKindSchema,
  terminalAtMs: EpochMsSchema,
  durationMs: NonnegativeSafeIntegerSchema,
  outcome: CronTerminalOutcomeSchema,
}).superRefine((row, ctx) => {
  const expected = workKindForTerminal(row.outcome);
  if (expected !== undefined && expected !== row.workKind) {
    ctx.addIssue({ code: "custom", path: ["outcome", "kind"], message: "terminal outcome does not match work kind" });
  }
});
export type CronExecutionTerminalRow = z.infer<typeof CronExecutionTerminalRowSchema>;

export const CronExecutionRowSchema = z.union([
  CronExecutionStartedRowSchema,
  CronExecutionTerminalRowSchema,
]);
export type CronExecutionRow = z.infer<typeof CronExecutionRowSchema>;

export type CronExecutionRowEncodingError = {
  code: "invalid_row";
  errorKind: "validation";
  message: string;
};

export function encodeCronExecutionRow(
  row: CronExecutionRow,
): Result<Buffer, CronExecutionRowEncodingError> {
  const parsed = CronExecutionRowSchema.safeParse(row);
  return parsed.success
    ? ok(Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8"))
    : err({ code: "invalid_row", errorKind: "validation", message: "Invalid cron execution row" });
}

export type CronDeliveryProjectionStatus =
  | "not_requested"
  | "suppressed"
  | "pre_send_failed"
  | "accepted"
  | "partial"
  | "rejected"
  | "unknown";

export type CronTerminalProjection = {
  status: Exclude<CronExecutionStatus, "started">;
  deliveryStatus: CronDeliveryProjectionStatus;
  errorKind?: ErrorKind;
};

export function projectCronTerminalOutcome(outcome: CronTerminalOutcome): CronTerminalProjection {
  switch (outcome.kind) {
    case "agent_turn": {
      const delivery = projectDelivery(outcome.delivery);
      switch (outcome.execution.status) {
        case "completed": return withOptionalError("completed", delivery.status, delivery.errorKind);
        case "failed": return withOptionalError("failed", delivery.status, outcome.execution.errorKind);
        case "aborted": return withOptionalError(
          "aborted",
          delivery.status,
          "errorKind" in outcome.execution ? outcome.execution.errorKind : undefined,
        );
        case "unknown": return withOptionalError("unknown", delivery.status, outcome.execution.errorKind);
        default: {
          const _exhaustive: never = outcome.execution;
          return _exhaustive;
        }
      }
    }
    case "wake_gate_skip": {
      const delivery = projectDelivery(outcome.delivery);
      return withOptionalError("skipped", delivery.status, delivery.errorKind);
    }
    case "agent_turn_pre_model_skip":
      return { status: "skipped", deliveryStatus: "not_requested", errorKind: outcome.errorKind };
    case "heartbeat_event":
      return { status: "dispatched", deliveryStatus: "not_requested" };
    case "internal_action":
      switch (outcome.execution.status) {
        case "completed": return { status: "completed", deliveryStatus: "not_requested" };
        case "failed": return { status: "failed", deliveryStatus: "not_requested", errorKind: outcome.execution.errorKind };
        case "aborted": return { status: "aborted", deliveryStatus: "not_requested" };
        case "skipped": return { status: "skipped", deliveryStatus: "not_requested" };
        case "unknown": return { status: "unknown", deliveryStatus: "not_requested", errorKind: outcome.execution.errorKind };
        default: {
          const _exhaustive: never = outcome.execution;
          return _exhaustive;
        }
      }
    case "delivery_only": {
      const delivery = projectDelivery(outcome.delivery);
      switch (outcome.delivery.status) {
        case "accepted": return { status: "completed", deliveryStatus: delivery.status };
        case "suppressed": return { status: "skipped", deliveryStatus: delivery.status };
        case "pre_send_failed": return { status: "failed", deliveryStatus: delivery.status, errorKind: outcome.delivery.errorKind };
        case "partial":
        case "rejected": return { status: "failed", deliveryStatus: delivery.status, errorKind: outcome.delivery.errorKind };
        case "unknown": return { status: "unknown", deliveryStatus: delivery.status, errorKind: outcome.delivery.errorKind };
        default: {
          const _exhaustive: never = outcome.delivery;
          return _exhaustive;
        }
      }
    }
    case "pre_dispatch_failure":
      return { status: "failed", deliveryStatus: "not_requested", errorKind: outcome.errorKind };
    case "unsettled":
      return { status: "unknown", deliveryStatus: "not_requested", errorKind: outcome.errorKind };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export function classifyCronDependencyOutcome(
  outcome: CronTerminalOutcome,
): CronDependencyOutcome {
  switch (outcome.kind) {
    case "agent_turn":
      if (outcome.execution.status === "completed") return "success";
      return outcome.execution.status === "failed" && outcome.execution.errorKind === "dependency"
        ? "dependency_error"
        : "neutral";
    case "internal_action":
      if (outcome.modelResolved !== null && outcome.execution.status === "completed") return "success";
      return outcome.execution.status === "failed" && outcome.execution.errorKind === "dependency"
        ? "dependency_error"
        : "neutral";
    case "wake_gate_skip":
    case "agent_turn_pre_model_skip":
    case "heartbeat_event":
    case "delivery_only":
    case "pre_dispatch_failure":
    case "unsettled": return "neutral";
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function projectDelivery(delivery: z.infer<typeof CronDeliveryOutcomeSchema>): {
  status: CronDeliveryProjectionStatus;
  errorKind?: ErrorKind;
} {
  switch (delivery.status) {
    case "not_requested":
    case "suppressed":
    case "accepted": return { status: delivery.status };
    case "pre_send_failed":
    case "partial":
    case "rejected":
    case "unknown": return { status: delivery.status, errorKind: delivery.errorKind };
    default: {
      const _exhaustive: never = delivery;
      return _exhaustive;
    }
  }
}

function withOptionalError(
  status: CronTerminalProjection["status"],
  deliveryStatus: CronDeliveryProjectionStatus,
  errorKind: ErrorKind | undefined,
): CronTerminalProjection {
  return errorKind === undefined ? { status, deliveryStatus } : { status, deliveryStatus, errorKind };
}

function workKindForTerminal(outcome: CronTerminalOutcome): z.infer<typeof CronWorkKindSchema> | undefined {
  switch (outcome.kind) {
    case "agent_turn":
    case "wake_gate_skip":
    case "agent_turn_pre_model_skip": return "agent_turn";
    case "heartbeat_event": return "heartbeat_event";
    case "internal_action": return "internal_action";
    case "delivery_only": return "delivery_only";
    case "pre_dispatch_failure":
    case "unsettled": return undefined;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function fixedPreDispatchErrorKind(stage: CronPreDispatchFailureStage): ErrorKind | undefined {
  switch (stage) {
    case "start_record_recovery":
    case "root_registration": return "internal";
    case "executor_not_bound":
    case "executor_precondition": return "precondition";
    case "executor_invalid_input": return "validation";
    case "dispatch_rejected": return undefined;
    default: {
      const _exhaustive: never = stage;
      return _exhaustive;
    }
  }
}
