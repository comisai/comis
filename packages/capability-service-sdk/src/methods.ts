// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { CAPABILITY_SERVICE_LIMITS, CAPABILITY_SERVICE_PROTOCOL_ID } from "./constants.js";
import {
  BundleDigestSchema,
  CapabilityServiceLimitsSchema,
  CapabilityServiceMethodSchema,
  ExternalRunRefSchema,
  ManagedRunRefSchema,
  OperationIdSchema,
  RegistrationNonceSchema,
  ServiceInstanceRefSchema,
  TimestampMsSchema,
} from "./common.js";

const ProtocolIdSchema = z.literal(CAPABILITY_SERVICE_PROTOCOL_ID);

const HandshakeParamsSchema = z.strictObject({
  protocolId: ProtocolIdSchema,
  bundleDigest: BundleDigestSchema,
  operationId: OperationIdSchema,
  serviceInstanceRef: ServiceInstanceRefSchema,
  supportedMethods: z.array(CapabilityServiceMethodSchema).length(5),
});

export const CapabilityHandshakeRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("capability.handshake"),
  params: HandshakeParamsSchema,
});

export const CapabilityHandshakeResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    protocolId: ProtocolIdSchema,
    bundleDigest: BundleDigestSchema,
    serviceInstanceRef: ServiceInstanceRefSchema,
    acceptedMethods: z.array(CapabilityServiceMethodSchema).length(5),
    limits: CapabilityServiceLimitsSchema,
  }),
});

export const CapabilityActivateRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("capability.activate"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    serviceInstanceRef: ServiceInstanceRefSchema,
    managedRunRef: ManagedRunRefSchema,
    externalRunRef: ExternalRunRefSchema,
    registrationNonce: RegistrationNonceSchema,
    registrationExpiresAtMs: TimestampMsSchema,
  }),
});

export const CapabilityActivateResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunRef: ManagedRunRefSchema,
    externalRunRef: ExternalRunRefSchema,
    state: z.literal("active"),
    activatedAtMs: TimestampMsSchema,
  }),
});

export const CapabilityAbandonRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("capability.abandon"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    serviceInstanceRef: ServiceInstanceRefSchema,
    externalRunRef: ExternalRunRefSchema,
    registrationNonce: RegistrationNonceSchema,
    reason: z.enum([
      "activation_rejected",
      "owner_cancelled",
      "registration_expired",
      "service_unavailable",
    ]),
  }),
});

export const CapabilityAbandonResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    externalRunRef: ExternalRunRefSchema,
    state: z.literal("abandoned"),
  }),
});

const EvidenceDescriptorSchema = z.strictObject({
  evidenceRef: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/),
  mediaType: z.string().min(1).max(128),
  sizeBytes: z.number().int().min(0).max(CAPABILITY_SERVICE_LIMITS.maxEvidenceBytes),
  sha256: BundleDigestSchema,
});

export const CapabilityReportRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("capability.report"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    serviceInstanceRef: ServiceInstanceRefSchema,
    managedRunRef: ManagedRunRefSchema,
    reportRef: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/),
    sequence: z.number().int().positive(),
    state: z.enum(["active", "blocked", "completed", "failed"]),
    summary: z.string().max(CAPABILITY_SERVICE_LIMITS.maxReportBytes),
    evidence: z.array(EvidenceDescriptorSchema).max(32),
  }),
});

export const CapabilityReportResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    managedRunRef: ManagedRunRefSchema,
    reportRef: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/),
    acceptedSequence: z.number().int().positive(),
    retainedUntilMs: TimestampMsSchema,
  }),
});

export const CapabilityHealthRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  method: z.literal("capability.health"),
  params: z.strictObject({
    protocolId: ProtocolIdSchema,
    bundleDigest: BundleDigestSchema,
    operationId: OperationIdSchema,
    serviceInstanceRef: ServiceInstanceRefSchema,
  }),
});

export const CapabilityHealthResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema,
  result: z.strictObject({
    protocolId: ProtocolIdSchema,
    bundleDigest: BundleDigestSchema,
    serviceInstanceRef: ServiceInstanceRefSchema,
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
]);

export type CapabilityServiceRequest = z.infer<typeof CapabilityServiceRequestSchema>;
export type CapabilityHandshakeRequest = z.infer<typeof CapabilityHandshakeRequestSchema>;
export type CapabilityActivateRequest = z.infer<typeof CapabilityActivateRequestSchema>;
export type CapabilityAbandonRequest = z.infer<typeof CapabilityAbandonRequestSchema>;
export type CapabilityReportRequest = z.infer<typeof CapabilityReportRequestSchema>;
export type CapabilityHealthRequest = z.infer<typeof CapabilityHealthRequestSchema>;
