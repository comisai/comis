// SPDX-License-Identifier: Apache-2.0
/** Strict content-free operator contracts for inferred follow-up tasks. */
import { z } from "zod";
import { ConversationRefSchema } from "../../domain/conversation-scope.js";
import { defineContract } from "../types.js";

const IdentifierSchema = z.string().min(1).max(256);
const EpochMsSchema = z.number().int().nonnegative().safe();
const CountSchema = z.number().int().nonnegative().safe();
const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RawAuthorityStateSchema = z.strictObject({
  exists: z.boolean(),
  bytes: CountSchema,
  digest: Sha256DigestSchema.nullable(),
});
const TaskQuarantineStateSchema = z.strictObject({
  exists: z.boolean(),
  bytes: CountSchema,
  digest: Sha256DigestSchema.nullable(),
  recordCount: CountSchema,
  state: z.enum(["valid", "invalid", "unavailable"]),
});
const ResetIntentProjectionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({
    status: z.literal("pending"),
    operationId: IdentifierSchema,
    phase: z.enum(["prepared", "archive_recorded", "replacement_recorded", "completion_recorded"]),
    digest: Sha256DigestSchema,
  }),
  z.strictObject({ status: z.literal("invalid"), digest: Sha256DigestSchema }),
]);
const TaskStatusSchema = z.enum([
  "pending",
  "checking",
  "delivering",
  "delivered",
  "delivery_partial",
  "dismissed",
  "delivery_unknown",
  "expired",
  "cancelled",
]);

const TaskOperatorProjectionSchema = z.strictObject({
  id: IdentifierSchema,
  agentId: IdentifierSchema,
  status: TaskStatusSchema,
  dueEarliestMs: EpochMsSchema,
  dueLatestMs: EpochMsSchema,
  expiresAtMs: EpochMsSchema,
  attemptCount: CountSchema,
  preAcceptanceFailureCount: CountSchema,
  sourceExecutionId: IdentifierSchema,
  sourceOccurrenceCount: z.number().int().positive().safe(),
  conversationRef: ConversationRefSchema,
});

export const TasksStatusContract = defineContract({
  method: "tasks.status",
  request: z.strictObject({ agentId: IdentifierSchema.optional() }),
  response: z.strictObject({
    resolvedAgentId: IdentifierSchema,
    configuredEnabled: z.boolean(),
    state: z.enum(["initializing", "disabled", "ready", "maintenance", "failed"]),
    strictAuthorityValid: z.boolean(),
    ownershipReconciled: z.boolean(),
    store: RawAuthorityStateSchema,
    quarantine: TaskQuarantineStateSchema,
    intent: ResetIntentProjectionSchema,
    counts: z.strictObject({
      total: CountSchema,
      pending: CountSchema,
      active: CountSchema,
      terminal: CountSchema,
    }),
  }),
  scopes: ["admin"] as const,
});

export const TasksListContract = defineContract({
  method: "tasks.list",
  request: z.strictObject({
    agentId: IdentifierSchema.optional(),
    status: TaskStatusSchema.optional(),
    limit: z.number().int().positive().max(256).optional(),
  }),
  response: z.strictObject({
    resolvedAgentId: IdentifierSchema,
    fileDigest: Sha256DigestSchema,
    tasks: z.array(TaskOperatorProjectionSchema).max(256),
  }),
  scopes: ["admin"] as const,
});

const TaskCancellationOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("cancelled"),
    taskIds: z.array(IdentifierSchema).min(1).max(256),
    activeTaskIds: z.array(IdentifierSchema).max(256),
  }),
  z.strictObject({
    status: z.literal("active_attempt"),
    taskId: IdentifierSchema,
    attemptId: IdentifierSchema,
  }),
  z.strictObject({
    status: z.literal("already_terminal"),
    taskId: IdentifierSchema,
    taskStatus: TaskStatusSchema,
  }),
  z.strictObject({ status: z.literal("not_found"), taskId: IdentifierSchema }),
  z.strictObject({
    status: z.literal("nothing_pending"),
    activeTaskIds: z.array(IdentifierSchema).max(256),
  }),
]);

export const TasksCancelContract = defineContract({
  method: "tasks.cancel",
  request: z.union([
    z.strictObject({ taskId: IdentifierSchema, agentId: IdentifierSchema.optional() }),
    z.strictObject({ allPending: z.literal(true), agentId: IdentifierSchema.optional() }),
  ]),
  response: z.strictObject({
    outcome: TaskCancellationOutcomeSchema,
    scheduleRescan: z.enum(["not_required", "completed", "failed"]),
  }),
  scopes: ["admin"] as const,
});

export const TasksResetContract = defineContract({
  method: "tasks.reset",
  request: z.strictObject({
    expectedDigest: Sha256DigestSchema,
    confirmed: z.literal(true),
    agentId: IdentifierSchema.optional(),
  }),
  response: z.strictObject({
    resolvedAgentId: IdentifierSchema,
    operationId: IdentifierSchema,
    beforeDigest: Sha256DigestSchema.nullable(),
    afterDigest: Sha256DigestSchema,
    state: z.literal("disabled"),
    reinitialized: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

export const TASK_HANDLERS_CONTRACTS = [
  TasksStatusContract,
  TasksListContract,
  TasksCancelContract,
  TasksResetContract,
] as const;
