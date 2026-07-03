// SPDX-License-Identifier: Apache-2.0
/**
 * Shared config-audit write-hook helpers.
 *
 * Consolidates the per-call `process.*` reads + audit-record-build +
 * append boilerplate that was previously duplicated across two daemon
 * modules:
 *
 *   - The local `withAuditHook` formerly in
 *     `packages/daemon/src/config/last-known-good.ts` (single-call sync
 *     wrapper for LKG save/restore — sync append because the LKG path
 *     runs during daemon shutdown when async writes may not flush).
 *
 *   - The two-call decomposed form formerly in
 *     `packages/daemon/src/api/config-handlers/config-audit-hook.ts`
 *     (`buildConfigAuditBase` + `appendConfigAuditWithOutcome`, required
 *     by `config-write.ts:120-369` because the YAML write is interleaved
 *     with validator pre-checks between the two calls). Both former
 *     modules are now superseded by this file.
 *
 * Three public shapes are provided:
 *
 *   1. `withAuditHookSync` — single-call sync wrapper. The LKG path uses
 *      this; the JSONL append goes through `appendConfigAuditRecordSync`.
 *
 *   2. `withAuditHook` — single-call async wrapper. Same shape as the
 *      sync variant, but `params.write` may return a Promise and the
 *      JSONL append goes through async `appendConfigAuditRecord` with
 *      `suppressError`.
 *
 *   3. `buildConfigAuditBase` + `appendConfigAuditWithOutcome` —
 *      two-call decomposed form for `config-write.ts` (preserves the
 *      existing import surface; the body delegates to the same
 *      internal `buildBaseFromProcess` helper as the single-call
 *      wrappers).
 *
 * All five sanctioned trust-boundary process reads
 * (`process.pid` / `process.ppid` / `process.argv` / `process.cwd()` /
 * `process.execArgv`) live inside `buildBaseFromProcess` and execute
 * at function-call time, not module-init, so per-record provenance is
 * captured correctly when the daemon forks/execs.
 *
 * Audit-append failures NEVER abort the underlying write — the sync
 * path uses a bare try/catch (matching the LKG write path's error
 * handling); the async path uses `suppressError` (matching the
 * config-write path's). The JSONL log is a forensics aid; the file
 * write itself is the load-bearing artifact.
 *
 * @module
 */

import { fileURLToPath } from "node:url";

import { suppressError } from "@comis/shared";
import {
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  resolveConfigAuditLogPath,
  getDefaultConfigAuditConfinedBase,
  type ConfigWriteAuditRecordBase,
  type ConfigWriteSource,
} from "@comis/observability";
import type { ComisLogger } from "@comis/core";

/**
 * Outcome of the config-write attempt, derived in the calling handler
 * from `(wroteFile, writeError)`.
 *
 * Fix D1 (log-review): `rejected` carries an optional `message` so the
 * validator's rejection reason can be threaded through to the
 * persisted `errorMessage` field on `ConfigWriteAuditRecord`.
 */
export type ConfigAuditOutcome =
  | { kind: "rename" }
  | { kind: "failed"; code?: string; message?: string }
  | { kind: "rejected"; message?: string };

// ---------------------------------------------------------------------------
// Internal: shared base builder (5 sanctioned trust-boundary process reads)
// ---------------------------------------------------------------------------

/**
 * Build a `ConfigWriteAuditRecordBase` by snapshotting current process
 * state. Returns `undefined` on construction failure (best-effort).
 *
 * Per-call (not module-init) reads of `process.pid` / `process.ppid` /
 * `process.argv` / `process.cwd()` / `process.execArgv` so per-record
 * provenance is correct even if the daemon forks/execs after this
 * module loads.
 */
function buildBaseFromProcess(params: {
  source: ConfigWriteSource;
  configPath: string;
  entryScript: string;
}): ConfigWriteAuditRecordBase | undefined {
  try {
    return createConfigWriteAuditRecordBase({
      source: params.source,
      configPath: params.configPath,
      // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
      pid: process.pid,
      // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
      ppid: process.ppid,
      // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
      argv: process.argv,
      // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
      cwd: process.cwd(),
      // eslint-disable-next-line no-restricted-syntax -- daemon trust-boundary read for audit-log provenance
      execArgv: process.execArgv,
      watchMode: false,
      entryScript: params.entryScript,
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Two-call decomposed form (preserved for config-write.ts:120-369 where the
// YAML write is interleaved with validator pre-checks between the two calls)
// ---------------------------------------------------------------------------

/**
 * Build the audit-record base for the in-flight config.patch RPC.
 * Returns `undefined` when base construction itself fails (e.g., stat
 * permission issues on the target path) — audit is best-effort.
 *
 * @param localPath - Absolute path of the local override config file.
 * @param callerSource - The ConfigWriteSource tag for the JSONL
 *   record's `callerSource` field. Defaults to `"config-patch-rpc"`
 *   so existing call sites keep working unchanged. Other sites (MCP
 *   handlers) pass `"mcp.connect"` / `"mcp.disconnect"` so the audit
 *   trail can distinguish MCP-driven writes from generic config.patch
 *   writes.
 */
export function buildConfigAuditBase(
  localPath: string,
  callerSource: ConfigWriteSource = "config-patch-rpc",
): ConfigWriteAuditRecordBase | undefined {
  // entryScript is the resolved entry script for the non-comis-argv
  // heuristic — pm2 and systemd-indirect launches present `node
  // ProcessContainerFork.js` in argv[0..1] without the literal "comis",
  // so the heuristic would false-positive without this hint. The
  // current file path contains "comis" (it lives under
  // packages/daemon/src/config/) so reading import.meta.url here
  // satisfies the heuristic.
  return buildBaseFromProcess({
    source: callerSource,
    configPath: localPath,
    entryScript: fileURLToPath(import.meta.url),
  });
}

/**
 * Finalize + append a config-audit record. Audit failures swallowed
 * via `suppressError` (async write path).
 */
export function appendConfigAuditWithOutcome(
  base: ConfigWriteAuditRecordBase | undefined,
  outcome: ConfigAuditOutcome,
  logger: ComisLogger,
): void {
  if (base === undefined) return;
  try {
    const finalizeParams =
      outcome.kind === "rename"
        ? ({ result: "rename" as const })
        : outcome.kind === "failed"
          ? {
              result: "failed" as const,
              ...(outcome.code !== undefined && { errorCode: outcome.code }),
              ...(outcome.message !== undefined && {
                errorMessage: outcome.message,
              }),
            }
          // Fix D1 (log-review): thread rejection message into errorMessage.
          : ({
              result: "rejected" as const,
              ...(outcome.message !== undefined && {
                errorMessage: outcome.message,
              }),
            });
    const record = finalizeConfigWriteAuditRecord(base, finalizeParams);
    const auditLogPath = resolveConfigAuditLogPath();
    const auditConfinedBase = getDefaultConfigAuditConfinedBase(auditLogPath);
    suppressError(
      appendConfigAuditRecord({
        filePath: auditLogPath,
        record,
        // Confine the audit-log write to ~/.comis/ when the default
        // log path applies; skip confinement when the operator set
        // COMIS_CONFIG_AUDIT_LOG to a custom location.
        ...(auditConfinedBase !== undefined && {
          confinedBaseDir: auditConfinedBase,
        }),
      }),
      "best-effort config-audit append (config.patch)",
      (msg) => logger.debug({ method: "config.patch" }, msg),
    );
  } catch {
    // Audit-finalize failed — swallow.
  }
}

// ---------------------------------------------------------------------------
// Single-call wrappers (LKG path uses the sync variant; the async variant is
// available for future async writers)
// ---------------------------------------------------------------------------

/** Common params for the single-call audit-hook wrappers. */
export interface WithAuditHookParams {
  /** ConfigWriteSource tag for the JSONL record. */
  readonly source: ConfigWriteSource;
  /** Operative path for the audit record (the WRITE TARGET). */
  readonly auditConfigPath: string;
  /**
   * Resolved entry-script path of the calling module (typically
   * `fileURLToPath(import.meta.url)`). The caller must pass it
   * explicitly because reading `import.meta.url` here would resolve
   * to audit-hook.ts, not the caller.
   */
  readonly entryScript: string;
  /**
   * When `false`, run `write` directly and skip the JSONL append.
   * Honors `diagnostics.configAudit.enabled`. Defaults to `true`.
   */
  readonly auditEnabled?: boolean;
}

/** Return shape from the single-call audit-hook wrappers. */
export interface WithAuditHookResult {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Sync single-call audit-hook wrapper.
 *
 * Captures pre-write state, runs the (sync) write callback, then
 * records the outcome (`rename` / `failed`) into the config-audit
 * JSONL log via `appendConfigAuditRecordSync`. Audit failures are
 * swallowed — the JSONL is a forensics aid, not a correctness gate.
 *
 * When `params.auditEnabled === false`, the JSONL append is skipped
 * but `params.write()` still runs and the success/failure shape is
 * returned to the caller.
 */
export function withAuditHookSync(
  params: WithAuditHookParams & { readonly write: () => void },
): WithAuditHookResult {
  const auditEnabled = params.auditEnabled ?? true;

  // Short-circuit when audit is disabled — run the write and surface
  // the success/failure shape WITHOUT emitting JSONL.
  if (!auditEnabled) {
    try {
      params.write();
      return { ok: true };
    } catch (writeErr) {
      const errorCode = (writeErr as NodeJS.ErrnoException).code;
      const errorMessage = (writeErr as Error).message;
      const result: WithAuditHookResult = { ok: false };
      if (errorCode !== undefined)
        (result as { errorCode?: string }).errorCode = errorCode;
      if (errorMessage !== undefined)
        (result as { errorMessage?: string }).errorMessage = errorMessage;
      return result;
    }
  }

  const base = buildBaseFromProcess({
    source: params.source,
    configPath: params.auditConfigPath,
    entryScript: params.entryScript,
  });
  // Base-construction failed: still run the write (audit is
  // best-effort) and surface the result without emitting JSONL.
  if (base === undefined) {
    try {
      params.write();
      return { ok: true };
    } catch (writeErr) {
      const errorCode = (writeErr as NodeJS.ErrnoException).code;
      const errorMessage = (writeErr as Error).message;
      const result: WithAuditHookResult = { ok: false };
      if (errorCode !== undefined)
        (result as { errorCode?: string }).errorCode = errorCode;
      if (errorMessage !== undefined)
        (result as { errorMessage?: string }).errorMessage = errorMessage;
      return result;
    }
  }

  let writeOk = true;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  try {
    params.write();
  } catch (writeErr) {
    writeOk = false;
    errorCode = (writeErr as NodeJS.ErrnoException).code;
    errorMessage = (writeErr as Error).message;
  }

  try {
    const record = finalizeConfigWriteAuditRecord(base, {
      result: writeOk ? "rename" : "failed",
      ...(errorCode !== undefined && { errorCode }),
      ...(errorMessage !== undefined && { errorMessage }),
    });
    const auditLogPath = resolveConfigAuditLogPath();
    const auditConfinedBase = getDefaultConfigAuditConfinedBase(auditLogPath);
    appendConfigAuditRecordSync({
      filePath: auditLogPath,
      record,
      // Confine the audit-log write to ~/.comis/ when the default log
      // path applies; skip confinement when the operator overrode
      // COMIS_CONFIG_AUDIT_LOG to a custom location (they own the
      // legitimacy of the override target).
      ...(auditConfinedBase !== undefined && {
        confinedBaseDir: auditConfinedBase,
      }),
    });
  } catch {
    // Audit append failed — swallow. The JSONL is a forensics aid.
  }

  if (!writeOk) {
    const result: WithAuditHookResult = { ok: false };
    if (errorCode !== undefined)
      (result as { errorCode?: string }).errorCode = errorCode;
    if (errorMessage !== undefined)
      (result as { errorMessage?: string }).errorMessage = errorMessage;
    return result;
  }
  return { ok: true };
}

/**
 * Async single-call audit-hook wrapper. Provided for symmetry with the
 * sync variant; async writers use `appendConfigAuditRecord` (async)
 * with `suppressError` for the JSONL append.
 */
export async function withAuditHook(
  params: WithAuditHookParams & {
    readonly write: () => void | Promise<void>;
    readonly logger?: ComisLogger;
  },
): Promise<WithAuditHookResult> {
  const auditEnabled = params.auditEnabled ?? true;

  if (!auditEnabled) {
    try {
      await params.write();
      return { ok: true };
    } catch (writeErr) {
      const errorCode = (writeErr as NodeJS.ErrnoException).code;
      const errorMessage = (writeErr as Error).message;
      const result: WithAuditHookResult = { ok: false };
      if (errorCode !== undefined)
        (result as { errorCode?: string }).errorCode = errorCode;
      if (errorMessage !== undefined)
        (result as { errorMessage?: string }).errorMessage = errorMessage;
      return result;
    }
  }

  const base = buildBaseFromProcess({
    source: params.source,
    configPath: params.auditConfigPath,
    entryScript: params.entryScript,
  });
  if (base === undefined) {
    try {
      await params.write();
      return { ok: true };
    } catch (writeErr) {
      const errorCode = (writeErr as NodeJS.ErrnoException).code;
      const errorMessage = (writeErr as Error).message;
      const result: WithAuditHookResult = { ok: false };
      if (errorCode !== undefined)
        (result as { errorCode?: string }).errorCode = errorCode;
      if (errorMessage !== undefined)
        (result as { errorMessage?: string }).errorMessage = errorMessage;
      return result;
    }
  }

  let writeOk = true;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  try {
    await params.write();
  } catch (writeErr) {
    writeOk = false;
    errorCode = (writeErr as NodeJS.ErrnoException).code;
    errorMessage = (writeErr as Error).message;
  }

  try {
    const record = finalizeConfigWriteAuditRecord(base, {
      result: writeOk ? "rename" : "failed",
      ...(errorCode !== undefined && { errorCode }),
      ...(errorMessage !== undefined && { errorMessage }),
    });
    const auditLogPath = resolveConfigAuditLogPath();
    const auditConfinedBase = getDefaultConfigAuditConfinedBase(auditLogPath);
    const appendPromise = appendConfigAuditRecord({
      filePath: auditLogPath,
      record,
      ...(auditConfinedBase !== undefined && {
        confinedBaseDir: auditConfinedBase,
      }),
    });
    if (params.logger !== undefined) {
      const logger = params.logger;
      suppressError(
        appendPromise,
        "best-effort config-audit append (withAuditHook)",
        (msg) => logger.debug({ method: "withAuditHook" }, msg),
      );
    } else {
      // No logger available — still swallow but without trace.
      suppressError(
        appendPromise,
        "best-effort config-audit append (withAuditHook)",
      );
    }
  } catch {
    // Audit-finalize failed — swallow.
  }

  if (!writeOk) {
    const result: WithAuditHookResult = { ok: false };
    if (errorCode !== undefined)
      (result as { errorCode?: string }).errorCode = errorCode;
    if (errorMessage !== undefined)
      (result as { errorMessage?: string }).errorMessage = errorMessage;
    return result;
  }
  return { ok: true };
}
