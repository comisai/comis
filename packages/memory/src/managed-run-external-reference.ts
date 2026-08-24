// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ManagedRunOwnerScope, ManagedRunRecord } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { ManagedRunDbRowSchema } from "./managed-run-row-schema.js";
import { rowToManagedRunRecord, scopeMatches } from "./managed-run-store-record.js";
import { createRowMapper } from "./row-mapper.js";

const runMapper = createRowMapper(ManagedRunDbRowSchema);

export interface ManagedRunExternalReferenceLookup {
  get(
    scope: ManagedRunOwnerScope,
    serviceInstanceId: string,
    externalRunRef: string,
    availability: "active" | "released",
  ): Result<ManagedRunRecord | undefined, Error>;
}

/** Prepare the exact owner-scoped external-reference lookup. */
export function createManagedRunExternalReferenceLookup(
  db: Database.Database,
): ManagedRunExternalReferenceLookup {
  const selectRun = db.prepare(`
    SELECT runs.* FROM managed_runs AS runs
    WHERE runs.external_run_ref_digest = ?
      AND runs.service_instance_id = ?
      AND runs.tenant_id = ?
      AND runs.agent_id = ?
      AND runs.principal_id = ?
      AND runs.conversation_ref = ?
      AND EXISTS (
        SELECT 1 FROM managed_run_release_reservations AS reservation
        WHERE reservation.managed_run_id = runs.managed_run_id
      ) = ?
    LIMIT 2
  `);

  return {
    get: (scope, serviceInstanceId, externalRunRef, availability) => {
      if (
        serviceInstanceId.length === 0
        || serviceInstanceId.length > 256
        || externalRunRef.length === 0
        || externalRunRef.length > 256
        || (availability !== "active" && availability !== "released")
      ) return err(new Error("managed-run external reference lookup is invalid"));
      const digest = createHash("sha256").update(externalRunRef, "utf8").digest("hex");
      const rows = runMapper.parseRows(selectRun.all(
        digest,
        serviceInstanceId,
        scope.tenantId,
        scope.agentId,
        scope.principalId,
        scope.conversationRef,
        availability === "released" ? 1 : 0,
      ));
      if (!rows.ok) return err(new Error(rows.error.message));
      if (rows.value.length > 1) {
        return err(new Error("managed-run external reference is ambiguous in the owner scope"));
      }
      const row = rows.value[0];
      if (row === undefined) return ok(undefined);
      const record = rowToManagedRunRecord(row);
      if (!record.ok) return record;
      return record.value.serviceInstanceId === serviceInstanceId && scopeMatches(record.value, scope)
        ? ok(record.value)
        : ok(undefined);
    },
  };
}
