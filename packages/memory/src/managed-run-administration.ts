// SPDX-License-Identifier: Apache-2.0
/**
 * The scope-free operator reads over managed runs.
 *
 * They live apart from the scoped store on purpose. Every other read in that
 * module is bound to one tenant, agent, principal, and conversation, and the
 * value of that constraint is that it is not optional. Keeping the cross-scope
 * query in its own module means adding a filter here can never accidentally
 * relax the scoped path, and a reviewer can see the whole unscoped surface at
 * once instead of hunting for it among conversation-bound queries.
 *
 * @module
 */
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ManagedRunStatusSchema,
  type ManagedRunAdministrationListInput,
  type ManagedRunHealthCountInput,
  type ManagedRunHealthCounts,
  type ManagedRunLinkage,
  type ManagedRunLinkageInput,
  type ManagedRunRecord,
  type ManagedRunStatus,
  type ManagedRunStatusReason,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { ManagedRunDbRowSchema } from "./managed-run-row-schema.js";
import { rowToManagedRunRecord } from "./managed-run-store-record.js";
import { createRowMapper } from "./row-mapper.js";

const runMapper = createRowMapper(ManagedRunDbRowSchema);
const statusCountMapper = createRowMapper(z.strictObject({ status: z.string(), c: z.number() }));
const reasonCountMapper = createRowMapper(z.strictObject({ reason: z.string(), c: z.number() }));
const scalarCountMapper = createRowMapper(z.strictObject({ c: z.number() }));
const worstIdMapper = createRowMapper(z.strictObject({ managed_run_id: z.string() }));
const linkageMapper = createRowMapper(z.strictObject({
  managed_run_id: z.string(),
  service_instance_id: z.string(),
  status: z.string(),
  status_reason: z.string(),
  trace_id: z.string(),
}));

/**
 * The statuses that mean a run needs attention. A cancelled run is an intended
 * outcome, not degradation; failed and uncertain are the two that an operator is
 * asking about when they read system health.
 */
const DEGRADED_STATUSES = Object.freeze(["failed", "unknown"] as const);
const DEGRADED_STATUS_LIST = DEGRADED_STATUSES.map((status) => `'${status}'`).join(", ");

export interface ManagedRunAdministrationReads {
  listRuns(input: ManagedRunAdministrationListInput): Result<ManagedRunRecord[], Error>;
  countByStatus(input: ManagedRunHealthCountInput): Result<ManagedRunHealthCounts, Error>;
  countActiveByService(serviceInstanceId: string): Result<number, Error>;
  listByTraceIds(input: ManagedRunLinkageInput): Result<ManagedRunLinkage[], Error>;
}

/** Prepare the cross-scope operator statements against one open database. */
export function createManagedRunAdministrationReads(
  db: Database.Database,
): ManagedRunAdministrationReads {
  // Filters are all optional so an operator can start from every run this
  // daemon holds and narrow from there; ordering is most-recently-updated first
  // because that is the run they are almost always asking about.
  const listRows = db.prepare(`
    SELECT * FROM managed_runs
    WHERE (? IS NULL OR service_instance_id = ?)
      AND (? IS NULL OR agent_id = ?)
      AND (json_array_length(?) = 0 OR status IN (SELECT value FROM json_each(?)))
    ORDER BY updated_at_ms DESC, managed_run_id ASC
    LIMIT ?
  `);
  // Aggregate reads for the system-health digest. They read the same index the
  // list read does, windowed on update time, but return only counts and closed
  // enums so a system-wide report never carries a run body.
  const statusCountRows = db.prepare(`
    SELECT status, COUNT(*) AS c FROM managed_runs
    WHERE updated_at_ms >= ?
    GROUP BY status
  `);
  const degradedReasonRows = db.prepare(`
    SELECT status_reason AS reason, COUNT(*) AS c FROM managed_runs
    WHERE updated_at_ms >= ? AND status IN (${DEGRADED_STATUS_LIST})
    GROUP BY status_reason
  `);
  const distinctServiceRow = db.prepare(`
    SELECT COUNT(DISTINCT service_instance_id) AS c FROM managed_runs
    WHERE updated_at_ms >= ?
  `);
  const degradedServiceRow = db.prepare(`
    SELECT COUNT(DISTINCT service_instance_id) AS c FROM managed_runs
    WHERE updated_at_ms >= ? AND status IN (${DEGRADED_STATUS_LIST})
  `);
  const worstDegradedRow = db.prepare(`
    SELECT managed_run_id FROM managed_runs
    WHERE updated_at_ms >= ? AND status IN (${DEGRADED_STATUS_LIST})
    ORDER BY updated_at_ms DESC, managed_run_id ASC
    LIMIT 1
  `);
  // Active-concurrency count for one service: every run that has not reached a
  // terminal status. The activation coordinator reads this scalar to admit or
  // refuse a new run against the service's declared concurrency ceiling.
  const activeCountRow = db.prepare(`
    SELECT COUNT(*) AS c FROM managed_runs
    WHERE service_instance_id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')
  `);
  // Session→run linkage: the managed runs whose prepare-time trace is one of the
  // traces a session's trajectory ran. Content-free projection — ids, closed
  // enums, and the linking trace only.
  const linkageRows = db.prepare(`
    SELECT managed_run_id, service_instance_id, status, status_reason, trace_id
    FROM managed_runs
    WHERE trace_id IN (SELECT value FROM json_each(?))
    ORDER BY updated_at_ms DESC, managed_run_id ASC
    LIMIT ?
  `);

  return {
    listRuns: (input) => {
      if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 10_000) {
        return err(new Error("managed-run administration list limit is invalid"));
      }
      const statuses = JSON.stringify(input.statuses ?? []);
      const rows = runMapper.parseRows(listRows.all(
        input.serviceInstanceId ?? null,
        input.serviceInstanceId ?? null,
        input.agentId ?? null,
        input.agentId ?? null,
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
    },
    countByStatus: (input) => {
      if (!Number.isInteger(input.updatedSinceMs) || input.updatedSinceMs < 0) {
        return err(new Error("managed-run health count window is invalid"));
      }
      const since = input.updatedSinceMs;
      const statusRows = statusCountMapper.parseRows(statusCountRows.all(since));
      if (!statusRows.ok) return err(new Error(statusRows.error.message));
      const reasonRows = reasonCountMapper.parseRows(degradedReasonRows.all(since));
      if (!reasonRows.ok) return err(new Error(reasonRows.error.message));
      const distinct = scalarCountMapper.parseRows(distinctServiceRow.all(since));
      if (!distinct.ok) return err(new Error(distinct.error.message));
      const degradedServices = scalarCountMapper.parseRows(degradedServiceRow.all(since));
      if (!degradedServices.ok) return err(new Error(degradedServices.error.message));
      const worst = worstIdMapper.parseRows(worstDegradedRow.all(since));
      if (!worst.ok) return err(new Error(worst.error.message));

      const byStatus = Object.fromEntries(
        ManagedRunStatusSchema.options.map((status) => [status, 0]),
      ) as Record<ManagedRunStatus, number>;
      for (const row of statusRows.value) {
        if (row.status in byStatus) byStatus[row.status as ManagedRunStatus] = row.c;
      }
      const degradedReasonCodes: Record<string, number> = {};
      for (const row of reasonRows.value) degradedReasonCodes[row.reason] = row.c;
      const worstManagedRunId = worst.value[0]?.managed_run_id;

      return ok({
        byStatus,
        degradedReasonCodes,
        distinctServiceInstances: distinct.value[0]?.c ?? 0,
        degradedServiceInstances: degradedServices.value[0]?.c ?? 0,
        ...(worstManagedRunId === undefined ? {} : { worstManagedRunId }),
      });
    },
    countActiveByService: (serviceInstanceId) => {
      if (serviceInstanceId.length === 0 || serviceInstanceId.length > 256) {
        return err(new Error("managed-run active-count service instance id is invalid"));
      }
      const rows = scalarCountMapper.parseRows(activeCountRow.all(serviceInstanceId));
      if (!rows.ok) return err(new Error(rows.error.message));
      return ok(rows.value[0]?.c ?? 0);
    },
    listByTraceIds: (input) => {
      if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 10_000) {
        return err(new Error("managed-run linkage limit is invalid"));
      }
      if (input.traceIds.length === 0) return ok([]);
      const rows = linkageMapper.parseRows(
        linkageRows.all(JSON.stringify([...input.traceIds]), input.limit),
      );
      if (!rows.ok) return err(new Error(rows.error.message));
      return ok(rows.value.map((row) => ({
        managedRunId: row.managed_run_id,
        serviceInstanceId: row.service_instance_id,
        status: row.status as ManagedRunStatus,
        statusReason: row.status_reason as ManagedRunStatusReason,
        traceId: row.trace_id,
      })));
    },
  };
}
