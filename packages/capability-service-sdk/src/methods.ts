// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { CAPABILITY_SERVICE_LIMITS, CAPABILITY_SERVICE_PROTOCOL_ID } from "./constants.js";
import {
  AttachmentTargetNameSchema,
  BundleDigestSchema,
  CapabilityServiceLimitsSchema,
  CapabilityServiceScopeSchema,
  EvidenceRefSchema,
  ExecutionAttachmentIdSchema,
  ExternalRunRefSchema,
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

const HandshakeParamsSchema = z.strictObject({
  protocolId: ProtocolIdSchema,
  bundleDigest: BundleDigestSchema,
  operationId: OperationIdSchema,
  serviceInstanceId: ServiceInstanceIdSchema,
  requestedScopes: z.array(CapabilityServiceScopeSchema).min(1).max(5),
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
    activeScopes: z.array(CapabilityServiceScopeSchema).min(1).max(5),
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
  CapabilityHandshakeRequestSchema,
  CapabilityHealthRequestSchema,
  CapabilityReportRequestSchema,
  CapabilityTerminalEventRequestSchema,
]);

export type CapabilityServiceRequest = z.infer<typeof CapabilityServiceRequestSchema>;
export type CapabilityHandshakeRequest = z.infer<typeof CapabilityHandshakeRequestSchema>;
export type CapabilityActivateRequest = z.infer<typeof CapabilityActivateRequestSchema>;
export type CapabilityAbandonRequest = z.infer<typeof CapabilityAbandonRequestSchema>;
export type CapabilityReportRequest = z.infer<typeof CapabilityReportRequestSchema>;
export type CapabilityTerminalEventRequest = z.infer<typeof CapabilityTerminalEventRequestSchema>;
export type CapabilityHealthRequest = z.infer<typeof CapabilityHealthRequestSchema>;
