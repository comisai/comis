// SPDX-License-Identifier: Apache-2.0
/**
 * Config-OBSERVE audit record writer (read-side counterpart to
 * `append.ts`'s write-side helpers). Closes OBS-REVIEW-03: the
 * daemon's bootstrap config-read path now produces one
 * `event: "config.observe"` JSONL record per resolved configPath
 * entry, so operators can reconstruct "what config was read at boot"
 * from `~/.comis/logs/config-audit.jsonl` alone.
 *
 * Two entry points:
 *
 *   - `createConfigObserveAuditRecord(...)` — produce a fully-formed
 *     `ConfigObserveAuditRecord` matching design §9.2. Captures
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
import { safeJsonStringify } from "../shared/safe-json-stringify.js";
import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import { systemDateFrom, systemNowMs } from "@comis/core";

import {
  redactConfigAuditArgv,
  CONFIG_AUDIT_ARGV_CAP,
} from "./argv-redactor.js";
import { detectSuspicious } from "./suspicious.js";
import {
  DEFAULT_KEEP_ROTATED,
  DEFAULT_ROTATE_AT_BYTES,
  ensureConfigAuditParentDir,
  rotateConfigAuditLogIfNeeded,
} from "./append.js";
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
  // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
  const pid = process.pid;
  // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
  const ppid = process.ppid;
  // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
  const rawArgv = process.argv;
  // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
  const cwd = process.cwd();
  // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
  const rawExecArgv = process.execArgv;
  const argv = Array.from(rawArgv);
  const execArgv = Array.from(rawExecArgv);

  const suspicious = detectSuspicious({ argv, execArgv });

  return {
    traceSchema: "comis-config-audit",
    schemaVersion: 1,
    ts: systemDateFrom(systemNowMs()).toISOString(),
    source: "config-io",
    event: "config.observe",

    configPath: params.filePath,
    callerSource: params.callerSource,

    pid,
    ppid,
    argv,
    cwd,
    execArgv,
    watchMode: false,

    suspicious,
  };
}

/**
 * Serialize the observe record for on-disk persistence. Mirrors the
 * write-side `encodeRecord` shape: argv goes through the dedicated
 * `redactConfigAuditArgv`, the rest of the record goes through
 * `sanitizeForPersistence`, then `safeJsonStringify` produces the
 * final line. The two redactors are NOT composed — see `append.ts`
 * encodeRecord header for the rationale.
 */
function encodeObserveRecord(record: ConfigObserveAuditRecord): string {
  const argvRedacted = redactConfigAuditArgv(record.argv).slice(
    0,
    CONFIG_AUDIT_ARGV_CAP,
  );
  const withoutArgv: Record<string, unknown> = { ...record };
  delete (withoutArgv as { argv?: unknown }).argv;
  const sanitized = sanitizeForPersistence(withoutArgv) as Record<
    string,
    unknown
  >;
  sanitized.argv = argvRedacted;
  const json = safeJsonStringify(sanitized);
  if (json === undefined) {
    // Hand-crafted sentinel that always serializes. Matches the
    // write-side fallback in `emitSerializationErrorSentinel` — we
    // duplicate it here so the observe writer can stand alone.
    const sentinel = {
      traceSchema: "comis-config-audit" as const,
      schemaVersion: 1 as const,
      __serializationError: "record-not-serializable" as const,
      ts: systemDateFrom(systemNowMs()).toISOString(),
    };
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- sentinel is hand-crafted to be unconditionally serializable
    return JSON.stringify(sentinel)! + "\n";
  }
  return json + "\n";
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
    const encoded = encodeObserveRecord(params.record);
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

