// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";
import { UserTrustLevelSchema } from "../context/context.js";
import { AGENT_CAPABILITIES } from "../security/capability.js";
import { DeliveryOriginSchema } from "./delivery-origin.js";
import {
  ConversationRefSchema,
  ResolvedTurnScopeSchema,
  createConversationRef,
} from "./conversation-scope.js";
import { ResponseLocalePolicySchema } from "./response-locale-policy.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const TOOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~/-]*$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const OpaqueIdSchema = z.string().min(1).max(256).regex(OPAQUE_ID_PATTERN);
const DigestSchema = z.string().regex(SHA256_HEX_PATTERN);
const TimestampMsSchema = z.number().int().nonnegative();

export const ManagedRunStatusSchema = z.enum([
  "preparing",
  "active",
  "waiting",
  "paused",
  "candidate_complete",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);

export const ManagedRunStatusReasonSchema = z.enum([
  "awaiting_activation",
  "activation_acknowledged",
  "activation_rejected",
  "report_activity",
  "attention_pending",
  "service_paused",
  "verification_pending",
  "outcome_verified",
  "failure_verified",
  "owner_cancelled",
  "authority_revoked",
  "recovery_join_missing",
  "service_state_unavailable",
  "activation_outcome_unknown",
]);

export const ManagedRunInitiationSourceSchema = z.enum([
  "user_request",
  "schedule",
  "service_event",
]);

export const ManagedRunTerminalOutcomeSchema = z.strictObject({
  kind: z.enum(["succeeded", "failed", "cancelled"]),
  recordedAtMs: TimestampMsSchema,
});

const sortedUnique = <T>(values: readonly T[], compare: (left: T, right: T) => number): boolean =>
  values.every((value, index) => index === 0 || compare(values[index - 1] as T, value) < 0);

const SortedAgentCapabilitiesSchema = z.array(z.enum(AGENT_CAPABILITIES)).max(64).refine(
  (values) => sortedUnique(values, (left, right) => left.localeCompare(right)),
  "captured agent capabilities must be unique and sorted",
);

const SortedToolIdsSchema = z.array(z.string().min(1).max(256).regex(TOOL_ID_PATTERN)).max(512).refine(
  (values) => sortedUnique(values, (left, right) => left.localeCompare(right)),
  "captured tool ids must be unique and sorted",
);

const SortedOpaqueIdsSchema = z.array(OpaqueIdSchema).max(256).refine(
  (values) => sortedUnique(values, (left, right) => left.localeCompare(right)),
  "captured references must be unique and sorted",
);

const STATUS_REASONS = {
  preparing: new Set(["awaiting_activation"]),
  active: new Set(["activation_acknowledged", "report_activity"]),
  waiting: new Set(["attention_pending"]),
  paused: new Set(["service_paused"]),
  candidate_complete: new Set(["verification_pending"]),
  succeeded: new Set(["outcome_verified"]),
  failed: new Set(["failure_verified"]),
  cancelled: new Set(["activation_rejected", "owner_cancelled", "authority_revoked"]),
  unknown: new Set([
    "recovery_join_missing",
    "service_state_unavailable",
    "activation_outcome_unknown",
  ]),
} as const satisfies Readonly<Record<z.infer<typeof ManagedRunStatusSchema>, ReadonlySet<string>>>;

export const ManagedRunRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  managedRunId: OpaqueIdSchema,
  serviceInstanceId: OpaqueIdSchema,
  externalRunRefDigest: DigestSchema,
  activationDescriptorDigest: DigestSchema,
  activationDescriptorRef: OpaqueIdSchema.optional(),
  displayLabel: z.string().trim().min(1).max(256).optional(),
  tenantId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  principalId: z.string().min(1).max(256),
  conversationRef: ConversationRefSchema,
  turnScope: ResolvedTurnScopeSchema,
  deliveryOrigin: DeliveryOriginSchema,
  traceId: z.string().min(1).max(256),
  trustLevel: UserTrustLevelSchema,
  responseLocalePolicy: ResponseLocalePolicySchema,
  workspacePolicyHash: DigestSchema,
  rootRunId: OpaqueIdSchema,
  initiationSource: ManagedRunInitiationSourceSchema,
  ingressProfileId: OpaqueIdSchema.optional(),
  ingressEventDigest: DigestSchema.optional(),
  managedRunGroupId: OpaqueIdSchema.optional(),
  parentManagedRunId: OpaqueIdSchema.optional(),
  capturedAgentCapabilities: SortedAgentCapabilitiesSchema,
  capturedToolIds: SortedToolIdsSchema,
  capturedCapabilityViewHash: DigestSchema,
  workspaceLeaseId: OpaqueIdSchema.optional(),
  executionAttachmentIds: SortedOpaqueIdsSchema,
  terminalSessionIds: SortedOpaqueIdsSchema,
  status: ManagedRunStatusSchema,
  statusReason: ManagedRunStatusReasonSchema,
  lastAcceptedReportSequence: z.number().int().nonnegative(),
  lastReducedReportSequence: z.number().int().nonnegative(),
  pendingContinuation: z.boolean(),
  openAttentionCount: z.number().int().nonnegative(),
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  lastHeartbeatAtMs: TimestampMsSchema.optional(),
  terminalOutcome: ManagedRunTerminalOutcomeSchema.optional(),
}).superRefine((record, context) => {
  const conversation = record.turnScope.conversation;
  if (record.tenantId !== conversation.tenantId) {
    context.addIssue({ code: "custom", path: ["tenantId"], message: "tenant must match the canonical turn scope" });
  }
  if (record.agentId !== conversation.agentId) {
    context.addIssue({ code: "custom", path: ["agentId"], message: "agent must match the canonical turn scope" });
  }
  if (record.principalId !== record.turnScope.principal.principalId) {
    context.addIssue({ code: "custom", path: ["principalId"], message: "principal must match the canonical turn scope" });
  }
  const expectedConversationRef = createConversationRef(conversation);
  if (!expectedConversationRef.ok || expectedConversationRef.value !== record.conversationRef) {
    context.addIssue({ code: "custom", path: ["conversationRef"], message: "conversation reference must match the canonical turn scope" });
  }

  const endpoint = record.turnScope.endpoint;
  const origin = record.deliveryOrigin;
  if (
    origin.tenantId !== record.tenantId
    || origin.userId !== record.principalId
    || origin.channelType !== endpoint.channelType
    || origin.channelId !== endpoint.conversationId
    || origin.threadId !== endpoint.threadId
  ) {
    context.addIssue({ code: "custom", path: ["deliveryOrigin"], message: "delivery origin must match the exact turn endpoint and principal" });
  }

  const hasIngressProfile = record.ingressProfileId !== undefined;
  const hasIngressEvent = record.ingressEventDigest !== undefined;
  if (record.initiationSource === "service_event") {
    if (!hasIngressProfile || !hasIngressEvent) {
      context.addIssue({ code: "custom", path: ["initiationSource"], message: "service events require profile and event provenance" });
    }
  } else if (hasIngressProfile || hasIngressEvent) {
    context.addIssue({ code: "custom", path: ["initiationSource"], message: "non-event runs cannot carry service-event provenance" });
  }

  if (!STATUS_REASONS[record.status].has(record.statusReason)) {
    context.addIssue({ code: "custom", path: ["statusReason"], message: "status reason must match the managed-run status" });
  }
  if (record.status === "preparing" && record.activationDescriptorRef === undefined) {
    context.addIssue({ code: "custom", path: ["activationDescriptorRef"], message: "preparing runs require an activation descriptor" });
  }
  if (
    record.activationDescriptorRef !== undefined
    && record.status !== "preparing"
    && record.status !== "unknown"
  ) {
    context.addIssue({ code: "custom", path: ["activationDescriptorRef"], message: "only preparing or uncertain runs may retain an activation descriptor" });
  }

  const terminal = record.status === "succeeded" || record.status === "failed" || record.status === "cancelled";
  if (terminal && record.terminalOutcome?.kind !== record.status) {
    context.addIssue({ code: "custom", path: ["terminalOutcome"], message: "terminal status requires its matching terminal outcome" });
  }
  if (!terminal && record.terminalOutcome !== undefined) {
    context.addIssue({ code: "custom", path: ["terminalOutcome"], message: "nonterminal runs cannot carry a terminal outcome" });
  }
  if (record.lastReducedReportSequence > record.lastAcceptedReportSequence) {
    context.addIssue({ code: "custom", path: ["lastReducedReportSequence"], message: "reduced report sequence cannot exceed the accepted sequence" });
  }
  if (record.updatedAtMs < record.createdAtMs) {
    context.addIssue({ code: "custom", path: ["updatedAtMs"], message: "updated time cannot precede creation" });
  }
  if (record.lastHeartbeatAtMs !== undefined && record.lastHeartbeatAtMs > record.updatedAtMs) {
    context.addIssue({ code: "custom", path: ["lastHeartbeatAtMs"], message: "heartbeat cannot be later than the record update" });
  }
  if (
    record.terminalOutcome !== undefined
    && (record.terminalOutcome.recordedAtMs < record.createdAtMs
      || record.terminalOutcome.recordedAtMs > record.updatedAtMs)
  ) {
    context.addIssue({ code: "custom", path: ["terminalOutcome", "recordedAtMs"], message: "terminal outcome time must fall within the record lifetime" });
  }
});

export type ManagedRunStatus = z.infer<typeof ManagedRunStatusSchema>;
export type ManagedRunStatusReason = z.infer<typeof ManagedRunStatusReasonSchema>;
export type ManagedRunInitiationSource = z.infer<typeof ManagedRunInitiationSourceSchema>;
export type ManagedRunTerminalOutcome = z.infer<typeof ManagedRunTerminalOutcomeSchema>;
export type ManagedRunRecord = z.infer<typeof ManagedRunRecordSchema>;

export function parseManagedRunRecord(raw: unknown): Result<ManagedRunRecord, z.ZodError> {
  const parsed = ManagedRunRecordSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
