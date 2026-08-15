// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type {
  InvalidManagedRunRecord,
  ManagedRunRecord,
  ManagedRunRecoveryScan,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { ManagedRunDbRowSchema } from "./managed-run-row-schema.js";
import { rowToManagedRunRecord } from "./managed-run-store-record.js";
import { createRowMapper } from "./row-mapper.js";

const runMapper = createRowMapper(ManagedRunDbRowSchema);
const recoveryIdentitySchema = z.object({
  managed_run_id: z.string(),
  service_instance_id: z.string(),
});

export function mapManagedRunRecoveryRows(
  rawRows: readonly unknown[],
  limit: number,
): Result<ManagedRunRecoveryScan, Error> {
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
  const lastIdentity = rawRows.length === 0
    ? undefined
    : recoveryIdentitySchema.safeParse(rawRows.at(-1));
  if (lastIdentity !== undefined && !lastIdentity.success) {
    return err(new Error("recoverable managed-run row lacks stable identity"));
  }
  return ok({
    records,
    invalid,
    ...(rawRows.length === limit && lastIdentity?.success
      ? { nextAfterManagedRunId: lastIdentity.data.managed_run_id }
      : {}),
  });
}
