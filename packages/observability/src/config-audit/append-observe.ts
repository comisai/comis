// SPDX-License-Identifier: Apache-2.0
/**
 * Config-OBSERVE audit record writer (read-side counterpart to
 * `append.ts`'s write-side helpers).
 *
 * Two entry points (RED stub — not implemented yet):
 *
 *   - `createConfigObserveAuditRecord(...)` — produce a fully-formed
 *     `ConfigObserveAuditRecord` for a single config-read event.
 *
 *   - `appendConfigObserveAuditRecord(...)` — pipe the record through
 *     the same `appendRegularFile` + rotation chassis the write-side
 *     uses, persisting one JSONL line to
 *     `~/.comis/logs/config-audit.jsonl`.
 *
 * This module exists to close OBS-REVIEW-03: the daemon's bootstrap
 * config-read path produces no audit record today, so operators
 * cannot reconstruct "what config was read at boot" from audit logs
 * alone. With this writer + the daemon-side wiring, every resolved
 * `configPaths[i]` entry produces one observe record on every
 * bootstrap.
 *
 * @module
 */

import type { ConfigObserveAuditRecord } from "./types.js";

/** Input to `createConfigObserveAuditRecord`. */
export interface CreateObserveRecordParams {
  /** Absolute filesystem path of the config file that was observed. */
  readonly filePath: string;
  /** Caller-source identifier (e.g. "daemon-bootstrap", "cli-config-show"). */
  readonly callerSource: string;
}

/** Input to `appendConfigObserveAuditRecord`. */
export interface AppendObserveRecordParams {
  /** Full path of the audit-log file (typically resolved via `resolveConfigAuditLogPath`). */
  readonly filePath: string;
  /** The record to append. */
  readonly record: ConfigObserveAuditRecord;
  /** Optional confinement base forwarded to `appendRegularFile`. */
  readonly confinedBaseDir?: string;
  /** Optional rotation cap (defaults to `DEFAULT_ROTATE_AT_BYTES`). */
  readonly rotateAtBytes?: number;
  /** Optional rotation retention count (defaults to `DEFAULT_KEEP_ROTATED`). */
  readonly keepRotated?: number;
}

/**
 * RED STUB — see `append-observe.test.ts` for the contract.
 * Throws by design until the GREEN implementation lands.
 */
export function createConfigObserveAuditRecord(
  _params: CreateObserveRecordParams,
): ConfigObserveAuditRecord {
  throw new Error(
    "createConfigObserveAuditRecord: not implemented yet (RED stub)",
  );
}

/**
 * RED STUB — see `append-observe.test.ts` for the contract.
 * Throws by design until the GREEN implementation lands.
 */
export function appendConfigObserveAuditRecord(
  _params: AppendObserveRecordParams,
): Promise<{ ok: true; totalBytes: number } | { ok: false; error: Error }> {
  throw new Error(
    "appendConfigObserveAuditRecord: not implemented yet (RED stub)",
  );
}
