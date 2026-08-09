// SPDX-License-Identifier: Apache-2.0
// @allow-throw: managed-run schema preflight rejects an incompatible authority table at the daemon database boundary.
import type Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

const REQUIRED_MANAGED_RUN_COLUMNS = [
  "managed_run_id",
  "service_instance_id",
  "tenant_id",
  "agent_id",
  "principal_id",
  "conversation_ref",
  "turn_scope",
  "status",
  "last_accepted_report_sequence",
  "last_reduced_report_sequence",
] as const;

/** Create the content-free managed-run authority, report, claim, and replay tables. */
export function ensureManagedRunTables(db: Database.Database): void {
  const existing = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_runs'",
  ).get() !== undefined;
  if (existing) {
    const columns = new Set(requireTableInfoRows(
      db.prepare("PRAGMA table_info(managed_runs)").all(),
      "managed_runs",
    ).map((row) => row.name));
    const missing = REQUIRED_MANAGED_RUN_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `managed_runs database schema is incompatible: missing ${missing.join(", ")}. Back up the database, then recreate it with the current Comis schema.`,
      );
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_runs (
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      managed_run_id TEXT PRIMARY KEY NOT NULL,
      service_instance_id TEXT NOT NULL,
      external_run_ref_digest TEXT NOT NULL,
      activation_descriptor_ref TEXT,
      display_label TEXT,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      turn_scope TEXT NOT NULL,
      delivery_origin TEXT NOT NULL,
      trust_level TEXT NOT NULL CHECK(trust_level IN ('admin','user','guest')),
      response_locale_policy TEXT NOT NULL,
      workspace_policy_hash TEXT NOT NULL,
      root_run_id TEXT NOT NULL,
      initiation_source TEXT NOT NULL CHECK(initiation_source IN ('user_request','schedule','service_event')),
      ingress_profile_id TEXT,
      ingress_event_digest TEXT,
      managed_run_group_id TEXT,
      parent_managed_run_id TEXT,
      captured_agent_capabilities TEXT NOT NULL,
      captured_tool_ids TEXT NOT NULL,
      captured_capability_view_hash TEXT NOT NULL,
      workspace_lease_id TEXT,
      execution_attachment_ids TEXT NOT NULL,
      terminal_session_ids TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('preparing','active','waiting','paused','candidate_complete','succeeded','failed','cancelled','unknown')),
      status_reason TEXT NOT NULL,
      last_accepted_report_sequence INTEGER NOT NULL CHECK(last_accepted_report_sequence >= 0),
      last_reduced_report_sequence INTEGER NOT NULL CHECK(last_reduced_report_sequence >= 0),
      pending_continuation INTEGER NOT NULL CHECK(pending_continuation IN (0,1)),
      open_attention_count INTEGER NOT NULL CHECK(open_attention_count >= 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_heartbeat_at_ms INTEGER,
      terminal_outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_managed_runs_owner
      ON managed_runs (tenant_id, agent_id, principal_id, conversation_ref, updated_at_ms);
    CREATE INDEX IF NOT EXISTS idx_managed_runs_service
      ON managed_runs (service_instance_id, updated_at_ms);
    CREATE INDEX IF NOT EXISTS idx_managed_runs_recovery
      ON managed_runs (status, updated_at_ms);

    CREATE TABLE IF NOT EXISTS managed_run_reports (
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      service_instance_id TEXT NOT NULL,
      managed_run_id TEXT NOT NULL REFERENCES managed_runs(managed_run_id),
      service_report_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      kind TEXT NOT NULL CHECK(kind IN ('attention','blocked','candidate_complete','failed','paused','progress','resolution')),
      content_ref TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL,
      retained_until_ms INTEGER NOT NULL,
      observed_at_ms INTEGER,
      PRIMARY KEY (service_instance_id, service_report_id),
      UNIQUE (managed_run_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_managed_run_reports_reduce
      ON managed_run_reports (managed_run_id, sequence);

    CREATE TABLE IF NOT EXISTS managed_run_operations (
      managed_run_id TEXT NOT NULL REFERENCES managed_runs(managed_run_id),
      operation_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('transition','revoke')),
      input_hash TEXT NOT NULL,
      result_record TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (managed_run_id, operation_id, operation_kind)
    );

    CREATE TABLE IF NOT EXISTS managed_run_continuation_claims (
      claim_id TEXT PRIMARY KEY NOT NULL,
      managed_run_id TEXT NOT NULL REFERENCES managed_runs(managed_run_id),
      claim_hash TEXT NOT NULL,
      through_report_sequence INTEGER NOT NULL CHECK(through_report_sequence >= 0),
      state TEXT NOT NULL CHECK(state IN ('active','completed','failed','abandoned')),
      claimed_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      claim_result_record TEXT NOT NULL,
      reduction_hash TEXT,
      reduction_result_record TEXT,
      outcome_hash TEXT,
      outcome_result_record TEXT,
      outcome_recorded_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_managed_run_continuation_active
      ON managed_run_continuation_claims (managed_run_id, state, expires_at_ms);

    CREATE TABLE IF NOT EXISTS managed_run_content_index (
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      managed_run_id TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('activation','report','evidence','attention')),
      content_hash TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
      relative_path TEXT NOT NULL,
      expires_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, agent_id, managed_run_id, content_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_managed_run_content_expiry
      ON managed_run_content_index (expires_at_ms)
      WHERE expires_at_ms IS NOT NULL;
  `);
}
