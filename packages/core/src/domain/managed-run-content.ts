// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const OpaqueRefSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampMsSchema = z.number().int().nonnegative();

export const MAX_MANAGED_RUN_REPORT_BYTES = 16_384;
export const MAX_MANAGED_EVIDENCE_BYTES = 1_048_576;
export const MAX_MANAGED_EVIDENCE_PRIVATE_BYTES = Math.ceil(MAX_MANAGED_EVIDENCE_BYTES / 3) * 4 + 512;

export const ManagedRunReportKindSchema = z.enum([
  "attention",
  "blocked",
  "candidate_complete",
  "failed",
  "paused",
  "progress",
  "resolution",
]);

const managedRunReportInputShape = {
  serviceReportId: OpaqueRefSchema,
  kind: ManagedRunReportKindSchema,
  externalKey: z.string().min(1).max(256).optional(),
  summary: z.string().max(MAX_MANAGED_RUN_REPORT_BYTES),
  details: z.string().max(MAX_MANAGED_RUN_REPORT_BYTES).optional(),
  artifactRefs: z.array(OpaqueRefSchema).max(32).optional(),
  observedAtMs: TimestampMsSchema.optional(),
};

function validateReportBytes(
  body: { readonly summary: string; readonly details?: string },
  context: z.RefinementCtx,
): void {
  const bytes = Buffer.byteLength(body.summary, "utf8")
    + (body.details === undefined ? 0 : Buffer.byteLength(body.details, "utf8"));
  if (bytes > MAX_MANAGED_RUN_REPORT_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["summary"],
      message: "combined report content exceeds the UTF-8 byte limit",
    });
  }
}

/** Private service preparation data. It carries no host authority fields. */
export const ManagedRunActivationDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  externalRunRef: OpaqueRefSchema,
  registrationNonce: z.string().min(16).max(256).regex(OPAQUE_REF_PATTERN),
  expiresAtMs: TimestampMsSchema,
  requestedWorkspace: z.strictObject({
    rootHint: z.string().min(1).max(512),
  }).optional(),
  requestedAttachment: z.strictObject({
    kind: z.enum(["unix_socket", "inherited_descriptor"]),
    sourcePath: z.string().min(1).max(4_096),
  }).optional(),
});

/** Strict private MCP result extension supplied by a prepared service command. */
export const ManagedRunPreparedStartSchema = ManagedRunActivationDescriptorSchema.extend({
  state: z.literal("prepared"),
  displayLabel: z.string().trim().min(1).max(256).optional(),
}).omit({ schemaVersion: true });

/** Strict unversioned payload accepted from an authenticated service. */
export const ManagedRunReportInputSchema = z.strictObject({
  ...managedRunReportInputShape,
}).superRefine(validateReportBytes);

/** Versioned private report body stored outside the content-free index. */
export const ManagedRunReportBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...managedRunReportInputShape,
}).superRefine(validateReportBytes);

/** Content-free report metadata used for replay, reduction, and recovery scans. */
export const ManagedRunReportIndexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  serviceInstanceId: OpaqueRefSchema,
  managedRunId: OpaqueRefSchema,
  serviceReportId: OpaqueRefSchema,
  sequence: z.number().int().positive(),
  kind: ManagedRunReportKindSchema,
  contentRef: OpaqueRefSchema,
  contentHash: DigestSchema,
  receivedAtMs: TimestampMsSchema,
  retainedUntilMs: TimestampMsSchema,
  observedAtMs: TimestampMsSchema.optional(),
}).superRefine((index, context) => {
  if (index.retainedUntilMs < index.receivedAtMs) {
    context.addIssue({
      code: "custom",
      path: ["retainedUntilMs"],
      message: "report retention cannot end before receipt",
    });
  }
});

export const ManagedEvidenceVerificationLevelSchema = z.enum([
  "reported",
  "adapter_verified",
  "host_verified",
]);

export const ManagedEvidenceDeliverySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reference") }),
  z.strictObject({
    kind: z.literal("attachment"),
    // eslint-disable-next-line no-control-regex -- attachment filenames must reject NUL at the private-content boundary
    fileName: z.string().min(1).max(256).regex(/^[^/\\\u0000\r\n]+$/u),
    mediaType: z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/u),
  }),
]);

/** Contentful evidence body and optional presentation stored only in the private content store. */
export const ManagedEvidencePrivateBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  bodyBase64: z.string()
    .max(Math.ceil(MAX_MANAGED_EVIDENCE_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  delivery: ManagedEvidenceDeliverySchema.optional(),
});

/** Content-free immutable evidence descriptor used for reduction and replay. */
export const ManagedEvidenceIndexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  serviceInstanceId: OpaqueRefSchema,
  managedRunId: OpaqueRefSchema,
  evidenceRef: OpaqueRefSchema,
  kind: OpaqueRefSchema,
  subjectDigest: DigestSchema,
  observedAtMs: TimestampMsSchema,
  expiresAtMs: TimestampMsSchema.optional(),
  contentRef: OpaqueRefSchema,
  contentHash: DigestSchema,
  privateContentHash: DigestSchema,
  verificationLevel: ManagedEvidenceVerificationLevelSchema,
  deliveryKind: z.enum(["none", "reference", "attachment"]),
  receivedAtMs: TimestampMsSchema,
}).superRefine((evidence, context) => {
  if (evidence.expiresAtMs !== undefined && evidence.expiresAtMs <= evidence.observedAtMs) {
    context.addIssue({
      code: "custom",
      path: ["expiresAtMs"],
      message: "evidence expiry must be later than its observation",
    });
  }
});

export type ManagedRunReportKind = z.infer<typeof ManagedRunReportKindSchema>;
export type ManagedRunActivationDescriptor = z.infer<typeof ManagedRunActivationDescriptorSchema>;
export type ManagedRunPreparedStart = z.infer<typeof ManagedRunPreparedStartSchema>;
export type ManagedRunReportInput = z.infer<typeof ManagedRunReportInputSchema>;
export type ManagedRunReportBody = z.infer<typeof ManagedRunReportBodySchema>;
export type ManagedRunReportIndex = z.infer<typeof ManagedRunReportIndexSchema>;
export type ManagedEvidenceVerificationLevel = z.infer<
  typeof ManagedEvidenceVerificationLevelSchema
>;
export type ManagedEvidenceDelivery = z.infer<typeof ManagedEvidenceDeliverySchema>;
export type ManagedEvidencePrivateBody = z.infer<typeof ManagedEvidencePrivateBodySchema>;
export type ManagedEvidenceIndex = z.infer<typeof ManagedEvidenceIndexSchema>;
