// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const ManagedRunDbRowSchema = z.strictObject({
  schema_version: z.literal(1),
  managed_run_id: z.string(),
  service_instance_id: z.string(),
  external_run_ref_digest: z.string(),
  activation_descriptor_digest: z.string(),
  activation_descriptor_ref: z.string().nullable(),
  display_label: z.string().nullable(),
  tenant_id: z.string(),
  agent_id: z.string(),
  principal_id: z.string(),
  conversation_ref: z.string(),
  turn_scope: z.string(),
  delivery_origin: z.string(),
  trace_id: z.string(),
  trust_level: z.string(),
  response_locale_policy: z.string(),
  workspace_policy_hash: z.string(),
  root_run_id: z.string(),
  initiation_source: z.string(),
  ingress_profile_id: z.string().nullable(),
  ingress_event_digest: z.string().nullable(),
  managed_run_group_id: z.string().nullable(),
  parent_managed_run_id: z.string().nullable(),
  captured_agent_capabilities: z.string(),
  captured_tool_ids: z.string(),
  captured_capability_view_hash: z.string(),
  workspace_lease_id: z.string().nullable(),
  execution_attachment_ids: z.string(),
  terminal_session_ids: z.string(),
  status: z.string(),
  status_reason: z.string(),
  last_accepted_report_sequence: z.number().int(),
  last_reduced_report_sequence: z.number().int(),
  pending_continuation: z.union([z.literal(0), z.literal(1)]),
  open_attention_count: z.number().int(),
  created_at_ms: z.number().int(),
  updated_at_ms: z.number().int(),
  last_heartbeat_at_ms: z.number().int().nullable(),
  terminal_outcome: z.string().nullable(),
});

export const ManagedRunReportDbRowSchema = z.strictObject({
  schema_version: z.literal(1),
  service_instance_id: z.string(),
  managed_run_id: z.string(),
  service_report_id: z.string(),
  sequence: z.number().int(),
  kind: z.string(),
  content_ref: z.string(),
  content_hash: z.string(),
  received_at_ms: z.number().int(),
  retained_until_ms: z.number().int(),
  observed_at_ms: z.number().int().nullable(),
});

export const ManagedEvidenceDbRowSchema = z.strictObject({
  schema_version: z.literal(1),
  service_instance_id: z.string(),
  managed_run_id: z.string(),
  evidence_ref: z.string(),
  kind: z.string(),
  subject_digest: z.string(),
  observed_at_ms: z.number().int(),
  expires_at_ms: z.number().int().nullable(),
  content_ref: z.string(),
  content_hash: z.string(),
  private_content_hash: z.string(),
  verification_level: z.string(),
  delivery_kind: z.string(),
  received_at_ms: z.number().int(),
});

export const ManagedRunOperationDbRowSchema = z.strictObject({
  input_hash: z.string(),
  result_record: z.string(),
});

export const ManagedRunReleaseReservationDbRowSchema = z.strictObject({
  operation_id: z.string(),
  input_hash: z.string(),
  result_record: z.string(),
  reserved_at_ms: z.number().int(),
});

export const ManagedRunContinuationClaimDbRowSchema = z.strictObject({
  claim_id: z.string(),
  managed_run_id: z.string(),
  claim_hash: z.string(),
  through_report_sequence: z.number().int(),
  state: z.string(),
  claimed_at_ms: z.number().int(),
  expires_at_ms: z.number().int(),
  claim_result_record: z.string(),
  reduction_hash: z.string().nullable(),
  reduction_result_record: z.string().nullable(),
  outcome_hash: z.string().nullable(),
  outcome_result_record: z.string().nullable(),
  outcome_recorded_at_ms: z.number().int().nullable(),
});

export const ManagedRunAttentionDbRowSchema = z.strictObject({
  schema_version: z.literal(1),
  attention_id: z.string(),
  managed_run_id: z.string(),
  service_instance_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  principal_id: z.string(),
  conversation_ref: z.string(),
  external_key: z.string().nullable(),
  report_sequence: z.number().int(),
  attention_ref: z.string(),
  status: z.string(),
  response_ref: z.string().nullable(),
  created_at_ms: z.number().int(),
  updated_at_ms: z.number().int(),
  expires_at_ms: z.number().int().nullable(),
});

export const ManagedRunAttentionOperationDbRowSchema = z.strictObject({
  input_hash: z.string(),
  result_record: z.string(),
});

export const ManagedRunAttentionCountDbRowSchema = z.strictObject({
  count: z.number().int().nonnegative(),
});

export type ManagedRunDbRow = z.infer<typeof ManagedRunDbRowSchema>;
export type ManagedRunReportDbRow = z.infer<typeof ManagedRunReportDbRowSchema>;
export type ManagedEvidenceDbRow = z.infer<typeof ManagedEvidenceDbRowSchema>;
export type ManagedRunOperationDbRow = z.infer<typeof ManagedRunOperationDbRowSchema>;
export type ManagedRunReleaseReservationDbRow = z.infer<typeof ManagedRunReleaseReservationDbRowSchema>;
export type ManagedRunContinuationClaimDbRow = z.infer<typeof ManagedRunContinuationClaimDbRowSchema>;
export type ManagedRunAttentionDbRow = z.infer<typeof ManagedRunAttentionDbRowSchema>;
