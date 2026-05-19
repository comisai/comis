// SPDX-License-Identifier: Apache-2.0
/**
 * Config-audit record writer (Plan 45-05 task 5).
 *
 * Three entry points compose the persisted-write pipeline:
 *
 *   1. `createConfigWriteAuditRecordBase(...)` — snapshot the
 *      pre-write state (caller provenance + previous-file stat / hash
 *      / bytes). Called BEFORE the actual config write.
 *
 *   2. `finalizeConfigWriteAuditRecord(base, params)` — splice in the
 *      post-write state and outcome (next-file stat / hash / bytes,
 *      result, errorCode, errorMessage). Returns a complete
 *      `ConfigWriteAuditRecord`.
 *
 *   3. `appendConfigAuditRecord(...)` / `appendConfigAuditRecordSync(...)`
 *      — pipe the record through `redactConfigAuditArgv` +
 *      `sanitizeForPersistence` (45-02) and append as one JSONL line
 *      via `appendRegularFile` from 45-01 (symlink-safe, file-mode
 *      0o600). When the file exceeds `rotateAtBytes`, rotate to
 *      `<path>.1`, shift `.N` → `.N+1`, discard at `keepRotated`.
 *
 * The two-phase split is required because the previous-file state
 * (hash/bytes/stat) must be captured BEFORE the write mutates them,
 * but the next-file state and outcome can only be captured AFTER the
 * write resolves (success, schema-rejection, or OS-level failure).
 *
 * The sync variant exists because the daemon's `last-known-good.ts`
 * save runs during shutdown when async appends may not flush before
 * the process exits. Production callers in async RPC paths should
 * prefer the async variant.
 *
 * @module
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

import { ok, err, type Result } from "@comis/shared";
import { appendRegularFile } from "@comis/infra";
import { systemDateFrom, systemNowMs } from "@comis/core";

import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import { safeJsonStringify } from "../shared/safe-json-stringify.js";

import {
  redactConfigAuditArgv,
  CONFIG_AUDIT_ARGV_CAP,
} from "./argv-redactor.js";
import { detectSuspicious } from "./suspicious.js";
import type {
  ConfigWriteAuditRecord,
  ConfigWriteResult,
  ConfigWriteSource,
  FileStatSnapshot,
  SuspiciousFlag,
} from "./types.js";

/**
 * Default rotation thresholds per design §9.4. The 10 MB cap keeps
 * the audit log bounded; `keepRotated=5` retains roughly the last
 * 50 MB of history.
 */
export const DEFAULT_ROTATE_AT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_KEEP_ROTATED = 5;

/**
 * Base shape returned by `createConfigWriteAuditRecordBase`. Carries
 * everything that can be captured BEFORE the write. The "next" half
 * of the record is filled by `finalizeConfigWriteAuditRecord`.
 */
export interface ConfigWriteAuditRecordBase {
  readonly source: ConfigWriteSource;
  readonly configPath: string;
  readonly pid: number;
  readonly ppid: number;
  readonly argv: string[];
  readonly cwd: string;
  readonly execArgv: string[];
  readonly watchMode: boolean;
  readonly existsBefore: boolean;
  readonly previousHash: string | null;
  readonly previousBytes: number | null;
  readonly previousStat: FileStatSnapshot | null;
  readonly hasMetaBefore: boolean;
  readonly suspicious: SuspiciousFlag[];
  readonly tsMsBase: number;
}

/** Input to `createConfigWriteAuditRecordBase`. */
export interface CreateBaseParams {
  readonly source: ConfigWriteSource;
  readonly configPath: string;
  readonly pid: number;
  readonly ppid: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly execArgv: readonly string[];
  readonly watchMode: boolean;
}

function snapshotStat(p: string): FileStatSnapshot | null {
  try {
    const s = fs.statSync(p);
    return {
      dev: s.dev,
      ino: typeof s.ino === "bigint" ? Number(s.ino) : (s.ino as number),
      mode: s.mode,
      nlink: typeof s.nlink === "bigint" ? Number(s.nlink) : (s.nlink as number),
      uid: s.uid,
      gid: s.gid,
    };
  } catch {
    return null;
  }
}

function sha256OfFile(p: string): string | null {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function fileBytes(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

/**
 * Capture pre-write state for the config-audit record. Called
 * BEFORE the actual config-write call.
 */
export function createConfigWriteAuditRecordBase(
  params: CreateBaseParams,
): ConfigWriteAuditRecordBase {
  const existsBefore = fs.existsSync(params.configPath);
  const previousHash = existsBefore ? sha256OfFile(params.configPath) : null;
  const previousBytes = existsBefore ? fileBytes(params.configPath) : null;
  const previousStat = existsBefore ? snapshotStat(params.configPath) : null;
  const hasMetaBefore = previousStat !== null;

  const suspicious = detectSuspicious({
    argv: params.argv,
    execArgv: params.execArgv,
  });

  return {
    source: params.source,
    configPath: params.configPath,
    pid: params.pid,
    ppid: params.ppid,
    argv: Array.from(params.argv),
    cwd: params.cwd,
    execArgv: Array.from(params.execArgv),
    watchMode: params.watchMode,
    existsBefore,
    previousHash,
    previousBytes,
    previousStat,
    hasMetaBefore,
    suspicious,
    tsMsBase: systemNowMs(),
  };
}

/** Input to `finalizeConfigWriteAuditRecord`. */
export interface FinalizeParams {
  readonly result: ConfigWriteResult;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly changedPathCount?: number | null;
  /**
   * Pre-computed next-state values. When omitted, the helper
   * re-reads the file from disk. Production callers typically let
   * the helper read; explicit overrides exist for tests + the rare
   * caller that already has the hash in hand.
   */
  readonly nextHash?: string | null;
  readonly nextBytes?: number | null;
  readonly nextStat?: FileStatSnapshot | null;
}

/**
 * Finalize a config-audit record by splicing in post-write state.
 * Re-reads the file from disk by default.
 */
export function finalizeConfigWriteAuditRecord(
  base: ConfigWriteAuditRecordBase,
  params: FinalizeParams,
): ConfigWriteAuditRecord {
  const nowMs = systemNowMs();
  const nextStat = params.nextStat ?? snapshotStat(base.configPath);
  const nextBytes = params.nextBytes ?? fileBytes(base.configPath);
  const nextHash = params.nextHash ?? sha256OfFile(base.configPath);
  const hasMetaAfter = nextStat !== null;

  const record: ConfigWriteAuditRecord = {
    traceSchema: "comis-config-audit",
    schemaVersion: 1,
    phase: "write",
    source: base.source,
    configPath: base.configPath,
    pid: base.pid,
    ppid: base.ppid,
    argv: base.argv,
    cwd: base.cwd,
    execArgv: base.execArgv,
    watchMode: base.watchMode,
    existsBefore: base.existsBefore,
    previousHash: base.previousHash,
    previousBytes: base.previousBytes,
    previousStat: base.previousStat,
    hasMetaBefore: base.hasMetaBefore,
    nextHash,
    nextBytes,
    nextStat,
    hasMetaAfter,
    changedPathCount: params.changedPathCount ?? null,
    result: params.result,
    suspicious: base.suspicious,
    ts: systemDateFrom(nowMs).toISOString(),
    tsMs: nowMs,
  };
  if (params.errorCode !== undefined) record.errorCode = params.errorCode;
  if (params.errorMessage !== undefined)
    record.errorMessage = params.errorMessage;

  return record;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Rotate the audit-log file when its current size + projected
 * appended bytes would exceed `rotateAtBytes`.
 *
 * Strategy: rename main → `.1`; shift `.N` → `.N+1` for `N <
 * keepRotated`; the file previously at `.keepRotated` is unlinked.
 *
 * After this returns, the main path no longer exists — the next
 * `appendRegularFile` call will create it under `0o600`.
 */
function rotateAuditLogIfNeeded(
  filePath: string,
  appendBytes: number,
  rotateAtBytes: number,
  keepRotated: number,
): void {
  let currentBytes: number;
  try {
    currentBytes = fs.statSync(filePath).size;
  } catch {
    // Doesn't exist yet — nothing to rotate.
    return;
  }
  if (currentBytes + appendBytes <= rotateAtBytes) return;

  // Discard the oldest rotation if at the cap; then shift down.
  for (let i = keepRotated; i >= 1; i--) {
    const here = filePath + "." + i;
    if (i === keepRotated) {
      try {
        fs.unlinkSync(here);
      } catch {
        // Doesn't exist — fine.
      }
      continue;
    }
    const next = filePath + "." + (i + 1);
    try {
      fs.renameSync(here, next);
    } catch {
      // Source doesn't exist — fine.
    }
  }

  // Rename main → .1.
  try {
    fs.renameSync(filePath, filePath + ".1");
  } catch {
    // Can't rename — best-effort, leave the main file alone.
  }
}

// ---------------------------------------------------------------------------
// Append entry points
// ---------------------------------------------------------------------------

/** Input shared by the sync + async appenders. */
export interface AppendConfigAuditParams {
  readonly filePath: string;
  readonly record: ConfigWriteAuditRecord;
  readonly rotateAtBytes?: number;
  readonly keepRotated?: number;
}

/** Error class for the appender. Wraps `appendRegularFile` errors. */
export class ConfigAuditAppendError extends Error {
  public readonly name = "ConfigAuditAppendError" as const;
  public readonly code: string;
  constructor(message: string, code = "CONFIG_AUDIT_APPEND_FAILED") {
    super(message);
    this.code = code;
  }
}

/**
 * Plan 45-gap-01 (BL-01): Sentinel emitted when `safeJsonStringify`
 * returns undefined (BigInt, circular reference, or other host-throw in
 * JSON.stringify). The sentinel is hand-crafted with only string +
 * number primitives so it is guaranteed to be JSON-serializable —
 * `JSON.stringify` on the sentinel can never itself fail (BL-01 closure
 * invariant).
 *
 * Downstream consumers (config.audit.list, scrubber, doctor) see a
 * parseable record they can recognize and skip / report. Compare to
 * the prior behavior, which wrote the literal string "undefined\n"
 * that broke every JSON.parse call on the affected line.
 */
function emitSerializationErrorSentinel(): string {
  // Hand-crafted to be unconditionally serializable. JSON.stringify here
  // CANNOT return undefined — the non-null assertion is sound and is the
  // boundary point where the writer guarantees a parseable JSONL line.
  const sentinel = {
    traceSchema: "comis-config-audit" as const,
    schemaVersion: 1 as const,
    __serializationError: "record-not-serializable" as const,
    tsMs: systemNowMs(),
  };
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return JSON.stringify(sentinel)! + "\n";
}

/**
 * Encode a record for on-disk persistence: argv goes through the
 * dedicated `redactConfigAuditArgv` (which knows `--flag=value`
 * shape); the rest of the record goes through `sanitizeForPersistence`
 * (45-02). The two redactors are NOT composed because they would
 * mutually over-redact — `redactSecretsInText` matches `--api-key=...`
 * as a credential pattern and would collapse the already-masked
 * `--api-key=***` to a bare `***`, losing the flag-name evidence
 * operators need for forensics.
 */
function encodeRecord(record: ConfigWriteAuditRecord): string {
  const argvRedacted = redactConfigAuditArgv(record.argv).slice(
    0,
    CONFIG_AUDIT_ARGV_CAP,
  );
  // Sanitize everything EXCEPT argv. Use a placeholder marker for
  // argv so the sanitizer leaves the slot alone, then splice the
  // dedicated redacted argv back in via the parsed graph.
  const withoutArgv: Record<string, unknown> = { ...record };
  delete (withoutArgv as { argv?: unknown }).argv;
  const sanitized = sanitizeForPersistence(withoutArgv) as Record<string, unknown>;
  // Splice the argv back in. We trust `argvRedacted` (the dedicated
  // redactor) is already strictly safer than the regex pass would be.
  sanitized.argv = argvRedacted;
  const json = safeJsonStringify(sanitized);
  if (json === undefined) {
    // BL-01: safeJsonStringify returned undefined (BigInt, circular ref,
    // or host throw in JSON.stringify). Falling back to a JSON-parseable
    // sentinel preserves audit-log forensic integrity; downstream
    // consumers can recognize and skip the sentinel without parse failures.
    return emitSerializationErrorSentinel();
  }
  return json + "\n";
}

/** Ensure the parent dir exists with mode 0o700. */
function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best-effort — operator may have intentionally set wider perms.
    }
  }
}

/**
 * Append a config-audit record to the file. Async wrapper around the
 * synchronous `appendRegularFile` primitive (the wrapping is for
 * future-proofing — callers that need to await rotation should
 * receive a Promise).
 */
export async function appendConfigAuditRecord(
  params: AppendConfigAuditParams,
): Promise<Result<{ totalBytes: number }, ConfigAuditAppendError>> {
  return appendConfigAuditRecordSyncImpl(params);
}

/** Sync variant — used during daemon shutdown when async won't flush. */
export function appendConfigAuditRecordSync(
  params: AppendConfigAuditParams,
): Result<{ totalBytes: number }, ConfigAuditAppendError> {
  return appendConfigAuditRecordSyncImpl(params);
}

function appendConfigAuditRecordSyncImpl(
  params: AppendConfigAuditParams,
): Result<{ totalBytes: number }, ConfigAuditAppendError> {
  const rotateAtBytes = params.rotateAtBytes ?? DEFAULT_ROTATE_AT_BYTES;
  const keepRotated = params.keepRotated ?? DEFAULT_KEEP_ROTATED;
  const encoded = encodeRecord(params.record);
  const bytes = Buffer.byteLength(encoded, "utf8");

  ensureParentDir(params.filePath);
  rotateAuditLogIfNeeded(params.filePath, bytes, rotateAtBytes, keepRotated);

  const appendResult = appendRegularFile({
    path: params.filePath,
    content: encoded,
    // Per design §9.4 the rotation check above is the operative
    // bound; we do NOT pass maxFileBytes through to appendRegularFile
    // (which would reject the append, not rotate). Rotation already
    // ensured space for the new record.
  });
  if (!appendResult.ok) {
    return err(
      new ConfigAuditAppendError(
        `Failed to append config-audit record: ${appendResult.error.message}`,
        (appendResult.error as { code?: string }).code ?? "APPEND_FAILED",
      ),
    );
  }
  return ok({ totalBytes: appendResult.value.totalBytes });
}
