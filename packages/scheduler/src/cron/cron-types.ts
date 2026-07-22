// SPDX-License-Identifier: Apache-2.0
import {
  ChannelEndpointSchema,
  ConversationLocatorSchema,
} from "@comis/core";
import { z } from "zod";

const MAX_IDENTIFIER_BYTES = 256;
const MAX_MODEL_BYTES = 512;
export const MAX_CRON_TEXT_BYTES = 64 * 1024;
export const MAX_WAKE_GATE_SCRIPT_BYTES = 256 * 1024;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(maxBytes: number, label: string) {
  return z.string().min(1).refine(
    (value) => utf8Bytes(value) <= maxBytes,
    `${label} exceeds ${maxBytes} UTF-8 bytes`,
  );
}

const IdentifierSchema = boundedString(MAX_IDENTIFIER_BYTES, "identifier");
const EpochMsSchema = z.number().int().nonnegative().safe();
const PositiveSafeIntegerSchema = z.number().int().positive().safe();
const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

/** Store-ready schedules are fully resolved and host-timezone independent. */
export const CronPersistedScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("cron"),
    expr: boundedString(1_024, "cron expression"),
    tz: boundedString(128, "timezone"),
  }),
  z.strictObject({
    kind: z.literal("every"),
    everyMs: PositiveSafeIntegerSchema,
    anchorMs: EpochMsSchema,
  }),
  z.strictObject({
    kind: z.literal("at"),
    atMs: EpochMsSchema,
  }),
]);

export type CronPersistedSchedule = z.infer<typeof CronPersistedScheduleSchema>;
export type CronSchedule = CronPersistedSchedule;

/** Public authoring schedules are resolved exactly once before persistence. */
export const CronAuthoringScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("cron"),
    expr: boundedString(1_024, "cron expression"),
    tz: boundedString(128, "timezone").optional(),
  }),
  z.strictObject({
    kind: z.literal("every"),
    everyMs: PositiveSafeIntegerSchema,
    anchorMs: EpochMsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("at"),
    at: boundedString(128, "wall-clock timestamp"),
    tz: boundedString(128, "timezone").optional(),
    fold: z.enum(["earlier", "later"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("in"),
    seconds: PositiveSafeIntegerSchema,
  }),
]);

export type CronAuthoringSchedule = z.infer<typeof CronAuthoringScheduleSchema>;

export const CronJobLifecycleSchema = z.discriminatedUnion("status", [
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

export type CronJobLifecycle = z.infer<typeof CronJobLifecycleSchema>;

export const CronAuthorablePayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("heartbeat_event"),
    text: boundedString(MAX_CRON_TEXT_BYTES, "heartbeat-event text"),
    wakeMode: z.enum(["now", "next-heartbeat"]),
  }),
  z.strictObject({
    kind: z.literal("delivery"),
    text: boundedString(MAX_CRON_TEXT_BYTES, "delivery text"),
  }),
  z.strictObject({
    kind: z.literal("agent_turn"),
    message: boundedString(MAX_CRON_TEXT_BYTES, "agent-turn message"),
    model: boundedString(MAX_MODEL_BYTES, "model override").optional(),
    timeoutSeconds: PositiveSafeIntegerSchema.max(86_400).optional(),
  }),
]);

export type CronAuthorablePayload = z.infer<typeof CronAuthorablePayloadSchema>;

export const CronInternalActionNameSchema = z.enum([
  "memory_review",
  "memory_lifecycle",
  "reflection",
]);
export type CronInternalActionName = z.infer<typeof CronInternalActionNameSchema>;

export const CronAgentSessionPolicySchema = z.discriminatedUnion("strategy", [
  z.strictObject({ strategy: z.literal("fresh") }),
  z.strictObject({
    strategy: z.literal("rolling"),
    maxHistoryTurns: PositiveSafeIntegerSchema.max(20),
  }),
]);
export type CronAgentSessionPolicy = z.infer<typeof CronAgentSessionPolicySchema>;

export const CronWakeGateSchema = z.strictObject({
  script: boundedString(MAX_WAKE_GATE_SCRIPT_BYTES, "wake-gate script"),
  language: z.enum(["js", "ts"]),
  timeoutSeconds: PositiveSafeIntegerSchema.max(300),
});
export type CronWakeGate = z.infer<typeof CronWakeGateSchema>;

export const CronDeliveryTargetSchema = z.strictObject({
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
    (partition.kind === "endpoint-conversation"
      || partition.kind === "endpoint-conversation-principal")
    && !channelEndpointsEqual(partition.endpoint, endpoint)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["destinationEndpoint"],
      message: "destination endpoint must match the conversation partition",
    });
  }
});
export type CronDeliveryTarget = z.infer<typeof CronDeliveryTargetSchema>;

const ToolPolicySchema = z.strictObject({
  profile: z.enum(["minimal", "coding", "messaging", "supervisor", "full"]),
  allow: z.array(IdentifierSchema).max(256),
  deny: z.array(IdentifierSchema).max(256),
});

const CronJobBaseShape = {
  id: IdentifierSchema,
  name: boundedString(1_024, "job name").max(200),
  agentId: IdentifierSchema,
  schedule: CronPersistedScheduleSchema,
  lifecycle: CronJobLifecycleSchema,
  maxConsecutiveDependencyErrors: NonnegativeSafeIntegerSchema.optional(),
};

export const AuthoredHeartbeatCronJobSchema = z.strictObject({
  ...CronJobBaseShape,
  source: z.literal("authored"),
  payload: CronAuthorablePayloadSchema.options[0],
});

export const AuthoredDeliveryCronJobSchema = z.strictObject({
  ...CronJobBaseShape,
  source: z.literal("authored"),
  payload: CronAuthorablePayloadSchema.options[1],
  deliveryTarget: CronDeliveryTargetSchema,
});

export const AuthoredAgentTurnCronJobSchema = z.strictObject({
  ...CronJobBaseShape,
  source: z.literal("authored"),
  payload: CronAuthorablePayloadSchema.options[2],
  sessionPolicy: CronAgentSessionPolicySchema,
  continuationMode: z.enum(["none", "heartbeat_excerpt", "origin_history"]),
  deliveryTarget: CronDeliveryTargetSchema.optional(),
  wakeGate: CronWakeGateSchema.optional(),
  cacheRetention: z.enum(["none", "short", "long"]).optional(),
  toolPolicy: ToolPolicySchema.optional(),
}).superRefine((value, ctx) => {
  if (value.continuationMode === "origin_history" && value.deliveryTarget === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["deliveryTarget"],
      message: "origin_history continuation requires a delivery target",
    });
  }
});

export const BuiltInCronJobSchema = z.strictObject({
  ...CronJobBaseShape,
  source: z.literal("built_in"),
  payload: z.strictObject({
    kind: z.literal("internal_action"),
    action: CronInternalActionNameSchema,
  }),
});

export const CronPersistedJobSchema = z.union([
  AuthoredHeartbeatCronJobSchema,
  AuthoredDeliveryCronJobSchema,
  AuthoredAgentTurnCronJobSchema,
  BuiltInCronJobSchema,
]).superRefine((job, ctx) => {
  if ("deliveryTarget" in job && job.deliveryTarget !== undefined
    && job.deliveryTarget.conversation.conversationScope.agentId !== job.agentId) {
    ctx.addIssue({
      code: "custom",
      path: ["deliveryTarget", "conversation", "conversationScope", "agentId"],
      message: "delivery conversation must belong to the job owner",
    });
  }
  const oneShotLifecycle = job.lifecycle.status === "one_shot_claimed"
    || job.lifecycle.status === "one_shot_terminal";
  if (oneShotLifecycle && job.schedule.kind !== "at") {
    ctx.addIssue({
      code: "custom",
      path: ["lifecycle", "status"],
      message: "one-shot lifecycle is legal only for an at schedule",
    });
  }
});

export type CronPersistedJob = z.infer<typeof CronPersistedJobSchema>;
export type CronJob = CronPersistedJob;
export type AuthoredHeartbeatCronJob = z.infer<typeof AuthoredHeartbeatCronJobSchema>;
export type AuthoredDeliveryCronJob = z.infer<typeof AuthoredDeliveryCronJobSchema>;
export type AuthoredAgentTurnCronJob = z.infer<typeof AuthoredAgentTurnCronJobSchema>;
export type BuiltInCronJob = z.infer<typeof BuiltInCronJobSchema>;

function channelEndpointsEqual(
  left: z.infer<typeof ChannelEndpointSchema>,
  right: z.infer<typeof ChannelEndpointSchema>,
): boolean {
  return left.channelType === right.channelType
    && left.channelInstanceId === right.channelInstanceId
    && left.conversationId === right.conversationId
    && left.threadId === right.threadId
    && left.conversationKind === right.conversationKind;
}
