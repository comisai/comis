// SPDX-License-Identifier: Apache-2.0
/**
 * Two-phase config-audit hook helpers for the config.patch RPC.
 * Extracted from config-write.ts to keep that file under the 400-line
 * per-subdir cap.
 *
 * Two entry points:
 *   - `buildConfigAuditBase(localPath)` — capture pre-write state.
 *     Returns `undefined` on construction failure (best-effort).
 *   - `appendConfigAuditWithOutcome(base, outcome, logger)` —
 *     finalize + append the record. Audit-write failures swallowed
 *     via suppressError.
 *
 * @module
 */

import { suppressError } from "@comis/shared";
import {
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  appendConfigAuditRecord,
  resolveConfigAuditLogPath,
  getDefaultConfigAuditConfinedBase,
  type ConfigWriteAuditRecordBase,
} from "@comis/observability";
import type { ComisLogger } from "@comis/core";

/**
 * Outcome of the config-write attempt, derived in the calling
 * handler from `(wroteFile, writeError)`.
 *
 * Fix D1 (log-review): `rejected` carries an optional `message` so
 * the validator's rejection reason can be threaded through to the
 * persisted `errorMessage` field on ConfigWriteAuditRecord. Pre-fix
 * `rejected` swallowed the reason — operators saw "result: rejected"
 * but had to grep daemon logs separately for the validator text.
 */
export type ConfigAuditOutcome =
  | { kind: "rename" }
  | { kind: "failed"; code?: string; message?: string }
  | { kind: "rejected"; message?: string };

/**
 * Build the audit-record base for the in-flight config.patch RPC.
 * Returns `undefined` when the base construction itself fails (e.g.,
 * stat permission issues on the target path) — audit is best-effort.
 */
export function buildConfigAuditBase(
  localPath: string,
): ConfigWriteAuditRecordBase | undefined {
  try {
    return createConfigWriteAuditRecordBase({
      source: "config-patch-rpc",
      configPath: localPath,
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
    });
  } catch {
    return undefined;
  }
}

/**
 * Finalize + append a config-audit record. Audit failures swallowed.
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
