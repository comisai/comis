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
import type {
  ManagedRunAdministrationListInput,
  ManagedRunRecord,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { ManagedRunDbRowSchema } from "./managed-run-row-schema.js";
import { rowToManagedRunRecord } from "./managed-run-store-record.js";
import { createRowMapper } from "./row-mapper.js";

const runMapper = createRowMapper(ManagedRunDbRowSchema);

export interface ManagedRunAdministrationReads {
  listRuns(input: ManagedRunAdministrationListInput): Result<ManagedRunRecord[], Error>;
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
  };
}
