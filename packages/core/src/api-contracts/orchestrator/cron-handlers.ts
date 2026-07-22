// SPDX-License-Identifier: Apache-2.0
/** Strict cron and scheduler RPC contracts. */
import { z } from "zod";
import {
  ChannelEndpointSchema,
  ConversationLocatorSchema,
} from "../../domain/conversation-scope.js";
import { defineContract } from "../types.js";

const IdentifierSchema = z.string().min(1).max(256);
const EpochMsSchema = z.number().int().nonnegative().safe();
const PositiveSafeIntegerSchema = z.number().int().positive().safe();
const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ErrorKindSchema = z.enum([
  "config",
  "network",
  "auth",
  "validation",
  "precondition",
  "timeout",
  "resource",
  "dependency",
  "internal",
  "platform",
]);
const CronMaintenanceErrorCodeSchema = z.enum([
  "invalid_input",
  "invalid_path",
  "confirmation_required",
  "digest_mismatch",
  "intent_present",
  "intent_invalid",
  "intent_ambiguous",
  "archive_conflict",
  "lock_contended",
  "lock_failed",
  "io",
  "interrupted",
  "initialization_failed",
  "ownership_reconciliation_failed",
  "built_in_reconciliation_failed",
  "snapshot_failed",
  "active_execution",
  "unsafe_single_file",
  "post_reset_initialization_failed",
  "dependency_not_ready",
  "activation_failed",
]);

const CronAuthoringScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("cron"),
    expr: z.string().min(1).max(1_024),
    tz: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    kind: z.literal("every"),
    everyMs: PositiveSafeIntegerSchema,
    anchorMs: EpochMsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("at"),
    at: z.string().min(1).max(128),
    tz: z.string().min(1).max(128).optional(),
    fold: z.enum(["earlier", "later"]).optional(),
  }),
  z.strictObject({ kind: z.literal("in"), seconds: PositiveSafeIntegerSchema }),
]);

const CronPersistedScheduleProjectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cron"), expr: z.string(), tz: z.string() }),
  z.strictObject({ kind: z.literal("every"), everyMs: PositiveSafeIntegerSchema, anchorMs: EpochMsSchema }),
  z.strictObject({ kind: z.literal("at"), atMs: EpochMsSchema }),
]);

const CronAuthorablePayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("heartbeat_event"),
    text: z.string().min(1),
    wakeMode: z.enum(["now", "next-heartbeat"]),
  }),
  z.strictObject({ kind: z.literal("delivery"), text: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("agent_turn"),
    message: z.string().min(1),
    model: z.string().min(1).optional(),
    timeoutSeconds: PositiveSafeIntegerSchema.max(86_400).optional(),
  }),
]);

const CronSessionPolicySchema = z.discriminatedUnion("strategy", [
  z.strictObject({ strategy: z.literal("fresh") }),
  z.strictObject({ strategy: z.literal("rolling"), maxHistoryTurns: PositiveSafeIntegerSchema.max(20) }),
]);

const CronWakeGateSchema = z.strictObject({
  script: z.string().min(1),
  language: z.enum(["js", "ts"]),
  timeoutSeconds: PositiveSafeIntegerSchema.max(300),
});

const CronToolPolicySchema = z.strictObject({
  profile: z.enum(["minimal", "coding", "messaging", "supervisor", "full"]),
  allow: z.array(IdentifierSchema).max(256),
  deny: z.array(IdentifierSchema).max(256),
});

const CronDeliveryTargetSchema = z.strictObject({
  conversation: ConversationLocatorSchema,
  destinationEndpoint: ChannelEndpointSchema,
}).superRefine((value, ctx) => {
  const partition = value.conversation.conversationScope.partition;
  const endpoint = value.destinationEndpoint;
  if (partition.kind === "channel-principal" && partition.channelType !== endpoint.channelType) {
    ctx.addIssue({
      code: "custom",
      path: ["destinationEndpoint", "channelType"],
      message: "destination channel type must match the conversation partition",
    });
  }
  if (
    (partition.kind === "endpoint-conversation" || partition.kind === "endpoint-conversation-principal")
    && !endpointsEqual(partition.endpoint, endpoint)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["destinationEndpoint"],
      message: "destination endpoint must match the conversation partition",
    });
  }
});

const CronAddRequestSchema = z.strictObject({
  name: z.string().min(1).max(200),
  agentId: IdentifierSchema.optional(),
  schedule: CronAuthoringScheduleSchema,
  payload: CronAuthorablePayloadSchema,
  sessionPolicy: CronSessionPolicySchema.optional(),
  continuationMode: z.enum(["none", "heartbeat_excerpt", "origin_history"]).optional(),
  deliveryTarget: CronDeliveryTargetSchema.optional(),
  wakeGate: CronWakeGateSchema.optional(),
  cacheRetention: z.enum(["none", "short", "long"]).optional(),
  toolPolicy: CronToolPolicySchema.optional(),
  maxConsecutiveDependencyErrors: NonnegativeSafeIntegerSchema.optional(),
});

export const CronAddContract = defineContract({
  method: "cron.add",
  request: CronAddRequestSchema,
  response: z.strictObject({
    jobId: IdentifierSchema,
    name: z.string().min(1),
    schedule: CronPersistedScheduleProjectionSchema,
  }),
  scopes: ["rpc"] as const,
});

const CronLifecycleProjectionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("scheduled"),
    nextRunAtMs: EpochMsSchema,
    consecutiveDependencyErrors: NonnegativeSafeIntegerSchema,
  }),
  z.strictObject({
    status: z.literal("paused"),
    nextRunAtMs: EpochMsSchema,
    consecutiveDependencyErrors: NonnegativeSafeIntegerSchema,
    reason: z.enum(["operator", "dependency_errors"]),
  }),
  z.strictObject({
    status: z.literal("one_shot_claimed"),
    executionId: IdentifierSchema,
    scheduledForMs: EpochMsSchema,
    claimedAtMs: EpochMsSchema,
  }),
  z.strictObject({
    status: z.literal("one_shot_terminal"),
    terminalExecutionId: IdentifierSchema,
    terminalAtMs: EpochMsSchema,
  }),
]);

const CronProjectedPayloadSchema = z.strictObject({
  kind: z.enum(["heartbeat_event", "delivery", "agent_turn", "internal_action"]),
  text: z.string().min(1).optional(),
  wakeMode: z.enum(["now", "next-heartbeat"]).optional(),
  message: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  timeoutSeconds: PositiveSafeIntegerSchema.max(86_400).optional(),
  action: z.enum(["memory_review", "memory_lifecycle", "reflection"]).optional(),
});

const CronJobProjectionSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1),
  agentId: IdentifierSchema,
  source: z.enum(["authored", "built_in"]),
  schedule: CronPersistedScheduleProjectionSchema,
  lifecycle: CronLifecycleProjectionSchema,
  payload: CronProjectedPayloadSchema,
  maxConsecutiveDependencyErrors: NonnegativeSafeIntegerSchema.optional(),
  sessionPolicy: CronSessionPolicySchema.optional(),
  continuationMode: z.enum(["none", "heartbeat_excerpt", "origin_history"]).optional(),
  deliveryTarget: CronDeliveryTargetSchema.optional(),
  wakeGate: CronWakeGateSchema.optional(),
  cacheRetention: z.enum(["none", "short", "long"]).optional(),
  toolPolicy: CronToolPolicySchema.optional(),
});

export const CronListContract = defineContract({
  method: "cron.list",
  request: z.strictObject({ agentId: z.string().min(1).optional() }),
  response: z.strictObject({ jobs: z.array(CronJobProjectionSchema) }),
  scopes: ["rpc"] as const,
});

export const CronUpdateContract = defineContract({
  method: "cron.update",
  request: z.strictObject({
    jobId: IdentifierSchema.optional(),
    jobName: z.string().min(1).optional(),
    name: z.string().min(1).max(200).optional(),
    schedule: CronAuthoringScheduleSchema.optional(),
    payload: CronAuthorablePayloadSchema.optional(),
    sessionPolicy: CronSessionPolicySchema.optional(),
    continuationMode: z.enum(["none", "heartbeat_excerpt", "origin_history"]).optional(),
    deliveryTarget: CronDeliveryTargetSchema.nullable().optional(),
    wakeGate: CronWakeGateSchema.nullable().optional(),
    cacheRetention: z.enum(["none", "short", "long"]).nullable().optional(),
    toolPolicy: CronToolPolicySchema.nullable().optional(),
    maxConsecutiveDependencyErrors: NonnegativeSafeIntegerSchema.nullable().optional(),
    paused: z.boolean().optional(),
  }).refine((value) => value.jobId !== undefined || value.jobName !== undefined, {
    message: "jobId or jobName is required",
  }),
  response: z.strictObject({ jobName: z.string(), updated: z.boolean() }),
  scopes: ["rpc"] as const,
});

export const CronRemoveContract = defineContract({
  method: "cron.remove",
  request: z.strictObject({ jobId: IdentifierSchema.optional(), jobName: z.string().min(1).optional() })
    .refine((value) => value.jobId !== undefined || value.jobName !== undefined, {
      message: "jobId or jobName is required",
    }),
  response: z.strictObject({ jobName: z.string(), removed: z.boolean() }),
  scopes: ["rpc"] as const,
});

export const CronStatusContract = defineContract({
  method: "cron.status",
  request: z.strictObject({ agentId: z.string().min(1).optional() }),
  response: z.strictObject({
    state: z.enum(["initializing", "disabled", "ready", "active", "maintenance", "failed"]),
    configuredEnabled: z.boolean(),
    running: z.boolean(),
    strictAuthoritiesValid: z.boolean(),
    ownershipReconciled: z.boolean(),
    jobCount: NonnegativeSafeIntegerSchema,
    activeClaimCount: NonnegativeSafeIntegerSchema,
    resolvedAgentId: IdentifierSchema,
    store: rawAuthoritySchema(),
    ledger: rawAuthoritySchema(),
    intent: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("none") }),
      z.strictObject({
        status: z.literal("pending"),
        operationId: IdentifierSchema,
        target: z.enum(["store", "ledger", "all"]),
        phase: z.enum(["prepared", "archives_recorded", "replacements_recorded", "completion_recorded"]),
        digest: Sha256DigestSchema,
      }),
      z.strictObject({ status: z.literal("invalid"), digest: Sha256DigestSchema }),
    ]),
    lastError: z.strictObject({
      code: CronMaintenanceErrorCodeSchema,
      errorKind: ErrorKindSchema,
    }).optional(),
  }),
  scopes: ["rpc"] as const,
});

const CronResetRequestSchema = z.discriminatedUnion("target", [
  z.strictObject({
    target: z.literal("store"),
    expectedDigests: z.strictObject({ store: Sha256DigestSchema.nullable() }),
    confirmed: z.literal(true),
    agentId: IdentifierSchema.optional(),
  }),
  z.strictObject({
    target: z.literal("ledger"),
    expectedDigests: z.strictObject({ ledger: Sha256DigestSchema.nullable() }),
    confirmed: z.literal(true),
    agentId: IdentifierSchema.optional(),
  }),
  z.strictObject({
    target: z.literal("all"),
    expectedDigests: z.strictObject({
      store: Sha256DigestSchema.nullable(),
      ledger: Sha256DigestSchema.nullable(),
    }),
    confirmed: z.literal(true),
    agentId: IdentifierSchema.optional(),
  }),
]);

const DigestPairSchema = z.strictObject({
  store: Sha256DigestSchema.nullable(),
  ledger: Sha256DigestSchema.nullable(),
});

export const CronResetContract = defineContract({
  method: "cron.reset",
  request: CronResetRequestSchema,
  response: z.strictObject({
    operationId: IdentifierSchema,
    target: z.enum(["store", "ledger", "all"]),
    resolvedAgentId: IdentifierSchema,
    beforeDigests: DigestPairSchema,
    afterDigests: DigestPairSchema,
    state: z.enum(["disabled", "ready", "active"]),
    reactivated: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

const CronExecutionGroupProjectionSchema = z.strictObject({
  executionId: IdentifierSchema,
  jobId: IdentifierSchema,
  agentId: IdentifierSchema,
  scheduledForMs: EpochMsSchema,
  trigger: z.enum(["scheduled", "catchup", "manual"]),
  workKind: z.enum(["agent_turn", "heartbeat_event", "internal_action", "delivery_only"]),
  rootRunId: z.string().nullable(),
  startedAtMs: EpochMsSchema,
  terminalAtMs: EpochMsSchema.optional(),
  durationMs: NonnegativeSafeIntegerSchema.optional(),
  status: z.enum(["started", "dispatched", "completed", "failed", "aborted", "skipped", "unknown"]),
  deliveryStatus: z.enum(["not_requested", "suppressed", "pre_send_failed", "accepted", "partial", "rejected", "unknown"]),
  errorKind: ErrorKindSchema.optional(),
});

export const CronRunsContract = defineContract({
  method: "cron.runs",
  request: z.strictObject({
    jobName: z.string().min(1),
    limit: PositiveSafeIntegerSchema.max(10_000).optional(),
    agentId: z.string().min(1).optional(),
  }),
  response: z.strictObject({ runs: z.array(CronExecutionGroupProjectionSchema) }),
  scopes: ["rpc"] as const,
});

export const CronRunContract = defineContract({
  method: "cron.run",
  request: z.strictObject({
    jobName: z.string().min(1).optional(),
    mode: z.enum(["force", "due"]).optional(),
    agentId: z.string().min(1).optional(),
  }),
  response: z.strictObject({
    triggered: z.boolean(),
    mode: z.enum(["force", "due"]),
    jobName: z.string().optional(),
    resolvedAgentId: IdentifierSchema,
    executionId: IdentifierSchema.optional(),
    executionIds: z.array(IdentifierSchema).optional(),
  }),
  scopes: ["rpc"] as const,
});

export const SchedulerWakeContract = defineContract({
  method: "scheduler.wake",
  request: z.strictObject({ target: z.enum(["agent", "monitoring"]) }),
  response: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("accepted"),
      disposition: z.enum(["new_occurrence", "occurrence_upgraded"]),
      correlationId: IdentifierSchema,
      lane: z.enum(["normal", "task"]),
      retainedReason: z.enum(["interval", "manual", "hook", "wake", "exec-event", "cron", "task"]),
    }),
    z.strictObject({
      status: z.literal("coalesced"),
      correlationId: IdentifierSchema,
      lane: z.enum(["normal", "task"]),
      retainedReason: z.enum(["interval", "manual", "hook", "wake", "exec-event", "cron", "task"]),
    }),
  ]),
  scopes: ["rpc"] as const,
});

export const CRON_HANDLERS_CONTRACTS = [
  CronAddContract,
  CronListContract,
  CronUpdateContract,
  CronRemoveContract,
  CronStatusContract,
  CronRunsContract,
  CronRunContract,
  CronResetContract,
  SchedulerWakeContract,
] as const;

function rawAuthoritySchema() {
  return z.strictObject({
    exists: z.boolean(),
    bytes: NonnegativeSafeIntegerSchema,
    digest: Sha256DigestSchema.nullable(),
  }).superRefine((value, ctx) => {
    if (value.exists !== (value.digest !== null) || (!value.exists && value.bytes !== 0)) {
      ctx.addIssue({ code: "custom", message: "raw authority existence, bytes, and digest must agree" });
    }
  });
}

function endpointsEqual(
  left: z.infer<typeof ChannelEndpointSchema>,
  right: z.infer<typeof ChannelEndpointSchema>,
): boolean {
  return left.channelType === right.channelType
    && left.channelInstanceId === right.channelInstanceId
    && left.conversationId === right.conversationId
    && left.threadId === right.threadId
    && left.conversationKind === right.conversationKind;
}
