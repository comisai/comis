// SPDX-License-Identifier: Apache-2.0
/**
 * Config-OBSERVE audit record writer (read-side counterpart to
 * `append.ts`'s write-side helpers). The daemon's bootstrap
 * config-read path produces one `event: "config.observe"` JSONL
 * record per resolved configPath entry, so operators can reconstruct
 * "what config was read at boot" from
 * `~/.comis/logs/config-audit.jsonl` alone.
 *
 * Two entry points:
 *
 *   - `createConfigObserveAuditRecord(...)` — produce a fully-formed
 *     `ConfigObserveAuditRecord` with the config.observe schema shape. Captures
 *     caller provenance via `process.pid`, `process.ppid`,
 *     `process.argv`, `process.cwd()`, `process.execArgv`. The
 *     suspicious-flag heuristic mirrors the write-side
 *     `detectSuspicious(...)` call.
 *
 *   - `appendConfigObserveAuditRecord(...)` — pipe the record through
 *     the same `appendRegularFile` + rotation chassis the write-side
 *     uses (via the now-exported `ensureConfigAuditParentDir` +
 *     `rotateConfigAuditLogIfNeeded` helpers). Argv goes through the
 *     same `redactConfigAuditArgv` redactor.
 *
 * Audit-append failures at boot are caller's-responsibility to
 * absorb (Promise.allSettled in the daemon wiring); the writer
 * itself returns a Result-shaped object rather than throwing so the
 * caller can log the failure without bringing down the daemon.
 *
 * @module
 */

import { appendRegularFile } from "../shared/fs-safe.js";
import { systemDateFrom, systemNowMs } from "@comis/core";

import { encodeAuditRecord } from "./encode-record.js";
import { detectSuspicious } from "./suspicious.js";
import {
  DEFAULT_KEEP_ROTATED,
  DEFAULT_ROTATE_AT_BYTES,
  ensureConfigAuditParentDir,
  rotateConfigAuditLogIfNeeded,
} from "./append.js";
import type { ConfigObserveAuditRecord } from "./types.js";
import type { FileSnapshot } from "../shared/file-snapshot.js";

/**
 * Optional config-observe observation cluster.
 *
 * The daemon-side `readConfigFileObservation` aggregator (in
 * `@comis/daemon/src/config/read-config-file-observation.ts`) builds this
 * cluster from disk; non-bootstrap callers (e.g. `comis config show`) can
 * omit it entirely. When omitted, every file-state / LKG / backup field
 * on the record stays at its null default (matching the `exists:false`
 * shape).
 *
 * Note: observability is the substrate; the policy of which siblings to
 * consult lives in `@comis/daemon`. This package consumes the cluster
 * without knowing how the aggregator built it.
 */
export interface ObserveObservation {
  readonly exists: boolean;
  readonly snapshot: FileSnapshot | null;
  readonly lkg: FileSnapshot | null;
  readonly backup: FileSnapshot | null;
}

/**
 * Optional config-observe recovery state cluster.
 *
 * Populated by callers that own a restore flow (`--restore-last-good`,
 * future `--restore-backup`). Default (when undefined) is the
 * "no recovery" shape: `restoredFromBackup:false`, all paths/codes
 * `null`.
 */
export interface ObserveRecovery {
  readonly clobberedPath: string | null;
  readonly restoredFromBackup: boolean;
  readonly restoredBackupPath: string | null;
  readonly restoreErrorCode: string | null;
  readonly restoreErrorMessage: string | null;
}

/** Input to `createConfigObserveAuditRecord`. */
export interface CreateObserveRecordParams {
  /** Absolute filesystem path of the config file that was observed. */
  readonly filePath: string;
  /** Caller-source identifier (e.g. "daemon-bootstrap", "cli-config-show"). */
  readonly callerSource: string;
  /**
   * File-state observation. When omitted, defaults to the
   * `exists:false` / all-null shape — the caller doesn't know whether
   * the file exists or what its hash is.
   */
  readonly observation?: ObserveObservation;
  /**
   * Validity bit. Default `true` — non-bootstrap callers (e.g.
   * `comis config show`) are read-only and have no Zod-validation
   * outcome to report; the daemon-bootstrap caller passes `false` when
   * `bootResult.ok === false`.
   */
  readonly valid?: boolean;
  /**
   * Recovery state. Default `{restoredFromBackup:false,
   * clobberedPath:null, restoredBackupPath:null, restoreErrorCode:null,
   * restoreErrorMessage:null}`.
   */
  readonly recovery?: ObserveRecovery;
  /**
   * Caller's own module path (typically `fileURLToPath(import.meta.url)`)
   * — forwarded into `detectSuspicious` so the observe-side audit
   * record's `suspicious` flag set parity-matches the write-side
   * (which already accepts `entryScript` via
   * `createConfigWriteAuditRecordBase`). When omitted,
   * `detectSuspicious` falls back to its argv/execArgv-only
   * heuristic (existing behavior).
   */
  readonly entryScript?: string;
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

/** Result shape for `appendConfigObserveAuditRecord`. */
export type AppendObserveResult =
  | { readonly ok: true; readonly totalBytes: number }
  | { readonly ok: false; readonly error: Error };

/**
 * Build a `ConfigObserveAuditRecord` for the given config file read.
 *
 * Caller provenance is captured from the host process at call time —
 * this is the sanctioned trust-boundary read of `process.pid`,
 * `process.ppid`, `process.argv`, `process.cwd()`, `process.execArgv`
 * (matching the write-side `createConfigWriteAuditRecordBase` shape).
 * The function is synchronous + side-effect-free — it does not touch
 * disk; the caller is responsible for the subsequent append.
 */
export function createConfigObserveAuditRecord(
  params: CreateObserveRecordParams,
): ConfigObserveAuditRecord {
  // Sanctioned trust-boundary reads of process fields for audit-log
  // provenance. This module sits in @comis/observability where the
  // no-restricted-syntax process.env rule is not enforced — but the
  // call still reads runtime process state, which is the intentional
  // semantics here (mirror-matches `process.pid` reads in
  // packages/daemon/src/config/audit-hook.ts and
  // packages/daemon/src/config/last-known-good.ts).
  const pid = process.pid;
  const ppid = process.ppid;
  const rawArgv = process.argv;
  const cwd = process.cwd();
  const rawExecArgv = process.execArgv;
  const argv = Array.from(rawArgv);
  const execArgv = Array.from(rawExecArgv);

  const suspicious = detectSuspicious({
    argv,
    execArgv,
    ...(params.entryScript !== undefined ? { entryScript: params.entryScript } : {}),
  });

  // Observation projection — when the caller passed an
  // observation cluster, project the snapshots onto the record fields;
  // otherwise fall through to the null defaults.
  const obs = params.observation;
  const snap = obs?.snapshot ?? null;
  const lkg = obs?.lkg ?? null;
  const bak = obs?.backup ?? null;
  const rec = params.recovery;
  const valid = params.valid ?? true;

  return {
    traceSchema: "comis-config-audit",
    schemaVersion: 1,
    ts: systemDateFrom(systemNowMs()).toISOString(),
    source: "config-io",
    event: "config.observe",
    phase: "read",

    configPath: params.filePath,
    callerSource: params.callerSource,

    pid,
    ppid,
    argv,
    cwd,
    execArgv,
    watchMode: false,

    // File-state fields — projected from the observation cluster's snapshot.
    exists: obs?.exists ?? false,
    valid,
    hash: snap?.hash ?? null,
    bytes: snap?.bytes ?? null,
    mtimeMs: snap?.mtimeMs ?? null,
    ctimeMs: snap?.ctimeMs ?? null,
    dev: snap?.dev ?? null,
    ino: snap?.ino ?? null,
    mode: snap?.mode ?? null,
    nlink: snap?.nlink ?? null,
    uid: snap?.uid ?? null,
    gid: snap?.gid ?? null,
    // LKG triple — FileSnapshot narrowed to {hash, bytes, mtimeMs}.
    lastKnownGoodHash: lkg?.hash ?? null,
    lastKnownGoodBytes: lkg?.bytes ?? null,
    lastKnownGoodMtimeMs: lkg?.mtimeMs ?? null,
    // Backup triple — same narrowing.
    backupHash: bak?.hash ?? null,
    backupBytes: bak?.bytes ?? null,
    backupMtimeMs: bak?.mtimeMs ?? null,
    // Recovery state — defaults to "no recovery" shape.
    clobberedPath: rec?.clobberedPath ?? null,
    restoredFromBackup: rec?.restoredFromBackup ?? false,
    restoredBackupPath: rec?.restoredBackupPath ?? null,
    restoreErrorCode: rec?.restoreErrorCode ?? null,
    restoreErrorMessage: rec?.restoreErrorMessage ?? null,

    suspicious,
  };
}

/**
 * Append a `ConfigObserveAuditRecord` to the daemon-wide audit log.
 * Uses the same parent-dir + rotation invariants the write-side does
 * (via the exported helpers in `append.ts`).
 *
 * Failure is returned, not thrown — the daemon-side caller wraps the
 * call in `Promise.allSettled` so a single append failure at boot
 * does not abort startup.
 */
export async function appendConfigObserveAuditRecord(
  params: AppendObserveRecordParams,
): Promise<AppendObserveResult> {
  const rotateAtBytes = params.rotateAtBytes ?? DEFAULT_ROTATE_AT_BYTES;
  const keepRotated = params.keepRotated ?? DEFAULT_KEEP_ROTATED;

  try {
    const encoded = encodeAuditRecord(params.record as unknown as Record<string, unknown>);
    const bytes = Buffer.byteLength(encoded, "utf8");

    ensureConfigAuditParentDir(params.filePath);
    rotateConfigAuditLogIfNeeded(
      params.filePath,
      bytes,
      rotateAtBytes,
      keepRotated,
    );

    const appendResult = appendRegularFile({
      path: params.filePath,
      content: encoded,
      ...(params.confinedBaseDir !== undefined
        ? { confinedBaseDir: params.confinedBaseDir }
        : {}),
    });
    if (!appendResult.ok) {
      return { ok: false, error: appendResult.error };
    }
    return { ok: true, totalBytes: appendResult.value.totalBytes };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
}

