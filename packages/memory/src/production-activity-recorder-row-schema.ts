// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const RecordKindSchema = z.enum([
  "channel_inbound_normalized",
  "delivery_platform_attempt",
  "delivery_platform_outcome",
  "gap",
]);

export const ActivityRecordingMetaRowSchema = z.strictObject({
  stream_id: z.string().min(1),
  instance_id: z.guid(),
  next_sequence: z.number().int().positive(),
  head_hash: z.string().length(64),
  logical_bytes: z.number().int().nonnegative(),
  record_count: z.number().int().nonnegative(),
  gap_count: z.number().int().nonnegative(),
});
export type ActivityRecordingMetaRow = z.infer<typeof ActivityRecordingMetaRowSchema>;

export const ActivityRecordingRecordRowSchema = z.strictObject({
  sequence: z.number().int().positive(),
  record_id: z.string(),
  kind: RecordKindSchema,
  trace_id: z.string().nullable(),
  parent_record_id: z.string().nullable(),
  attempt_id: z.string().nullable(),
  capability_digest: z.string().nullable(),
  writer_id: z.guid(),
  occurred_at_ms: z.number().int().nonnegative(),
  payload_ciphertext: z.instanceof(Buffer),
  payload_iv: z.instanceof(Buffer),
  payload_auth_tag: z.instanceof(Buffer),
  payload_salt: z.instanceof(Buffer),
  payload_digest: z.string().length(64),
  payload_bytes: z.number().int().nonnegative(),
  previous_hash: z.string().length(64),
  record_hash: z.string().length(64),
  state_logical_bytes: z.number().int().positive(),
  state_record_count: z.number().int().positive(),
  state_gap_count: z.number().int().nonnegative(),
  proof_ciphertext: z.instanceof(Buffer),
  proof_iv: z.instanceof(Buffer),
  proof_auth_tag: z.instanceof(Buffer),
  proof_salt: z.instanceof(Buffer),
  logical_bytes: z.number().int().positive(),
});
export type ActivityRecordingRecordRow = z.infer<typeof ActivityRecordingRecordRowSchema>;

export const ActivityRecordingParentStateRowSchema = z.strictObject({
  sequence: z.number().int().positive(),
  record_id: z.string(),
  record_hash: z.string().length(64),
  kind: RecordKindSchema,
  trace_id: z.string().nullable(),
  occurred_at_ms: z.number().int().nonnegative(),
  attempt_id: z.string().nullable(),
  capability_digest: z.string().nullable(),
  writer_id: z.guid(),
  settlement_count: z.number().int().nonnegative(),
});
export type ActivityRecordingParentStateRow = z.infer<typeof ActivityRecordingParentStateRowSchema>;

export const ActivityRecordingWriterStateRowSchema = z.strictObject({
  writer_id: z.guid(),
  instance_id: z.guid(),
  lease_expires_at_ms: z.number().int().nonnegative(),
  closed_at_ms: z.number().int().nonnegative().nullable(),
});
export type ActivityRecordingWriterStateRow = z.infer<typeof ActivityRecordingWriterStateRowSchema>;
