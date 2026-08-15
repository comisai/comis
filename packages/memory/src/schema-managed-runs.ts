// SPDX-License-Identifier: Apache-2.0
// @allow-throw: managed-run schema preflight rejects an incompatible authority table at the daemon database boundary.
import type Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

const REQUIRED_MANAGED_RUN_COLUMNS = [
  "managed_run_id",
  "service_instance_id",
  "activation_descriptor_digest",
  "tenant_id",
  "agent_id",
  "principal_id",
  "conversation_ref",
  "turn_scope",
  "trace_id",
  "status",
  "last_accepted_report_sequence",
  "last_reduced_report_sequence",
] as const;

const REQUIRED_WORKSPACE_LEASE_COLUMNS = ["filesystem_birthtime_ns"] as const;
const REQUIRED_EXECUTION_ATTACHMENT_COLUMNS = ["source_filesystem_birthtime_ns"] as const;
const REQUIRED_CONTINUATION_CLAIM_COLUMNS = ["reduction_outcome"] as const;
const REQUIRED_ATTENTION_OPERATION_COLUMNS = [
  "tenant_id",
  "agent_id",
  "principal_id",
  "conversation_ref",
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

  const existingWorkspaceLeases = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_leases'",
  ).get() !== undefined;
  if (existingWorkspaceLeases) {
    const columns = new Set(requireTableInfoRows(
      db.prepare("PRAGMA table_info(workspace_leases)").all(),
      "workspace_leases",
    ).map((row) => row.name));
    const missing = REQUIRED_WORKSPACE_LEASE_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `workspace_leases database schema is incompatible: missing ${missing.join(", ")}. Back up the database, then recreate it with the current Comis schema.`,
      );
    }
  }

  const existingExecutionAttachments = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_attachments'",
  ).get() !== undefined;
  if (existingExecutionAttachments) {
    const columns = new Set(requireTableInfoRows(
      db.prepare("PRAGMA table_info(execution_attachments)").all(),
      "execution_attachments",
    ).map((row) => row.name));
    const missing = REQUIRED_EXECUTION_ATTACHMENT_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `execution_attachments database schema is incompatible: missing ${missing.join(", ")}. Back up the database, then recreate it with the current Comis schema.`,
      );
    }
  }

  const existingContinuationClaims = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_run_continuation_claims'",
  ).get() !== undefined;
  if (existingContinuationClaims) {
    const columns = new Set(requireTableInfoRows(
      db.prepare("PRAGMA table_info(managed_run_continuation_claims)").all(),
      "managed_run_continuation_claims",
    ).map((row) => row.name));
    const missing = REQUIRED_CONTINUATION_CLAIM_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `managed_run_continuation_claims database schema is incompatible: missing ${missing.join(", ")}. Back up the database, then recreate it with the current Comis schema.`,
      );
    }
  }

  const existingAttentionOperations = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_run_attention_operations'",
  ).get() !== undefined;
  if (existingAttentionOperations) {
    const columns = new Set(requireTableInfoRows(
      db.prepare("PRAGMA table_info(managed_run_attention_operations)").all(),
      "managed_run_attention_operations",
    ).map((row) => row.name));
    const missing = REQUIRED_ATTENTION_OPERATION_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `managed_run_attention_operations database schema is incompatible: missing ${missing.join(", ")}. Back up the database, then recreate it with the current Comis schema.`,
      );
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_runs (
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      managed_run_id TEXT PRIMARY KEY NOT NULL,
      service_instance_id TEXT NOT NULL,
      external_run_ref_digest TEXT NOT NULL,
      activation_descriptor_digest TEXT NOT NULL,
      activation_descriptor_ref TEXT,
      display_label TEXT,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      turn_scope TEXT NOT NULL,
      delivery_origin TEXT NOT NULL,
      trace_id TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_managed_runs_external_ref
      ON managed_runs (
        external_run_ref_digest, service_instance_id, tenant_id, agent_id,
        principal_id, conversation_ref
      );
    CREATE INDEX IF NOT EXISTS idx_managed_runs_recovery
      ON managed_runs (status, updated_at_ms);

    CREATE TABLE IF NOT EXISTS workspace_leases (
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      workspace_lease_id TEXT PRIMARY KEY NOT NULL,
      managed_run_id TEXT NOT NULL UNIQUE REFERENCES managed_runs(managed_run_id),
      service_instance_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      canonical_path TEXT NOT NULL,
      filesystem_device INTEGER NOT NULL CHECK(filesystem_device >= 0),
      filesystem_inode INTEGER NOT NULL CHECK(filesystem_inode >= 0),
      filesystem_birthtime_ns TEXT NOT NULL CHECK(
        length(filesystem_birthtime_ns) BETWEEN 1 AND 20
        AND filesystem_birthtime_ns NOT GLOB '*[^0-9]*'
        AND substr(filesystem_birthtime_ns, 1, 1) <> '0'
      ),
      state TEXT NOT NULL CHECK(state IN ('active','released')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_recovered_at_ms INTEGER,
      released_at_ms INTEGER,
      release_disposition TEXT CHECK(release_disposition IN ('reap_safe','preserve'))
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_leases_recovery
      ON workspace_leases (state, updated_at_ms, workspace_lease_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_leases_active_path
      ON workspace_leases (canonical_path) WHERE state = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_leases_active_filesystem_identity
      ON workspace_leases (
        filesystem_device, filesystem_inode, filesystem_birthtime_ns
      ) WHERE state = 'active';

    CREATE TABLE IF NOT EXISTS execution_attachments (
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      execution_attachment_id TEXT PRIMARY KEY NOT NULL,
      managed_run_id TEXT NOT NULL REFERENCES managed_runs(managed_run_id),
      workspace_lease_id TEXT NOT NULL REFERENCES workspace_leases(workspace_lease_id),
      service_instance_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind = 'unix_socket'),
      source_path TEXT NOT NULL,
      source_filesystem_type TEXT NOT NULL CHECK(source_filesystem_type = 'socket'),
      source_filesystem_device INTEGER NOT NULL CHECK(source_filesystem_device >= 0),
      source_filesystem_inode INTEGER NOT NULL CHECK(source_filesystem_inode >= 0),
      source_filesystem_birthtime_ns TEXT NOT NULL CHECK(
        length(source_filesystem_birthtime_ns) BETWEEN 1 AND 20
        AND source_filesystem_birthtime_ns NOT GLOB '*[^0-9]*'
        AND substr(source_filesystem_birthtime_ns, 1, 1) <> '0'
      ),
      target_name TEXT NOT NULL,
      access TEXT NOT NULL CHECK(access = 'connect_only'),
      state TEXT NOT NULL CHECK(state IN ('active','revoked')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_recovered_at_ms INTEGER,
      revoked_at_ms INTEGER,
      revocation_reason TEXT CHECK(revocation_reason IN ('lease_release','authority_revoked','recovery_mismatch'))
    );
    CREATE INDEX IF NOT EXISTS idx_execution_attachments_run
      ON execution_attachments (managed_run_id, workspace_lease_id, state, execution_attachment_id);
    CREATE INDEX IF NOT EXISTS idx_execution_attachments_recovery
      ON execution_attachments (state, updated_at_ms, execution_attachment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_attachments_active_source
      ON execution_attachments (source_path) WHERE state = 'active';

    CREATE TABLE IF NOT EXISTS execution_attachment_operations (
      execution_attachment_id TEXT NOT NULL REFERENCES execution_attachments(execution_attachment_id),
      operation_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('revoke','reconcile')),
      input_hash TEXT NOT NULL,
      result_record TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (execution_attachment_id, operation_id, operation_kind)
    );

    CREATE TABLE IF NOT EXISTS workspace_lease_operations (
      workspace_lease_id TEXT NOT NULL REFERENCES workspace_leases(workspace_lease_id),
      operation_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('release','reconcile')),
      input_hash TEXT NOT NULL,
      result_record TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (workspace_lease_id, operation_id, operation_kind)
    );

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

    CREATE TABLE IF NOT EXISTS managed_run_evidence (
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      service_instance_id TEXT NOT NULL,
      managed_run_id TEXT NOT NULL REFERENCES managed_runs(managed_run_id),
      evidence_ref TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_digest TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER,
      content_ref TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      private_content_hash TEXT NOT NULL,
      verification_level TEXT NOT NULL CHECK(verification_level IN ('reported','adapter_verified','host_verified')),
      delivery_kind TEXT NOT NULL CHECK(delivery_kind IN ('none','reference','attachment')),
      received_at_ms INTEGER NOT NULL,
      PRIMARY KEY (service_instance_id, evidence_ref),
      UNIQUE (managed_run_id, evidence_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_managed_run_evidence_run
      ON managed_run_evidence (managed_run_id, evidence_ref);

    CREATE TABLE IF NOT EXISTS managed_run_attention (
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      attention_id TEXT PRIMARY KEY NOT NULL,
      managed_run_id TEXT NOT NULL REFERENCES managed_runs(managed_run_id),
      service_instance_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      external_key TEXT,
      report_sequence INTEGER NOT NULL CHECK(report_sequence > 0),
      attention_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','response_pending','delivered','resolved','cancelled','expired')),
      response_ref TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_run_attention_external
      ON managed_run_attention (managed_run_id, external_key)
      WHERE external_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_managed_run_attention_open
      ON managed_run_attention (tenant_id, agent_id, principal_id, conversation_ref, status, created_at_ms);

    CREATE TABLE IF NOT EXISTS managed_run_attention_operations (
      attention_id TEXT NOT NULL REFERENCES managed_run_attention(attention_id),
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('response','delivery')),
      input_hash TEXT NOT NULL,
      result_record TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (attention_id, operation_id, operation_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_managed_run_attention_operation_lookup
      ON managed_run_attention_operations (operation_id, operation_kind, attention_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_run_attention_owner_response_operation
      ON managed_run_attention_operations (
        tenant_id, agent_id, principal_id, conversation_ref, operation_id
      ) WHERE operation_kind = 'response';

    CREATE TABLE IF NOT EXISTS managed_run_operations (
      managed_run_id TEXT NOT NULL REFERENCES managed_runs(managed_run_id),
      operation_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('transition','revoke')),
      input_hash TEXT NOT NULL,
      result_record TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (managed_run_id, operation_id, operation_kind)
    );

    CREATE TABLE IF NOT EXISTS managed_run_release_reservations (
      managed_run_id TEXT PRIMARY KEY NOT NULL REFERENCES managed_runs(managed_run_id),
      operation_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      result_record TEXT NOT NULL,
      reserved_at_ms INTEGER NOT NULL
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
      reduction_outcome TEXT CHECK(reduction_outcome IN ('completed','failed','abandoned')),
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
