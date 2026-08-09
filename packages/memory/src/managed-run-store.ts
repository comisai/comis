// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ManagedRunReportIndexSchema,
  type InvalidManagedRunRecord,
  type ManagedRunBindingOutcome,
  type ManagedRunContinuationClaimInput,
  type ManagedRunContinuationClaimOutcome,
  type ManagedRunContinuationOutcomeInput,
  type ManagedRunCreateOutcome,
  type ManagedRunLookupScope,
  type ManagedRunMutationOutcome,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
  type ManagedRunRecoveryScan,
  type ManagedRunReducedStateInput,
  type ManagedRunReportAppendInput,
  type ManagedRunReportAppendOutcome,
  type ManagedRunReportIndex,
  type ManagedRunReportRangeInput,
  type ManagedRunServiceScope,
  type ManagedRunStorePort,
  type ManagedRunTerminalBindingInput,
  type ManagedRunTransitionClaimInput,
  type ManagedRunTransitionClaimOutcome,
  type ManagedRunWorkspaceBindingInput,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import {
  ManagedRunContinuationClaimDbRowSchema,
  ManagedRunDbRowSchema,
  ManagedRunOperationDbRowSchema,
  ManagedRunReportDbRowSchema,
} from "./managed-run-row-schema.js";
import {
  hashCanonical,
  managedRunInsertValues,
  parseStoredManagedRunRecord,
  rowToManagedRunRecord,
  rowToManagedRunReport,
  scopeMatches,
  serializeManagedRunRecord,
  transitionAllowed,
  validateManagedRunRecord,
} from "./managed-run-store-record.js";
import { createRowMapper } from "./row-mapper.js";

const runMapper = createRowMapper(ManagedRunDbRowSchema);
const reportMapper = createRowMapper(ManagedRunReportDbRowSchema);
const operationMapper = createRowMapper(ManagedRunOperationDbRowSchema);
const claimMapper = createRowMapper(ManagedRunContinuationClaimDbRowSchema);
const recoveryIdentitySchema = z.object({
  managed_run_id: z.string(),
  service_instance_id: z.string(),
});

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function validLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit > 0 && limit <= 10_000;
}

function resultRecord<K extends "bound" | "claimed" | "identical_replay" | "updated">(
  kind: K,
  record: ManagedRunRecord,
): { readonly kind: K; readonly record: ManagedRunRecord } {
  return { kind, record };
}

/** Create the SQLite implementation of the content-free managed-run state port. */
export function createSqliteManagedRunStore(db: Database.Database): ManagedRunStorePort {
  const selectRun = db.prepare("SELECT * FROM managed_runs WHERE managed_run_id = ?");
  const insertRun = db.prepare(`
    INSERT INTO managed_runs (
      schema_version, managed_run_id, service_instance_id, external_run_ref_digest,
      activation_descriptor_digest,
      activation_descriptor_ref, display_label, tenant_id, agent_id, principal_id,
      conversation_ref, turn_scope, delivery_origin, trace_id, trust_level, response_locale_policy,
      workspace_policy_hash, root_run_id, initiation_source, ingress_profile_id,
      ingress_event_digest, managed_run_group_id, parent_managed_run_id,
      captured_agent_capabilities, captured_tool_ids, captured_capability_view_hash,
      workspace_lease_id, execution_attachment_ids, terminal_session_ids, status,
      status_reason, last_accepted_report_sequence, last_reduced_report_sequence,
      pending_continuation, open_attention_count, created_at_ms, updated_at_ms,
      last_heartbeat_at_ms, terminal_outcome
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  const updateMutableRun = db.prepare(`
    UPDATE managed_runs SET
      activation_descriptor_ref = ?, workspace_lease_id = ?,
      execution_attachment_ids = ?, terminal_session_ids = ?, status = ?,
      status_reason = ?, last_accepted_report_sequence = ?,
      last_reduced_report_sequence = ?, pending_continuation = ?,
      open_attention_count = ?, updated_at_ms = ?, last_heartbeat_at_ms = ?,
      terminal_outcome = ?
    WHERE managed_run_id = ?
  `);
  const selectOperation = db.prepare(`
    SELECT input_hash, result_record FROM managed_run_operations
    WHERE managed_run_id = ? AND operation_id = ? AND operation_kind = ?
  `);
  const insertOperation = db.prepare(`
    INSERT INTO managed_run_operations (
      managed_run_id, operation_id, operation_kind, input_hash, result_record, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectReport = db.prepare(`
    SELECT * FROM managed_run_reports
    WHERE service_instance_id = ? AND service_report_id = ?
  `);
  const insertReport = db.prepare(`
    INSERT INTO managed_run_reports (
      schema_version, service_instance_id, managed_run_id, service_report_id,
      sequence, kind, content_ref, content_hash, received_at_ms,
      retained_until_ms, observed_at_ms
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listReportRangeRows = db.prepare(`
    SELECT * FROM managed_run_reports
    WHERE managed_run_id = ? AND sequence > ? AND sequence <= ?
    ORDER BY sequence ASC
  `);
  const selectClaim = db.prepare(`
    SELECT * FROM managed_run_continuation_claims WHERE claim_id = ?
  `);
  const abandonExpiredClaims = db.prepare(`
    UPDATE managed_run_continuation_claims SET state = 'abandoned'
    WHERE managed_run_id = ? AND state = 'active' AND expires_at_ms <= ?
  `);
  const selectActiveClaim = db.prepare(`
    SELECT claim_id FROM managed_run_continuation_claims
    WHERE managed_run_id = ? AND state = 'active' LIMIT 1
  `);
  const insertClaim = db.prepare(`
    INSERT INTO managed_run_continuation_claims (
      claim_id, managed_run_id, claim_hash, through_report_sequence, state,
      claimed_at_ms, expires_at_ms, claim_result_record
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const recordReduction = db.prepare(`
    UPDATE managed_run_continuation_claims
    SET reduction_hash = ?, reduction_result_record = ?
    WHERE claim_id = ? AND state = 'active' AND reduction_hash IS NULL
  `);
  const recordContinuationOutcome = db.prepare(`
    UPDATE managed_run_continuation_claims
    SET state = ?, outcome_hash = ?, outcome_result_record = ?, outcome_recorded_at_ms = ?
    WHERE claim_id = ? AND state = 'active' AND reduction_hash IS NOT NULL AND outcome_hash IS NULL
  `);
  const listScopedRows = db.prepare(`
    SELECT * FROM managed_runs
    WHERE tenant_id = ? AND agent_id = ? AND principal_id = ? AND conversation_ref = ?
      AND (json_array_length(?) = 0 OR status IN (SELECT value FROM json_each(?)))
    ORDER BY created_at_ms ASC, managed_run_id ASC
    LIMIT ?
  `);
  const listRecoverableRows = db.prepare(`
    SELECT * FROM managed_runs
    WHERE status IN (SELECT value FROM json_each(?)) AND updated_at_ms <= ?
    ORDER BY updated_at_ms ASC, managed_run_id ASC
    LIMIT ?
  `);

  function readRecord(managedRunId: string): Result<ManagedRunRecord | undefined, Error> {
    const row = runMapper.parseOptionalRow(selectRun.get(managedRunId));
    if (!row.ok) return err(new Error(row.error.message));
    if (row.value === undefined) return ok(undefined);
    return rowToManagedRunRecord(row.value);
  }

  function persistMutable(record: ManagedRunRecord): Result<void, Error> {
    const parsed = validateManagedRunRecord(record);
    if (!parsed.ok) return parsed;
    const updated = updateMutableRun.run(
      record.activationDescriptorRef ?? null,
      record.workspaceLeaseId ?? null,
      JSON.stringify(record.executionAttachmentIds),
      JSON.stringify(record.terminalSessionIds),
      record.status,
      record.statusReason,
      record.lastAcceptedReportSequence,
      record.lastReducedReportSequence,
      record.pendingContinuation ? 1 : 0,
      record.openAttentionCount,
      record.updatedAtMs,
      record.lastHeartbeatAtMs ?? null,
      record.terminalOutcome === undefined ? null : JSON.stringify(record.terminalOutcome),
      record.managedRunId,
    );
    return updated.changes === 1 ? ok(undefined) : err(new Error("managed-run update lost its row"));
  }

  function readStoredOperation(
    managedRunId: string,
    operationId: string,
    operationKind: "transition" | "revoke",
  ): Result<{ inputHash: string; record: ManagedRunRecord } | undefined, Error> {
    const row = operationMapper.parseOptionalRow(
      selectOperation.get(managedRunId, operationId, operationKind),
    );
    if (!row.ok) return err(new Error(row.error.message));
    if (row.value === undefined) return ok(undefined);
    const record = parseStoredManagedRunRecord(row.value.result_record);
    return record.ok ? ok({ inputHash: row.value.input_hash, record: record.value }) : record;
  }

  function transitionHash(input: ManagedRunTransitionClaimInput): string {
    return hashCanonical({
      managedRunId: input.managedRunId,
      expectedStatuses: input.expectedStatuses,
      nextStatus: input.nextStatus,
      nextStatusReason: input.nextStatusReason,
      terminalOutcome: input.terminalOutcome,
    });
  }

  function applyTransition(
    scope: ManagedRunLookupScope,
    input: ManagedRunTransitionClaimInput,
    operationKind: "transition" | "revoke",
  ): Result<ManagedRunTransitionClaimOutcome, Error> {
    const inputHash = transitionHash(input);
    const current = readRecord(input.managedRunId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    const previous = readStoredOperation(input.managedRunId, input.operationId, operationKind);
    if (!previous.ok) return previous;
    if (previous.value !== undefined) {
      return previous.value.inputHash === inputHash
        ? ok(resultRecord("identical_replay", previous.value.record))
        : ok({ kind: "replay_conflict" });
    }
    if (!input.expectedStatuses.includes(current.value.status)) {
      return ok({ kind: "state_mismatch", status: current.value.status });
    }
    if (!transitionAllowed(current.value.status, input.nextStatus)) {
      return ok({ kind: "invalid_transition" });
    }
    if (input.transitionedAtMs < current.value.updatedAtMs) {
      return err(new Error("managed-run transition time cannot move backward"));
    }
    const terminal = input.nextStatus === "succeeded"
      || input.nextStatus === "failed"
      || input.nextStatus === "cancelled";
    const next: ManagedRunRecord = {
      ...current.value,
      ...(input.nextStatus === "active" || terminal ? { activationDescriptorRef: undefined } : {}),
      status: input.nextStatus,
      statusReason: input.nextStatusReason,
      ...(input.terminalOutcome === undefined ? { terminalOutcome: undefined } : { terminalOutcome: input.terminalOutcome }),
      pendingContinuation: terminal ? false : current.value.pendingContinuation,
      updatedAtMs: input.transitionedAtMs,
    };
    const persisted = persistMutable(next);
    if (!persisted.ok) return persisted;
    insertOperation.run(
      input.managedRunId,
      input.operationId,
      operationKind,
      inputHash,
      serializeManagedRunRecord(next),
      input.transitionedAtMs,
    );
    return ok(resultRecord("claimed", next));
  }

  const createTransaction = db.transaction((record: ManagedRunRecord): Result<ManagedRunCreateOutcome, Error> => {
    const parsed = validateManagedRunRecord(record);
    if (!parsed.ok) return parsed;
    const existing = readRecord(record.managedRunId);
    if (!existing.ok) return existing;
    if (existing.value !== undefined) {
      return serializeManagedRunRecord(existing.value) === serializeManagedRunRecord(parsed.value)
        ? ok({ kind: "identical_replay", record: existing.value })
        : ok({ kind: "replay_conflict" });
    }
    insertRun.run(...managedRunInsertValues(parsed.value));
    return ok({ kind: "created", record: parsed.value });
  });

  const transitionTransaction = db.transaction((
    scope: ManagedRunLookupScope,
    input: ManagedRunTransitionClaimInput,
    operationKind: "transition" | "revoke",
  ) => applyTransition(scope, input, operationKind));

  const reportTransaction = db.transaction((
    scope: ManagedRunServiceScope,
    input: ManagedRunReportAppendInput,
  ): Result<ManagedRunReportAppendOutcome, Error> => {
    const previousRow = reportMapper.parseOptionalRow(selectReport.get(
      scope.serviceInstanceId,
      input.serviceReportId,
    ));
    if (!previousRow.ok) return err(new Error(previousRow.error.message));
    if (previousRow.value !== undefined) {
      const previous = rowToManagedRunReport(previousRow.value);
      if (!previous.ok) return previous;
      return previous.value.managedRunId === input.managedRunId
        && previous.value.contentHash === input.contentHash
        ? ok({ kind: "identical_replay", report: previous.value })
        : ok({ kind: "replay_conflict" });
    }
    const current = readRecord(input.managedRunId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    if (!new Set(["active", "waiting", "paused", "candidate_complete", "unknown"]).has(current.value.status)) {
      return ok({ kind: "state_mismatch", status: current.value.status });
    }
    if (input.receivedAtMs < current.value.updatedAtMs) {
      return err(new Error("managed-run report receipt cannot move time backward"));
    }
    const sequence = current.value.lastAcceptedReportSequence + 1;
    const candidate = ManagedRunReportIndexSchema.safeParse({
      schemaVersion: 1,
      serviceInstanceId: scope.serviceInstanceId,
      managedRunId: input.managedRunId,
      serviceReportId: input.serviceReportId,
      sequence,
      kind: input.kind,
      contentRef: input.contentRef,
      contentHash: input.contentHash,
      receivedAtMs: input.receivedAtMs,
      retainedUntilMs: input.retainedUntilMs,
      ...(input.observedAtMs === undefined ? {} : { observedAtMs: input.observedAtMs }),
    });
    if (!candidate.success) return err(new Error(`managed-run report validation failed: ${candidate.error.message}`));
    insertReport.run(
      scope.serviceInstanceId,
      input.managedRunId,
      input.serviceReportId,
      sequence,
      input.kind,
      input.contentRef,
      input.contentHash,
      input.receivedAtMs,
      input.retainedUntilMs,
      input.observedAtMs ?? null,
    );
    const next: ManagedRunRecord = {
      ...current.value,
      lastAcceptedReportSequence: sequence,
      pendingContinuation: true,
      openAttentionCount: current.value.openAttentionCount
        + (input.kind === "attention" || input.kind === "blocked" ? 1 : 0),
      updatedAtMs: input.receivedAtMs,
    };
    const persisted = persistMutable(next);
    return persisted.ok ? ok({ kind: "accepted", report: candidate.data }) : persisted;
  });

  const bindingTransaction = db.transaction((
    scope: ManagedRunOwnerScope,
    input: ManagedRunTerminalBindingInput | ManagedRunWorkspaceBindingInput,
  ): Result<ManagedRunBindingOutcome, Error> => {
    const current = readRecord(input.managedRunId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    const isTerminal = "terminalSessionId" in input;
    const tenantId = isTerminal ? input.terminalTenantId : input.leaseTenantId;
    const agentId = isTerminal ? input.terminalAgentId : input.leaseAgentId;
    if (tenantId !== current.value.tenantId || agentId !== current.value.agentId) {
      return ok({ kind: "ownership_mismatch" });
    }
    if (isTerminal && current.value.terminalSessionIds.includes(input.terminalSessionId)) {
      return ok(resultRecord("identical_replay", current.value));
    }
    if (!isTerminal && current.value.workspaceLeaseId === input.workspaceLeaseId) {
      return ok(resultRecord("identical_replay", current.value));
    }
    if (!isTerminal && current.value.workspaceLeaseId !== undefined) {
      return ok({ kind: "ownership_mismatch" });
    }
    if (input.boundAtMs < current.value.updatedAtMs) {
      return err(new Error("managed-run binding time cannot move backward"));
    }
    const next: ManagedRunRecord = {
      ...current.value,
      ...(isTerminal
        ? { terminalSessionIds: [...current.value.terminalSessionIds, input.terminalSessionId].sort() }
        : { workspaceLeaseId: input.workspaceLeaseId }),
      updatedAtMs: input.boundAtMs,
    };
    const persisted = persistMutable(next);
    return persisted.ok ? ok(resultRecord("bound", next)) : persisted;
  });

  const claimContinuationTransaction = db.transaction((
    scope: ManagedRunOwnerScope,
    input: ManagedRunContinuationClaimInput,
  ): Result<ManagedRunContinuationClaimOutcome, Error> => {
    const inputHash = hashCanonical({
      managedRunId: input.managedRunId,
      throughReportSequence: input.throughReportSequence,
    });
    const existing = claimMapper.parseOptionalRow(selectClaim.get(input.claimId));
    if (!existing.ok) return err(new Error(existing.error.message));
    if (existing.value !== undefined) {
      const record = parseStoredManagedRunRecord(existing.value.claim_result_record);
      if (!record.ok) return record;
      if (!scopeMatches(record.value, scope)) return ok({ kind: "scope_mismatch" });
      return existing.value.claim_hash === inputHash
        ? ok(resultRecord("identical_replay", record.value))
        : ok({ kind: "replay_conflict" });
    }
    const current = readRecord(input.managedRunId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    if (!current.value.pendingContinuation) return ok({ kind: "not_pending" });
    if (
      input.throughReportSequence !== current.value.lastAcceptedReportSequence
      || input.throughReportSequence <= current.value.lastReducedReportSequence
    ) return ok({ kind: "cursor_mismatch" });
    if (input.expiresAtMs <= input.claimedAtMs) return err(new Error("continuation claim expiry must follow its claim time"));
    abandonExpiredClaims.run(input.managedRunId, input.claimedAtMs);
    if (selectActiveClaim.get(input.managedRunId) !== undefined) return ok({ kind: "not_pending" });
    insertClaim.run(
      input.claimId,
      input.managedRunId,
      inputHash,
      input.throughReportSequence,
      input.claimedAtMs,
      input.expiresAtMs,
      serializeManagedRunRecord(current.value),
    );
    return ok(resultRecord("claimed", current.value));
  });

  const reduceTransaction = db.transaction((
    scope: ManagedRunOwnerScope,
    input: ManagedRunReducedStateInput,
  ): Result<ManagedRunMutationOutcome, Error> => {
    const current = readRecord(input.managedRunId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    const claim = claimMapper.parseOptionalRow(selectClaim.get(input.claimId));
    if (!claim.ok) return err(new Error(claim.error.message));
    if (claim.value === undefined || claim.value.managed_run_id !== input.managedRunId) {
      return ok({ kind: "claim_mismatch" });
    }
    const inputHash = hashCanonical({
      managedRunId: input.managedRunId,
      throughReportSequence: input.throughReportSequence,
      status: input.status,
      statusReason: input.statusReason,
      terminalOutcome: input.terminalOutcome,
    });
    if (claim.value.reduction_hash !== null) {
      if (claim.value.reduction_hash !== inputHash || claim.value.reduction_result_record === null) {
        return ok({ kind: "claim_mismatch" });
      }
      const original = parseStoredManagedRunRecord(claim.value.reduction_result_record);
      return original.ok ? ok(resultRecord("identical_replay", original.value)) : original;
    }
    if (claim.value.state !== "active") return ok({ kind: "claim_mismatch" });
    if (
      input.throughReportSequence !== claim.value.through_report_sequence
      || input.throughReportSequence < current.value.lastReducedReportSequence
      || input.throughReportSequence > current.value.lastAcceptedReportSequence
    ) return ok({ kind: "cursor_regression" });
    if (!transitionAllowed(current.value.status, input.status)) {
      return ok({ kind: "invalid_transition" });
    }
    if (input.committedAtMs < current.value.updatedAtMs) {
      return err(new Error("managed-run reduction time cannot move backward"));
    }
    const terminal = input.status === "succeeded" || input.status === "failed" || input.status === "cancelled";
    const next: ManagedRunRecord = {
      ...current.value,
      status: input.status,
      statusReason: input.statusReason,
      lastReducedReportSequence: input.throughReportSequence,
      ...(input.terminalOutcome === undefined ? { terminalOutcome: undefined } : { terminalOutcome: input.terminalOutcome }),
      pendingContinuation: terminal ? false : current.value.pendingContinuation,
      updatedAtMs: input.committedAtMs,
    };
    const persisted = persistMutable(next);
    if (!persisted.ok) return persisted;
    const reduced = recordReduction.run(inputHash, serializeManagedRunRecord(next), input.claimId);
    return reduced.changes === 1
      ? ok(resultRecord("updated", next))
      : err(new Error("managed-run continuation reduction lost its claim"));
  });

  const outcomeTransaction = db.transaction((
    scope: ManagedRunOwnerScope,
    input: ManagedRunContinuationOutcomeInput,
  ): Result<ManagedRunMutationOutcome, Error> => {
    const current = readRecord(input.managedRunId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    const claim = claimMapper.parseOptionalRow(selectClaim.get(input.claimId));
    if (!claim.ok) return err(new Error(claim.error.message));
    if (claim.value === undefined || claim.value.managed_run_id !== input.managedRunId) {
      return ok({ kind: "claim_mismatch" });
    }
    const inputHash = hashCanonical({ managedRunId: input.managedRunId, outcome: input.outcome });
    if (claim.value.outcome_hash !== null) {
      if (claim.value.outcome_hash !== inputHash || claim.value.outcome_result_record === null) {
        return ok({ kind: "claim_mismatch" });
      }
      const original = parseStoredManagedRunRecord(claim.value.outcome_result_record);
      return original.ok ? ok(resultRecord("identical_replay", original.value)) : original;
    }
    if (claim.value.state !== "active" || claim.value.reduction_hash === null) {
      return ok({ kind: "claim_mismatch" });
    }
    if (input.recordedAtMs < current.value.updatedAtMs) {
      return err(new Error("managed-run continuation outcome time cannot move backward"));
    }
    const next: ManagedRunRecord = {
      ...current.value,
      pendingContinuation: input.outcome === "completed"
        ? current.value.lastAcceptedReportSequence > current.value.lastReducedReportSequence
        : true,
      updatedAtMs: input.recordedAtMs,
    };
    const persisted = persistMutable(next);
    if (!persisted.ok) return persisted;
    const settled = recordContinuationOutcome.run(
      input.outcome,
      inputHash,
      serializeManagedRunRecord(next),
      input.recordedAtMs,
      input.claimId,
    );
    return settled.changes === 1
      ? ok(resultRecord("updated", next))
      : err(new Error("managed-run continuation outcome lost its claim"));
  });

  async function boundary<T>(operation: () => Result<T, Error>): Promise<Result<T, Error>> {
    try {
      return operation();
    } catch (cause) {
      return err(asError(cause));
    }
  }

  return Object.freeze({
    create: (record) => boundary(() => createTransaction.immediate(record)),
    get: (scope, managedRunId) => boundary(() => {
      const record = readRecord(managedRunId);
      if (!record.ok || record.value === undefined) return record;
      return ok(scopeMatches(record.value, scope) ? record.value : undefined);
    }),
    claimTransition: (scope, input) => boundary(
      () => transitionTransaction.immediate(scope, input, "transition"),
    ),
    bindTerminal: (scope, input) => boundary(() => bindingTransaction.immediate(scope, input)),
    setWorkspaceLease: (scope, input) => boundary(() => bindingTransaction.immediate(scope, input)),
    appendReportAndAdvanceAcceptedCursor: (scope, input) => boundary(
      () => reportTransaction.immediate(scope, input),
    ),
    listReportRange: (scope, input: ManagedRunReportRangeInput) => boundary(() => {
      if (
        !Number.isInteger(input.afterSequence)
        || input.afterSequence < 0
        || !Number.isInteger(input.throughSequence)
        || input.throughSequence < input.afterSequence
        || input.throughSequence - input.afterSequence > 10_000
      ) return err(new Error("managed-run report range is invalid"));
      const record = readRecord(input.managedRunId);
      if (!record.ok) return record;
      if (record.value === undefined || !scopeMatches(record.value, scope)) return ok([]);
      const rows = reportMapper.parseRows(listReportRangeRows.all(
        input.managedRunId,
        input.afterSequence,
        input.throughSequence,
      ));
      if (!rows.ok) return err(new Error(rows.error.message));
      const reports: ManagedRunReportIndex[] = [];
      for (const row of rows.value) {
        const report = rowToManagedRunReport(row);
        if (!report.ok) return report;
        reports.push(report.value);
      }
      return ok(reports);
    }),
    claimContinuation: (scope, input) => boundary(
      () => claimContinuationTransaction.immediate(scope, input),
    ),
    commitReducedState: (scope, input) => boundary(() => reduceTransaction.immediate(scope, input)),
    markContinuationOutcome: (scope, input) => boundary(
      () => outcomeTransaction.immediate(scope, input),
    ),
    listScoped: (input) => boundary(() => {
      if (!validLimit(input.limit)) return err(new Error("managed-run list limit is invalid"));
      const statuses = JSON.stringify(input.statuses ?? []);
      const rows = runMapper.parseRows(listScopedRows.all(
        input.scope.tenantId,
        input.scope.agentId,
        input.scope.principalId,
        input.scope.conversationRef,
        statuses,
        statuses,
        input.limit,
      ));
      if (!rows.ok) return err(new Error(rows.error.message));
      const records: ManagedRunRecord[] = [];
      for (const row of rows.value) {
        const record = rowToManagedRunRecord(row);
        if (!record.ok) return record;
        records.push(record.value);
      }
      return ok(records);
    }),
    listRecoverable: (input) => boundary((): Result<ManagedRunRecoveryScan, Error> => {
      if (!validLimit(input.limit) || input.statuses.length === 0) {
        return err(new Error("managed-run recovery scan input is invalid"));
      }
      const rawRows = listRecoverableRows.all(
        JSON.stringify(input.statuses),
        input.updatedBeforeMs,
        input.limit,
      );
      const records: ManagedRunRecord[] = [];
      const invalid: InvalidManagedRunRecord[] = [];
      for (const rawRow of rawRows) {
        const identity = recoveryIdentitySchema.safeParse(rawRow);
        if (!identity.success) return err(new Error("recoverable managed-run row lacks stable identity"));
        const row = runMapper.parseOptionalRow(rawRow);
        if (!row.ok || row.value === undefined) {
          invalid.push({
            managedRunId: identity.data.managed_run_id,
            serviceInstanceId: identity.data.service_instance_id,
            reason: "record_validation_failed",
          });
          continue;
        }
        const record = rowToManagedRunRecord(row.value);
        if (!record.ok) {
          invalid.push({
            managedRunId: identity.data.managed_run_id,
            serviceInstanceId: identity.data.service_instance_id,
            reason: "record_validation_failed",
          });
          continue;
        }
        records.push(record.value);
      }
      return ok({ records, invalid });
    }),
    revoke: (scope, input) => boundary(() => transitionTransaction.immediate(
      scope,
      {
        operationId: input.operationId,
        managedRunId: input.managedRunId,
        expectedStatuses: ["preparing", "active", "waiting", "paused", "candidate_complete", "unknown"],
        nextStatus: "cancelled",
        nextStatusReason: input.reason,
        transitionedAtMs: input.revokedAtMs,
        terminalOutcome: { kind: "cancelled", recordedAtMs: input.revokedAtMs },
      },
      "revoke",
    )),
  } satisfies ManagedRunStorePort);
}
