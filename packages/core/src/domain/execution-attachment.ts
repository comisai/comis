// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, normalize } from "node:path";
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
const TARGET_NAME_PATTERN = /^attachment-[a-f0-9]{32}\.sock$/u;
const OpaqueIdSchema = z.string().min(1).max(256).regex(OPAQUE_ID_PATTERN);
const TimestampMsSchema = z.number().int().nonnegative();

export const ExecutionAttachmentFilesystemIdentitySchema = z.strictObject({
  device: z.number().int().nonnegative().safe(),
  inode: z.number().int().nonnegative().safe(),
});

export const ExecutionAttachmentKindSchema = z.enum(["unix_socket"]);
export const ExecutionAttachmentStateSchema = z.enum(["active", "revoked"]);
export const ExecutionAttachmentRevocationReasonSchema = z.enum([
  "lease_release",
  "authority_revoked",
  "recovery_mismatch",
]);

export const ExecutionAttachmentRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executionAttachmentId: OpaqueIdSchema,
  managedRunId: OpaqueIdSchema,
  workspaceLeaseId: OpaqueIdSchema,
  serviceInstanceId: OpaqueIdSchema,
  tenantId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  kind: ExecutionAttachmentKindSchema,
  sourcePath: z.string().min(1).max(4_096).refine(
    (path) => isAbsolute(path) && normalize(path) === path,
    "execution attachment source path must be absolute and normalized",
  ),
  sourceFilesystemType: z.literal("socket"),
  sourceFilesystemIdentity: ExecutionAttachmentFilesystemIdentitySchema,
  targetName: z.string().regex(TARGET_NAME_PATTERN),
  access: z.literal("connect_only"),
  state: ExecutionAttachmentStateSchema,
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  lastRecoveredAtMs: TimestampMsSchema.optional(),
  revokedAtMs: TimestampMsSchema.optional(),
  revocationReason: ExecutionAttachmentRevocationReasonSchema.optional(),
}).superRefine((record, context) => {
  if (record.updatedAtMs < record.createdAtMs) {
    context.addIssue({ code: "custom", path: ["updatedAtMs"], message: "execution attachment update cannot precede creation" });
  }
  if (
    record.lastRecoveredAtMs !== undefined
    && (record.lastRecoveredAtMs < record.createdAtMs || record.lastRecoveredAtMs > record.updatedAtMs)
  ) {
    context.addIssue({ code: "custom", path: ["lastRecoveredAtMs"], message: "execution attachment recovery time must fall within the record lifetime" });
  }
  const hasRevocation = record.revokedAtMs !== undefined && record.revocationReason !== undefined;
  if (record.state === "revoked" && !hasRevocation) {
    context.addIssue({ code: "custom", path: ["revokedAtMs"], message: "revoked execution attachments require time and reason" });
  }
  if (record.state === "active" && (record.revokedAtMs !== undefined || record.revocationReason !== undefined)) {
    context.addIssue({ code: "custom", path: ["state"], message: "active execution attachments cannot carry revocation state" });
  }
  if (
    record.revokedAtMs !== undefined
    && (record.revokedAtMs < record.createdAtMs || record.revokedAtMs > record.updatedAtMs)
  ) {
    context.addIssue({ code: "custom", path: ["revokedAtMs"], message: "execution attachment revocation time must fall within the record lifetime" });
  }
});

export type ExecutionAttachmentFilesystemIdentity = z.infer<typeof ExecutionAttachmentFilesystemIdentitySchema>;
export type ExecutionAttachmentKind = z.infer<typeof ExecutionAttachmentKindSchema>;
export type ExecutionAttachmentState = z.infer<typeof ExecutionAttachmentStateSchema>;
export type ExecutionAttachmentRevocationReason = z.infer<typeof ExecutionAttachmentRevocationReasonSchema>;
export type ExecutionAttachmentRecord = z.infer<typeof ExecutionAttachmentRecordSchema>;

export function parseExecutionAttachmentRecord(raw: unknown): Result<ExecutionAttachmentRecord, z.ZodError> {
  const parsed = ExecutionAttachmentRecordSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
