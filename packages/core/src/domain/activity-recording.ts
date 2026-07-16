// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";

/** Families not yet captured by the prospective activity recorder. */
export const ActivityRecordingExactnessBlockerSchema = z.enum([
  "trusted_external_head_anchor_missing",
  "raw_channel_ingress_before_normalization",
  "gateway_http_ingress",
  "gateway_json_rpc_ingress",
  "gateway_websocket_ingress",
  "webhook_ingress",
  "openai_compatible_api_ingress",
  "cli_local_device_and_internal_api_ingress",
  "synthetic_system_and_injected_turns",
  "channel_reactions_and_message_mutations",
  "interactive_callbacks_approvals_and_poll_events",
  "delivery_queue_drain_and_direct_adapter_sends",
  "attachment_media_and_rich_delivery",
  "scheduler_and_proactive_activity",
  "heartbeat_and_daemon_lifecycle_activity",
  "model_tool_mcp_and_external_io",
  "provider_streams_retries_and_responses",
  "subagent_graph_and_background_activity",
  "cross_session_and_orchestrator_queue_activity",
  "memory_session_config_and_runtime_state",
  "secret_oauth_and_identity_state",
  "dependency_response_cassettes",
  "speech_vision_image_and_file_pipeline_bytes",
]);

export type ActivityRecordingExactnessBlocker = z.infer<
  typeof ActivityRecordingExactnessBlockerSchema
>;

/** The complete blocker set for the currently covered vertical slice. */
export const ACTIVITY_RECORDING_EXACTNESS_BLOCKERS = Object.freeze(
  ActivityRecordingExactnessBlockerSchema.options,
);

/** Closed, content-free reason recorded when prospective evidence is lost. */
export const ActivityRecordingGapReasonSchema = z.enum([
  "payload_invalid",
  "payload_too_large",
  "record_limit_exceeded",
  "storage_limit_exceeded",
  "crypto_failed",
  "storage_failed",
  "integrity_check_failed",
  "unknown_after_restart",
  "unknown_at_shutdown",
  "causal_parent_invalid",
  "attempt_already_settled",
  "settlement_capability_invalid",
  "trace_mismatch",
  "timestamp_order_invalid",
  "outcome_shape_invalid",
  "handoff_capacity_exceeded",
  "handoff_timeout",
  "recorder_closed",
  "database_busy",
  "head_anchor_unavailable",
  "head_anchor_conflict",
  "writer_lease_expired",
  "clock_unavailable",
]);

export type ActivityRecordingGapReason = z.infer<
  typeof ActivityRecordingGapReasonSchema
>;

/** Coarse outcome class; SDK error text remains inside the encrypted payload. */
export const ActivityRecordingOutcomeClassSchema = z.enum([
  "success",
  "platform_error",
  "adapter_throw",
]);

export type ActivityRecordingOutcomeClass = z.infer<
  typeof ActivityRecordingOutcomeClassSchema
>;

/** Closed source family names used by index rows and health events. */
export const ActivityRecordingSourceKindSchema = z.enum([
  "channel_inbound_normalized",
  "delivery_platform_attempt",
  "delivery_platform_outcome",
]);

export type ActivityRecordingSourceKind = z.infer<
  typeof ActivityRecordingSourceKindSchema
>;

/** Closed kinds carried by authenticated evidence-index rows. */
export const ActivityRecordingRecordKindSchema = z.enum([
  ...ActivityRecordingSourceKindSchema.options,
  "gap",
]);

export type ActivityRecordingRecordKind = z.infer<
  typeof ActivityRecordingRecordKindSchema
>;

/** Parse a blocker without a throwing Zod boundary. */
export function parseActivityRecordingExactnessBlocker(
  raw: unknown,
): Result<ActivityRecordingExactnessBlocker, z.ZodError> {
  const parsed = ActivityRecordingExactnessBlockerSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
