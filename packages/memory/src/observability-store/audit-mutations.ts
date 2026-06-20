// SPDX-License-Identifier: Apache-2.0
/**
 * Security-audit sink helpers (AUDIT-01) — the only genuinely-new machinery in
 * Phase 176. Composes TWO existing analogs rather than inventing storage:
 *
 *   1. **SQLite half** (mirrors `observability-mutations.ts`): `insertAuditEvent`
 *      / `queryAuditEvents` over the dedicated `obs_audit_events` table
 *      (DDL + indexes shipped by Plan 01 via `ensureObsAuditTable`). Bound
 *      params only — `refs` is a `JSON.stringify`'d scrubbed blob, never
 *      interpolated SQL (T-176-12).
 *
 *   2. **JSONL half** (clones `@comis/observability` `config-audit/append.ts`):
 *      `appendAuditJsonl` writes one scrubbed JSON line per event to
 *      `~/.comis/logs/security-audit.jsonl` via the verified-good
 *      `ensureConfigAuditParentDir` → `rotateConfigAuditLogIfNeeded` →
 *      `appendRegularFile` pipeline (0700 dir / 0600 file, symlink-safe,
 *      defensive `fchmodSync(fd, 0o600)`). The rotation cap rides the EXISTING
 *      `observability.logRotation` policy (the 6th stream — no per-sink knob);
 *      the caller passes `{rotateAtBytes, keepRotated}` from it. The two-phase
 *      `createBase`/`finalize` split is deliberately NOT cloned — audit is
 *      single-shot: one event → one sanitize → one line + one row.
 *
 * The `secret:accessed` row carries `secretName` + `outcome` and NEVER a value
 * — structurally, because the source payload is value-free (events-infra.ts).
 *
 * @module
 */

import type Database from "better-sqlite3";
import {
  appendRegularFile,
  rotateConfigAuditLogIfNeeded,
  ensureConfigAuditParentDir,
} from "@comis/observability";
import type {
  ObservabilityStore,
  AuditEventRow,
  AuditQueryParams,
} from "./observability-store-types.js";

// AuditQueryParams is declared in observability-store-types.ts (beside the
// ObservabilityStore interface that consumes it) to avoid a types↔impl `.d.ts`
// import cycle. Re-exported here for the barrel + ergonomic co-location.
export type { AuditQueryParams } from "./observability-store-types.js";

/** Default audit-query row cap (bounded reports — GBIII I2). */
export const DEFAULT_AUDIT_QUERY_LIMIT = 200;
/** Hard ceiling so a pathological `limit` can never unbound the scan. */
export const MAX_AUDIT_QUERY_LIMIT = 1000;

/** Shape of the audit slice of ObservabilityStore implemented here. */
export type AuditMutations = Pick<ObservabilityStore, "insertAuditEvent" | "queryAuditEvents">;

/** Raw snake_case row read back from `obs_audit_events`. */
interface AuditEventDbRow {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  ts: number;
  kind: string;
  classification: string | null;
  action: string | null;
  actor: string | null;
  outcome: string | null;
  severity: string | null;
  trace_id: string | null;
  refs: string | null;
}

function auditEventFromRow(r: AuditEventDbRow): AuditEventRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    ts: r.ts,
    kind: r.kind,
    classification: r.classification,
    action: r.action,
    actor: r.actor,
    outcome: r.outcome,
    severity: r.severity,
    traceId: r.trace_id,
    refs: r.refs,
  };
}

/**
 * Prepare the audit insert/query statements and return the audit slice of the
 * ObservabilityStore handle. Composed into `createObservabilityStore`.
 *
 * @param db - An open better-sqlite3 Database with `obs_audit_events` initialized.
 */
export function bindAuditMutations(db: Database.Database): AuditMutations {
  // Fixed INSERT — bound params only; refs is a pre-scrubbed JSON string.
  const insertStmt = db.prepare(`
    INSERT INTO obs_audit_events (
      id, tenant_id, agent_id, ts, kind, classification,
      action, actor, outcome, severity, trace_id, refs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function insertAuditEvent(row: AuditEventRow): void {
    insertStmt.run(
      row.id,
      row.tenantId,
      row.agentId,
      row.ts,
      row.kind,
      row.classification,
      row.action,
      row.actor,
      row.outcome,
      row.severity,
      row.traceId,
      row.refs,
    );
  }

  function queryAuditEvents(params: AuditQueryParams): AuditEventRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.kind != null) {
      conditions.push("kind = ?");
      values.push(params.kind);
    }
    if (params.classification != null) {
      conditions.push("classification = ?");
      values.push(params.classification);
    }
    if (params.agentId != null) {
      conditions.push("agent_id = ?");
      values.push(params.agentId);
    }
    if (params.tenant != null) {
      conditions.push("tenant_id = ?");
      values.push(params.tenant);
    }
    if (params.outcome != null) {
      conditions.push("outcome = ?");
      values.push(params.outcome);
    }
    if (params.since != null) {
      conditions.push("ts >= ?");
      values.push(params.since);
    }
    if (params.until != null) {
      conditions.push("ts <= ?");
      values.push(params.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Clamp the row cap so a pathological caller can never unbound the scan.
    const requested = params.limit ?? DEFAULT_AUDIT_QUERY_LIMIT;
    const limit = Math.max(1, Math.min(requested, MAX_AUDIT_QUERY_LIMIT));
    const sql = `SELECT * FROM obs_audit_events ${where} ORDER BY ts DESC LIMIT ?`;
    values.push(limit);

    const raw = db.prepare(sql).all(...values) as AuditEventDbRow[];
    return raw.map(auditEventFromRow);
  }

  return { insertAuditEvent, queryAuditEvents };
}

/** Input to {@link appendAuditJsonl}. */
export interface AppendAuditJsonlParams {
  /** Absolute path to the audit JSONL (default `~/.comis/logs/security-audit.jsonl`). */
  filePath: string;
  /** The already-scrubbed record to serialize as one line (NEVER raw metadata). */
  record: object;
  /** Rotation cap in bytes — pull from `observability.logRotation.maxSizeBytes`. */
  rotateAtBytes: number;
  /** Rotated-file count — pull from `observability.logRotation.maxFiles`. */
  keepRotated: number;
  /** Real-path confinement base (production: `getDefaultConfigAuditConfinedBase()`); tests omit it. */
  confinedBaseDir?: string;
}

/** The default audit-log path under the data dir. */
export const SECURITY_AUDIT_LOG_BASENAME = "security-audit.jsonl";

/**
 * Append one scrubbed audit record as a JSON line to `security-audit.jsonl`,
 * reusing the config-audit rotation/append pipeline (0600 file, 0700 dir,
 * symlink-safe). Single-shot — the record MUST already be sanitized by the
 * caller (the sink routes `audit:event.metadata` through `sanitizeForPersistence`
 * before calling here). Throws nothing the caller cannot catch: a write failure
 * surfaces via the thrown append error, which the daemon subscriber try/catches
 * (the SQLite half still drains).
 */
export function appendAuditJsonl(params: AppendAuditJsonlParams): void {
  const line = JSON.stringify(params.record) + "\n";
  const bytes = Buffer.byteLength(line, "utf8");

  ensureConfigAuditParentDir(params.filePath);
  rotateConfigAuditLogIfNeeded(params.filePath, bytes, params.rotateAtBytes, params.keepRotated);

  const result = appendRegularFile({
    path: params.filePath,
    content: line,
    ...(params.confinedBaseDir !== undefined ? { confinedBaseDir: params.confinedBaseDir } : {}),
  });
  if (!result.ok) {
    throw new Error(`Failed to append security-audit record: ${result.error.message}`);
  }
}
