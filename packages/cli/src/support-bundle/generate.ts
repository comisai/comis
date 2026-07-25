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
 *  3. read the cross-session system digest over the --since window through the
 *     sanctioned offline seam, and build the config-posture membership digest,
 *  4. on --session, embed the offline IncidentReport (and, on --deep, resolve the
 *     real session file) and read the window-scoped audit {total,byKind} digest,
 *  5. fold the doctor aggregate + system + embedded explain into the triage verdict,
 *  6. shape `doctor.json`, render the issue summary and the AI issue draft,
 *  7. create the bundle dir, export the deep trace bundle into it (--deep), then
 *     write the up-to-nine-file bundle through the symlink-safe writer.
 *
 * Everything is `Result`-chained: the orchestrator throws nothing (the command
 * that invokes it owns the throw boundary and surfaces the completion/failure
 * line). A section that cannot be produced folds into a bundle warning and the
 * run continues (partial output); only an unproducible bundle directory is a
 * hard `err`, carrying an `errorKind` + operator `hint` so the boundary can log
 * an actionable failure.
 *
 * The nine daemon-down checks are composed here, while context construction is
 * shared with `doctor` and `health` so path, env, TLS, and bind-address semantics
 * cannot drift between diagnostic surfaces.
 *
 * @module
 */

import type { SystemHealthReport } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { exportTrajectoryBundle } from "@comis/observability";

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
import { buildDiagnosticContext } from "../doctor/diagnostic-suite.js";
import { buildDoctorJson } from "../doctor/output.js";
import {
  assembleSystemHealthReportOffline,
  readAuditSummaryOffline,
  suggestWorstSessionOffline,
} from "../util/offline-obs.js";
import type { DoctorCheck, DoctorContext, DoctorResult } from "../doctor/types.js";

import { buildSupportTriage } from "./triage.js";
import { buildConfigPosture } from "./config-posture.js";
import { collectHostSnapshot, type CollectHostSnapshotDeps } from "./host-snapshot.js";
import { embedSession, type EmbedSessionResult } from "./session-embed.js";
import { renderIssueSummary } from "./render-issue.js";
import { renderAiIssueDraft } from "./render-ai-draft.js";
import { writeSupportBundle, ensureSupportBundleDir } from "./writer.js";
import type { SupportBundleWarning, ConfigPostureDigest, AuditSummary } from "./types.js";

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
  /** Diagnostic window in hours — the span the system digest is assembled over. */
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
   * The system-report assembler, defaulting to the sanctioned offline seam
   * (`assembleSystemHealthReportOffline`). Injected in tests with a hermetic
   * fixture so a unit run never loads the @comis/daemon runtime graph the offline
   * seam dynamic-imports. Matches the injected-seam style of `readFile`,
   * `isDaemonRunning`, and `withClient`.
   */
  readonly assembleSystem?: (dataDir: string, sinceHours: number) => Promise<SystemHealthReport>;
  /** The `--session <ref>` argument (sessionKey | traceId | rootRunId) when focusing on one session. */
  readonly session?: string;
  /** Whether `--deep` was requested — embeds the per-session trace bundle (requires `--session`). */
  readonly deep?: boolean;
  /**
   * The `--session`/`--deep` embed engine, defaulting to the real `embedSession`
   * (which assembles the offline IncidentReport and resolves the deep session
   * file through the pointer seam). Injected in tests so a unit run never loads
   * the @comis/daemon runtime graph the offline assembler dynamic-imports.
   */
  readonly embedSessionFn?: typeof embedSession;
  /**
   * The offline audit `{ total, byKind }` window read, defaulting to
   * `readAuditSummaryOffline`. Reads the local observability store directly (no
   * daemon); a missing/unreadable store returns `undefined` → a manifest warning.
   */
  readonly readAudit?: typeof readAuditSummaryOffline;
  /**
   * The trajectory-bundle exporter, defaulting to the real `exportTrajectoryBundle`.
   * Injected in tests so `--deep` unit runs stay hermetic (the real exporter opens
   * the session DAG through the pi SDK SessionManager).
   */
  readonly exportTrace?: typeof exportTrajectoryBundle;
  /**
   * The CLI-side worst-session ranking, defaulting to `suggestWorstSessionOffline`.
   * Best-effort, offline, soft-failing; surfaces a hint when no `--session` is given.
   */
  readonly suggestWorst?: typeof suggestWorstSessionOffline;
}

/** Success payload consumed by the command wiring. */
export interface GenerateSupportBundleResult {
  readonly bundleDir: string;
  readonly status: string;
  readonly activeSignals: string[];
  readonly warnings: SupportBundleWarning[];
  /**
   * The worst-session hint surfaced when no `--session` was given (the CLI-side
   * stopgap ranking). Omitted when a session was focused or none could be ranked.
   */
  readonly worstSessionKey?: string;
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
 * Build the support-bundle doctor context through the same resolver and runtime
 * path derivation used by the interactive diagnostic commands.
 *
 * @param configPaths - config file paths to resolve.
 * @param deps - the data-dir fallback and an optional config-read seam.
 * @returns the diagnostic context the daemon-down checks consume.
 */
export function buildSupportDoctorContext(
  configPaths: string[],
  deps: { dataDir: string; readFile?: (path: string) => string },
): DoctorContext {
  return buildDiagnosticContext(configPaths, {
    defaultDataDir: deps.dataDir,
    ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
  });
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

  // System compose: assemble the cross-session digest over the --since window
  // through the sanctioned offline seam (dead-daemon capable). A throw folds into
  // a warning and omits system-health.json; a coverage-empty read keeps the valid empty
  // report (still written) but records an honest warning. Never a crash.
  const assembleSystem = deps.assembleSystem ?? assembleSystemHealthReportOffline;
  let system: SystemHealthReport | undefined;
  try {
    system = await assembleSystem(deps.dataDir, deps.sinceHours);
  } catch (thrown) {
    sectionWarnings.push({
      source: "system",
      code: "system_read_failed",
      count: 1,
      message: `System health report could not be assembled: ${describeError(thrown)}`,
    });
  }
  if (
    system !== undefined &&
    system.coverage?.sessionSummary.found === false &&
    system.sessions.total === 0
  ) {
    sectionWarnings.push({
      source: "system",
      code: "system_store_empty",
      count: 1,
      message:
        "System health store held no session summaries in the window; the report is " +
        "empty and its coverage block reports the gap.",
    });
  }

  // Config-posture compose: the membership digest from the RAW top-level config
  // keys the resolver captured (never the fully-defaulted validated config, which
  // reports every section present). A config that did not parse to an object has
  // no raw keys — omit the file and warn; the parse failure already surfaces as
  // config_corrupt from the doctor run. The system config_posture finding's closed
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
    configPosture = buildConfigPosture(resolution.rawTopLevelKeys, system?.findings ?? []);
  }

  // Session embed: on --session, assemble the offline IncidentReport and — on
  // --deep — resolve the real session file through the pointer seam. The engine
  // never throws: a bad ref folds into an "explain"/"trace-export" warning and the
  // core bundle still generates.
  let embed: EmbedSessionResult | undefined;
  if (deps.session !== undefined) {
    embed = await (deps.embedSessionFn ?? embedSession)({
      ref: deps.session,
      deep: deps.deep ?? false,
      dataDir: deps.dataDir,
    });
    sectionWarnings.push(...embed.warnings);
  }

  // Audit compose: always attempt the window-scoped {total,byKind} read from the
  // offline store. A missing/unreadable store returns undefined — omit
  // audit-summary.json and record an honest warning (never a crash).
  const auditSummary: AuditSummary | undefined = (deps.readAudit ?? readAuditSummaryOffline)(
    deps.dataDir,
    deps.sinceHours,
    deps.nowMs,
  );
  if (auditSummary === undefined) {
    sectionWarnings.push({
      source: "audit",
      code: "audit_store_unreadable",
      count: 1,
      message:
        "Audit-summary omitted: the observability store was absent or unreadable, so the " +
        "window audit counts could not be read.",
    });
  }

  // Worst-session hint (the CLI-side stopgap): only when NOT focusing a session,
  // rank the local rollups so the command can tip the operator at a session to
  // drill into. Best-effort — an empty or unreadable tree yields no hint.
  let worstSessionKey: string | undefined;
  if (deps.session === undefined) {
    worstSessionKey = (deps.suggestWorst ?? suggestWorstSessionOffline)(deps.dataDir);
  }

  // Pure assembly: the system- and explain-enriched reducer verdict, the doctor.json
  // shape, and the render. System/explain are passed only when present so their
  // summaries are omitted when the section could not be produced (status rule 2
  // honors an embedded explain.outcome.degraded).
  const triage = buildSupportTriage({
    host,
    doctor,
    ...(system !== undefined ? { system } : {}),
    ...(embed?.explain !== undefined ? { explain: embed.explain } : {}),
  });
  const doctorJson = buildDoctorJson(doctor);
  const issueSummaryMd = renderIssueSummary(triage);
  const aiIssueDraftMd = renderAiIssueDraft(triage);

  // Create the bundle dir FIRST (ordering is load-bearing): the trace export
  // writes INTO it and its warning must reach the manifest, so the dir must exist
  // before both the exporter and the writer's manifest write. An unproducible dir
  // is the one hard error (a symlinked slot, an ENOTDIR collision, an escape).
  const dir = ensureSupportBundleDir(deps.dataDir, deps.nowMs);
  if (!dir.ok) {
    return err({
      kind: "bundle-unproducible",
      errorKind: "resource",
      hint:
        "Ensure the data dir is writable and the support-bundles slot is a real " +
        "directory (not a symlink); check its ownership and permissions.",
      reason: dir.error.reason,
    });
  }
  const bundleDir = dir.value;

  // Trace export: with --deep and a resolved deep session file, embed the 8-file
  // per-session bundle by pointing the exporter's workspaceDir at the bundle dir
  // (no copy — it derives its own trace-exports/ output dir from there and applies
  // its OWN platform-aware redaction, which the support-bundle does not re-process).
  // This runs BEFORE the writer's manifest write so a failure lands in the manifest;
  // the clock is stamped from deps.nowMs for determinism.
  if (deps.deep === true && embed?.explain !== undefined && embed.deepSessionFile !== undefined) {
    const explain = embed.explain;
    const exportTrace = deps.exportTrace ?? exportTrajectoryBundle;
    const traceResult = await exportTrace({
      sessionId: explain.sessionKey,
      sessionKey: explain.sessionKey,
      sessionFile: embed.deepSessionFile,
      workspaceDir: bundleDir,
      traceId: explain.traceId,
      agentId: explain.agentId,
      clock: () => deps.nowMs,
    });
    if (!traceResult.ok) {
      sectionWarnings.push({
        source: "trace-export",
        code: "trace_export_failed",
        count: 1,
        message: `The deep trace export could not be produced: ${traceResult.error.kind}.`,
      });
    }
  }

  // Safe write: the up-to-nine allowlisted files through the symlink-safe
  // primitives with the redaction backstop, into the pre-created bundle dir.
  // system-health.json/config-posture.json/audit-summary.json ride the trusted leaf and
  // explain.json rides the untrusted value-shape leaf; each is written only when
  // defined. Section-level write failures fold into warnings.
  const writeResult = writeSupportBundle({
    dataDir: deps.dataDir,
    generatedAtMs: deps.nowMs,
    bundleDir,
    triage,
    issueSummaryMd,
    aiIssueDraftMd,
    doctorJson,
    systemJson: system,
    configPostureJson: configPosture,
    explainJson: embed?.explain,
    auditSummaryJson: auditSummary,
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
    ...(worstSessionKey !== undefined ? { worstSessionKey } : {}),
  });
}
