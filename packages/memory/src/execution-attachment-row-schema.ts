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
  source_filesystem_type: z.string(),
  source_filesystem_device: z.number().int(),
  source_filesystem_inode: z.number().int(),
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
  execution_attachment_ids: z.string(),
  lease_managed_run_id: z.string(),
  lease_service_instance_id: z.string(),
  lease_tenant_id: z.string(),
  lease_agent_id: z.string(),
  lease_state: z.string(),
});

export type ExecutionAttachmentDbRow = z.infer<typeof ExecutionAttachmentDbRowSchema>;
