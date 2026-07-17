// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

/**
 * Add structured delivery-failure provenance to an existing observability DB.
 * Both columns are nullable: NULL means the historical row did not record the
 * failing boundary or classification.
 */
export function ensureObsDeliveryColumns(db: Database.Database): void {
  const cols = new Set(
    requireTableInfoRows(db.prepare(`PRAGMA table_info(obs_delivery)`).all(), "obs_delivery")
      .map((row) => row.name),
  );
  if (!cols.has("failure_stage")) {
    db.exec(`ALTER TABLE obs_delivery ADD COLUMN failure_stage TEXT`);
  }
  if (!cols.has("error_kind")) {
    db.exec(`ALTER TABLE obs_delivery ADD COLUMN error_kind TEXT`);
  }
}
