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
 *  3. read the cross-session fleet digest over the --since window through the
 *     sanctioned offline seam, and build the config-posture membership digest,
 *  4. fold the doctor aggregate + fleet into the deterministic triage verdict,
 *  5. shape `doctor.json`, render the issue summary and the AI issue draft,
 *  6. write the up-to-seven-file bundle through the symlink-safe writer.
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
import type { FleetHealthReport } from "@comis/core";
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
import { assembleFleetHealthReportOffline } from "../util/offline-obs.js";
import type { DoctorCheck, DoctorContext, DoctorResult } from "../doctor/types.js";

import { buildSupportTriage } from "./triage.js";
import { buildConfigPosture } from "./config-posture.js";
import { collectHostSnapshot, type CollectHostSnapshotDeps } from "./host-snapshot.js";
import { renderIssueSummary } from "./render-issue.js";
import { renderAiIssueDraft } from "./render-ai-draft.js";
import { writeSupportBundle } from "./writer.js";
import type { SupportBundleWarning, ConfigPostureDigest } from "./types.js";

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
  /** Diagnostic window in hours — the span the fleet digest is assembled over. */
  readonly sinceHours: number;
  /** Generation instant in epoch ms — stamps the manifest and the bundle dir name. */
  readonly nowMs: number;
  /** Seeds the config resolver (temp fixtures in tests). */
  readonly readFile?: (path: string) => string;
  /** Forwarded to the host snapshot's best-effort daemon-version probe. */
  readonly isDaemonRunning?: (timeoutMs?: number) => Promise<boolean>;
  /** Forwarded to the host snapshot's best-effort daemon-version probe. */
  readonly withClient?: CollectHostSnapshotDeps["withClient"];
  /**
   * The fleet-report assembler, defaulting to the sanctioned offline seam
   * (`assembleFleetHealthReportOffline`). Injected in tests with a hermetic
   * fixture so a unit run never loads the @comis/daemon runtime graph the offline
   * seam dynamic-imports. Matches the injected-seam style of `readFile`,
   * `isDaemonRunning`, and `withClient`.
   */
  readonly assembleFleet?: (dataDir: string, sinceHours: number) => Promise<FleetHealthReport>;
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

  // Doctor compose: build the local context ONCE — the config resolution feeds
  // both the checks and the config-posture digest, so the config is resolved a
  // single time. `buildSupportDoctorContext` resolves through the never-throw
  // resolver and is safe outside the try; only `runDoctorChecks` can throw, and a
  // failure there is a warning, not a crash, so the bundle still generates.
  const context = buildSupportDoctorContext(deps.configPaths, {
    dataDir: deps.dataDir,
    ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
  });
  let doctor: DoctorResult = EMPTY_DOCTOR_RESULT;
  try {
    doctor = await runDoctorChecks([...SUPPORT_BUNDLE_CHECKS], context);
  } catch (thrown) {
    sectionWarnings.push({
      source: "doctor",
      code: "doctor_run_failed",
      count: 1,
      message: `Doctor checks could not run: ${describeError(thrown)}`,
    });
  }

  // Fleet compose: assemble the cross-session digest over the --since window
  // through the sanctioned offline seam (dead-daemon capable). A throw folds into
  // a warning and omits fleet.json; a coverage-empty read keeps the valid empty
  // report (still written) but records an honest warning. Never a crash.
  const assembleFleet = deps.assembleFleet ?? assembleFleetHealthReportOffline;
  let fleet: FleetHealthReport | undefined;
  try {
    fleet = await assembleFleet(deps.dataDir, deps.sinceHours);
  } catch (thrown) {
    sectionWarnings.push({
      source: "fleet",
      code: "fleet_read_failed",
      count: 1,
      message: `Fleet health report could not be assembled: ${describeError(thrown)}`,
    });
  }
  if (
    fleet !== undefined &&
    fleet.coverage?.sessionSummary.found === false &&
    fleet.sessions.total === 0
  ) {
    sectionWarnings.push({
      source: "fleet",
      code: "fleet_store_empty",
      count: 1,
      message:
        "Fleet health store held no session summaries in the window; the report is " +
        "empty and its coverage block reports the gap.",
    });
  }

  // Config-posture compose: the membership digest from the RAW top-level config
  // keys the resolver captured (never the fully-defaulted validated config, which
  // reports every section present). A config that did not parse to an object has
  // no raw keys — omit the file and warn; the parse failure already surfaces as
  // config_corrupt from the doctor run. The fleet config_posture finding's closed
  // labels + count ride along when present.
  const resolution = context.configResolution;
  let configPosture: ConfigPostureDigest | undefined;
  if (resolution?.loadError !== undefined || resolution?.rawTopLevelKeys === undefined) {
    sectionWarnings.push({
      source: "config-posture",
      code: "config_unreadable",
      count: 1,
      message: "Config-posture digest omitted: the config could not be read as a section map.",
    });
  } else {
    configPosture = buildConfigPosture(resolution.rawTopLevelKeys, fleet?.findings ?? []);
  }

  // Pure assembly: the fleet-enriched reducer verdict, the doctor.json shape, and
  // the render. Fleet is passed only when present so its summary is omitted on a
  // thrown read.
  const triage = buildSupportTriage({
    host,
    doctor,
    ...(fleet !== undefined ? { fleet } : {}),
  });
  const doctorJson = buildDoctorJson(doctor);
  const issueSummaryMd = renderIssueSummary(triage);
  const aiIssueDraftMd = renderAiIssueDraft(triage);

  // Safe write: the up-to-seven allowlisted files through the symlink-safe
  // primitives with the redaction backstop. fleet.json + config-posture.json ride
  // the writer's trusted-leaf path and are each written only when defined.
  // Section-level write failures fold into warnings; only an unproducible bundle
  // dir is a hard error.
  const writeResult = writeSupportBundle({
    dataDir: deps.dataDir,
    generatedAtMs: deps.nowMs,
    triage,
    issueSummaryMd,
    aiIssueDraftMd,
    doctorJson,
    fleetJson: fleet,
    configPostureJson: configPosture,
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
