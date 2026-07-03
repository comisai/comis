// SPDX-License-Identifier: Apache-2.0
/**
 * Bootstrap-time config observe emitters.
 * Extracted from packages/daemon/src/daemon.ts (originally part of the
 * deleted stage-helpers layer) during stage decomposition collapse.
 * These 3 ConfigObserve symbols live here because they are the ONLY
 * external test consumer of any former stage-helper (consumed by
 * daemon-config-observe.test.ts).
 */

import {
  appendConfigObserveAuditRecord,
  createConfigObserveAuditRecord,
  resolveConfigAuditLogPath,
  getDefaultConfigAuditConfinedBase,
} from "@comis/observability";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readConfigFileObservation, type ConfigFileObservation } from "./read-config-file-observation.js";

// ---------------------------------------------------------------------------
// Emit config.observe records at daemon bootstrap config-read path. Each
// record carries the full forensics shape (file-stat + LKG +
// backup + recovery). Dispatch model: `Promise.allSettled` so a single
// append failure cannot abort daemon boot.
// ---------------------------------------------------------------------------

/** Parameters for `emitBootstrapConfigObserveRecords`. */
export interface EmitBootstrapConfigObserveRecordsParams {
  /**
   * File-state observations, one per *requested* config path
   * (NOT one per existing path — missing paths produce `exists:false`
   * records). Built by the daemon's `readConfigFileObservation`
   * aggregator BEFORE the `existsSync` filter at the call site.
   */
  readonly observations: readonly ConfigFileObservation[];
  /**
   * Per-path validity bit. The daemon-bootstrap caller builds this
   * from the monolithic `bootResult.ok`: every path in a failed boot
   * gets `valid:false`; in a successful boot every path gets
   * `valid:true`. Per-file Zod-error granularity is intentionally out
   * of scope (the boot result is monolithic across all configPaths).
   * Missing entries default to `true` (defensive).
   */
  readonly validityByPath: ReadonlyMap<string, boolean>;
  /**
   * Optional override for the audit-log path. Production callers omit
   * this and let the helper resolve it via `resolveConfigAuditLogPath`
   * (which honors `COMIS_CONFIG_AUDIT_LOG`). Tests pass an explicit
   * path so they don't write into the real `~/.comis/`.
   */
  readonly auditLogPath?: string;
  /**
   * Optional override for the confinement base. Production callers
   * omit this and let the helper compute it via
   * `getDefaultConfigAuditConfinedBase`. Tests pass an explicit base
   * tied to the test's tmp dir.
   */
  readonly confinedBaseDir?: string;
}

/**
 * Aggregate the bootstrap config-read step: build observations
 * for every requested path (BEFORE the existsSync filter), filter
 * existing paths for the actual bootstrap call, run `_bootstrap`,
 * build the coarse per-path validity map, and emit the
 * `event:config.observe` audit records — all in one call.
 *
 * Returns the bootstrap result and the existing config-paths array so
 * the caller can continue with secret-ref resolution / container
 * construction. Observe-record emission happens BEFORE the caller
 * throws on `bootResult.ok === false` (the forensics record is
 * precisely what's wanted when boot fails).
 */
export async function runConfigBootstrapAndEmitObserve<TBoot>(params: {
  readonly requestedConfigPaths: readonly string[];
  readonly mergedEnv: Record<string, string | undefined>;
  readonly bootstrap: (input: {
    configPaths: string[];
    env: Record<string, string | undefined>;
  }) => { ok: true; value: TBoot } | { ok: false; error: { message: string } };
}): Promise<{
  configPaths: string[];
  bootResult: { ok: true; value: TBoot } | { ok: false; error: { message: string } };
}> {
  const observations = params.requestedConfigPaths.map((p) =>
    readConfigFileObservation(p),
  );
  const configPaths = params.requestedConfigPaths.filter((p) => existsSync(p));
  const bootResult = params.bootstrap({
    configPaths,
    env: params.mergedEnv,
  });
  const validityByPath = new Map(
    params.requestedConfigPaths.map((p) => [p, bootResult.ok] as const),
  );
  await emitBootstrapConfigObserveRecords({ observations, validityByPath });
  return { configPaths, bootResult };
}

/**
 * Emit one `event: "config.observe"` audit-log record per observation
 * (one per *requested* config path, including missing ones). Each
 * record carries the forensics shape projected from the
 * observation cluster (file-stat block + LKG triple + backup triple)
 * plus the per-path validity bit.
 *
 * Dispatch model: `Promise.allSettled` over per-path appends so a
 * single failure (audit log unwritable, dir permission, ENOSPC) does
 * not propagate and abort daemon startup. The audit log is a
 * forensics aid, not a correctness gate.
 *
 * No-op when `observations` is empty — the daemon may legitimately
 * bootstrap with no config files when the operator hasn't seeded
 * any (the build of `AppConfig` falls back to schema defaults).
 */
export async function emitBootstrapConfigObserveRecords(
  params: EmitBootstrapConfigObserveRecordsParams,
): Promise<void> {
  if (params.observations.length === 0) return;

  const auditLogPath = params.auditLogPath ?? resolveConfigAuditLogPath();
  const confinedBaseDir =
    params.confinedBaseDir ?? getDefaultConfigAuditConfinedBase(auditLogPath);

  const appendPromises = params.observations.map(async (obs) => {
    // Default-true validity when the map omits a path — defensive: a
    // missing entry shouldn't cascade into `valid:false`.
    const valid = params.validityByPath.get(obs.configPath) ?? true;
    const record = createConfigObserveAuditRecord({
      filePath: obs.configPath,
      callerSource: "daemon-bootstrap",
      observation: {
        exists: obs.exists,
        snapshot: obs.snapshot,
        lkg: obs.lkg,
        backup: obs.backup,
      },
      valid,
      entryScript: fileURLToPath(import.meta.url),
    });
    return appendConfigObserveAuditRecord({
      filePath: auditLogPath,
      record,
      ...(confinedBaseDir !== undefined
        ? { confinedBaseDir }
        : {}),
    });
  });

  // Settle all appends — failures are recorded in the returned
  // results but never thrown back at the caller. Audit failures at
  // boot are non-fatal.
  await Promise.allSettled(appendPromises);
}
