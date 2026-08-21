// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const ExecutionAttachmentDbRowSchema = z.strictObject({
  schema_version: z.literal(1),
  execution_attachment_id: z.string(),
  managed_run_id: z.string(),
  workspace_lease_id: z.string(),
  service_instance_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  kind: z.string(),
  source_path: z.string(),
  relay_identity: z.string().length(64).regex(/^[a-f0-9]*[a-f1-9][a-f0-9]*$/u),
  source_filesystem_type: z.string(),
  source_filesystem_device: z.number().int(),
  source_filesystem_inode: z.number().int(),
  source_filesystem_birthtime_ns: z.string().max(20).regex(/^[1-9][0-9]*$/u),
  target_name: z.string(),
  access: z.string(),
  state: z.string(),
  created_at_ms: z.number().int(),
  updated_at_ms: z.number().int(),
  last_recovered_at_ms: z.number().int().nullable(),
  revoked_at_ms: z.number().int().nullable(),
  revocation_reason: z.string().nullable(),
});

export const ExecutionAttachmentOperationDbRowSchema = z.strictObject({
  input_hash: z.string(),
  result_record: z.string(),
});

export const ExecutionAttachmentAuthorityDbRowSchema = z.strictObject({
  managed_run_id: z.string(),
  service_instance_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  workspace_lease_id: z.string().nullable(),
  lease_managed_run_id: z.string(),
  lease_service_instance_id: z.string(),
  lease_tenant_id: z.string(),
  lease_agent_id: z.string(),
  lease_state: z.string(),
  release_operation_id: z.string().nullable(),
});

export type ExecutionAttachmentDbRow = z.infer<typeof ExecutionAttachmentDbRowSchema>;
