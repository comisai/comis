// SPDX-License-Identifier: Apache-2.0
/**
 * Config-audit record writer.
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
 *      `sanitizeForPersistence` and append as one JSONL line via
 *      `appendRegularFile` (symlink-safe, file-mode 0o600). When the
 *      file exceeds `rotateAtBytes`, rotate to `<path>.1`, shift
 *      `.N` → `.N+1`, discard at `keepRotated`.
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
import * as os from "node:os";
import * as path from "node:path";

import { ok, err, type Result } from "@comis/shared";
import { appendRegularFile, ensureContainedDir } from "../shared/fs-safe.js";
import { safePath, systemDateFrom, systemNowMs } from "@comis/core";

import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import { safeJsonStringify } from "../shared/safe-json-stringify.js";

import {
  redactConfigAuditArgv,
  CONFIG_AUDIT_ARGV_CAP,
} from "./argv-redactor.js";
import { emitSerializationErrorSentinel } from "./serialization-sentinel.js";
import { detectSuspicious } from "./suspicious.js";
import type {
  ConfigWriteAuditRecord,
  ConfigWriteResult,
  ConfigWriteSource,
  FileStatSnapshot,
  SuspiciousFlag,
} from "./types.js";

/**
 * Default rotation thresholds. The 10 MB cap keeps the audit log
 * bounded; `keepRotated=5` retains roughly the last 50 MB of history.
 */
export const DEFAULT_ROTATE_AT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_KEEP_ROTATED = 5;

/**
 * Base shape returned by `createConfigWriteAuditRecordBase`. Carries
 * everything that can be captured BEFORE the write. The "next" half
 * of the record is filled by `finalizeConfigWriteAuditRecord`.
 *
 * `callerSource` is the pre-260519-rrm `source` enum value (e.g.,
 * "last-known-good-save", "config-patch-rpc", "cli-sync-tooling") —
 * stored under `callerSource` on the persisted record so the design
 * §9.2 top-level `source` slot is reserved for the fixed literal
 * `"config-io"`. Caller-site call patterns are unchanged.
 */
export interface ConfigWriteAuditRecordBase {
  readonly callerSource: ConfigWriteSource;
  readonly configPath: string;
  readonly pid: number;
  readonly ppid: number;
  readonly argv: string[];
  readonly cwd: string;
  readonly execArgv: string[];
  readonly watchMode: boolean;
  readonly watchSession: string | null;
  readonly watchCommand: string | null;
  readonly existsBefore: boolean;
  readonly previousHash: string | null;
  readonly previousBytes: number | null;
  readonly previousStat: FileStatSnapshot | null;
  readonly hasMetaBefore: boolean;
  readonly suspicious: SuspiciousFlag[];
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
  /** Optional watch-mode session label (forwarded into the record). */
  readonly watchSession?: string | null;
  /** Optional watch-mode command label (forwarded into the record). */
  readonly watchCommand?: string | null;
  /**
   * Optional resolved entry-script path (typically
   * `fileURLToPath(import.meta.url)`). Forwarded to the
   * `non-comis-argv` heuristic so pm2 / systemd-indirect launches
   * do not false-positive when the caller's resolved entry script
   * contains "comis" but `process.argv[0..1]` does not.
   */
  readonly entryScript?: string;
}

/**
 * Stringify a POSIX dev/ino value. Both can be `bigint` on some
 * filesystems (POSIX `st_dev` and `st_ino` can exceed JS safe-integer
 * range); the design §9.2 contract for these two fields is
 * `string | null`. Returns `null` when the input is null/undefined.
 */
function stringifyPosixId(v: number | bigint | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === "bigint" ? v.toString() : String(v);
}

function snapshotStat(p: string): FileStatSnapshot | null {
  try {
    const s = fs.statSync(p);
    return {
      dev: stringifyPosixId(s.dev),
      ino: stringifyPosixId(s.ino),
      mode: typeof s.mode === "number" ? s.mode : null,
      nlink: typeof s.nlink === "bigint" ? Number(s.nlink) : (s.nlink as number),
      uid: typeof s.uid === "number" ? s.uid : null,
      gid: typeof s.gid === "number" ? s.gid : null,
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
    ...(params.entryScript !== undefined && { entryScript: params.entryScript }),
  });

  return {
    callerSource: params.source,
    configPath: params.configPath,
    pid: params.pid,
    ppid: params.ppid,
    argv: Array.from(params.argv),
    cwd: params.cwd,
    execArgv: Array.from(params.execArgv),
    watchMode: params.watchMode,
    watchSession: params.watchSession ?? null,
    watchCommand: params.watchCommand ?? null,
    existsBefore,
    previousHash,
    previousBytes,
    previousStat,
    hasMetaBefore,
    suspicious,
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
    ts: systemDateFrom(nowMs).toISOString(),
    source: "config-io",
    event: "config.write",
    result: params.result,

    // Identity / caller provenance.
    configPath: base.configPath,
    callerSource: base.callerSource,
    pid: base.pid,
    ppid: base.ppid,
    argv: base.argv,
    cwd: base.cwd,
    execArgv: base.execArgv,
    watchMode: base.watchMode,
    watchSession: base.watchSession,
    watchCommand: base.watchCommand,

    // File state — hashes + bytes.
    existsBefore: base.existsBefore,
    previousHash: base.previousHash,
    nextHash,
    previousBytes: base.previousBytes,
    nextBytes,

    // File state — flat POSIX stat fields. snapshotStat already
    // returns dev/ino as `string | null`; mode/nlink/uid/gid stay
    // numeric. nlink in particular is a number on every supported
    // platform, but we still force a null fallback when the stat
    // snapshot itself failed (existsBefore=false, EACCES, etc.).
    previousDev: base.previousStat?.dev ?? null,
    nextDev: nextStat?.dev ?? null,
    previousIno: base.previousStat?.ino ?? null,
    nextIno: nextStat?.ino ?? null,
    previousMode: base.previousStat?.mode ?? null,
    nextMode: nextStat?.mode ?? null,
    previousNlink: base.previousStat?.nlink ?? null,
    nextNlink: nextStat?.nlink ?? null,
    previousUid: base.previousStat?.uid ?? null,
    nextUid: nextStat?.uid ?? null,
    previousGid: base.previousStat?.gid ?? null,
    nextGid: nextStat?.gid ?? null,

    changedPathCount: params.changedPathCount ?? null,
    hasMetaBefore: base.hasMetaBefore,
    hasMetaAfter,

    suspicious: base.suspicious,
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
/**
 * Exported so the observe-side writer (`append-observe.ts`) can share
 * the same rotation strategy. The semantics are identical to the
 * original private helper.
 */
export function rotateConfigAuditLogIfNeeded(
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
  /**
   * Opt-in real-path confinement base forwarded to `appendRegularFile`.
   * Production callers (last-known-good, config-audit-hook, CLI
   * sync-tooling audit) should pass `path.join(os.homedir(), ".comis")`
   * via `getDefaultConfigAuditConfinedBase()` to close the
   * ancestor-symlink gap. Tests omit it (default `undefined`) to keep
   * tmp-dir paths legal.
   */
  readonly confinedBaseDir?: string;
}

/**
 * Resolve the confinement base for production config-audit callers.
 *
 * - When the audit-log path is the default `~/.comis/logs/config-audit.jsonl`,
 *   confine writes to `~/.comis/` so ancestor-symlink escapes are
 *   rejected with `PathEscapesConfinementError`.
 * - When the operator has set `COMIS_CONFIG_AUDIT_LOG` to a custom path
 *   (sentinel: the resolved audit-log path lives outside `~/.comis/`),
 *   they own the legitimacy of that location — confinement is skipped
 *   (return `undefined`) so we don't reject the operator's own write
 *   path. Callers receive `undefined` and pass through to the
 *   `confinedBaseDir`-omit branch.
 *
 * The function takes the resolved log path so the env-override
 * detection is consistent with the actual write target.
 */
export function getDefaultConfigAuditConfinedBase(
  resolvedAuditLogPath?: string,
): string | undefined {
  const defaultBase = safePath(os.homedir(), ".comis");
  if (resolvedAuditLogPath === undefined) return defaultBase;
  // When the resolved log path stays inside ~/.comis/, the default
  // base applies. When the operator points the env-var elsewhere
  // (override case), drop confinement — they own that path.
  const normalized = path.resolve(resolvedAuditLogPath);
  if (
    normalized === defaultBase ||
    normalized.startsWith(defaultBase + path.sep)
  ) {
    return defaultBase;
  }
  return undefined;
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
 * Encode a record for on-disk persistence: argv goes through the
 * dedicated `redactConfigAuditArgv` (which knows `--flag=value`
 * shape); the rest of the record goes through `sanitizeForPersistence`.
 * The two redactors are NOT composed because they would mutually
 * over-redact — `redactSecretsInText` matches `--api-key=...` as a
 * credential pattern and would collapse the already-masked
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
    // safeJsonStringify returned undefined (BigInt, circular ref,
    // or host throw in JSON.stringify). Falling back to a JSON-parseable
    // sentinel preserves audit-log forensic integrity; downstream
    // consumers can recognize and skip the sentinel without parse failures.
    return emitSerializationErrorSentinel();
  }
  return json + "\n";
}

/**
 * Ensure the parent dir exists with mode 0o700, including for the
 * existing-parent case (OBS-REVIEW-01 fix; Phase 48 OBS-HARD-01
 * substrate migration).
 *
 * Delegates to the shared `ensureContainedDir` substrate, which owns
 * the canonical `mkdir + lstat-gated chmod` pattern with
 * confused-deputy safety:
 *
 *   - Fresh-create: dir created at the specified mode.
 *
 *   - Existing-parent: `mkdirSync`'s `mode` arg is silently ignored
 *     on recursive EEXIST; the substrate's defensive chmod restores
 *     the §1.4 0o700 invariant, gated on a non-symlink `lstat`
 *     (never chmod a symlinked dir — target may be shared state).
 *
 * The **file** itself is independently locked to `0o600` by the
 * defensive `fchmodSync(fd, 0o600)` inside `appendRegularFile`
 * (fs-safe.ts step 3) — per-record file-mode invariant is preserved
 * regardless of the parent's pre-existing mode.
 *
 * The exported sync void signature is preserved for back-compat with
 * the observe-side writer (`append-observe.ts`) which calls it
 * directly. The substrate's Result is discarded because the existing
 * contract is best-effort — the subsequent `appendRegularFile` call
 * surfaces real errors via its own Result.err branch.
 */
export function ensureConfigAuditParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  // Delegate to the shared `ensureContainedDir` substrate (Phase 48
  // OBS-HARD-01). The substrate owns the mkdir + lstat-gated chmod
  // pattern with confused-deputy safety. Result is intentionally
  // discarded — preserves the existing best-effort contract; the
  // subsequent appendRegularFile call surfaces real errors via its
  // own Result.err branch.
  ensureContainedDir({ dir, mode: 0o700 });
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

  ensureConfigAuditParentDir(params.filePath);
  rotateConfigAuditLogIfNeeded(params.filePath, bytes, rotateAtBytes, keepRotated);

  const appendResult = appendRegularFile({
    path: params.filePath,
    content: encoded,
    // The rotation check above is the operative bound; we do NOT pass
    // maxFileBytes through to appendRegularFile (which would reject
    // the append, not rotate). Rotation already ensured space for the
    // new record.
    //
    // Forward the caller's confinement base (typically `~/.comis/`)
    // so an ancestor-symlink escape would be rejected by
    // `appendRegularFile`. Tests omit it; production callers pass
    // `getDefaultConfigAuditConfinedBase()`.
    ...(params.confinedBaseDir !== undefined
      ? { confinedBaseDir: params.confinedBaseDir }
      : {}),
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
