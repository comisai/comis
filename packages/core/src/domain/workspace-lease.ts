// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
const OpaqueIdSchema = z.string().min(1).max(256).regex(OPAQUE_ID_PATTERN);
const TimestampMsSchema = z.number().int().nonnegative();

export const WorkspaceLeaseFilesystemIdentitySchema = z.strictObject({
  device: z.number().int().nonnegative().safe(),
  inode: z.number().int().nonnegative().safe(),
  birthtimeNs: z.string().max(20).regex(/^[1-9][0-9]*$/u),
});

export const WorkspaceLeaseDispositionSchema = z.enum(["reap_safe", "preserve"]);
export const WorkspaceLeaseStateSchema = z.enum(["active", "released"]);

export const WorkspaceLeaseRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceLeaseId: OpaqueIdSchema,
  managedRunId: OpaqueIdSchema,
  serviceInstanceId: OpaqueIdSchema,
  tenantId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  canonicalPath: z.string().min(1).max(4_096),
  filesystemIdentity: WorkspaceLeaseFilesystemIdentitySchema,
  state: WorkspaceLeaseStateSchema,
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  lastRecoveredAtMs: TimestampMsSchema.optional(),
  releasedAtMs: TimestampMsSchema.optional(),
  releaseDisposition: WorkspaceLeaseDispositionSchema.optional(),
}).superRefine((record, context) => {
  if (record.updatedAtMs < record.createdAtMs) {
    context.addIssue({
      code: "custom",
      path: ["updatedAtMs"],
      message: "workspace lease update cannot precede creation",
    });
  }
  if (
    record.lastRecoveredAtMs !== undefined
    && (record.lastRecoveredAtMs < record.createdAtMs
      || record.lastRecoveredAtMs > record.updatedAtMs)
  ) {
    context.addIssue({
      code: "custom",
      path: ["lastRecoveredAtMs"],
      message: "workspace lease recovery time must fall within the record lifetime",
    });
  }
  const hasRelease = record.releasedAtMs !== undefined
    && record.releaseDisposition !== undefined;
  if (record.state === "released" && !hasRelease) {
    context.addIssue({
      code: "custom",
      path: ["releasedAtMs"],
      message: "released workspace leases require time and disposition",
    });
  }
  if (
    record.state === "active"
    && (record.releasedAtMs !== undefined || record.releaseDisposition !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "active workspace leases cannot carry release state",
    });
  }
  if (
    record.releasedAtMs !== undefined
    && (record.releasedAtMs < record.createdAtMs || record.releasedAtMs > record.updatedAtMs)
  ) {
    context.addIssue({
      code: "custom",
      path: ["releasedAtMs"],
      message: "workspace lease release time must fall within the record lifetime",
    });
  }
});

export type WorkspaceLeaseFilesystemIdentity = z.infer<
  typeof WorkspaceLeaseFilesystemIdentitySchema
>;
export type WorkspaceLeaseDisposition = z.infer<typeof WorkspaceLeaseDispositionSchema>;
export type WorkspaceLeaseState = z.infer<typeof WorkspaceLeaseStateSchema>;
export type WorkspaceLeaseRecord = z.infer<typeof WorkspaceLeaseRecordSchema>;

export function parseWorkspaceLeaseRecord(
  raw: unknown,
): Result<WorkspaceLeaseRecord, z.ZodError> {
  const parsed = WorkspaceLeaseRecordSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
