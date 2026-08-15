// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import {
  parseWorkspaceLeaseRecord,
  type WorkspaceLeaseCreateOutcome,
  type WorkspaceLeasePort,
  type WorkspaceLeaseReconcileInput,
  type WorkspaceLeaseReconcileOutcome,
  type WorkspaceLeaseRecord,
  type WorkspaceLeaseReleaseInput,
  type WorkspaceLeaseReleaseOutcome,
  type WorkspaceLeaseScope,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { hashCanonical } from "./managed-run-store-record.js";
import { createRowMapper } from "./row-mapper.js";
import {
  WorkspaceLeaseDbRowSchema,
  WorkspaceLeaseOperationDbRowSchema,
  type WorkspaceLeaseDbRow,
} from "./workspace-lease-row-schema.js";

const leaseMapper = createRowMapper(WorkspaceLeaseDbRowSchema);
const operationMapper = createRowMapper(WorkspaceLeaseOperationDbRowSchema);

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function scopeMatches(record: WorkspaceLeaseRecord, scope: WorkspaceLeaseScope): boolean {
  return record.tenantId === scope.tenantId
    && record.agentId === scope.agentId
    && record.serviceInstanceId === scope.serviceInstanceId
    && record.managedRunId === scope.managedRunId;
}

function workspacePathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftPrefix = left.endsWith("/") ? left : `${left}/`;
  const rightPrefix = right.endsWith("/") ? right : `${right}/`;
  return right.startsWith(leftPrefix) || left.startsWith(rightPrefix);
}

function rowToRecord(row: WorkspaceLeaseDbRow): Result<WorkspaceLeaseRecord, Error> {
  const parsed = parseWorkspaceLeaseRecord({
    schemaVersion: row.schema_version,
    workspaceLeaseId: row.workspace_lease_id,
    managedRunId: row.managed_run_id,
    serviceInstanceId: row.service_instance_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    canonicalPath: row.canonical_path,
    filesystemIdentity: {
      device: row.filesystem_device,
      inode: row.filesystem_inode,
      birthtimeNs: row.filesystem_birthtime_ns,
    },
    state: row.state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.last_recovered_at_ms === null
      ? {}
      : { lastRecoveredAtMs: row.last_recovered_at_ms }),
    ...(row.released_at_ms === null ? {} : { releasedAtMs: row.released_at_ms }),
    ...(row.release_disposition === null
      ? {}
      : { releaseDisposition: row.release_disposition }),
  });
  return parsed.ok ? ok(parsed.value) : err(new Error(parsed.error.message));
}

function serialize(record: WorkspaceLeaseRecord): string {
  return JSON.stringify(record);
}

function parseStored(raw: string): Result<WorkspaceLeaseRecord, Error> {
  try {
    const parsed = parseWorkspaceLeaseRecord(JSON.parse(raw));
    return parsed.ok ? ok(parsed.value) : err(new Error(parsed.error.message));
  } catch (cause) {
    return err(asError(cause));
  }
}

/** Create the SQLite implementation of durable workspace lease authority. */
export function createSqliteWorkspaceLeaseStore(db: Database.Database): WorkspaceLeasePort {
  const selectLease = db.prepare("SELECT * FROM workspace_leases WHERE workspace_lease_id = ?");
  const selectLeaseByRun = db.prepare("SELECT * FROM workspace_leases WHERE managed_run_id = ?");
  const selectActiveWorkspaceIdentities = db.prepare(`
    SELECT * FROM workspace_leases
    WHERE state = 'active'
    ORDER BY workspace_lease_id ASC
  `);
  const insertLease = db.prepare(`
    INSERT INTO workspace_leases (
      schema_version, workspace_lease_id, managed_run_id, service_instance_id,
      tenant_id, agent_id, canonical_path, filesystem_device, filesystem_inode,
      filesystem_birthtime_ns,
      state, created_at_ms, updated_at_ms, last_recovered_at_ms,
      released_at_ms, release_disposition
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateLease = db.prepare(`
    UPDATE workspace_leases SET
      state = ?, updated_at_ms = ?, last_recovered_at_ms = ?,
      released_at_ms = ?, release_disposition = ?
    WHERE workspace_lease_id = ?
  `);
  const selectOperation = db.prepare(`
    SELECT input_hash, result_record FROM workspace_lease_operations
    WHERE workspace_lease_id = ? AND operation_id = ? AND operation_kind = ?
  `);
  const insertOperation = db.prepare(`
    INSERT INTO workspace_lease_operations (
      workspace_lease_id, operation_id, operation_kind,
      input_hash, result_record, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listActive = db.prepare(`
    SELECT * FROM workspace_leases
    WHERE state = 'active'
    ORDER BY updated_at_ms ASC, workspace_lease_id ASC
    LIMIT ?
  `);

  function readRecord(workspaceLeaseId: string): Result<WorkspaceLeaseRecord | undefined, Error> {
    const row = leaseMapper.parseOptionalRow(selectLease.get(workspaceLeaseId));
    if (!row.ok) return err(new Error(row.error.message));
    return row.value === undefined ? ok(undefined) : rowToRecord(row.value);
  }

  function readRunRecord(managedRunId: string): Result<WorkspaceLeaseRecord | undefined, Error> {
    const row = leaseMapper.parseOptionalRow(selectLeaseByRun.get(managedRunId));
    if (!row.ok) return err(new Error(row.error.message));
    return row.value === undefined ? ok(undefined) : rowToRecord(row.value);
  }

  function readActiveWorkspaceIdentity(
    record: WorkspaceLeaseRecord,
  ): Result<WorkspaceLeaseRecord | undefined, Error> {
    const rows = leaseMapper.parseRows(selectActiveWorkspaceIdentities.all());
    if (!rows.ok) return err(new Error(rows.error.message));
    for (const row of rows.value) {
      const active = rowToRecord(row);
      if (!active.ok) return active;
      if (
        workspacePathsOverlap(active.value.canonicalPath, record.canonicalPath)
        || (
          active.value.filesystemIdentity.device === record.filesystemIdentity.device
          && active.value.filesystemIdentity.inode === record.filesystemIdentity.inode
          && active.value.filesystemIdentity.birthtimeNs === record.filesystemIdentity.birthtimeNs
        )
      ) return ok(active.value);
    }
    return ok(undefined);
  }

  function persist(record: WorkspaceLeaseRecord): Result<void, Error> {
    const parsed = parseWorkspaceLeaseRecord(record);
    if (!parsed.ok) return err(new Error(parsed.error.message));
    const updated = updateLease.run(
      record.state,
      record.updatedAtMs,
      record.lastRecoveredAtMs ?? null,
      record.releasedAtMs ?? null,
      record.releaseDisposition ?? null,
      record.workspaceLeaseId,
    );
    return updated.changes === 1
      ? ok(undefined)
      : err(new Error("workspace lease update lost its row"));
  }

  function readOperation(
    workspaceLeaseId: string,
    operationId: string,
    operationKind: "release" | "reconcile",
  ): Result<{ readonly inputHash: string; readonly record: WorkspaceLeaseRecord } | undefined, Error> {
    const row = operationMapper.parseOptionalRow(
      selectOperation.get(workspaceLeaseId, operationId, operationKind),
    );
    if (!row.ok) return err(new Error(row.error.message));
    if (row.value === undefined) return ok(undefined);
    const record = parseStored(row.value.result_record);
    return record.ok ? ok({ inputHash: row.value.input_hash, record: record.value }) : record;
  }

  const createTransaction = db.transaction((
    record: WorkspaceLeaseRecord,
  ): Result<WorkspaceLeaseCreateOutcome, Error> => {
    const parsed = parseWorkspaceLeaseRecord(record);
    if (!parsed.ok) return err(new Error(parsed.error.message));
    const existing = readRecord(record.workspaceLeaseId);
    if (!existing.ok) return existing;
    if (existing.value !== undefined) {
      return serialize(existing.value) === serialize(parsed.value)
        ? ok({ kind: "identical_replay", record: existing.value })
        : ok({ kind: "replay_conflict" });
    }
    const runLease = readRunRecord(record.managedRunId);
    if (!runLease.ok) return runLease;
    if (runLease.value !== undefined) return ok({ kind: "replay_conflict" });
    if (parsed.value.state === "active") {
      const workspaceIdentity = readActiveWorkspaceIdentity(parsed.value);
      if (!workspaceIdentity.ok) return workspaceIdentity;
      if (workspaceIdentity.value !== undefined) return ok({ kind: "replay_conflict" });
    }
    insertLease.run(
      parsed.value.schemaVersion,
      parsed.value.workspaceLeaseId,
      parsed.value.managedRunId,
      parsed.value.serviceInstanceId,
      parsed.value.tenantId,
      parsed.value.agentId,
      parsed.value.canonicalPath,
      parsed.value.filesystemIdentity.device,
      parsed.value.filesystemIdentity.inode,
      parsed.value.filesystemIdentity.birthtimeNs,
      parsed.value.state,
      parsed.value.createdAtMs,
      parsed.value.updatedAtMs,
      parsed.value.lastRecoveredAtMs ?? null,
      parsed.value.releasedAtMs ?? null,
      parsed.value.releaseDisposition ?? null,
    );
    return ok({ kind: "created", record: parsed.value });
  });

  const releaseTransaction = db.transaction((
    scope: WorkspaceLeaseScope,
    input: WorkspaceLeaseReleaseInput,
  ): Result<WorkspaceLeaseReleaseOutcome, Error> => {
    const current = readRecord(input.workspaceLeaseId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    const inputHash = hashCanonical({
      workspaceLeaseId: input.workspaceLeaseId,
      disposition: input.disposition,
      releasedAtMs: input.releasedAtMs,
    });
    const previous = readOperation(input.workspaceLeaseId, input.operationId, "release");
    if (!previous.ok) return previous;
    if (previous.value !== undefined) {
      return previous.value.inputHash === inputHash
        ? ok({ kind: "identical_replay", record: previous.value.record })
        : ok({ kind: "replay_conflict" });
    }
    if (current.value.state !== "active") return ok({ kind: "state_mismatch" });
    if (input.releasedAtMs < current.value.updatedAtMs) {
      return err(new Error("workspace lease release time cannot move backward"));
    }
    const next: WorkspaceLeaseRecord = {
      ...current.value,
      state: "released",
      updatedAtMs: input.releasedAtMs,
      releasedAtMs: input.releasedAtMs,
      releaseDisposition: input.disposition,
    };
    const persisted = persist(next);
    if (!persisted.ok) return persisted;
    insertOperation.run(
      input.workspaceLeaseId,
      input.operationId,
      "release",
      inputHash,
      serialize(next),
      input.releasedAtMs,
    );
    return ok({ kind: "released", record: next });
  });

  const reconcileTransaction = db.transaction((
    scope: WorkspaceLeaseScope,
    input: WorkspaceLeaseReconcileInput,
  ): Result<WorkspaceLeaseReconcileOutcome, Error> => {
    const current = readRecord(input.workspaceLeaseId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    const inputHash = hashCanonical({
      workspaceLeaseId: input.workspaceLeaseId,
      filesystemIdentity: input.filesystemIdentity,
      recoveredAtMs: input.recoveredAtMs,
    });
    const previous = readOperation(input.workspaceLeaseId, input.operationId, "reconcile");
    if (!previous.ok) return previous;
    if (previous.value !== undefined) {
      return previous.value.inputHash === inputHash
        ? ok({ kind: "identical_replay", record: previous.value.record })
        : ok({ kind: "replay_conflict" });
    }
    if (current.value.state !== "active") return ok({ kind: "state_mismatch" });
    if (
      current.value.filesystemIdentity.device !== input.filesystemIdentity.device
      || current.value.filesystemIdentity.inode !== input.filesystemIdentity.inode
      || current.value.filesystemIdentity.birthtimeNs !== input.filesystemIdentity.birthtimeNs
    ) return ok({ kind: "identity_mismatch" });
    if (input.recoveredAtMs < current.value.updatedAtMs) {
      return err(new Error("workspace lease recovery time cannot move backward"));
    }
    const next: WorkspaceLeaseRecord = {
      ...current.value,
      updatedAtMs: input.recoveredAtMs,
      lastRecoveredAtMs: input.recoveredAtMs,
    };
    const persisted = persist(next);
    if (!persisted.ok) return persisted;
    insertOperation.run(
      input.workspaceLeaseId,
      input.operationId,
      "reconcile",
      inputHash,
      serialize(next),
      input.recoveredAtMs,
    );
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
    get: (scope, workspaceLeaseId) => boundary(() => {
      const record = readRecord(workspaceLeaseId);
      if (!record.ok || record.value === undefined) return record;
      return ok(scopeMatches(record.value, scope) ? record.value : undefined);
    }),
    release: (scope, input) => boundary(() => releaseTransaction.immediate(scope, input)),
    reconcile: (scope, input) => boundary(() => reconcileTransaction.immediate(scope, input)),
    listRecoverable: (input) => boundary(() => {
      if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 10_000) {
        return err(new Error("workspace lease recovery scan limit is invalid"));
      }
      const rows = leaseMapper.parseRows(listActive.all(input.limit));
      if (!rows.ok) return err(new Error(rows.error.message));
      const records: WorkspaceLeaseRecord[] = [];
      for (const row of rows.value) {
        const record = rowToRecord(row);
        if (!record.ok) return record;
        records.push(record.value);
      }
      return ok(records);
    }),
  } satisfies WorkspaceLeasePort);
}
