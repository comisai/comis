// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";
import type { SessionKey } from "./session-key.js";

export const ChannelEndpointSchema = z.strictObject({
  channelType: z.string().min(1),
  channelInstanceId: z.string().min(1),
  conversationId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  conversationKind: z.enum(["direct", "shared"]),
});
export type ChannelEndpoint = z.infer<typeof ChannelEndpointSchema>;

export const PrincipalScopeSchema = z.strictObject({
  principalId: z.string().min(1),
});
export type PrincipalScope = z.infer<typeof PrincipalScopeSchema>;

export const PlatformPrincipalAssertionSchema = z.strictObject({
  channelType: z.string().min(1),
  channelInstanceId: z.string().min(1),
  platformSubjectId: z.string().min(1),
});
export type PlatformPrincipalAssertion = z.infer<typeof PlatformPrincipalAssertionSchema>;

export const ConversationPartitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent") }),
  z.strictObject({ kind: z.literal("principal"), principalId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("channel-principal"),
    channelType: z.string().min(1),
    principalId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("endpoint-conversation"), endpoint: ChannelEndpointSchema }),
  z.strictObject({
    kind: z.literal("endpoint-conversation-principal"),
    endpoint: ChannelEndpointSchema,
    principalId: z.string().min(1),
  }),
]);
export type ConversationPartition = z.infer<typeof ConversationPartitionSchema>;

export const ConversationScopeSchema = z.strictObject({
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  partition: ConversationPartitionSchema,
});
export type ConversationScope = z.infer<typeof ConversationScopeSchema>;

function endpointsEqual(left: ChannelEndpoint, right: ChannelEndpoint): boolean {
  return left.channelType === right.channelType
    && left.channelInstanceId === right.channelInstanceId
    && left.conversationId === right.conversationId
    && left.threadId === right.threadId
    && left.conversationKind === right.conversationKind;
}

export const ResolvedTurnScopeSchema = z
  .strictObject({
    conversation: ConversationScopeSchema,
    principal: PrincipalScopeSchema,
    endpoint: ChannelEndpointSchema,
  })
  .superRefine((value, ctx) => {
    const partition = value.conversation.partition;
    if (
      (partition.kind === "principal"
        || partition.kind === "channel-principal"
        || partition.kind === "endpoint-conversation-principal")
      && partition.principalId !== value.principal.principalId
    ) {
      ctx.addIssue({ code: "custom", path: ["conversation", "partition", "principalId"], message: "partition principal must equal authenticated principal" });
    }
    if (
      partition.kind === "channel-principal"
      && partition.channelType !== value.endpoint.channelType
    ) {
      ctx.addIssue({ code: "custom", path: ["conversation", "partition", "channelType"], message: "partition channel type must equal endpoint channel type" });
    }
    if (
      (partition.kind === "endpoint-conversation"
        || partition.kind === "endpoint-conversation-principal")
      && !endpointsEqual(partition.endpoint, value.endpoint)
    ) {
      ctx.addIssue({ code: "custom", path: ["conversation", "partition", "endpoint"], message: "partition endpoint must equal the resolved thread-narrowed endpoint" });
    }
  });
export type ResolvedTurnScope = z.infer<typeof ResolvedTurnScopeSchema>;

export const ConversationRefSchema = z
  .string()
  .regex(/^cv_[A-Za-z0-9_-]{43}$/)
  .brand<"ConversationRef">();
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

export const ConversationLocatorSchema = z.strictObject({
  conversationScope: ConversationScopeSchema,
  conversationRef: ConversationRefSchema,
}).superRefine((value, ctx) => {
  const expected = createConversationRef(value.conversationScope);
  if (!expected.ok || expected.value !== value.conversationRef) {
    ctx.addIssue({
      code: "custom",
      path: ["conversationRef"],
      message: "conversation reference must match the canonical conversation scope",
    });
  }
});
export type ConversationLocator = z.infer<typeof ConversationLocatorSchema>;

export class ConversationScopeError extends Error {
  readonly errorKind = "validation" as const;
}

function lengthDelimited(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function encodeEndpoint(endpoint: ChannelEndpoint): string[] {
  return [
    endpoint.channelType,
    endpoint.channelInstanceId,
    endpoint.conversationId,
    endpoint.threadId === undefined ? "thread:absent" : `thread:present:${endpoint.threadId}`,
    endpoint.conversationKind,
  ];
}

/** Canonical versioned encoding used only as the input to the opaque digest. */
export function encodeConversationScope(scope: ConversationScope): Result<string, ConversationScopeError> {
  const parsed = ConversationScopeSchema.safeParse(scope);
  if (!parsed.success) return err(new ConversationScopeError("Invalid conversation scope"));
  const value = parsed.data;
  const partition = value.partition;
  let partitionFields: string[];
  switch (partition.kind) {
    case "agent":
      partitionFields = [partition.kind];
      break;
    case "principal":
      partitionFields = [partition.kind, partition.principalId];
      break;
    case "channel-principal":
      partitionFields = [partition.kind, partition.channelType, partition.principalId];
      break;
    case "endpoint-conversation":
      partitionFields = [partition.kind, ...encodeEndpoint(partition.endpoint)];
      break;
    case "endpoint-conversation-principal":
      partitionFields = [partition.kind, ...encodeEndpoint(partition.endpoint), partition.principalId];
      break;
    default: {
      const _exhaustive: never = partition;
      return err(new ConversationScopeError(`Unsupported conversation partition: ${String(_exhaustive)}`));
    }
  }
  const fields = ["comis-conversation-scope", "v1", value.tenantId, value.agentId, ...partitionFields];
  return ok(fields.map(lengthDelimited).join(""));
}

export function createConversationRef(
  scope: ConversationScope,
): Result<ConversationRef, ConversationScopeError> {
  const encoded = encodeConversationScope(scope);
  if (!encoded.ok) return encoded;
  const candidate = `cv_${createHash("sha256").update(encoded.value, "utf8").digest("base64url")}`;
  const parsed = ConversationRefSchema.safeParse(candidate);
  return parsed.success
    ? ok(parsed.data)
    : err(new ConversationScopeError("Conversation reference generation failed validation"));
}

export function createConversationLocator(
  scope: ConversationScope,
): Result<ConversationLocator, ConversationScopeError> {
  const parsed = ConversationScopeSchema.safeParse(scope);
  if (!parsed.success) return err(new ConversationScopeError("Invalid conversation scope"));
  const reference = createConversationRef(parsed.data);
  return reference.ok
    ? ok({ conversationScope: parsed.data, conversationRef: reference.value })
    : reference;
}

/** Deterministic human-readable projection for transcript paths and cache labels only. */
export function conversationScopeToSessionKey(
  scope: ConversationScope,
): Result<SessionKey, ConversationScopeError> {
  const parsed = ConversationScopeSchema.safeParse(scope);
  if (!parsed.success) return err(new ConversationScopeError("Invalid conversation scope"));
  const base = { tenantId: parsed.data.tenantId, agentId: parsed.data.agentId };
  const partition = parsed.data.partition;
  switch (partition.kind) {
    case "agent":
      return ok({ ...base, userId: "main", channelId: "dm" });
    case "principal":
      return ok({ ...base, userId: partition.principalId, channelId: "dm", peerId: partition.principalId });
    case "channel-principal":
      return ok({ ...base, userId: partition.principalId, channelId: partition.channelType, peerId: partition.principalId });
    case "endpoint-conversation":
      return ok({
        ...base,
        userId: "conversation",
        channelId: `${partition.endpoint.channelType}:${partition.endpoint.channelInstanceId}:${partition.endpoint.conversationId}`,
        ...(partition.endpoint.threadId === undefined ? {} : { threadId: partition.endpoint.threadId }),
      });
    case "endpoint-conversation-principal":
      return ok({
        ...base,
        userId: partition.principalId,
        channelId: `${partition.endpoint.channelType}:${partition.endpoint.channelInstanceId}:${partition.endpoint.conversationId}`,
        peerId: partition.principalId,
        ...(partition.endpoint.threadId === undefined ? {} : { threadId: partition.endpoint.threadId }),
      });
    default: {
      const _exhaustive: never = partition;
      return err(new ConversationScopeError(`Unsupported conversation partition: ${String(_exhaustive)}`));
    }
  }
}
