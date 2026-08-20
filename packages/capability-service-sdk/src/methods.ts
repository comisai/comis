// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { CAPABILITY_SERVICE_LIMITS, CAPABILITY_SERVICE_PROTOCOL_ID } from "./constants.js";
import {
  AttachmentTargetNameSchema,
  BundleDigestSchema,
  CapabilityServiceLimitsSchema,
  CapabilityServiceScopeSchema,
  ContentDigestSchema,
  EvidenceKindSchema,
  EvidenceRefSchema,
  ExecutionAttachmentIdSchema,
  ExternalRunRefSchema,
  ManagedRunGroupIdSchema,
  ManagedRunIdSchema,
  OperationIdSchema,
  RegistrationNonceSchema,
  ServiceInstanceIdSchema,
  ServiceReportIdSchema,
  TerminalSessionIdSchema,
  TimestampMsSchema,
  WorkspaceLeaseIdSchema,
} from "./common.js";

const ProtocolIdSchema = z.literal(CAPABILITY_SERVICE_PROTOCOL_ID);
const BASE64_JSON_SCHEMA_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

function hasValidBase64Shape(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const paddingStart = value.endsWith("==")
    ? value.length - 2
    : value.endsWith("=") ? value.length - 1 : value.length;
  for (let index = 0; index < paddingStart; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphabet = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!isAlphabet) return false;
  }
  for (let index = paddingStart; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

const HandshakeParamsSchema = z.strictObject({
  protocolId: ProtocolIdSchema,
  bundleDigest: BundleDigestSchema,
  operationId: OperationIdSchema,
  serviceInstanceId: ServiceInstanceIdSchema,
  requestedScopes: z.array(CapabilityServiceScopeSchema).min(1).max(8),
});

export const CapabilityHandshakeRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("capabilityServices.handshake"),
  params: HandshakeParamsSchema,
});

export const CapabilityHandshakeResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    protocolId: ProtocolIdSchema,
    bundleDigest: BundleDigestSchema,
    serviceInstanceId: ServiceInstanceIdSchema,
    activeScopes: z.array(CapabilityServiceScopeSchema).min(1).max(8),
    limits: CapabilityServiceLimitsSchema,
  }),
});

const activateParamsShape = {
  operationId: OperationIdSchema,
  managedRunId: ManagedRunIdSchema,
  externalRunRef: ExternalRunRefSchema,
  registrationNonce: RegistrationNonceSchema,
  workspaceLeaseId: WorkspaceLeaseIdSchema.optional(),
};

const ActivateParamsSchema = z.union([
  z.strictObject({
    ...activateParamsShape,
    executionAttachmentId: ExecutionAttachmentIdSchema,
    attachmentTargetName: AttachmentTargetNameSchema,
  }),
  z.strictObject(activateParamsShape),
]);

export const CapabilityActivateRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRuns.activate"),
  params: ActivateParamsSchema,
});

export const CapabilityActivateResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunId: ManagedRunIdSchema,
    externalRunRef: ExternalRunRefSchema,
    state: z.literal("active"),
    activatedAtMs: TimestampMsSchema,
  }),
});

export const CapabilityAbandonRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRuns.abandon"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    externalRunRef: ExternalRunRefSchema,
    registrationNonce: RegistrationNonceSchema,
    reason: z.enum([
      "activation_rejected",
      "owner_cancelled",
      "registration_expired",
      "service_unavailable",
    ]),
    disposition: z.enum(["reap_safe", "preserve"]),
  }),
});

export const CapabilityAbandonResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    externalRunRef: ExternalRunRefSchema,
    state: z.literal("abandoned"),
    disposition: z.enum(["reap_safe", "preserve"]),
    terminalTransition: z.literal("unbound_preparation_abandoned"),
  }),
});

/**
 * Asks a running service to stop one bound run. The host names the run and why
 * it is stopping; it never names a disposition, because whether the service's
 * own artifacts survive is a domain judgement about work the host cannot see.
 * Cancellation is idempotent: a run already settled answers already_terminal.
 */
export const CapabilityCancelRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRuns.cancel"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunId: ManagedRunIdSchema,
    reason: z.enum(["owner_cancelled", "authority_revoked", "budget_exhausted"]),
  }),
});

export const CapabilityCancelResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunId: ManagedRunIdSchema,
    state: z.enum(["cancelling", "cancelled", "already_terminal"]),
    acknowledgedAtMs: TimestampMsSchema,
  }),
});

export const CapabilityReportRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRuns.report"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunId: ManagedRunIdSchema,
    serviceReportId: ServiceReportIdSchema,
    kind: z.enum([
      "attention",
      "blocked",
      "candidate_complete",
      "failed",
      "paused",
      "progress",
      "resolution",
    ]),
    externalKey: z.string().min(1).max(256).optional(),
    summary: z.string().max(CAPABILITY_SERVICE_LIMITS.maxReportBytes),
    details: z.string().max(CAPABILITY_SERVICE_LIMITS.maxReportBytes).optional(),
    artifactRefs: z.array(EvidenceRefSchema).max(32).optional(),
    observedAtMs: TimestampMsSchema.optional(),
  }),
});

export const CapabilityReportResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunId: ManagedRunIdSchema,
    serviceReportId: ServiceReportIdSchema,
    acceptedSequence: z.number().int().positive(),
    retainedUntilMs: TimestampMsSchema,
  }),
});

export const CapabilityReceiveAttentionResponseRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRuns.receiveAttentionResponse"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunId: ManagedRunIdSchema,
    externalKey: z.string().min(1).max(256),
  }),
});

const receiveAttentionResponseResultShape = {
  managedRunId: ManagedRunIdSchema,
  externalKey: z.string().min(1).max(256),
};

export const CapabilityReceiveAttentionResponseResponseSchema = z.union([
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: OperationIdSchema,
    result: z.strictObject({
      ...receiveAttentionResponseResultShape,
      state: z.literal("pending"),
    }),
  }),
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: OperationIdSchema,
    result: z.strictObject({
      ...receiveAttentionResponseResultShape,
      state: z.literal("delivered"),
      response: z.string().min(1).max(CAPABILITY_SERVICE_LIMITS.maxReportBytes),
    }),
  }),
]);

const EvidenceDeliverySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reference") }),
  z.strictObject({
    kind: z.literal("attachment"),
    // eslint-disable-next-line no-control-regex -- attachment filenames must reject NUL at the wire boundary
    fileName: z.string().min(1).max(256).regex(/^[^/\\\u0000\r\n]+$/u),
    mediaType: z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/u),
  }),
]);

export const CapabilityPutEvidenceRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRuns.putEvidence"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunId: ManagedRunIdSchema,
    evidenceRef: EvidenceRefSchema,
    kind: EvidenceKindSchema,
    subjectDigest: ContentDigestSchema,
    observedAtMs: TimestampMsSchema,
    expiresAtMs: TimestampMsSchema.optional(),
    contentHash: ContentDigestSchema,
    verificationLevel: z.enum(["reported", "adapter_verified", "host_verified"]),
    bodyBase64: z.string()
      .max(Math.ceil(CAPABILITY_SERVICE_LIMITS.maxEvidenceBytes / 3) * 4)
      .refine(hasValidBase64Shape, "must use valid base64 syntax")
      .meta({ pattern: BASE64_JSON_SCHEMA_PATTERN }),
    delivery: EvidenceDeliverySchema.optional(),
  }),
});

export const CapabilityPutEvidenceResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunId: ManagedRunIdSchema,
    evidenceRef: EvidenceRefSchema,
    contentHash: ContentDigestSchema,
    verificationLevel: z.enum(["reported", "adapter_verified"]),
    retainedUntilMs: TimestampMsSchema.optional(),
  }),
});

export const CapabilityReleaseRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRuns.release"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunId: ManagedRunIdSchema,
    workspaceLeaseId: WorkspaceLeaseIdSchema,
    disposition: z.enum(["reap_safe", "preserve"]),
    releasedAtMs: TimestampMsSchema,
  }),
});

export const CapabilityReleaseResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunId: ManagedRunIdSchema,
    workspaceLeaseId: WorkspaceLeaseIdSchema,
    state: z.literal("released"),
    disposition: z.enum(["reap_safe", "preserve"]),
    releasedAtMs: TimestampMsSchema,
  }),
});

/**
 * A group operation reports one outcome per member and is never advertised as
 * atomic. `not_attempted` is the load-bearing member of this set: a caller that
 * stopped partway must be able to say so, rather than pick between claiming a
 * success it did not get and a rejection that never happened.
 */
export const CapabilityGroupMemberOutcomeSchema = z.enum([
  "completed",
  "rejected",
  "unknown",
  "not_attempted",
]);

const GroupMemberOutcomeSchema = z.strictObject({
  managedRunId: ManagedRunIdSchema,
  outcome: CapabilityGroupMemberOutcomeSchema,
});

const groupMemberActivationShape = {
  managedRunId: ManagedRunIdSchema,
  externalRunRef: ExternalRunRefSchema,
  registrationNonce: RegistrationNonceSchema,
  workspaceLeaseId: WorkspaceLeaseIdSchema.optional(),
};

const GroupMemberActivationSchema = z.union([
  z.strictObject({
    ...groupMemberActivationShape,
    executionAttachmentId: ExecutionAttachmentIdSchema,
    attachmentTargetName: AttachmentTargetNameSchema,
  }),
  z.strictObject(groupMemberActivationShape),
]);

export const CapabilityGroupActivateRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRunGroups.activate"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunGroupId: ManagedRunGroupIdSchema,
    members: z.array(GroupMemberActivationSchema).min(1).max(CAPABILITY_SERVICE_LIMITS.maxGroupMembers),
  }),
});

export const CapabilityGroupActivateResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunGroupId: ManagedRunGroupIdSchema,
    members: z.array(GroupMemberOutcomeSchema).min(1).max(CAPABILITY_SERVICE_LIMITS.maxGroupMembers),
    activatedAtMs: TimestampMsSchema,
  }),
});

export const CapabilityGroupAbandonRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRunGroups.abandon"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunGroupId: ManagedRunGroupIdSchema,
    reason: z.enum([
      "activation_rejected",
      "owner_cancelled",
      "registration_expired",
      "service_unavailable",
    ]),
    disposition: z.enum(["reap_safe", "preserve"]),
  }),
});

export const CapabilityGroupAbandonResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunGroupId: ManagedRunGroupIdSchema,
    members: z.array(GroupMemberOutcomeSchema).min(1).max(CAPABILITY_SERVICE_LIMITS.maxGroupMembers),
    state: z.literal("abandoned"),
    disposition: z.enum(["reap_safe", "preserve"]),
  }),
});

/**
 * Member state counts, spelled out field by field rather than as a keyed map.
 * A map keyed by an enum has no honest JSON Schema representation that also
 * pins the key set, and the external contract must not be weaker than the host
 * it describes.
 */
const GroupStateCountsSchema = z.strictObject({
  preparing: z.number().int().nonnegative().optional(),
  active: z.number().int().nonnegative().optional(),
  waiting: z.number().int().nonnegative().optional(),
  paused: z.number().int().nonnegative().optional(),
  candidate_complete: z.number().int().nonnegative().optional(),
  succeeded: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  cancelled: z.number().int().nonnegative().optional(),
  unknown: z.number().int().nonnegative().optional(),
});

export const CapabilityGroupGetHostRollupRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRunGroups.getHostRollup"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunGroupId: ManagedRunGroupIdSchema,
  }),
});

export const CapabilityGroupGetHostRollupResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunGroupId: ManagedRunGroupIdSchema,
    memberManagedRunIds: z.array(ManagedRunIdSchema).min(1).max(CAPABILITY_SERVICE_LIMITS.maxGroupMembers),
    stateCounts: GroupStateCountsSchema,
    attentionCount: z.number().int().nonnegative(),
    activeCustodyCount: z.number().int().nonnegative(),
    updatedAtMs: TimestampMsSchema,
  }),
});

export const CapabilityTerminalTransitionSchema = z.enum([
  "created",
  "running",
  "input_needed",
  "stuck",
  "exited",
  "lost",
  "recovered",
  "released",
]);

export const CapabilityTerminalEventRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRuns.terminalEvent"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunId: ManagedRunIdSchema,
    workspaceLeaseId: WorkspaceLeaseIdSchema,
    terminalSessionId: TerminalSessionIdSchema,
    transition: CapabilityTerminalTransitionSchema,
  }),
});

export const CapabilityTerminalEventResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunId: ManagedRunIdSchema,
    terminalSessionId: TerminalSessionIdSchema,
    transition: CapabilityTerminalTransitionSchema,
  }),
});

/**
 * Liveness proves the service still owns the run between reports. It is
 * deliberately incapable of carrying status, a summary, or a reason: run state
 * has exactly one path in, and that path is sequenced report ingestion.
 */
export const CapabilityHeartbeatRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("managedRuns.heartbeat"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    managedRunId: ManagedRunIdSchema,
    observedAtMs: TimestampMsSchema,
  }),
});

export const CapabilityHeartbeatResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunId: ManagedRunIdSchema,
    acceptedAtMs: TimestampMsSchema,
    lastHeartbeatAtMs: TimestampMsSchema,
  }),
});

export const CapabilityHealthRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("capabilityServices.health"),
  params: z.strictObject({
    protocolId: ProtocolIdSchema,
    bundleDigest: BundleDigestSchema,
    operationId: OperationIdSchema,
    serviceInstanceId: ServiceInstanceIdSchema,
  }),
});

export const CapabilityHealthResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    protocolId: ProtocolIdSchema,
    bundleDigest: BundleDigestSchema,
    serviceInstanceId: ServiceInstanceIdSchema,
    status: z.enum(["degraded", "healthy"]),
    observedAtMs: TimestampMsSchema,
    reasonCodes: z.array(z.string().min(1).max(128)).max(16),
  }),
});

export const CapabilityServiceRequestSchema = z.discriminatedUnion("method", [
  CapabilityAbandonRequestSchema,
  CapabilityActivateRequestSchema,
  CapabilityCancelRequestSchema,
  CapabilityHandshakeRequestSchema,
  CapabilityHeartbeatRequestSchema,
  CapabilityHealthRequestSchema,
  CapabilityPutEvidenceRequestSchema,
  CapabilityGroupGetHostRollupRequestSchema,
  CapabilityReceiveAttentionResponseRequestSchema,
  CapabilityReleaseRequestSchema,
  CapabilityReportRequestSchema,
  CapabilityTerminalEventRequestSchema,
]);

export type CapabilityServiceRequest = z.infer<typeof CapabilityServiceRequestSchema>;
export type CapabilityHandshakeRequest = z.infer<typeof CapabilityHandshakeRequestSchema>;
export type CapabilityActivateRequest = z.infer<typeof CapabilityActivateRequestSchema>;
export type CapabilityAbandonRequest = z.infer<typeof CapabilityAbandonRequestSchema>;
export type CapabilityCancelRequest = z.infer<typeof CapabilityCancelRequestSchema>;
export type CapabilityReportRequest = z.infer<typeof CapabilityReportRequestSchema>;
export type CapabilityTerminalEventRequest = z.infer<typeof CapabilityTerminalEventRequestSchema>;
export type CapabilityHealthRequest = z.infer<typeof CapabilityHealthRequestSchema>;
export type CapabilityHeartbeatRequest = z.infer<typeof CapabilityHeartbeatRequestSchema>;
export type CapabilityPutEvidenceRequest = z.infer<typeof CapabilityPutEvidenceRequestSchema>;
export type CapabilityReceiveAttentionResponseRequest = z.infer<typeof CapabilityReceiveAttentionResponseRequestSchema>;
export type CapabilityReleaseRequest = z.infer<typeof CapabilityReleaseRequestSchema>;
export type CapabilityGroupActivateRequest = z.infer<typeof CapabilityGroupActivateRequestSchema>;
export type CapabilityGroupAbandonRequest = z.infer<typeof CapabilityGroupAbandonRequestSchema>;
export type CapabilityGroupGetHostRollupRequest = z.infer<typeof CapabilityGroupGetHostRollupRequestSchema>;
export type CapabilityGroupMemberOutcome = z.infer<typeof CapabilityGroupMemberOutcomeSchema>;
