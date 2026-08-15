// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import {
  ManagedRunAttentionRecordSchema,
  type ManagedRunAttentionDeliveryInput,
  type ManagedRunAttentionListInput,
  type ManagedRunAttentionMutationOutcome,
  type ManagedRunAttentionRecord,
  type ManagedRunAttentionResponseInput,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
  type ManagedRunReportAppendInput,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  ManagedRunAttentionCountDbRowSchema,
  ManagedRunAttentionDbRowSchema,
  ManagedRunAttentionOperationDbRowSchema,
  type ManagedRunAttentionDbRow,
} from "./managed-run-row-schema.js";
import { hashCanonical } from "./managed-run-store-record.js";
import { createRowMapper } from "./row-mapper.js";

const attentionMapper = createRowMapper(ManagedRunAttentionDbRowSchema);
const operationMapper = createRowMapper(ManagedRunAttentionOperationDbRowSchema);
const countMapper = createRowMapper(ManagedRunAttentionCountDbRowSchema);
function rowToRecord(row: ManagedRunAttentionDbRow): Result<ManagedRunAttentionRecord, Error> {
  const parsed = ManagedRunAttentionRecordSchema.safeParse({
    schemaVersion: row.schema_version,
    attentionId: row.attention_id,
    managedRunId: row.managed_run_id,
    serviceInstanceId: row.service_instance_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    principalId: row.principal_id,
    conversationRef: row.conversation_ref,
    ...(row.external_key === null ? {} : { externalKey: row.external_key }),
    reportSequence: row.report_sequence,
    attentionRef: row.attention_ref,
    status: row.status,
    ...(row.response_ref === null ? {} : { responseRef: row.response_ref }),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.expires_at_ms === null ? {} : { expiresAtMs: row.expires_at_ms }),
  });
  return parsed.success
    ? ok(parsed.data)
    : err(new Error(`managed-run attention row validation failed: ${parsed.error.message}`));
}

function scopeMatches(record: ManagedRunAttentionRecord, scope: ManagedRunOwnerScope): boolean {
  return record.tenantId === scope.tenantId
    && record.agentId === scope.agentId
    && record.principalId === scope.principalId
    && record.conversationRef === scope.conversationRef;
}

export interface ManagedRunAttentionStoreStatements {
  applyReport(
    record: ManagedRunRecord,
    sequence: number,
    input: ManagedRunReportAppendInput,
  ): Result<number, Error>;
  get(
    scope: ManagedRunOwnerScope,
    attentionId: string,
  ): Result<ManagedRunAttentionRecord | undefined, Error>;
  getResponseByOperation(
    scope: ManagedRunOwnerScope,
    operationId: string,
  ): Result<ManagedRunAttentionRecord | undefined, Error>;
  listOpen(
    scope: ManagedRunOwnerScope,
    input: ManagedRunAttentionListInput,
  ): Result<ManagedRunAttentionRecord[], Error>;
  claimResponse(
    scope: ManagedRunOwnerScope,
    input: ManagedRunAttentionResponseInput,
  ): Result<ManagedRunAttentionMutationOutcome, Error>;
  markDelivered(
    scope: ManagedRunOwnerScope,
    input: ManagedRunAttentionDeliveryInput,
  ): Result<ManagedRunAttentionMutationOutcome, Error>;
}

/** Prepare attention operations that join the managed-report SQLite transaction. */
export function createManagedRunAttentionStoreStatements(
  db: Database.Database,
): ManagedRunAttentionStoreStatements {
  const selectById = db.prepare("SELECT * FROM managed_run_attention WHERE attention_id = ?");
  const selectByExternal = db.prepare(`
    SELECT * FROM managed_run_attention WHERE managed_run_id = ? AND external_key = ?
  `);
  const insert = db.prepare(`
    INSERT INTO managed_run_attention (
      schema_version, attention_id, managed_run_id, service_instance_id,
      tenant_id, agent_id, principal_id, conversation_ref, external_key,
      report_sequence, attention_ref, status, response_ref, created_at_ms,
      updated_at_ms, expires_at_ms
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?)
  `);
  const resolve = db.prepare(`
    UPDATE managed_run_attention SET status = 'resolved', updated_at_ms = ?
    WHERE managed_run_id = ? AND external_key = ?
      AND status IN ('open','response_pending','delivered')
  `);
  const countOpen = db.prepare(`
    SELECT COUNT(*) AS count FROM managed_run_attention
    WHERE managed_run_id = ? AND status IN ('open','response_pending','delivered')
  `);
  const listOpenRows = db.prepare(`
    SELECT * FROM managed_run_attention
    WHERE tenant_id = ? AND agent_id = ? AND principal_id = ? AND conversation_ref = ?
      AND (? IS NULL OR managed_run_id = ?)
      AND status IN ('open','response_pending','delivered')
    ORDER BY created_at_ms ASC, attention_id ASC
    LIMIT ?
  `);
  const update = db.prepare(`
    UPDATE managed_run_attention SET status = ?, response_ref = ?, updated_at_ms = ?
    WHERE attention_id = ?
  `);
  const selectOperation = db.prepare(`
    SELECT input_hash, result_record FROM managed_run_attention_operations
    WHERE attention_id = ? AND operation_id = ? AND operation_kind = ?
  `);
  const selectResponseOperationByOwner = db.prepare(`
    SELECT o.input_hash, o.result_record
    FROM managed_run_attention_operations o
    WHERE o.operation_id = ? AND o.operation_kind = 'response'
      AND o.tenant_id = ? AND o.agent_id = ?
      AND o.principal_id = ? AND o.conversation_ref = ?
    ORDER BY o.attention_id ASC
    LIMIT 2
  `);
  const insertOperation = db.prepare(`
    INSERT INTO managed_run_attention_operations (
      attention_id, tenant_id, agent_id, principal_id, conversation_ref,
      operation_id, operation_kind, input_hash, result_record, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function read(attentionId: string): Result<ManagedRunAttentionRecord | undefined, Error> {
    const row = attentionMapper.parseOptionalRow(selectById.get(attentionId));
    if (!row.ok) return err(new Error(row.error.message));
    return row.value === undefined ? ok(undefined) : rowToRecord(row.value);
  }

  function openCount(managedRunId: string): Result<number, Error> {
    const parsed = countMapper.parseOptionalRow(countOpen.get(managedRunId));
    if (!parsed.ok) return err(new Error(parsed.error.message));
    return parsed.value === undefined
      ? err(new Error("managed-run attention count is missing"))
      : ok(parsed.value.count);
  }

  function readResponseOperationByOwner(
    scope: ManagedRunOwnerScope,
    operationId: string,
  ): Result<{
    readonly inputHash: string;
    readonly record: ManagedRunAttentionRecord;
  } | undefined, Error> {
    const rows = operationMapper.parseRows(selectResponseOperationByOwner.all(
      operationId,
      scope.tenantId,
      scope.agentId,
      scope.principalId,
      scope.conversationRef,
    ));
    if (!rows.ok) return err(new Error(rows.error.message));
    if (rows.value.length > 1) {
      return err(new Error("managed-run attention response operation is not owner-unique"));
    }
    const row = rows.value[0];
    if (row === undefined) return ok(undefined);
    const decoded = tryCatch(() => JSON.parse(row.result_record) as unknown);
    if (!decoded.ok) return err(decoded.error);
    const parsed = ManagedRunAttentionRecordSchema.safeParse(decoded.value);
    if (!parsed.success || !scopeMatches(parsed.data, scope)) {
      return err(new Error("stored managed-run attention response operation is invalid"));
    }
    return ok({ inputHash: row.input_hash, record: parsed.data });
  }

  function mutate(
    scope: ManagedRunOwnerScope,
    input: ManagedRunAttentionResponseInput | ManagedRunAttentionDeliveryInput,
    kind: "response" | "delivery",
  ): Result<ManagedRunAttentionMutationOutcome, Error> {
    const inputHash = hashCanonical(input);
    const prior = operationMapper.parseOptionalRow(selectOperation.get(
      input.attentionId,
      input.operationId,
      kind,
    ));
    if (!prior.ok) return err(new Error(prior.error.message));
    if (prior.value !== undefined) {
      const priorOperation = prior.value;
      const decoded = tryCatch(() => JSON.parse(priorOperation.result_record) as unknown);
      if (!decoded.ok) return err(decoded.error);
      const parsed = ManagedRunAttentionRecordSchema.safeParse(decoded.value);
      if (!parsed.success) return err(new Error("stored managed-run attention operation is invalid"));
      if (!scopeMatches(parsed.data, scope)) return ok({ kind: "scope_mismatch" });
      return priorOperation.input_hash === inputHash
        ? ok({ kind: "identical_replay", record: parsed.data })
        : ok({ kind: "replay_conflict" });
    }
    if (kind === "response") {
      const ownerOperation = readResponseOperationByOwner(scope, input.operationId);
      if (!ownerOperation.ok) return ownerOperation;
      if (ownerOperation.value !== undefined) {
        return ownerOperation.value.record.attentionId === input.attentionId
          && ownerOperation.value.inputHash === inputHash
          ? ok({ kind: "identical_replay", record: ownerOperation.value.record })
          : ok({ kind: "replay_conflict" });
      }
    }
    const current = read(input.attentionId);
    if (!current.ok) return current;
    if (current.value === undefined) return ok({ kind: "not_found" });
    if (!scopeMatches(current.value, scope)) return ok({ kind: "scope_mismatch" });
    const transitionTime = kind === "response"
      ? (input as ManagedRunAttentionResponseInput).respondedAtMs
      : (input as ManagedRunAttentionDeliveryInput).deliveredAtMs;
    if (transitionTime < current.value.updatedAtMs) {
      return err(new Error("managed-run attention time cannot move backward"));
    }
    if (
      (kind === "response" && current.value.status !== "open")
      || (kind === "delivery" && current.value.status !== "response_pending")
    ) return ok({ kind: "state_mismatch" });
    const next: ManagedRunAttentionRecord = {
      ...current.value,
      status: kind === "response" ? "response_pending" : "delivered",
      ...(kind === "response"
        ? { responseRef: (input as ManagedRunAttentionResponseInput).responseRef }
        : {}),
      updatedAtMs: transitionTime,
    };
    const validated = ManagedRunAttentionRecordSchema.safeParse(next);
    if (!validated.success) return err(new Error(`managed-run attention transition is invalid: ${validated.error.message}`));
    update.run(next.status, next.responseRef ?? null, transitionTime, next.attentionId);
    insertOperation.run(
      next.attentionId,
      scope.tenantId,
      scope.agentId,
      scope.principalId,
      scope.conversationRef,
      input.operationId,
      kind,
      inputHash,
      JSON.stringify(validated.data),
      transitionTime,
    );
    return ok({ kind: "updated", record: validated.data });
  }

  const store: ManagedRunAttentionStoreStatements = {
    applyReport: (record, sequence, input) => {
      const isAttention = input.kind === "attention" || input.kind === "blocked";
      if (isAttention !== (input.attention !== undefined)) {
        return err(new Error("attention reports require exactly one durable attention descriptor"));
      }
      if (input.attention !== undefined) {
        const candidate = ManagedRunAttentionRecordSchema.safeParse({
          schemaVersion: 1,
          attentionId: input.attention.attentionId,
          managedRunId: record.managedRunId,
          serviceInstanceId: record.serviceInstanceId,
          tenantId: record.tenantId,
          agentId: record.agentId,
          principalId: record.principalId,
          conversationRef: record.conversationRef,
          ...(input.attention.externalKey === undefined ? {} : { externalKey: input.attention.externalKey }),
          reportSequence: sequence,
          attentionRef: input.attention.attentionRef,
          status: "open",
          createdAtMs: input.receivedAtMs,
          updatedAtMs: input.receivedAtMs,
          ...(input.attention.expiresAtMs === undefined ? {} : { expiresAtMs: input.attention.expiresAtMs }),
        });
        if (!candidate.success) return err(new Error(`managed-run attention is invalid: ${candidate.error.message}`));
        const existing = read(candidate.data.attentionId);
        if (!existing.ok) return existing;
        if (existing.value === undefined) {
          if (candidate.data.externalKey !== undefined) {
            const collided = attentionMapper.parseOptionalRow(selectByExternal.get(
              record.managedRunId,
              candidate.data.externalKey,
            ));
            if (!collided.ok) return err(new Error(collided.error.message));
            if (collided.value !== undefined) return err(new Error("managed-run attention external key is already bound"));
          }
          insert.run(
            candidate.data.attentionId,
            candidate.data.managedRunId,
            candidate.data.serviceInstanceId,
            candidate.data.tenantId,
            candidate.data.agentId,
            candidate.data.principalId,
            candidate.data.conversationRef,
            candidate.data.externalKey ?? null,
            candidate.data.reportSequence,
            candidate.data.attentionRef,
            candidate.data.createdAtMs,
            candidate.data.updatedAtMs,
            candidate.data.expiresAtMs ?? null,
          );
        } else if (hashCanonical(existing.value) !== hashCanonical(candidate.data)) {
          return err(new Error("managed-run attention identity conflicts with its original report"));
        }
      }
      if (input.kind === "resolution" && input.resolutionExternalKey !== undefined) {
        resolve.run(input.receivedAtMs, record.managedRunId, input.resolutionExternalKey);
      } else if (input.kind !== "resolution" && input.resolutionExternalKey !== undefined) {
        return err(new Error("only resolution reports may carry a resolution external key"));
      }
      return openCount(record.managedRunId);
    },
    get: (scope, attentionId) => {
      const record = read(attentionId);
      if (!record.ok || record.value === undefined) return record;
      return ok(scopeMatches(record.value, scope) ? record.value : undefined);
    },
    getResponseByOperation: (scope, operationId) => {
      const operation = readResponseOperationByOwner(scope, operationId);
      if (!operation.ok) return operation;
      return ok(operation.value?.record);
    },
    listOpen: (scope, input) => {
      if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 10_000) {
        return err(new Error("managed-run attention list limit is invalid"));
      }
      const rows = attentionMapper.parseRows(listOpenRows.all(
        scope.tenantId,
        scope.agentId,
        scope.principalId,
        scope.conversationRef,
        input.managedRunId ?? null,
        input.managedRunId ?? null,
        input.limit,
      ));
      if (!rows.ok) return err(new Error(rows.error.message));
      const records: ManagedRunAttentionRecord[] = [];
      for (const row of rows.value) {
        const record = rowToRecord(row);
        if (!record.ok) return record;
        records.push(record.value);
      }
      return ok(records);
    },
    claimResponse: (scope, input) => mutate(scope, input, "response"),
    markDelivered: (scope, input) => mutate(scope, input, "delivery"),
  };
  return Object.freeze(store);
}
