// SPDX-License-Identifier: Apache-2.0
/**
 * Pure triage reducer for the support bundle — signal derivation and summary.
 *
 * Signals are keyed on each finding's `category` + `status` (with the `check`
 * label splitting the config sub-cases), never on a check id: the id is absent
 * from the findings a reducer receives, so keying on it would silently yield an
 * empty signal set on a broken install.
 *
 * @module
 */

import type { DoctorFinding, DoctorResult } from "../doctor/types.js";
import type { SupportTriage } from "./types.js";

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
