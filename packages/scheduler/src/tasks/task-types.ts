// SPDX-License-Identifier: Apache-2.0
import {
  AgentTurnExecutionOutcomeSchema,
  BackgroundTaskOriginSchema,
  ConversationRefSchema,
  ERROR_KINDS,
  ModelResolutionSourceSchema,
  ResponseLocalePolicySchema,
  WorkspacePolicySnapshotSchema,
  verifyWorkspacePolicySnapshot,
  type ErrorKind,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";

const IdSchema = z.string().min(1).max(256);
const SafeTimeSchema = z.number().int().nonnegative().safe();
const SafeCountSchema = z.number().int().nonnegative().safe();
const ErrorKindSchema = z.enum(ERROR_KINDS);

const FollowupTaskBaseSchema = z.strictObject({
  id: IdSchema,
  agentId: z.string().min(1).max(128),
  origin: BackgroundTaskOriginSchema,
  sourceExecutionId: IdSchema,
  lastSourceExecutionId: IdSchema,
  sourceOccurrenceCount: z.number().int().positive().safe(),
  workspacePolicyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  responseLocalePolicy: ResponseLocalePolicySchema,
  text: z.string().min(1).max(4_096),
  contentTrust: z.enum(["derived", "external"]),
  confidence: z.number().min(0).max(1),
  createdAtMs: SafeTimeSchema,
  dueEarliestMs: SafeTimeSchema,
  dueLatestMs: SafeTimeSchema,
  expiresAtMs: SafeTimeSchema,
  dedupeKey: z.string().regex(/^[a-f0-9]{64}$/u),
  attemptCount: SafeCountSchema,
  preAcceptanceFailureCount: SafeCountSchema,
});

export const FollowupTaskRecordSchema = z.discriminatedUnion("status", [
  FollowupTaskBaseSchema.extend({ status: z.literal("pending"), nextAttemptAtMs: SafeTimeSchema }),
  FollowupTaskBaseSchema.extend({ status: z.literal("checking"), activeAttemptId: IdSchema }),
  FollowupTaskBaseSchema.extend({ status: z.literal("delivering"), activeAttemptId: IdSchema }),
  FollowupTaskBaseSchema.extend({
    status: z.literal("delivered"), terminalAttemptId: IdSchema, terminalAtMs: SafeTimeSchema,
  }),
  FollowupTaskBaseSchema.extend({
    status: z.literal("delivery_partial"), terminalAttemptId: IdSchema, terminalAtMs: SafeTimeSchema,
  }),
  FollowupTaskBaseSchema.extend({
    status: z.literal("dismissed"), terminalAttemptId: IdSchema, terminalAtMs: SafeTimeSchema,
  }),
  FollowupTaskBaseSchema.extend({
    status: z.literal("delivery_unknown"), terminalAttemptId: IdSchema, terminalAtMs: SafeTimeSchema,
  }),
  FollowupTaskBaseSchema.extend({
    status: z.literal("expired"), terminalAttemptId: IdSchema.nullable(), terminalAtMs: SafeTimeSchema,
  }),
  FollowupTaskBaseSchema.extend({
    status: z.literal("cancelled"), terminalAttemptId: z.null(), terminalAtMs: SafeTimeSchema,
  }),
]).superRefine((task, context) => {
  if (
    task.createdAtMs > task.dueEarliestMs
    || task.dueEarliestMs > task.dueLatestMs
    || task.dueLatestMs > task.expiresAtMs
  ) {
    context.addIssue({ code: "custom", message: "task time window is contradictory" });
  }
  if (task.origin.turnScope.conversation.agentId !== task.agentId) {
    context.addIssue({ code: "custom", path: ["agentId"], message: "task agent must equal origin agent" });
  }
  if (Buffer.byteLength(task.text, "utf8") > 4 * 1_024) {
    context.addIssue({ code: "custom", path: ["text"], message: "task text exceeds its byte ceiling" });
  }
  if (task.status === "pending" && (
    task.nextAttemptAtMs < task.createdAtMs
    || task.nextAttemptAtMs > task.dueLatestMs
    || task.nextAttemptAtMs > task.expiresAtMs
  )) {
    context.addIssue({ code: "custom", path: ["nextAttemptAtMs"], message: "pending attempt time is outside the task window" });
  }
  if ("terminalAtMs" in task && task.terminalAtMs < task.createdAtMs) {
    context.addIssue({ code: "custom", path: ["terminalAtMs"], message: "task terminal time precedes creation" });
  }
});

const ExecutionMetricsSchema = z.strictObject({
  durationMs: SafeCountSchema,
  totalTokens: SafeCountSchema,
  costUsd: z.number().nonnegative().finite(),
  toolCalls: z.literal(0),
  llmCalls: SafeCountSchema,
});
const SuccessfulExecutionSchema = z.strictObject({ status: z.literal("completed"), finishReason: z.literal("stop") });
const SettledCheckBaseSchema = z.strictObject({
  status: z.literal("settled"),
  agentExecutionId: IdSchema,
  modelResolved: z.string().min(1).max(512),
  modelResolutionSource: ModelResolutionSourceSchema,
  metrics: ExecutionMetricsSchema,
});
export const SuccessfulTaskCheckExecutionEvidenceSchema = SettledCheckBaseSchema.extend({ execution: SuccessfulExecutionSchema });

export const TaskCheckExecutionEvidenceSchema = z.union([
  z.strictObject({
    status: z.literal("not_started"),
    code: z.enum(["invalid_input", "invalid_target"]),
    errorKind: z.literal("validation"),
  }),
  z.strictObject({
    status: z.literal("not_started"),
    code: z.enum(["not_bound", "precondition_failed"]),
    errorKind: z.literal("precondition"),
  }),
  z.strictObject({ status: z.literal("not_returned") }),
  SettledCheckBaseSchema.extend({ execution: AgentTurnExecutionOutcomeSchema }),
]);

export const TaskAttemptFailureStageSchema = z.enum([
  "executor_invalid_input",
  "executor_invalid_target",
  "executor_not_bound",
  "executor_precondition",
  "model",
  "deadline",
  "delivery_window_closed",
  "output_guard",
  "target_precondition",
  "configuration_disabled",
  "delivery_rejected",
  "owner_recovery_before_delivery",
]);

const AttemptBaseSchema = z.strictObject({
  id: IdSchema,
  bootId: IdSchema,
  rootRunId: IdSchema,
  taskIds: z.array(IdSchema).min(1).max(8),
  tenantId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  conversationRef: ConversationRefSchema,
  startedAtMs: SafeTimeSchema,
});

const HistoryOutcomeSchema = z.union([
  z.strictObject({ status: z.enum(["appended", "already_present"]) }),
  z.strictObject({ status: z.literal("failed"), errorKind: ErrorKindSchema }),
]);

const UnknownDeliverySchema = z.union([
  z.strictObject({
    source: z.literal("platform_ambiguous"),
    errorKind: ErrorKindSchema,
    deliveredChunks: SafeCountSchema,
    failedChunks: z.number().int().positive().safe(),
    ambiguousChunks: z.number().int().positive().safe(),
    lastPlatformMessageId: z.string().min(1).nullable(),
  }).superRefine((delivery, context) => {
    if (delivery.ambiguousChunks > delivery.failedChunks) {
      context.addIssue({ code: "custom", message: "ambiguous chunks cannot exceed failed chunks" });
    }
  }),
  z.strictObject({
    source: z.enum(["owner_recovery", "runtime_unsettled"]),
    errorKind: z.enum(["internal", "timeout"]),
    deliveredChunks: z.null(),
    failedChunks: z.null(),
    ambiguousChunks: z.null(),
    lastPlatformMessageId: z.null(),
  }).superRefine((delivery, context) => {
    const expected = delivery.source === "owner_recovery" ? "internal" : "timeout";
    if (delivery.errorKind !== expected) context.addIssue({ code: "custom", message: "unknown-delivery kind mismatch" });
  }),
]);

export const FollowupTaskAttemptRecordSchema = z.discriminatedUnion("status", [
  AttemptBaseSchema.extend({ status: z.literal("checking") }),
  AttemptBaseSchema.extend({
    status: z.literal("delivering"),
    check: SuccessfulTaskCheckExecutionEvidenceSchema,
    deliveringAtMs: SafeTimeSchema,
  }),
  AttemptBaseSchema.extend({
    status: z.literal("failed"),
    check: TaskCheckExecutionEvidenceSchema,
    deliveringAtMs: SafeTimeSchema.nullable(),
    failureStage: TaskAttemptFailureStageSchema,
    errorKind: ErrorKindSchema,
    deliveredChunks: z.literal(0),
    failedChunks: SafeCountSchema,
    terminalAtMs: SafeTimeSchema,
  }),
  AttemptBaseSchema.extend({
    status: z.literal("dismissed"), check: SuccessfulTaskCheckExecutionEvidenceSchema, terminalAtMs: SafeTimeSchema,
  }),
  AttemptBaseSchema.extend({
    status: z.literal("delivered"),
    check: SuccessfulTaskCheckExecutionEvidenceSchema,
    deliveringAtMs: SafeTimeSchema,
    deliveredChunks: z.number().int().positive().safe(),
    failedChunks: z.literal(0),
    lastPlatformMessageId: z.string().min(1).nullable(),
    deliveredAtMs: SafeTimeSchema,
    terminalAtMs: SafeTimeSchema,
    history: HistoryOutcomeSchema,
  }),
  AttemptBaseSchema.extend({
    status: z.literal("delivery_partial"),
    check: SuccessfulTaskCheckExecutionEvidenceSchema,
    deliveringAtMs: SafeTimeSchema,
    errorKind: ErrorKindSchema,
    deliveredChunks: z.number().int().positive().safe(),
    failedChunks: z.number().int().positive().safe(),
    lastPlatformMessageId: z.string().min(1).nullable(),
    deliveredAtMs: SafeTimeSchema,
    terminalAtMs: SafeTimeSchema,
  }),
  AttemptBaseSchema.extend({
    status: z.literal("delivery_unknown"),
    check: SuccessfulTaskCheckExecutionEvidenceSchema,
    deliveringAtMs: SafeTimeSchema,
    delivery: UnknownDeliverySchema,
    terminalAtMs: SafeTimeSchema,
  }),
]).superRefine((attempt, context) => {
  if (new Set(attempt.taskIds).size !== attempt.taskIds.length) {
    context.addIssue({ code: "custom", path: ["taskIds"], message: "attempt task ids must be unique" });
  }
  if (attempt.status === "failed") validateFailure(attempt, context);
  if ("terminalAtMs" in attempt && attempt.terminalAtMs < attempt.startedAtMs) {
    context.addIssue({ code: "custom", path: ["terminalAtMs"], message: "attempt terminal time precedes its start" });
  }
  if ("deliveringAtMs" in attempt && attempt.deliveringAtMs !== null && attempt.deliveringAtMs < attempt.startedAtMs) {
    context.addIssue({ code: "custom", path: ["deliveringAtMs"], message: "delivery time precedes attempt start" });
  }
  if ((attempt.status === "delivered" || attempt.status === "delivery_partial") && (
    attempt.deliveredAtMs < attempt.deliveringAtMs
    || attempt.terminalAtMs < attempt.deliveredAtMs
  )) {
    context.addIssue({ code: "custom", path: ["deliveredAtMs"], message: "delivery timestamps are contradictory" });
  }
});

function validateFailure(
  attempt: z.infer<typeof FollowupTaskAttemptRecordSchema> & { status: "failed" },
  context: z.RefinementCtx,
): void {
  const fixedKinds: Partial<Record<z.infer<typeof TaskAttemptFailureStageSchema>, string>> = {
    executor_invalid_input: "validation",
    executor_invalid_target: "validation",
    executor_not_bound: "precondition",
    executor_precondition: "precondition",
    delivery_window_closed: "precondition",
    target_precondition: "precondition",
    configuration_disabled: "precondition",
    deadline: "timeout",
    owner_recovery_before_delivery: "internal",
  };
  const expected = fixedKinds[attempt.failureStage];
  if (expected !== undefined && attempt.errorKind !== expected) {
    context.addIssue({ code: "custom", path: ["errorKind"], message: "failure stage kind mismatch" });
  }
  if (
    attempt.failureStage === "output_guard"
    && attempt.errorKind !== "auth"
    && attempt.errorKind !== "internal"
    && attempt.errorKind !== "validation"
  ) {
    context.addIssue({ code: "custom", path: ["errorKind"], message: "output guard failure kind is invalid" });
  }
  const deliveryRejected = attempt.failureStage === "delivery_rejected";
  if (
    deliveryRejected !== (attempt.deliveringAtMs !== null)
    || deliveryRejected !== (attempt.failedChunks > 0)
  ) {
    context.addIssue({ code: "custom", message: "failure delivery evidence is contradictory" });
  }
  const executorCodes: Partial<Record<z.infer<typeof TaskAttemptFailureStageSchema>, string>> = {
    executor_invalid_input: "invalid_input",
    executor_invalid_target: "invalid_target",
    executor_not_bound: "not_bound",
    executor_precondition: "precondition_failed",
  };
  const expectedCode = executorCodes[attempt.failureStage];
  if (
    expectedCode === undefined
      ? attempt.check.status === "not_started"
      : attempt.check.status !== "not_started" || attempt.check.code !== expectedCode
  ) {
    context.addIssue({ code: "custom", path: ["check"], message: "executor failure evidence does not match its stage" });
  }
  const ownerRecovery = attempt.failureStage === "owner_recovery_before_delivery";
  if (ownerRecovery !== (attempt.check.status === "not_returned")) {
    context.addIssue({ code: "custom", path: ["check"], message: "not-returned evidence is reserved for owner recovery" });
  }
}

export const FollowupTaskStoreFileSchema = z.strictObject({
  formatVersion: z.literal(1),
  tasks: z.array(FollowupTaskRecordSchema).max(10_000),
  attempts: z.array(FollowupTaskAttemptRecordSchema).max(50_000),
  policySnapshots: z.array(WorkspacePolicySnapshotSchema).max(10_000),
});

/** Bounded outer shape parsed before any authority-bearing record is trusted. */
export const FollowupTaskStoreEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(1),
  tasks: z.array(z.unknown()).max(10_000),
  attempts: z.array(z.unknown()).max(50_000),
  policySnapshots: z.array(z.unknown()).max(10_000),
});

export type FollowupTaskRecord = z.infer<typeof FollowupTaskRecordSchema>;
export type FollowupTaskAttemptRecord = z.infer<typeof FollowupTaskAttemptRecordSchema>;
export type FollowupTaskStoreFile = z.infer<typeof FollowupTaskStoreFileSchema>;
export type TaskAttemptFailureStage = z.infer<typeof TaskAttemptFailureStageSchema>;
export type TaskCheckExecutionEvidence = z.infer<typeof TaskCheckExecutionEvidenceSchema>;
export type SuccessfulTaskCheckExecutionEvidence = z.infer<typeof SuccessfulTaskCheckExecutionEvidenceSchema>;

export type FollowupTaskStoreErrorCode =
  | "not_initialized"
  | "invalid_path"
  | "invalid_state"
  | "lock_contended"
  | "lock_failed"
  | "io"
  | "store_full"
  | "ownership_unproven"
  | "disabled";

export interface FollowupTaskStoreError {
  readonly code: FollowupTaskStoreErrorCode;
  readonly errorKind: ErrorKind;
  readonly message: string;
}

export type TaskAdmissionResult =
  | { readonly itemId: string; readonly disposition: "created" | "merged"; readonly taskId: string }
  | { readonly itemId: string; readonly disposition: "below_threshold" | "unsafe_content" | "expired" | "active_conflict" | "store_full" };

export type TaskBeginDeliveryResult =
  | { readonly status: "delivering"; readonly deliveringAtMs: number }
  | { readonly status: "configuration_disabled" | "delivery_window_closed" };

export type TaskDeliverySettlement =
  | {
    readonly status: "accepted";
    readonly deliveredChunks: number;
    readonly failedChunks: 0;
    readonly lastPlatformMessageId: string | null;
    readonly deliveredAtMs: number;
    readonly history: { readonly status: "appended" | "already_present" } | { readonly status: "failed"; readonly errorKind: ErrorKind };
  }
  | {
    readonly status: "partial";
    readonly errorKind: ErrorKind;
    readonly deliveredChunks: number;
    readonly failedChunks: number;
    readonly lastPlatformMessageId: string | null;
    readonly deliveredAtMs: number;
  }
  | {
    readonly status: "unknown";
    readonly delivery:
      | {
        readonly source: "platform_ambiguous";
        readonly errorKind: ErrorKind;
        readonly deliveredChunks: number;
        readonly failedChunks: number;
        readonly ambiguousChunks: number;
        readonly lastPlatformMessageId: string | null;
      }
      | {
        readonly source: "owner_recovery" | "runtime_unsettled";
        readonly errorKind: "internal" | "timeout";
        readonly deliveredChunks: null;
        readonly failedChunks: null;
        readonly ambiguousChunks: null;
        readonly lastPlatformMessageId: null;
      };
  };

export type FollowupTaskStoreParseError =
  | { readonly code: "invalid_record"; readonly errorKind: "validation" }
  | { readonly code: "invalid_policy"; readonly errorKind: "validation" }
  | { readonly code: "duplicate_id"; readonly errorKind: "validation" }
  | { readonly code: "invalid_graph"; readonly errorKind: "validation" };

export function parseFollowupTaskStoreFile(
  raw: unknown,
): Result<FollowupTaskStoreFile, FollowupTaskStoreParseError> {
  const envelope = FollowupTaskStoreEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return err({ code: "invalid_record", errorKind: "validation" });
  const parsed = FollowupTaskStoreFileSchema.safeParse(raw);
  if (!parsed.success) return err({ code: "invalid_record", errorKind: "validation" });
  const root = parsed.data;
  if (hasDuplicate(root.tasks.map((task) => task.id)) || hasDuplicate(root.attempts.map((attempt) => attempt.id))) {
    return err({ code: "duplicate_id", errorKind: "validation" });
  }
  if (hasDuplicate(root.policySnapshots.map((snapshot) => snapshot.combinedHash))) {
    return err({ code: "duplicate_id", errorKind: "validation" });
  }
  for (const snapshot of root.policySnapshots) {
    if (!verifyWorkspacePolicySnapshot(snapshot).ok) {
      return err({ code: "invalid_policy", errorKind: "validation" });
    }
  }
  return validateGraph(root)
    ? ok(root)
    : err({ code: "invalid_graph", errorKind: "validation" });
}

function validateGraph(root: FollowupTaskStoreFile): boolean {
  const policies = new Map(root.policySnapshots.map((snapshot) => [snapshot.combinedHash, snapshot]));
  const tasks = new Map(root.tasks.map((task) => [task.id, task]));
  const attempts = new Map(root.attempts.map((attempt) => [attempt.id, attempt]));
  for (const task of root.tasks) {
    const policy = policies.get(task.workspacePolicyHash);
    if (policy === undefined || policy.agentId !== task.agentId) return false;
    if (task.status === "checking" || task.status === "delivering") {
      const attempt = attempts.get(task.activeAttemptId);
      if (attempt === undefined || attempt.status !== task.status || !attempt.taskIds.includes(task.id)) return false;
    } else if ("terminalAttemptId" in task && task.terminalAttemptId !== null) {
      const attempt = attempts.get(task.terminalAttemptId);
      if (attempt === undefined || !("terminalAtMs" in attempt) || !attempt.taskIds.includes(task.id)) return false;
      if (task.terminalAtMs !== attempt.terminalAtMs) return false;
      if (
        (task.status === "delivered" && attempt.status !== "delivered")
        || (task.status === "delivery_partial" && attempt.status !== "delivery_partial")
        || (task.status === "dismissed" && attempt.status !== "dismissed")
        || (task.status === "delivery_unknown" && attempt.status !== "delivery_unknown")
        || (task.status === "expired" && attempt.status !== "failed")
      ) return false;
    }
  }
  for (const attempt of root.attempts) {
    for (const taskId of attempt.taskIds) {
      const task = tasks.get(taskId);
      if (
        task === undefined
        || task.agentId !== attempt.agentId
        || task.origin.turnScope.conversation.tenantId !== attempt.tenantId
        || task.origin.conversationRef !== attempt.conversationRef
      ) return false;
      if (
        (attempt.status === "checking" || attempt.status === "delivering")
        && (task.status !== attempt.status || task.activeAttemptId !== attempt.id)
      ) return false;
    }
  }
  return true;
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}
