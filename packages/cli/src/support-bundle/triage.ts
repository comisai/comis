// SPDX-License-Identifier: Apache-2.0
/**
 * Pure triage reducer for the support bundle — the one genuinely new piece of
 * logic behind the machine-readable verdict.
 *
 * `buildSupportTriage(inputs)` folds a content-free `DoctorResult` (plus the
 * optional fleet/explain digests) into the deterministic `SupportTriage`
 * verdict. It performs no I/O, holds no clock, and calls no model — every read
 * happens in the caller and is passed in, so the same input always yields a
 * deeply-equal result (the machine-verdict contract).
 *
 * Two ordering contracts are load-bearing:
 *  - Signals are keyed on each finding's `category` + `status` (with the
 *    `check` label splitting the config sub-cases), never on a check id: the id
 *    is absent from the findings a reducer receives, so keying on it would
 *    silently yield an empty signal set on a broken install.
 *  - Status precedence is ordered first-match-wins, with `insufficient_evidence`
 *    ranked above `healthy` so an empty or offline read is never reported
 *    healthy.
 *
 * @module
 */

import type { FleetHealthReport, IncidentReport } from "@comis/core";
import type { DoctorFinding, DoctorResult } from "../doctor/types.js";
import type { HostSnapshot, SupportTriage, SupportTriageStatus } from "./types.js";

/**
 * Inputs to the reducer. `fleet`/`explain` are optional upstream verdicts that
 * later enrichment populates; they are declared now so the status rule can
 * already consume them without a schema change.
 */
export interface SupportTriageInputs {
  readonly host: HostSnapshot;
  readonly doctor: DoctorResult;
  readonly fleet?: FleetHealthReport;
  readonly explain?: IncidentReport;
}

// --- signal derivation -----------------------------------------------------

/**
 * Map one finding to its signal, or `undefined` when it carries none (passes,
 * skips, benign warns). The config fail sub-cases split on the `check` label:
 * "Config file parseable" is a corrupt/unreadable file; any other config fail
 * is a missing one.
 */
function signalForFinding(f: DoctorFinding): string | undefined {
  if (f.category === "config" && f.status === "fail") {
    return f.check === "Config file parseable" ? "config_corrupt" : "config_missing";
  }
  if (f.category === "config" && f.status === "warn" && f.check === "Config schema validation") {
    return "config_schema_invalid";
  }
  if (f.category === "daemon" && f.status === "warn") {
    return "daemon_down";
  }
  if (f.category === "daemon" && f.status === "fail") {
    return "daemon_stale_pid";
  }
  if (f.category === "gateway" && f.status === "fail") {
    return "gateway_unreachable";
  }
  // Any other failing category (oauth / version / channels / workspace /
  // secrets-audit / lcd) surfaces its category label verbatim.
  if (f.status === "fail") {
    return f.category;
  }
  return undefined;
}

/** Distinct active signals from a doctor result, order-stable (first seen wins). */
export function deriveDoctorSignals(doctor: DoctorResult): string[] {
  const seen = new Set<string>();
  const signals: string[] = [];
  for (const f of doctor.findings) {
    const signal = signalForFinding(f);
    if (signal !== undefined && !seen.has(signal)) {
      seen.add(signal);
      signals.push(signal);
    }
  }
  return signals;
}

/**
 * Fleet-sourced signals, consumed verbatim — every `finding.code` plus the
 * report's own `likelyRootCause.code` when it made a verdict. The reducer
 * forwards the fleet's short codes as-is (no curated allow-list, no threshold
 * re-derivation): the fleet owns its verdict, so a new finding code surfaces
 * without a change here. Order follows the report (findings, then the root
 * cause); the caller dedupes into the active-signal set.
 */
export function deriveFleetSignals(fleet: FleetHealthReport): string[] {
  const codes = fleet.findings.map((f) => f.code);
  if (fleet.likelyRootCause !== null) {
    codes.push(fleet.likelyRootCause.code);
  }
  return codes;
}

/**
 * Whether a fleet report carries positive operator evidence — at least one real
 * session or one diagnostic finding. Evidence is keyed on the
 * synthetic-EXCLUDED population (matching `sessions.total`), NOT on the
 * `coverage.sessionSummary.found` read breadcrumb: that flag is
 * synthetic-INCLUSIVE (`rows > 0` over the pre-exclusion row set), so a window
 * holding only synthetic/test rows would otherwise be mistaken for evidence and
 * let a thrown doctor run (zero passes) fall through to a false `healthy`. An
 * absent report (offline read, no fleet at all), a synthetic-only window, or a
 * coverage-empty one is treated as no evidence, so the status rules never
 * report `healthy` off a fleet that carries no real activity.
 */
export function fleetHasEvidence(fleet?: FleetHealthReport): boolean {
  return fleet !== undefined && (fleet.sessions.total > 0 || fleet.findings.length > 0);
}

/**
 * Content-free summary of the doctor aggregate. Counts are copied verbatim from
 * the `DoctorResult` (never recomputed); `failing` is the distinct set of
 * failing finding categories — the only per-check identity a pure reducer holds.
 */
export function buildDoctorSummary(doctor: DoctorResult): SupportTriage["doctorSummary"] {
  const failing = [
    ...new Set(doctor.findings.filter((f) => f.status === "fail").map((f) => f.category)),
  ];
  return {
    checksRun: doctor.checksRun,
    pass: doctor.passCount,
    warn: doctor.warnCount,
    fail: doctor.failCount,
    skip: doctor.skipCount,
    repairable: doctor.repairableCount,
    failing,
  };
}

/**
 * Content-free summary of the fleet aggregate — the five fields copied verbatim
 * from the `FleetHealthReport` (never recomputed). `degradedRate` and the root
 * `topErrorKinds`/`breakerTripTotal` are consumed as-is, `findingCodes` is the
 * finding codes in report order, and `likelyRootCause` collapses the report's
 * nullable verdict object to its code (or `null`).
 */
export function buildFleetSummary(fleet: FleetHealthReport): NonNullable<SupportTriage["fleetSummary"]> {
  return {
    degradedRate: fleet.sessions.degradedRate,
    topErrorKinds: fleet.topErrorKinds.map((e) => ({ kind: e.kind, count: e.count })),
    breakerTripTotal: fleet.breakerTripTotal,
    findingCodes: fleet.findings.map((f) => f.code),
    likelyRootCause: fleet.likelyRootCause !== null ? fleet.likelyRootCause.code : null,
  };
}

// --- status precedence -----------------------------------------------------

interface StatusContext {
  readonly doctor: DoctorResult;
  readonly signals: readonly string[];
  readonly fleet?: FleetHealthReport;
  readonly explain?: IncidentReport;
}

/**
 * Ordered, first-match-wins status rules — the precedence contract. The array
 * order is load-bearing: a config failure outranks every other signal, and
 * `insufficient_evidence` is evaluated before the `healthy` fallthrough so an
 * empty read is never reported healthy.
 */
const STATUS_RULES: ReadonlyArray<(ctx: StatusContext) => SupportTriageStatus | null> = [
  // 1. Any config-health failure -> misconfigured (outranks everything else).
  (ctx) =>
    ctx.doctor.findings.some((f) => f.category === "config" && f.status === "fail")
      ? "misconfigured"
      : null,
  // 2. Any other failure, a down daemon, or an upstream degraded / root-caused
  //    verdict -> degraded.
  (ctx) =>
    ctx.doctor.findings.some((f) => f.status === "fail") ||
    ctx.signals.includes("daemon_down") ||
    ctx.fleet?.likelyRootCause != null ||
    ctx.explain?.outcome?.degraded === true
      ? "degraded"
      : null,
  // 3. No positive evidence anywhere -> insufficient_evidence (ranked ABOVE
  //    healthy so an empty or offline read is never reported healthy). The
  //    fleet is now always passed, so an absent OR coverage-empty fleet both
  //    count as no evidence — never re-derive a fleet threshold here.
  (ctx) =>
    ctx.doctor.passCount === 0 && !fleetHasEvidence(ctx.fleet) && ctx.explain === undefined
      ? "insufficient_evidence"
      : null,
  // 4. Otherwise the read is positive and clean -> healthy.
  () => "healthy",
];

function deriveStatus(ctx: StatusContext): SupportTriageStatus {
  for (const rule of STATUS_RULES) {
    const status = rule(ctx);
    if (status !== null) {
      return status;
    }
  }
  return "healthy";
}

// --- next steps (reused; never a parallel remediation table) ---------------

const REPAIR_COMMAND = "comis doctor --repair";
const INIT_COMMAND = "comis init";
const MAX_NEXT_STEPS = 8;

/** Content-free follow-up commands for a maintainer drilling into the daemon. */
const MAINTAINER_NEXT_STEPS: readonly string[] = [
  "comis fleet --since 24",
  'comis explain "<sessionKey>"',
];

function dedupeCap(items: readonly string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}

/**
 * Reporter next steps REUSE each present `finding.suggestion` plus the two
 * standing repair commands — never a hand-authored remediation catalog. The
 * repair hint is added when the doctor found anything auto-repairable, and the
 * init hint when the config is missing.
 */
function buildReporterNextSteps(doctor: DoctorResult, signals: readonly string[]): string[] {
  const steps: string[] = [];
  for (const f of doctor.findings) {
    if (f.suggestion !== undefined && f.suggestion.length > 0) {
      steps.push(f.suggestion);
    }
  }
  if (doctor.repairableCount > 0) {
    steps.push(REPAIR_COMMAND);
  }
  if (signals.includes("config_missing")) {
    steps.push(INIT_COMMAND);
  }
  return dedupeCap(steps, MAX_NEXT_STEPS);
}

// --- evidence + privacy ----------------------------------------------------

/** The bundle's allowlisted output files, each with a content-free description. */
const EVIDENCE_FILES: ReadonlyArray<{ path: string; description: string }> = [
  { path: "issue-summary.md", description: "Human-readable triage summary for a bug report" },
  {
    path: "ai-issue-draft.md",
    description: "AI-fillable GitHub issue draft with the auto-known facts pre-filled",
  },
  { path: "triage.json", description: "Machine-readable triage verdict" },
  { path: "doctor.json", description: "Full diagnostic findings from the health checks" },
  { path: "fleet.json", description: "Cross-session fleet health digest (counts and short codes)" },
  {
    path: "config-posture.json",
    description: "Which config sections are present, plus flagged-key labels",
  },
  {
    path: "manifest.json",
    description: "Bundle index with the redaction fingerprint and any warnings",
  },
];

/** The enumerated exclusion set every downstream render and writer honors. */
const PRIVACY_EXCLUDES: readonly string[] = [
  "secrets",
  "raw-config-values",
  "message-bodies",
  "file-contents",
  ".env",
];

// --- reducer ---------------------------------------------------------------

/**
 * Fold the inputs into the deterministic triage verdict. Pure: no I/O, no
 * clock, no model. `generatedAt` is deliberately NOT stamped here — it lives
 * only on the bundle manifest so this verdict stays timestamp-free and
 * byte-stable across runs.
 */
export function buildSupportTriage(inputs: SupportTriageInputs): SupportTriage {
  const { host, doctor, fleet, explain } = inputs;
  // Doctor signals first, then fleet signals, deduped first-seen-wins: a fleet
  // code that repeats a doctor signal keeps the doctor entry's earlier slot.
  const activeSignals = [
    ...new Set([
      ...deriveDoctorSignals(doctor),
      ...(fleet !== undefined ? deriveFleetSignals(fleet) : []),
    ]),
  ];
  return {
    schemaVersion: 1,
    status: deriveStatus({ doctor, signals: activeSignals, fleet, explain }),
    activeSignals,
    host,
    doctorSummary: buildDoctorSummary(doctor),
    ...(fleet !== undefined ? { fleetSummary: buildFleetSummary(fleet) } : {}),
    reporterNextSteps: buildReporterNextSteps(doctor, activeSignals),
    maintainerNextSteps: [...MAINTAINER_NEXT_STEPS],
    evidenceFiles: EVIDENCE_FILES.map((file) => ({
      path: file.path,
      description: file.description,
    })),
    privacy: { redaction: "platform-aware-v1", excludes: [...PRIVACY_EXCLUDES] },
  };
}
