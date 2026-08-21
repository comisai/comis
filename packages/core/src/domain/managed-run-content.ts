// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { MANAGED_RUN_GROUP_MAX_MEMBERS } from "./managed-run-group.js";

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const OpaqueRefSchema = z.string().min(1).max(256).regex(OPAQUE_REF_PATTERN);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampMsSchema = z.number().int().nonnegative();
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
    relayIdentity: z.string().length(64).regex(/^[a-f0-9]*[a-f1-9][a-f0-9]*$/u),
  }).optional(),
  managedRunGroup: z.strictObject({
    managedRunGroupId: OpaqueRefSchema,
    registrationNonce: z.string().min(16).max(256).regex(OPAQUE_REF_PATTERN),
  }).optional(),
});

/** Strict private MCP result extension supplied by a prepared service command. */
export const ManagedRunPreparedStartSchema = ManagedRunActivationDescriptorSchema.extend({
  state: z.literal("prepared"),
  displayLabel: z.string().trim().min(1).max(256).optional(),
}).omit({ schemaVersion: true, managedRunGroup: true });

/** Strict private host input for one same-scope prepared run group. */
export const ManagedRunPreparedGroupStartSchema = z.strictObject({
  state: z.literal("prepared"),
  registrationNonce: z.string().min(16).max(256).regex(OPAQUE_REF_PATTERN),
  expiresAtMs: TimestampMsSchema,
  displayLabel: z.string().trim().min(1).max(256).optional(),
  members: z.array(ManagedRunPreparedStartSchema).min(1).max(MANAGED_RUN_GROUP_MAX_MEMBERS),
}).superRefine((group, context) => {
  const externalRunRefs = new Set<string>();
  const registrationNonces = new Set<string>([group.registrationNonce]);
  for (let index = 0; index < group.members.length; index += 1) {
    const member = group.members[index];
    if (member === undefined) continue;
    if (member.expiresAtMs !== group.expiresAtMs) {
      context.addIssue({
        code: "custom",
        path: ["members", index, "expiresAtMs"],
        message: "group members must share the group expiry",
      });
    }
    if (externalRunRefs.has(member.externalRunRef)) {
      context.addIssue({
        code: "custom",
        path: ["members", index, "externalRunRef"],
        message: "group member external references must be unique",
      });
    }
    externalRunRefs.add(member.externalRunRef);
    if (registrationNonces.has(member.registrationNonce)) {
      context.addIssue({
        code: "custom",
        path: ["members", index, "registrationNonce"],
        message: "group and member registration nonces must be unique",
      });
    }
    registrationNonces.add(member.registrationNonce);
  }
});

/** Versioned private replay join for one prepared group. */
export const ManagedRunGroupActivationDescriptorSchema = ManagedRunPreparedGroupStartSchema.extend({
  schemaVersion: z.literal(1),
});

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
    .refine(hasValidBase64Shape, "must use valid base64 syntax")
    .meta({ pattern: BASE64_JSON_SCHEMA_PATTERN }),
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
export type ManagedRunPreparedGroupStart = z.infer<typeof ManagedRunPreparedGroupStartSchema>;
export type ManagedRunGroupActivationDescriptor = z.infer<typeof ManagedRunGroupActivationDescriptorSchema>;
export type ManagedRunReportInput = z.infer<typeof ManagedRunReportInputSchema>;
export type ManagedRunReportBody = z.infer<typeof ManagedRunReportBodySchema>;
export type ManagedRunReportIndex = z.infer<typeof ManagedRunReportIndexSchema>;
export type ManagedEvidenceVerificationLevel = z.infer<
  typeof ManagedEvidenceVerificationLevelSchema
>;
export type ManagedEvidenceDelivery = z.infer<typeof ManagedEvidenceDeliverySchema>;
export type ManagedEvidencePrivateBody = z.infer<typeof ManagedEvidencePrivateBodySchema>;
export type ManagedEvidenceIndex = z.infer<typeof ManagedEvidenceIndexSchema>;
