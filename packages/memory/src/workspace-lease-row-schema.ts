// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const WorkspaceLeaseDbRowSchema = z.strictObject({
  schema_version: z.literal(1),
  workspace_lease_id: z.string(),
  managed_run_id: z.string(),
  service_instance_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  canonical_path: z.string(),
  filesystem_device: z.number().int(),
  filesystem_inode: z.number().int(),
  filesystem_birthtime_ns: z.string().max(20).regex(/^[1-9][0-9]*$/u),
  state: z.string(),
  created_at_ms: z.number().int(),
  updated_at_ms: z.number().int(),
  last_recovered_at_ms: z.number().int().nullable(),
  released_at_ms: z.number().int().nullable(),
  release_disposition: z.string().nullable(),
});

export const WorkspaceLeaseOperationDbRowSchema = z.strictObject({
  input_hash: z.string(),
  result_record: z.string(),
});

export type WorkspaceLeaseDbRow = z.infer<typeof WorkspaceLeaseDbRowSchema>;
