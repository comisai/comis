// SPDX-License-Identifier: Apache-2.0
/**
 * Durable managed-run groups.
 *
 * Membership lives on the member run rows and nowhere else. A separate
 * membership table would be a second source of truth that could disagree with
 * the runs it names, and a group that disagrees with its own members is worse
 * than no group at all — so the roll-up is derived on read from
 * `managed_runs.managed_run_group_id`.
 *
 * Preparation is one transaction by contract, not by convenience. A partially
 * written preparation presents some members as host-bound and leaves the rest
 * invisible, which a reader cannot distinguish from a group that was never
 * prepared. Every refusal therefore leaves the database exactly as it found it.
 *
 * @module
 */
import type Database from "better-sqlite3";
import {
  MANAGED_RUN_GROUP_MAX_MEMBERS,
  deriveManagedRunGroupRollup,
  type ManagedRunGroupPrepareInput,
  type ManagedRunGroupPrepareOutcome,
  type ManagedRunGroupRecord,
  type ManagedRunGroupStorePort,
  type ManagedRunLookupScope,
  type ManagedRunRecord,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";
import { ManagedRunDbRowSchema } from "./managed-run-row-schema.js";
import { createRowMapper } from "./row-mapper.js";
import {
  hashCanonical,
  managedRunInsertValues,
  rowToManagedRunRecord,
  scopeMatches,
  validateManagedRunRecord,
} from "./managed-run-store-record.js";

const GroupDbRowSchema = z.strictObject({
  schema_version: z.number().int(),
  managed_run_group_id: z.string(),
  service_instance_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  principal_id: z.string(),
  conversation_ref: z.string(),
  root_run_id: z.string(),
  created_at_ms: z.number().int(),
  updated_at_ms: z.number().int(),
});

const GroupOperationDbRowSchema = z.strictObject({ input_hash: z.string() });

type GroupRow = z.infer<typeof GroupDbRowSchema>;

const groupMapper = createRowMapper(GroupDbRowSchema);
const groupOperationMapper = createRowMapper(GroupOperationDbRowSchema);
const memberMapper = createRowMapper(ManagedRunDbRowSchema);

export function createSqliteManagedRunGroupStore(db: Database.Database): ManagedRunGroupStorePort {
  const insertGroup = db.prepare(`
    INSERT INTO managed_run_groups (
      schema_version, managed_run_group_id, service_instance_id, tenant_id, agent_id,
      principal_id, conversation_ref, root_run_id, created_at_ms, updated_at_ms
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
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
  const insertOperation = db.prepare(`
    INSERT INTO managed_run_group_operations (
      managed_run_group_id, operation_id, input_hash, recorded_at_ms
    ) VALUES (?, ?, ?, ?)
  `);
  const readOperation = db.prepare(`
    SELECT input_hash FROM managed_run_group_operations
    WHERE managed_run_group_id = ? AND operation_id = ?
  `);
  const readGroup = db.prepare("SELECT * FROM managed_run_groups WHERE managed_run_group_id = ?");
  // Bounded at one past the ceiling, deliberately. A truncating LIMIT would
  // hand back a roll-up that silently omits members; one extra row instead lets
  // the derivation refuse an impossible membership rather than describe it.
  const readMembers = db.prepare(`
    SELECT * FROM managed_runs WHERE managed_run_group_id = ? ORDER BY managed_run_id LIMIT ?
  `);
  const memberReadLimit = MANAGED_RUN_GROUP_MAX_MEMBERS + 1;
  const readRun = db.prepare("SELECT managed_run_id FROM managed_runs WHERE managed_run_id = ?");
  const activeCount = db.prepare(`
    SELECT COUNT(*) AS count FROM managed_runs
    WHERE service_instance_id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')
  `).pluck();

  function loadMembers(managedRunGroupId: string): Result<ManagedRunRecord[], Error> {
    const members: ManagedRunRecord[] = [];
    const rows = memberMapper.parseRows(readMembers.all(managedRunGroupId, memberReadLimit));
    if (!rows.ok) return err(new Error("managed-run group member row is unreadable"));
    for (const row of rows.value) {
      const record = rowToManagedRunRecord(row);
      if (!record.ok) return record;
      members.push(record.value);
    }
    return ok(members);
  }

  function rollupFor(row: GroupRow): Result<ManagedRunGroupRecord, Error> {
    const members = loadMembers(row.managed_run_group_id);
    if (!members.ok) return members;
    const rollup = deriveManagedRunGroupRollup({
      managedRunGroupId: row.managed_run_group_id,
      serviceInstanceId: row.service_instance_id,
      rootRunId: row.root_run_id,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      members: members.value,
    });
    return rollup.ok ? ok(rollup.value) : err(new Error(rollup.error.hint));
  }

  const prepareTransaction = db.transaction((
    input: ManagedRunGroupPrepareInput,
    admission?: { readonly maxActiveRuns: number },
  ): Result<ManagedRunGroupPrepareOutcome, Error> => {
    const inputHash = hashCanonical({
      managedRunGroupId: input.managedRunGroupId,
      serviceInstanceId: input.serviceInstanceId,
      rootRunId: input.rootRunId,
      createdAtMs: input.createdAtMs,
      members: input.members,
    });
    const prior = groupOperationMapper.parseOptionalRow(
      readOperation.get(input.managedRunGroupId, input.operationId),
    );
    if (!prior.ok) return err(new Error("managed-run group operation row is unreadable"));
    if (prior.value !== undefined) {
      if (prior.value.input_hash !== inputHash) return ok({ kind: "replay_conflict" });
      const existing = groupMapper.parseOptionalRow(readGroup.get(input.managedRunGroupId));
      if (!existing.ok) return err(new Error("managed-run group row is unreadable"));
      if (existing.value === undefined) {
        return err(new Error("recorded group preparation has no group record"));
      }
      const rollup = rollupFor(existing.value);
      return rollup.ok ? ok({ kind: "identical_replay", record: rollup.value }) : rollup;
    }

    // Every refusal that needs no database runs first, so an oversized or
    // wrong-scope preparation is turned away before it can spend one read per
    // member. The ceiling therefore lives in exactly one place — the derivation
    // — instead of being restated here where the two could drift apart.
    for (const member of input.members) {
      if (!validateManagedRunRecord(member).ok) {
        return ok({ kind: "scope_mismatch", managedRunId: member.managedRunId });
      }
    }
    const rollup = deriveManagedRunGroupRollup({
      managedRunGroupId: input.managedRunGroupId,
      serviceInstanceId: input.serviceInstanceId,
      rootRunId: input.rootRunId,
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
      members: input.members,
    });
    if (!rollup.ok) {
      if (rollup.error.kind === "membership_exceeds_ceiling") {
        return ok({ kind: "membership_exceeds_ceiling" });
      }
      const managedRunId = rollup.error.managedRunId;
      return ok(managedRunId === undefined
        ? { kind: "scope_mismatch" }
        : { kind: "scope_mismatch", managedRunId });
    }

    if (readGroup.get(input.managedRunGroupId) !== undefined) {
      // A different operation already minted this group id. Reusing it would
      // silently merge two preparations into one membership.
      return ok({ kind: "replay_conflict" });
    }
    for (const member of input.members) {
      if (readRun.get(member.managedRunId) !== undefined) {
        return ok({ kind: "member_conflict", managedRunId: member.managedRunId });
      }
    }
    if (admission !== undefined) {
      if (!Number.isInteger(admission.maxActiveRuns) || admission.maxActiveRuns < 1) {
        return err(new Error("managed-run group capacity admission is invalid"));
      }
      const current = activeCount.get(input.serviceInstanceId);
      if (typeof current !== "number") return err(new Error("managed-run active count is unreadable"));
      if (current + input.members.length > admission.maxActiveRuns) {
        return ok({ kind: "capacity_exceeded" });
      }
    }

    insertGroup.run(
      rollup.value.managedRunGroupId,
      rollup.value.serviceInstanceId,
      rollup.value.tenantId,
      rollup.value.agentId,
      rollup.value.principalId,
      rollup.value.conversationRef,
      rollup.value.rootRunId,
      rollup.value.createdAtMs,
      rollup.value.updatedAtMs,
    );
    for (const member of input.members) insertRun.run(...managedRunInsertValues(member));
    insertOperation.run(input.managedRunGroupId, input.operationId, inputHash, input.createdAtMs);
    return ok({ kind: "created", record: rollup.value });
  });

  return {
    prepareGroup(input, admission) {
      try {
        return Promise.resolve(prepareTransaction.immediate(input, admission));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },
    getGroup(scope: ManagedRunLookupScope, managedRunGroupId: string) {
      const parsedRow = groupMapper.parseOptionalRow(readGroup.get(managedRunGroupId));
      if (!parsedRow.ok) {
        return Promise.resolve(err(new Error("managed-run group row is unreadable")));
      }
      const row = parsedRow.value;
      if (row === undefined) return Promise.resolve(ok(undefined));
      const members = loadMembers(managedRunGroupId);
      if (!members.ok) return Promise.resolve(members);
      // Authority is decided on the MEMBERS, not on the group row. The group is
      // a projection of runs the caller may already read; it must never widen
      // that reach.
      const [anchor] = members.value;
      if (anchor === undefined || !scopeMatches(anchor, scope)) {
        return Promise.resolve(ok(undefined));
      }
      const rollup = rollupFor(row);
      return Promise.resolve(rollup.ok ? ok(rollup.value) : rollup);
    },
  };
}
