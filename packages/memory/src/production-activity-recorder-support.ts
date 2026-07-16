// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type {
  ActivityRecordingAttemptReceipt,
  ActivityRecordingCiphertext,
  ActivityRecordingCryptoPort,
  ActivityRecordingGapReason,
  ActivityRecordingHeadAuthorityPort,
  ActivityRecordingReceipt,
  ActivityRecordingSourceKind,
  ErrorKind,
  ProductionActivityRecorderPort,
} from "@comis/core";
import type { Result } from "@comis/shared";

import { ACTIVITY_RECORDING_ZERO_HASH } from "./production-activity-recorder-integrity.js";
import type { ActivityPayloadFailure } from "./production-activity-recorder-json.js";

export interface ActivityRecorderLimits {
  readonly maxPayloadBytes: number;
  readonly maxStoredBytes: number;
  readonly maxRecords: number;
  readonly gapReserveBytes: number;
  readonly gapReserveRecords: number;
  readonly busyTimeoutMs?: number;
}

export interface CommonRecorderOptions {
  readonly crypto: ActivityRecordingCryptoPort;
  readonly limits: ActivityRecorderLimits;
  readonly nowMs: () => number;
  readonly streamId?: string;
  readonly headAuthority?: ActivityRecordingHeadAuthorityPort;
  /** Stable fencing identity for one recorder runtime. Generated when absent. */
  readonly writerId?: string;
  /** Duration after which a non-renewing writer is fenced and recoverable. */
  readonly writerLeaseMs?: number;
}

export interface OpenSqliteProductionActivityRecorderOptions extends CommonRecorderOptions {
  readonly dbPath: string;
}

export interface CreateSqliteProductionActivityRecorderOptions extends CommonRecorderOptions {
  readonly db: Database.Database;
  readonly closeDatabase: boolean;
}

export type StoredKind = ActivityRecordingSourceKind | "gap";

export interface AppendRecordInput {
  readonly kind: StoredKind;
  readonly traceId: string | null;
  readonly parentRecordId: string | null;
  readonly attemptId: string | null;
  readonly capabilityDigest: string | null;
  readonly occurredAtMs: number;
  readonly payload: unknown;
  readonly useGapReserve: boolean;
  readonly settlement?: ActivityRecordingAttemptReceipt;
  readonly recovery?: {
    readonly writerId: string;
    readonly asOfMs: number;
  };
}

export interface InternalAppendFailure extends ActivityPayloadFailure {
  readonly persistedReceipt?: ActivityRecordingReceipt;
  readonly recoveryNoLongerEligible?: true;
}

export interface RuntimeProductionActivityRecorder extends ProductionActivityRecorderPort {
  heartbeat(): Promise<Result<void, Error>>;
}

export const DEFAULT_ACTIVITY_RECORDING_WRITER_LEASE_MS = 30_000;

export interface SealedRecord {
  readonly payload: ActivityRecordingCiphertext;
  readonly proof: ActivityRecordingCiphertext;
  readonly payloadDigest: string;
  readonly payloadBytes: number;
  readonly previousHash: string;
  readonly recordHash: string;
  readonly index: string;
  readonly logicalBytes: number;
  readonly stateLogicalBytes: number;
  readonly stateRecordCount: number;
  readonly stateGapCount: number;
}
export function recordIdFor(sequence: number): string {
  return `record:${String(sequence).padStart(20, "0")}`;
}

export function validLimits(limits: ActivityRecorderLimits): boolean {
  return Number.isSafeInteger(limits.maxPayloadBytes) && limits.maxPayloadBytes > 0
    && Number.isSafeInteger(limits.maxStoredBytes) && limits.maxStoredBytes > limits.gapReserveBytes
    && Number.isSafeInteger(limits.maxRecords) && limits.maxRecords > limits.gapReserveRecords
    && Number.isSafeInteger(limits.gapReserveBytes) && limits.gapReserveBytes > 0
    && Number.isSafeInteger(limits.gapReserveRecords) && limits.gapReserveRecords > 0
    && (limits.busyTimeoutMs === undefined
      || (Number.isSafeInteger(limits.busyTimeoutMs) && limits.busyTimeoutMs > 0
        && limits.busyTimeoutMs <= 2_147_483_647));
}

export function initSchema(db: Database.Database, streamId: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_recording_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      stream_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      next_sequence INTEGER NOT NULL,
      head_hash TEXT NOT NULL,
      logical_bytes INTEGER NOT NULL,
      record_count INTEGER NOT NULL,
      gap_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_recording_writers (
      writer_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      CHECK(lease_expires_at_ms >= 0),
      CHECK(closed_at_ms IS NULL OR closed_at_ms >= 0)
    );
    CREATE TABLE IF NOT EXISTS activity_recording_records (
      sequence INTEGER PRIMARY KEY,
      record_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN (
        'channel_inbound_normalized', 'delivery_platform_attempt',
        'delivery_platform_outcome', 'gap'
      )),
      trace_id TEXT,
      parent_record_id TEXT,
      attempt_id TEXT,
      capability_digest TEXT,
      writer_id TEXT NOT NULL REFERENCES activity_recording_writers(writer_id),
      occurred_at_ms INTEGER NOT NULL,
      payload_ciphertext BLOB NOT NULL,
      payload_iv BLOB NOT NULL,
      payload_auth_tag BLOB NOT NULL,
      payload_salt BLOB NOT NULL,
      payload_digest TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      previous_hash TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      state_logical_bytes INTEGER NOT NULL,
      state_record_count INTEGER NOT NULL,
      state_gap_count INTEGER NOT NULL,
      proof_ciphertext BLOB NOT NULL,
      proof_iv BLOB NOT NULL,
      proof_auth_tag BLOB NOT NULL,
      proof_salt BLOB NOT NULL,
      logical_bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_recording_parent
      ON activity_recording_records(parent_record_id, kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_recording_attempt_id
      ON activity_recording_records(attempt_id) WHERE attempt_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_recording_settlement_once
      ON activity_recording_records(parent_record_id)
      WHERE parent_record_id IS NOT NULL
        AND kind IN ('delivery_platform_outcome', 'gap');
  `);
  db.prepare(`
    INSERT OR IGNORE INTO activity_recording_meta
      (singleton, stream_id, instance_id, next_sequence, head_hash,
       logical_bytes, record_count, gap_count)
    VALUES (1, ?, ?, 1, ?, 0, 0, 0)
  `).run(streamId, randomUUID(), ACTIVITY_RECORDING_ZERO_HASH);
}

export function databaseFailureReason(error: Error): ActivityRecordingGapReason {
  const message = error.message.toLowerCase();
  return message.includes("busy") || message.includes("locked")
    ? "database_busy"
    : "storage_failed";
}

export function errorKindFor(reason: ActivityRecordingGapReason): ErrorKind {
  switch (reason) {
    case "payload_invalid":
    case "payload_too_large":
    case "outcome_shape_invalid":
      return "validation";
    case "record_limit_exceeded":
    case "storage_limit_exceeded":
    case "storage_failed":
    case "database_busy":
    case "handoff_capacity_exceeded":
      return "resource";
    case "handoff_timeout":
      return "timeout";
    case "settlement_capability_invalid":
    case "integrity_check_failed":
    case "head_anchor_conflict":
      return "auth";
    case "crypto_failed":
    case "head_anchor_unavailable":
    case "clock_unavailable":
      return "dependency";
    case "causal_parent_invalid":
    case "attempt_already_settled":
    case "trace_mismatch":
    case "timestamp_order_invalid":
    case "recorder_closed":
    case "writer_lease_expired":
      return "precondition";
    case "unknown_after_restart":
    case "unknown_at_shutdown":
      return "internal";
  }
}
