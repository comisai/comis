// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  ManagedRunRecordSchema,
  ManagedRunReportIndexSchema,
  parseManagedRunRecord,
  type ManagedRunLookupScope,
  type ManagedRunRecord,
  type ManagedRunReportIndex,
  type ManagedRunStatus,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import type { ManagedRunDbRow, ManagedRunReportDbRow } from "./managed-run-row-schema.js";

function parseJson(raw: string): Result<unknown, Error> {
  const parsed = tryCatch(() => JSON.parse(raw) as unknown);
  return parsed.ok ? parsed : err(parsed.error);
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function serializeManagedRunRecord(record: ManagedRunRecord): string {
  return JSON.stringify(record);
}

export function parseStoredManagedRunRecord(raw: string): Result<ManagedRunRecord, Error> {
  const decoded = parseJson(raw);
  if (!decoded.ok) return decoded;
  const parsed = parseManagedRunRecord(decoded.value);
  return parsed.ok ? parsed : err(new Error(`managed-run record validation failed: ${parsed.error.message}`));
}

export function rowToManagedRunRecord(row: ManagedRunDbRow): Result<ManagedRunRecord, Error> {
  const turnScope = parseJson(row.turn_scope);
  if (!turnScope.ok) return turnScope;
  const deliveryOrigin = parseJson(row.delivery_origin);
  if (!deliveryOrigin.ok) return deliveryOrigin;
  const responseLocalePolicy = parseJson(row.response_locale_policy);
  if (!responseLocalePolicy.ok) return responseLocalePolicy;
  const capturedAgentCapabilities = parseJson(row.captured_agent_capabilities);
  if (!capturedAgentCapabilities.ok) return capturedAgentCapabilities;
  const capturedToolIds = parseJson(row.captured_tool_ids);
  if (!capturedToolIds.ok) return capturedToolIds;
  const executionAttachmentIds = parseJson(row.execution_attachment_ids);
  if (!executionAttachmentIds.ok) return executionAttachmentIds;
  const terminalSessionIds = parseJson(row.terminal_session_ids);
  if (!terminalSessionIds.ok) return terminalSessionIds;
  const terminalOutcome = row.terminal_outcome === null ? ok(undefined) : parseJson(row.terminal_outcome);
  if (!terminalOutcome.ok) return terminalOutcome;

  const parsed = parseManagedRunRecord({
    schemaVersion: row.schema_version,
    managedRunId: row.managed_run_id,
    serviceInstanceId: row.service_instance_id,
    externalRunRefDigest: row.external_run_ref_digest,
    activationDescriptorDigest: row.activation_descriptor_digest,
    ...(row.activation_descriptor_ref === null ? {} : { activationDescriptorRef: row.activation_descriptor_ref }),
    ...(row.display_label === null ? {} : { displayLabel: row.display_label }),
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    principalId: row.principal_id,
    conversationRef: row.conversation_ref,
    turnScope: turnScope.value,
    deliveryOrigin: deliveryOrigin.value,
    traceId: row.trace_id,
    trustLevel: row.trust_level,
    responseLocalePolicy: responseLocalePolicy.value,
    workspacePolicyHash: row.workspace_policy_hash,
    rootRunId: row.root_run_id,
    initiationSource: row.initiation_source,
    ...(row.ingress_profile_id === null ? {} : { ingressProfileId: row.ingress_profile_id }),
    ...(row.ingress_event_digest === null ? {} : { ingressEventDigest: row.ingress_event_digest }),
    ...(row.managed_run_group_id === null ? {} : { managedRunGroupId: row.managed_run_group_id }),
    ...(row.parent_managed_run_id === null ? {} : { parentManagedRunId: row.parent_managed_run_id }),
    capturedAgentCapabilities: capturedAgentCapabilities.value,
    capturedToolIds: capturedToolIds.value,
    capturedCapabilityViewHash: row.captured_capability_view_hash,
    ...(row.workspace_lease_id === null ? {} : { workspaceLeaseId: row.workspace_lease_id }),
    executionAttachmentIds: executionAttachmentIds.value,
    terminalSessionIds: terminalSessionIds.value,
    status: row.status,
    statusReason: row.status_reason,
    lastAcceptedReportSequence: row.last_accepted_report_sequence,
    lastReducedReportSequence: row.last_reduced_report_sequence,
    pendingContinuation: row.pending_continuation === 1,
    openAttentionCount: row.open_attention_count,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.last_heartbeat_at_ms === null ? {} : { lastHeartbeatAtMs: row.last_heartbeat_at_ms }),
    ...(terminalOutcome.value === undefined ? {} : { terminalOutcome: terminalOutcome.value }),
  });
  return parsed.ok ? parsed : err(new Error(`managed-run row validation failed: ${parsed.error.message}`));
}

export function managedRunInsertValues(record: ManagedRunRecord): unknown[] {
  return [
    record.schemaVersion,
    record.managedRunId,
    record.serviceInstanceId,
    record.externalRunRefDigest,
    record.activationDescriptorDigest,
    record.activationDescriptorRef ?? null,
    record.displayLabel ?? null,
    record.tenantId,
    record.agentId,
    record.principalId,
    record.conversationRef,
    JSON.stringify(record.turnScope),
    JSON.stringify(record.deliveryOrigin),
    record.traceId,
    record.trustLevel,
    JSON.stringify(record.responseLocalePolicy),
    record.workspacePolicyHash,
    record.rootRunId,
    record.initiationSource,
    record.ingressProfileId ?? null,
    record.ingressEventDigest ?? null,
    record.managedRunGroupId ?? null,
    record.parentManagedRunId ?? null,
    JSON.stringify(record.capturedAgentCapabilities),
    JSON.stringify(record.capturedToolIds),
    record.capturedCapabilityViewHash,
    record.workspaceLeaseId ?? null,
    JSON.stringify(record.executionAttachmentIds),
    JSON.stringify(record.terminalSessionIds),
    record.status,
    record.statusReason,
    record.lastAcceptedReportSequence,
    record.lastReducedReportSequence,
    record.pendingContinuation ? 1 : 0,
    record.openAttentionCount,
    record.createdAtMs,
    record.updatedAtMs,
    record.lastHeartbeatAtMs ?? null,
    record.terminalOutcome === undefined ? null : JSON.stringify(record.terminalOutcome),
  ];
}

export function scopeMatches(record: ManagedRunRecord, scope: ManagedRunLookupScope): boolean {
  if (scope.kind === "service") return record.serviceInstanceId === scope.serviceInstanceId;
  return record.tenantId === scope.tenantId
    && record.agentId === scope.agentId
    && record.principalId === scope.principalId
    && record.conversationRef === scope.conversationRef;
}

const ALLOWED_TRANSITIONS: Readonly<Record<ManagedRunStatus, ReadonlySet<ManagedRunStatus>>> = {
  preparing: new Set(["active", "cancelled", "unknown"]),
  active: new Set(["active", "waiting", "paused", "candidate_complete", "succeeded", "failed", "cancelled", "unknown"]),
  waiting: new Set(["active", "waiting", "paused", "candidate_complete", "succeeded", "failed", "cancelled", "unknown"]),
  paused: new Set(["active", "waiting", "paused", "candidate_complete", "failed", "cancelled", "unknown"]),
  candidate_complete: new Set(["active", "waiting", "candidate_complete", "succeeded", "failed", "cancelled", "unknown"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  unknown: new Set(["preparing", "active", "waiting", "paused", "candidate_complete", "succeeded", "failed", "cancelled", "unknown"]),
};

export function transitionAllowed(current: ManagedRunStatus, next: ManagedRunStatus): boolean {
  // eslint-disable-next-line security/detect-object-injection -- current is the closed ManagedRunStatus union parsed from the strict domain schema
  return ALLOWED_TRANSITIONS[current].has(next);
}

export function rowToManagedRunReport(row: ManagedRunReportDbRow): Result<ManagedRunReportIndex, Error> {
  const parsed = ManagedRunReportIndexSchema.safeParse({
    schemaVersion: row.schema_version,
    serviceInstanceId: row.service_instance_id,
    managedRunId: row.managed_run_id,
    serviceReportId: row.service_report_id,
    sequence: row.sequence,
    kind: row.kind,
    contentRef: row.content_ref,
    contentHash: row.content_hash,
    receivedAtMs: row.received_at_ms,
    retainedUntilMs: row.retained_until_ms,
    ...(row.observed_at_ms === null ? {} : { observedAtMs: row.observed_at_ms }),
  });
  return parsed.success ? ok(parsed.data) : err(new Error(`managed-run report row validation failed: ${parsed.error.message}`));
}

export function validateManagedRunRecord(record: ManagedRunRecord): Result<ManagedRunRecord, Error> {
  const parsed = ManagedRunRecordSchema.safeParse(record);
  return parsed.success ? ok(parsed.data) : err(new Error(`managed-run validation failed: ${parsed.error.message}`));
}
