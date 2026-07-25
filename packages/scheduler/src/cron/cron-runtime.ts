// SPDX-License-Identifier: Apache-2.0
import {
  AgentExecutionAbortReasonSchema,
  AgentTurnExecutionOutcomeSchema,
  ERROR_KINDS,
  ModelResolutionSourceSchema,
  PlatformDeliveryOutcomeSchema,
  SessionKeySchema,
  type ErrorKind,
} from "@comis/core";
import type { Result } from "@comis/shared";
import { z } from "zod";
import {
  AuthoredAgentTurnCronJobSchema,
  AuthoredDeliveryCronJobSchema,
  AuthoredHeartbeatCronJobSchema,
  BuiltInCronJobSchema,
  CronInternalActionNameSchema,
} from "./cron-types.js";

const IdentifierSchema = z.string().min(1).max(256);
const RootRunIdSchema = z.string().min(1).max(512).startsWith("root-cron-");
const ErrorKindSchema = z.enum(ERROR_KINDS);
const EpochMsSchema = z.number().int().nonnegative().safe();
const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const NonnegativeFiniteSchema = z.number().nonnegative().finite();
const TriggerSchema = z.enum(["scheduled", "manual", "catchup"]);

const CronRuntimeInputBaseShape = {
  executionId: IdentifierSchema,
  scheduledForMs: EpochMsSchema,
  trigger: TriggerSchema,
};

export const CronRuntimeExecutionInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...CronRuntimeInputBaseShape,
    kind: z.literal("agent_turn"),
    rootRunId: RootRunIdSchema,
    job: AuthoredAgentTurnCronJobSchema,
  }),
  z.strictObject({
    ...CronRuntimeInputBaseShape,
    kind: z.literal("heartbeat_event"),
    job: AuthoredHeartbeatCronJobSchema,
  }),
  z.strictObject({
    ...CronRuntimeInputBaseShape,
    kind: z.literal("internal_action"),
    rootRunId: RootRunIdSchema,
    job: BuiltInCronJobSchema,
  }),
  z.strictObject({
    ...CronRuntimeInputBaseShape,
    kind: z.literal("delivery_only"),
    job: AuthoredDeliveryCronJobSchema,
  }),
]);
export type CronRuntimeExecutionInput = z.infer<typeof CronRuntimeExecutionInputSchema>;

export const CronDeliverySuppressionReasonSchema = z.enum(["response_filter", "quiet_hours"]);
export type CronDeliverySuppressionReason = z.infer<typeof CronDeliverySuppressionReasonSchema>;

export const CronDeliveryOutcomeSchema = z.union([
  z.strictObject({ status: z.literal("not_requested") }),
  z.strictObject({ status: z.literal("suppressed"), reason: CronDeliverySuppressionReasonSchema }),
  z.strictObject({
    status: z.literal("pre_send_failed"),
    reason: z.enum(["output_guard", "target_precondition", "cancelled"]),
    errorKind: ErrorKindSchema,
  }),
  PlatformDeliveryOutcomeSchema,
]);
export type CronDeliveryOutcome = z.infer<typeof CronDeliveryOutcomeSchema>;

export const CronDirectDeliveryOutcomeSchema = z.union([
  z.strictObject({ status: z.literal("suppressed"), reason: z.literal("quiet_hours") }),
  z.strictObject({
    status: z.literal("pre_send_failed"),
    reason: z.enum(["output_guard", "target_precondition", "cancelled"]),
    errorKind: ErrorKindSchema,
  }),
  PlatformDeliveryOutcomeSchema,
]);
export type CronDirectDeliveryOutcome = z.infer<typeof CronDirectDeliveryOutcomeSchema>;

export const SchedulerDiagnosticCounterSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  value: NonnegativeSafeIntegerSchema,
});
export type SchedulerDiagnosticCounter = z.infer<typeof SchedulerDiagnosticCounterSchema>;

export const SystemEventQueueDispositionSchema = z.enum([
  "accepted",
  "accepted_oldest_dropped",
  "duplicate",
]);
export type SystemEventQueueDisposition = z.infer<typeof SystemEventQueueDispositionSchema>;

export const CronContinuationOutcomeSchema = z.union([
  z.strictObject({ mode: z.literal("none"), status: z.literal("not_requested") }),
  z.strictObject({
    mode: z.literal("heartbeat_excerpt"),
    status: z.literal("admitted"),
    correlationId: IdentifierSchema,
    queueDisposition: SystemEventQueueDispositionSchema,
  }),
  z.strictObject({
    mode: z.literal("heartbeat_excerpt"),
    status: z.literal("skipped"),
    reason: z.enum(["execution_not_completed", "visible_text_unavailable"]),
  }),
  z.strictObject({
    mode: z.literal("heartbeat_excerpt"),
    status: z.literal("failed"),
    errorKind: ErrorKindSchema,
  }),
  z.strictObject({ mode: z.literal("origin_history"), status: z.enum(["appended", "already_present"]) }),
  z.strictObject({
    mode: z.literal("origin_history"),
    status: z.literal("skipped"),
    reason: z.enum(["execution_not_completed", "delivery_not_accepted"]),
  }),
  z.strictObject({ mode: z.literal("origin_history"), status: z.literal("failed"), errorKind: ErrorKindSchema }),
]);
export type CronContinuationOutcome = z.infer<typeof CronContinuationOutcomeSchema>;

const CronAgentMetricsSchema = z.strictObject({
  durationMs: NonnegativeSafeIntegerSchema,
  totalTokens: NonnegativeSafeIntegerSchema,
  costUsd: NonnegativeFiniteSchema,
  toolCalls: NonnegativeSafeIntegerSchema,
  llmCalls: NonnegativeSafeIntegerSchema,
});

export const CronWakeGateOutcomeSchema = z.union([
  z.strictObject({ status: z.literal("not_configured") }),
  z.strictObject({
    status: z.literal("woke"),
    durationMs: NonnegativeSafeIntegerSchema,
    toolCalls: NonnegativeSafeIntegerSchema,
  }),
  z.strictObject({
    status: z.literal("failed_open"),
    durationMs: NonnegativeSafeIntegerSchema,
    toolCalls: NonnegativeSafeIntegerSchema,
    errorKind: ErrorKindSchema,
  }),
]);
export type CronWakeGateOutcome = z.infer<typeof CronWakeGateOutcomeSchema>;

export const CronAgentTurnOutcomeSchema = z.strictObject({
  agentExecutionId: IdentifierSchema,
  rootRunId: RootRunIdSchema,
  sessionKey: SessionKeySchema,
  execution: AgentTurnExecutionOutcomeSchema,
  modelResolved: z.string().min(1).max(512),
  modelResolutionSource: ModelResolutionSourceSchema,
  metrics: CronAgentMetricsSchema,
  wakeGate: CronWakeGateOutcomeSchema,
  delivery: CronDeliveryOutcomeSchema,
  continuation: CronContinuationOutcomeSchema,
});
export type CronAgentTurnOutcome = z.infer<typeof CronAgentTurnOutcomeSchema>;

const DiagnosticCountersSchema = z.array(SchedulerDiagnosticCounterSchema).max(32);
export const InternalActionExecutionSchema = z.union([
  z.strictObject({ status: z.literal("completed"), counters: DiagnosticCountersSchema }),
  z.strictObject({ status: z.literal("failed"), errorKind: ErrorKindSchema, counters: DiagnosticCountersSchema }),
  z.strictObject({
    status: z.literal("aborted"),
    abortReason: AgentExecutionAbortReasonSchema,
    counters: DiagnosticCountersSchema,
  }),
  z.strictObject({ status: z.literal("skipped"), reason: z.literal("configuration_disabled"), counters: z.tuple([]) }),
  z.strictObject({ status: z.literal("unknown"), errorKind: ErrorKindSchema, counters: DiagnosticCountersSchema }),
]);
export type InternalActionExecution = z.infer<typeof InternalActionExecutionSchema>;

export const InternalActionRuntimeOutcomeSchema = z.strictObject({
  kind: z.literal("internal_action"),
  action: CronInternalActionNameSchema,
  rootRunId: RootRunIdSchema,
  modelResolved: z.string().min(1).max(512).nullable(),
  modelResolutionSource: ModelResolutionSourceSchema.nullable(),
  metrics: z.strictObject({
    totalTokens: NonnegativeSafeIntegerSchema.nullable(),
    costUsd: NonnegativeFiniteSchema.nullable(),
    llmCalls: NonnegativeSafeIntegerSchema,
  }),
  execution: InternalActionExecutionSchema,
}).superRefine((outcome, ctx) => {
  const keyless = outcome.action === "memory_lifecycle";
  const hasModelEvidence = outcome.modelResolved !== null
    && outcome.modelResolutionSource !== null
    && outcome.metrics.totalTokens !== null
    && outcome.metrics.costUsd !== null;
  const hasNoModelEvidence = outcome.modelResolved === null
    && outcome.modelResolutionSource === null
    && outcome.metrics.totalTokens === null
    && outcome.metrics.costUsd === null
    && outcome.metrics.llmCalls === 0;
  if ((keyless && !hasNoModelEvidence) || (!keyless && !hasModelEvidence)) {
    ctx.addIssue({
      code: "custom",
      path: ["modelResolved"],
      message: "internal action model evidence does not match its execution mode",
    });
  }
});

export const CronRuntimeOutcomeSchema = z.union([
  z.strictObject({ kind: z.literal("agent_turn"), outcome: CronAgentTurnOutcomeSchema }),
  z.strictObject({
    kind: z.literal("wake_gate_skip"),
    rootRunId: RootRunIdSchema,
    durationMs: NonnegativeSafeIntegerSchema,
    toolCalls: NonnegativeSafeIntegerSchema,
    delivery: CronDeliveryOutcomeSchema,
    continuation: CronContinuationOutcomeSchema,
  }),
  z.strictObject({
    kind: z.literal("agent_turn_pre_model_skip"),
    rootRunId: RootRunIdSchema,
    reason: z.enum(["wake_gate_disabled", "wake_gate_unbound"]),
    errorKind: z.literal("precondition"),
    continuation: CronContinuationOutcomeSchema,
  }),
  z.strictObject({
    kind: z.literal("heartbeat_event"),
    status: z.literal("dispatched"),
    correlationId: IdentifierSchema,
    queueDisposition: SystemEventQueueDispositionSchema,
  }),
  InternalActionRuntimeOutcomeSchema,
  z.strictObject({ kind: z.literal("delivery_only"), delivery: CronDirectDeliveryOutcomeSchema }),
]);
export type CronRuntimeOutcome = z.infer<typeof CronRuntimeOutcomeSchema>;

export const CronRuntimeErrorSchema = z.strictObject({
  code: z.enum(["not_bound", "invalid_input", "precondition_failed", "dispatch_rejected"]),
  errorKind: ErrorKindSchema,
  message: z.string().min(1).max(2_048),
});
export type CronRuntimeError = z.infer<typeof CronRuntimeErrorSchema>;

export interface CronRuntimeExecutor {
  execute(
    input: CronRuntimeExecutionInput,
    signal: AbortSignal,
  ): Promise<Result<CronRuntimeOutcome, CronRuntimeError>>;
}

export const SCHEDULER_TERMINATION_GRACE_MS = 5_000;
export const SCHEDULER_SHUTDOWN_DRAIN_MS = 30_000;

export function mapCronRuntimeErrorStage(
  code: CronRuntimeError["code"],
): "executor_not_bound" | "executor_invalid_input" | "executor_precondition" | "dispatch_rejected" {
  switch (code) {
    case "not_bound": return "executor_not_bound";
    case "invalid_input": return "executor_invalid_input";
    case "precondition_failed": return "executor_precondition";
    case "dispatch_rejected": return "dispatch_rejected";
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

export function runtimeErrorKind(error: CronRuntimeError): ErrorKind {
  return error.errorKind;
}
