// SPDX-License-Identifier: Apache-2.0
/**
 * Offline orchestrator for the support bundle — where the content-free pieces
 * become a working, safe bundle against a dead daemon.
 *
 * `generateSupportBundle(deps)` composes the collection + reduction + render +
 * safe-write chain with no live daemon required:
 *  1. collect the content-free host snapshot (best-effort daemon-version probe,
 *     short-circuited when the daemon is down),
 *  2. build a local doctor context and run the nine health checks daemon-down,
 *  3. fold the aggregate into the deterministic triage verdict,
 *  4. shape `doctor.json`, render the issue summary,
 *  5. write the four-file bundle through the symlink-safe writer.
 *
 * Everything is `Result`-chained: the orchestrator throws nothing (the command
 * that invokes it owns the throw boundary and surfaces the completion/failure
 * line). A section that cannot be produced folds into a bundle warning and the
 * run continues (partial output); only an unproducible bundle directory is a
 * hard `err`, carrying an `errorKind` + operator `hint` so the boundary can log
 * an actionable failure.
 *
 * The nine checks are composed here from the individually-exported check consts,
 * and the doctor context is built locally (mirroring the doctor command's
 * derivation, including the wildcard-bind → loopback remap): the command's
 * `ALL_CHECKS` array and context builder are non-exported locals, and extracting
 * them would rewire the unrelated health command — out of scope. Only the
 * store-aware config resolver is reused.
 *
 * @module
 */

import { safePath } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";

import { runDoctorChecks } from "../doctor/check-runner.js";
import { configHealthCheck } from "../doctor/checks/config-health.js";
import { daemonHealthCheck } from "../doctor/checks/daemon-health.js";
import { gatewayHealthCheck } from "../doctor/checks/gateway-health.js";
import { versionSkewHealthCheck } from "../doctor/checks/version-skew-health.js";
import { channelHealthCheck } from "../doctor/checks/channel-health.js";
import { workspaceHealthCheck } from "../doctor/checks/workspace-health.js";
import { oauthHealthCheck } from "../doctor/checks/oauth-health.js";
import { secretsAuditHealthCheck } from "../doctor/checks/secrets-audit-health.js";
import { lcdHealthCheck } from "../doctor/checks/lcd-health.js";
import { resolveDoctorConfig } from "../doctor/config-resolve.js";
import { buildDoctorJson } from "../doctor/output.js";
import { readCliVersion } from "../util/cli-version.js";
import type { DoctorCheck, DoctorContext, DoctorResult } from "../doctor/types.js";

import { buildSupportTriage } from "./triage.js";
import { collectHostSnapshot, type CollectHostSnapshotDeps } from "./host-snapshot.js";
import { renderIssueSummary } from "./render-issue.js";
import { writeSupportBundle } from "./writer.js";
import type { SupportBundleWarning } from "./types.js";

/**
 * The nine health checks, composed in the same execution order the doctor
 * command runs — config, daemon, gateway, version skew, channels, workspace,
 * OAuth, secrets audit, and the LCD store. All run daemon-down by design.
 */
const SUPPORT_BUNDLE_CHECKS: readonly DoctorCheck[] = [
  configHealthCheck,
  daemonHealthCheck,
  gatewayHealthCheck,
  versionSkewHealthCheck,
  channelHealthCheck,
  workspaceHealthCheck,
  oauthHealthCheck,
  secretsAuditHealthCheck,
  lcdHealthCheck,
];

/** Neutral aggregate used when the doctor evidence could not be assembled. */
const EMPTY_DOCTOR_RESULT: DoctorResult = {
  findings: [],
  checksRun: 0,
  passCount: 0,
  failCount: 0,
  warnCount: 0,
  skipCount: 0,
  repairableCount: 0,
};

/** Injectable seams + the caller-stamped generation instant for one bundle run. */
export interface GenerateSupportBundleDeps {
  /** Resolved data-dir root; the bundle is written under it. Injectable in tests. */
  readonly dataDir: string;
  /** Config file paths, resolved exactly as the doctor command resolves them. */
  readonly configPaths: string[];
  /**
   * Diagnostic window in hours. Accepted now so the command wiring stays stable;
   * not yet consumed for a fleet read (fleet composition arrives later).
   */
  readonly sinceHours: number;
  /** Generation instant in epoch ms — stamps the manifest and the bundle dir name. */
  readonly nowMs: number;
  /** Seeds the config resolver (temp fixtures in tests). */
  readonly readFile?: (path: string) => string;
  /** Forwarded to the host snapshot's best-effort daemon-version probe. */
  readonly isDaemonRunning?: (timeoutMs?: number) => Promise<boolean>;
  /** Forwarded to the host snapshot's best-effort daemon-version probe. */
  readonly withClient?: CollectHostSnapshotDeps["withClient"];
}

/** Success payload consumed by the command wiring. */
export interface GenerateSupportBundleResult {
  readonly bundleDir: string;
  readonly status: string;
  readonly activeSignals: string[];
  readonly warnings: SupportBundleWarning[];
}

/**
 * The one hard failure: the bundle directory itself could not be produced (a
 * symlinked slot, an ENOTDIR collision, a confinement escape). Carries an
 * `errorKind` + operator `hint` so the command boundary logs an actionable WARN.
 */
export interface GenerateSupportBundleError {
  readonly kind: "bundle-unproducible";
  readonly errorKind: "resource";
  readonly hint: string;
  readonly reason: string;
}

/** Best-effort human-readable reason from a Result error or thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "reason" in error) {
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  return String(error);
}

/**
 * Build the doctor context locally: resolve the config through the shared
 * store-aware path, then derive the data dir, PID-file path, and gateway URL.
 *
 * The gateway URL derivation mirrors the doctor command's: `gw.host` is a bind
 * address, so the wildcard forms are remapped to loopback (`0.0.0.0` →
 * `127.0.0.1`, `::` → `::1`) before the connectivity probe targets them, and
 * `tls` selects the scheme. Exported so the remap is unit-pinned.
 *
 * @param configPaths - config file paths to resolve.
 * @param deps - the data-dir fallback and an optional config-read seam.
 * @returns the diagnostic context the nine checks consume.
 */
export function buildSupportDoctorContext(
  configPaths: string[],
  deps: { dataDir: string; readFile?: (path: string) => string },
): DoctorContext {
  const configResolution = resolveDoctorConfig(
    configPaths,
    deps.readFile !== undefined ? { readFile: deps.readFile } : {},
  );
  const config = configResolution.config;

  // An unset `dataDir` defaults to "" in the schema, so `||` falls through to
  // the injected root rather than an empty path.
  const dataDir = config?.dataDir || deps.dataDir;
  const daemonPidFile = safePath(dataDir, "daemon.pid");

  let gatewayUrl: string | undefined;
  if (config?.gateway) {
    const gw = config.gateway;
    const bindHost = gw.host || "127.0.0.1";
    const host = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
    const port = gw.port || 4766;
    const protocol = gw.tls ? "https" : "http";
    gatewayUrl = `${protocol}://${host}:${port}`;
  }

  return {
    config,
    configResolution,
    configPaths,
    dataDir,
    daemonPidFile,
    gatewayUrl,
    cliVersion: readCliVersion(),
  };
}

/**
 * Assemble the support bundle offline and return the outcome.
 *
 * Composes the host snapshot, the nine daemon-down checks, the deterministic
 * triage, the issue summary, and the safe write. Returns `ok` on a full or
 * partial write (section failures ride on `warnings`), and `err` only when the
 * bundle directory cannot be produced.
 *
 * @param deps - injectable seams plus the caller-stamped generation instant.
 * @returns `ok({ bundleDir, status, activeSignals, warnings })`, or
 *   `err({ kind: "bundle-unproducible", errorKind, hint, reason })`.
 */
export async function generateSupportBundle(
  deps: GenerateSupportBundleDeps,
): Promise<Result<GenerateSupportBundleResult, GenerateSupportBundleError>> {
  const sectionWarnings: SupportBundleWarning[] = [];

  // Host snapshot: content-free, best-effort, never throws. The liveness/RPC
  // hooks are forwarded so a dead daemon short-circuits with no socket.
  const snapshotDeps: CollectHostSnapshotDeps = {
    ...(deps.isDaemonRunning !== undefined ? { isDaemonRunning: deps.isDaemonRunning } : {}),
    ...(deps.withClient !== undefined ? { withClient: deps.withClient } : {}),
  };
  const host = await collectHostSnapshot(snapshotDeps);

  // Doctor compose: build the local context and run the nine checks daemon-down.
  // Assembling the evidence is a section — a failure here is a warning, not a
  // crash, so the bundle still generates from whatever is available.
  let doctor: DoctorResult = EMPTY_DOCTOR_RESULT;
  try {
    const context = buildSupportDoctorContext(deps.configPaths, {
      dataDir: deps.dataDir,
      ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
    });
    doctor = await runDoctorChecks([...SUPPORT_BUNDLE_CHECKS], context);
  } catch (thrown) {
    sectionWarnings.push({
      source: "doctor",
      code: "doctor_run_failed",
      count: 1,
      message: `Doctor checks could not run: ${describeError(thrown)}`,
    });
  }

  // Pure assembly: the reducer verdict, the doctor.json shape, and the render.
  const triage = buildSupportTriage({ host, doctor });
  const doctorJson = buildDoctorJson(doctor);
  const issueSummaryMd = renderIssueSummary(triage);

  // Safe write: exactly the four allowlisted files through the symlink-safe
  // primitives with the redaction backstop. Section-level write failures fold
  // into warnings; only an unproducible bundle dir is a hard error.
  const writeResult = writeSupportBundle({
    dataDir: deps.dataDir,
    generatedAtMs: deps.nowMs,
    triage,
    issueSummaryMd,
    doctorJson,
    warnings: sectionWarnings,
  });
  if (!writeResult.ok) {
    return err({
      kind: "bundle-unproducible",
      errorKind: "resource",
      hint:
        "Ensure the data dir is writable and the support-bundles slot is a real " +
        "directory (not a symlink); check its ownership and permissions.",
      reason: writeResult.error.reason,
    });
  }

  return ok({
    bundleDir: writeResult.value.bundleDir,
    status: triage.status,
    activeSignals: triage.activeSignals,
    warnings: writeResult.value.warnings,
  });
}
