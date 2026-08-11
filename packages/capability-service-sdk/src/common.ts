// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  CAPABILITY_SERVICE_ERROR_DEFINITIONS,
  CAPABILITY_SERVICE_LIMITS,
  CAPABILITY_SERVICE_METHODS,
} from "./constants.js";

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/** Operator-configured service identity. Consumers compare it but never parse it. */
export const ServiceInstanceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(OPAQUE_REF_PATTERN);

/** External service run identity. Consumers compare it but never parse it. */
export const ExternalRunRefSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);

/** Comis-minted managed-run identity. Consumers compare it but never parse it. */
export const ManagedRunIdSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);

/** Comis-minted exclusive workspace authority. */
export const WorkspaceLeaseIdSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);

/** Comis-minted run-scoped execution attachment authority. */
export const ExecutionAttachmentIdSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);

/** Fixed host-chosen attachment target exposed inside the terminal sandbox. */
export const AttachmentTargetNameSchema = z
  .string()
  .regex(/^attachment-[a-f0-9]{32}\.sock$/);

/** Comis-minted terminal session identity. */
export const TerminalSessionIdSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);

/** Stable idempotency identity for a single protocol operation. */
export const OperationIdSchema = z.string().min(1).max(128).regex(OPAQUE_REF_PATTERN);
export const ServiceReportIdSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);
export const EvidenceRefSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);
export const EvidenceKindSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);

/** One-time proof used to bind a prepared external run. */
export const RegistrationNonceSchema = z.string().min(16).max(256).regex(OPAQUE_REF_PATTERN);

export const BundleDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ContentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampMsSchema = z.number().int().nonnegative();
export const CapabilityServiceMethodSchema = z.enum(CAPABILITY_SERVICE_METHODS);
export const CapabilityServiceScopeSchema = z.enum([
  "health",
  "evidence",
  "report",
  "workspace_lease",
  "terminal_events",
  "execution_attachment",
]);

export const CapabilityServiceLimitsSchema = z.strictObject({
  maxEvidenceBytes: z.literal(CAPABILITY_SERVICE_LIMITS.maxEvidenceBytes),
  maxInFlightRequests: z.literal(CAPABILITY_SERVICE_LIMITS.maxInFlightRequests),
  maxLineBytes: z.literal(CAPABILITY_SERVICE_LIMITS.maxLineBytes),
  maxReportBytes: z.literal(CAPABILITY_SERVICE_LIMITS.maxReportBytes),
  maxRequestBytes: z.literal(CAPABILITY_SERVICE_LIMITS.maxRequestBytes),
  maxResponseBytes: z.literal(CAPABILITY_SERVICE_LIMITS.maxResponseBytes),
  reportRetentionDays: z.literal(CAPABILITY_SERVICE_LIMITS.reportRetentionDays),
});

const errorVariants = CAPABILITY_SERVICE_ERROR_DEFINITIONS.map((definition) =>
  z.strictObject({
    code: z.literal(definition.code),
    kind: z.literal(definition.kind),
    retryable: z.literal(definition.retryable),
    message: z.string().min(1).max(1_024),
    hint: z.string().min(1).max(1_024).optional(),
  }),
);

export const CapabilityServiceErrorSchema = z.discriminatedUnion("kind", [
  errorVariants[0],
  errorVariants[1],
  errorVariants[2],
  errorVariants[3],
  errorVariants[4],
  errorVariants[5],
  errorVariants[6],
  errorVariants[7],
  errorVariants[8],
  errorVariants[9],
  errorVariants[10],
  errorVariants[11],
]);

export const CapabilityServiceErrorResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: OperationIdSchema.nullable(),
  error: CapabilityServiceErrorSchema,
});

export type ServiceInstanceId = z.infer<typeof ServiceInstanceIdSchema>;
export type ExternalRunRef = z.infer<typeof ExternalRunRefSchema>;
export type ManagedRunId = z.infer<typeof ManagedRunIdSchema>;
export type WorkspaceLeaseId = z.infer<typeof WorkspaceLeaseIdSchema>;
export type ExecutionAttachmentId = z.infer<typeof ExecutionAttachmentIdSchema>;
export type AttachmentTargetName = z.infer<typeof AttachmentTargetNameSchema>;
export type TerminalSessionId = z.infer<typeof TerminalSessionIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type ServiceReportId = z.infer<typeof ServiceReportIdSchema>;
export type CapabilityServiceError = z.infer<typeof CapabilityServiceErrorSchema>;
export type CapabilityServiceErrorResponse = z.infer<
  typeof CapabilityServiceErrorResponseSchema
>;
