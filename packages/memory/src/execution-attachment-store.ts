// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import {
  parseExecutionAttachmentRecord,
  type ExecutionAttachmentCreateOutcome,
  type ExecutionAttachmentPort,
  type ExecutionAttachmentReconcileInput,
  type ExecutionAttachmentReconcileOutcome,
  type ExecutionAttachmentRecord,
  type ExecutionAttachmentRevokeInput,
  type ExecutionAttachmentRevokeOutcome,
  type ExecutionAttachmentScope,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { hashCanonical } from "./managed-run-store-record.js";
import { createRowMapper } from "./row-mapper.js";
import {
  ExecutionAttachmentAuthorityDbRowSchema,
  ExecutionAttachmentDbRowSchema,
  ExecutionAttachmentOperationDbRowSchema,
  type ExecutionAttachmentDbRow,
} from "./execution-attachment-row-schema.js";

const attachmentMapper = createRowMapper(ExecutionAttachmentDbRowSchema);
const operationMapper = createRowMapper(ExecutionAttachmentOperationDbRowSchema);
const authorityMapper = createRowMapper(ExecutionAttachmentAuthorityDbRowSchema);

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function scopeMatches(record: ExecutionAttachmentRecord, scope: ExecutionAttachmentScope): boolean {
  return record.tenantId === scope.tenantId
    && record.agentId === scope.agentId
    && record.serviceInstanceId === scope.serviceInstanceId
    && record.managedRunId === scope.managedRunId
    && record.workspaceLeaseId === scope.workspaceLeaseId;
}

function rowToRecord(row: ExecutionAttachmentDbRow): Result<ExecutionAttachmentRecord, Error> {
  const parsed = parseExecutionAttachmentRecord({
    schemaVersion: row.schema_version,
    executionAttachmentId: row.execution_attachment_id,
    managedRunId: row.managed_run_id,
    workspaceLeaseId: row.workspace_lease_id,
    serviceInstanceId: row.service_instance_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    kind: row.kind,
    sourcePath: row.source_path,
    sourceFilesystemType: row.source_filesystem_type,
    sourceFilesystemIdentity: {
      device: row.source_filesystem_device,
      inode: row.source_filesystem_inode,
      birthtimeNs: row.source_filesystem_birthtime_ns,
    },
    targetName: row.target_name,
    access: row.access,
    state: row.state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.last_recovered_at_ms === null ? {} : { lastRecoveredAtMs: row.last_recovered_at_ms }),
    ...(row.revoked_at_ms === null ? {} : { revokedAtMs: row.revoked_at_ms }),
    ...(row.revocation_reason === null ? {} : { revocationReason: row.revocation_reason }),
  });
  return parsed.ok ? ok(parsed.value) : err(new Error(parsed.error.message));
}

function serialize(record: ExecutionAttachmentRecord): string {
  return JSON.stringify(record);
}

function parseStored(raw: string): Result<ExecutionAttachmentRecord, Error> {
  try {
    const parsed = parseExecutionAttachmentRecord(JSON.parse(raw));
    return parsed.ok ? ok(parsed.value) : err(new Error(parsed.error.message));
  } catch (cause) {
    return err(asError(cause));
  }
}

/** Create the SQLite implementation of durable execution-attachment authority. */
export function createSqliteExecutionAttachmentStore(db: Database.Database): ExecutionAttachmentPort {
  const selectAttachment = db.prepare("SELECT * FROM execution_attachments WHERE execution_attachment_id = ?");
  const selectActiveSource = db.prepare("SELECT execution_attachment_id FROM execution_attachments WHERE source_path = ? AND state = 'active'");
  const selectAuthority = db.prepare(`
    SELECT mr.managed_run_id, mr.service_instance_id, mr.tenant_id, mr.agent_id,
      mr.workspace_lease_id,
      wl.managed_run_id AS lease_managed_run_id,
      wl.service_instance_id AS lease_service_instance_id,
      wl.tenant_id AS lease_tenant_id, wl.agent_id AS lease_agent_id,
      wl.state AS lease_state,
      rr.operation_id AS release_operation_id
    FROM managed_runs mr
    JOIN workspace_leases wl ON wl.workspace_lease_id = mr.workspace_lease_id
    LEFT JOIN managed_run_release_reservations rr ON rr.managed_run_id = mr.managed_run_id
    WHERE mr.managed_run_id = ?
  `);
  const insertAttachment = db.prepare(`
    INSERT INTO execution_attachments (
      schema_version, execution_attachment_id, managed_run_id, workspace_lease_id,
      service_instance_id, tenant_id, agent_id, kind, source_path,
      source_filesystem_type, source_filesystem_device, source_filesystem_inode,
      source_filesystem_birthtime_ns,
      target_name, access, state, created_at_ms, updated_at_ms,
      last_recovered_at_ms, revoked_at_ms, revocation_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateAttachment = db.prepare(`
    UPDATE execution_attachments SET source_filesystem_device = ?,
      source_filesystem_inode = ?, source_filesystem_birthtime_ns = ?,
      state = ?, updated_at_ms = ?,
      last_recovered_at_ms = ?, revoked_at_ms = ?, revocation_reason = ?
    WHERE execution_attachment_id = ?
  `);
  const listActive = db.prepare(`
    SELECT * FROM execution_attachments
    WHERE tenant_id = ? AND agent_id = ? AND service_instance_id = ?
      AND managed_run_id = ? AND workspace_lease_id = ? AND state = 'active'
    ORDER BY execution_attachment_id ASC
  `);
  const listRecoverable = db.prepare(`
    SELECT * FROM execution_attachments
    WHERE state = 'active' AND updated_at_ms <= ?
      AND (? IS NULL OR execution_attachment_id > ?)
    ORDER BY execution_attachment_id ASC
    LIMIT ?
  `);
  const selectOperation = db.prepare(`
    SELECT input_hash, result_record FROM execution_attachment_operations
    WHERE execution_attachment_id = ? AND operation_id = ? AND operation_kind = ?
  `);
  const insertOperation = db.prepare(`
    INSERT INTO execution_attachment_operations (
      execution_attachment_id, operation_id, operation_kind,
      input_hash, result_record, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  function readRecord(executionAttachmentId: string): Result<ExecutionAttachmentRecord | undefined, Error> {
    const row = attachmentMapper.parseOptionalRow(selectAttachment.get(executionAttachmentId));
    if (!row.ok) return err(new Error(row.error.message));
    return row.value === undefined ? ok(undefined) : rowToRecord(row.value);
  }

  function persist(record: ExecutionAttachmentRecord): Result<void, Error> {
    const parsed = parseExecutionAttachmentRecord(record);
    if (!parsed.ok) return err(new Error(parsed.error.message));
    const updated = updateAttachment.run(
      record.sourceFilesystemIdentity.device,
      record.sourceFilesystemIdentity.inode,
      record.sourceFilesystemIdentity.birthtimeNs,
      record.state,
      record.updatedAtMs,
      record.lastRecoveredAtMs ?? null,
      record.revokedAtMs ?? null,
      record.revocationReason ?? null,
      record.executionAttachmentId,
    );
    return updated.changes === 1 ? ok(undefined) : err(new Error("execution attachment update lost its row"));
  }

  function readOperation(
    executionAttachmentId: string,
    operationId: string,
    operationKind: "revoke" | "reconcile",
  ): Result<{ readonly inputHash: string; readonly record: ExecutionAttachmentRecord } | undefined, Error> {
    const row = operationMapper.parseOptionalRow(selectOperation.get(executionAttachmentId, operationId, operationKind));
    if (!row.ok) return err(new Error(row.error.message));
    if (row.value === undefined) return ok(undefined);
    const record = parseStored(row.value.result_record);
    return record.ok ? ok({ inputHash: row.value.input_hash, record: record.value }) : record;
  }

  function authorityMatches(record: ExecutionAttachmentRecord): Result<boolean, Error> {
    const row = authorityMapper.parseOptionalRow(selectAuthority.get(record.managedRunId));
    if (!row.ok) return err(new Error(row.error.message));
    if (row.value === undefined) return ok(false);
    return ok(
      row.value.service_instance_id === record.serviceInstanceId
      && row.value.tenant_id === record.tenantId
      && row.value.agent_id === record.agentId
      && row.value.workspace_lease_id === record.workspaceLeaseId
      && row.value.lease_managed_run_id === record.managedRunId
      && row.value.lease_service_instance_id === record.serviceInstanceId
      && row.value.lease_tenant_id === record.tenantId
      && row.value.lease_agent_id === record.agentId
      && row.value.lease_state === "active"
      && row.value.release_operation_id === null
    );
  }

  const createTransaction = db.transaction((record: ExecutionAttachmentRecord): Result<ExecutionAttachmentCreateOutcome, Error> => {
    const parsed = parseExecutionAttachmentRecord(record);
    if (!parsed.ok) return err(new Error(parsed.error.message));
    if (parsed.value.state !== "active") return err(new Error("execution attachment creation requires active state"));
    const existing = readRecord(record.executionAttachmentId);
    if (!existing.ok) return existing;
    if (existing.value !== undefined) {
      return serialize(existing.value) === serialize(parsed.value)
        ? ok({ kind: "identical_replay", record: existing.value })
        : ok({ kind: "replay_conflict" });
    }
    const authorized = authorityMatches(parsed.value);
    if (!authorized.ok) return authorized;
    if (!authorized.value) return ok({ kind: "authority_mismatch" });
    if (selectActiveSource.get(parsed.value.sourcePath) !== undefined) return ok({ kind: "replay_conflict" });
    insertAttachment.run(
      parsed.value.schemaVersion,
      parsed.value.executionAttachmentId,
      parsed.value.managedRunId,
      parsed.value.workspaceLeaseId,
      parsed.value.serviceInstanceId,
      parsed.value.tenantId,
      parsed.value.agentId,
      parsed.value.kind,
      parsed.value.sourcePath,
      parsed.value.sourceFilesystemType,
      parsed.value.sourceFilesystemIdentity.device,
      parsed.value.sourceFilesystemIdentity.inode,
      parsed.value.sourceFilesystemIdentity.birthtimeNs,
      parsed.value.targetName,
      parsed.value.access,
      parsed.value.state,
      parsed.value.createdAtMs,
      parsed.value.updatedAtMs,
      null,
      null,
      null,
    );
    return ok({ kind: "created", record: parsed.value });
  });

  const revokeTransaction = db.transaction((scope: ExecutionAttachmentScope, input: ExecutionAttachmentRevokeInput): Result<ExecutionAttachmentRevokeOutcome, Error> => {
    const current = readRecord(input.executionAttachmentId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    const inputHash = hashCanonical(input);
    const previous = readOperation(input.executionAttachmentId, input.operationId, "revoke");
    if (!previous.ok) return previous;
    if (previous.value !== undefined) {
      return previous.value.inputHash === inputHash
        ? ok({ kind: "identical_replay", record: previous.value.record })
        : ok({ kind: "replay_conflict" });
    }
    if (current.value.state !== "active") return ok({ kind: "state_mismatch" });
    if (input.revokedAtMs < current.value.updatedAtMs) return err(new Error("execution attachment revocation time cannot move backward"));
    const next: ExecutionAttachmentRecord = {
      ...current.value,
      state: "revoked",
      updatedAtMs: input.revokedAtMs,
      revokedAtMs: input.revokedAtMs,
      revocationReason: input.reason,
    };
    const persisted = persist(next);
    if (!persisted.ok) return persisted;
    insertOperation.run(input.executionAttachmentId, input.operationId, "revoke", inputHash, serialize(next), input.revokedAtMs);
    return ok({ kind: "revoked", record: next });
  });

  const reconcileTransaction = db.transaction((scope: ExecutionAttachmentScope, input: ExecutionAttachmentReconcileInput): Result<ExecutionAttachmentReconcileOutcome, Error> => {
    const current = readRecord(input.executionAttachmentId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    const inputHash = hashCanonical(input);
    const previous = readOperation(input.executionAttachmentId, input.operationId, "reconcile");
    if (!previous.ok) return previous;
    if (previous.value !== undefined) {
      return previous.value.inputHash === inputHash
        ? ok({ kind: "identical_replay", record: previous.value.record })
        : ok({ kind: "replay_conflict" });
    }
    if (current.value.state !== "active") return ok({ kind: "state_mismatch" });
    const authorized = authorityMatches(current.value);
    if (!authorized.ok) return authorized;
    if (!authorized.value) return ok({ kind: "authority_mismatch" });
    if (input.recoveredAtMs < current.value.updatedAtMs) return err(new Error("execution attachment recovery time cannot move backward"));
    const next: ExecutionAttachmentRecord = {
      ...current.value,
      sourceFilesystemIdentity: input.sourceFilesystemIdentity,
      updatedAtMs: input.recoveredAtMs,
      lastRecoveredAtMs: input.recoveredAtMs,
    };
    const persisted = persist(next);
    if (!persisted.ok) return persisted;
    insertOperation.run(input.executionAttachmentId, input.operationId, "reconcile", inputHash, serialize(next), input.recoveredAtMs);
    return ok({ kind: "recovered", record: next });
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
    get: (scope, executionAttachmentId) => boundary(() => {
      const record = readRecord(executionAttachmentId);
      if (!record.ok || record.value === undefined) return record;
      return ok(scopeMatches(record.value, scope) ? record.value : undefined);
    }),
    listActiveForRun: (scope) => boundary(() => {
      const rows = attachmentMapper.parseRows(listActive.all(scope.tenantId, scope.agentId, scope.serviceInstanceId, scope.managedRunId, scope.workspaceLeaseId));
      if (!rows.ok) return err(new Error(rows.error.message));
      const records: ExecutionAttachmentRecord[] = [];
      for (const row of rows.value) {
        const record = rowToRecord(row);
        if (!record.ok) return record;
        records.push(record.value);
      }
      return ok(records);
    }),
    revoke: (scope, input) => boundary(() => revokeTransaction.immediate(scope, input)),
    reconcile: (scope, input) => boundary(() => reconcileTransaction.immediate(scope, input)),
    listRecoverable: (input) => boundary(() => {
      if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 10_000) return err(new Error("execution attachment recovery scan limit is invalid"));
      const rows = attachmentMapper.parseRows(listRecoverable.all(
        input.updatedBeforeMs,
        input.afterExecutionAttachmentId ?? null,
        input.afterExecutionAttachmentId ?? null,
        input.limit,
      ));
      if (!rows.ok) return err(new Error(rows.error.message));
      const records: ExecutionAttachmentRecord[] = [];
      for (const row of rows.value) {
        const record = rowToRecord(row);
        if (!record.ok) return record;
        records.push(record.value);
      }
      const last = records.at(-1);
      return ok({
        records,
        ...(records.length === input.limit && last !== undefined
          ? { nextAfterExecutionAttachmentId: last.executionAttachmentId }
          : {}),
      });
    }),
  } satisfies ExecutionAttachmentPort);
}
