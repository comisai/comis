// SPDX-License-Identifier: Apache-2.0
/**
 * Pure triage reducer for the support bundle.
 *
 * (Work in progress — the signal derivation and summary land first.)
 *
 * @module
 */

import type { DoctorResult } from "../doctor/types.js";
import type { SupportTriage } from "./types.js";

/** Distinct active signals derived from a doctor result. */
export function deriveDoctorSignals(_doctor: DoctorResult): string[] {
  return [];
}

/** Content-free summary of the doctor aggregate. */
export function buildDoctorSummary(_doctor: DoctorResult): SupportTriage["doctorSummary"] {
  return { checksRun: 0, pass: 0, warn: 0, fail: 0, skip: 0, repairable: 0, failing: [] };
}
