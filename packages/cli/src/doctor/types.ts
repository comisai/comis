// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor diagnostic type system.
 *
 * Defines the core interfaces for health check findings, checks,
 * diagnostic context, and aggregated results. Used by the check runner,
 * individual checks, repair modules, and output formatters.
 *
 * @module
 */

import type { AppConfig, UnresolvedEnvRef } from "@comis/core";

/** Status of a single doctor finding. */
export type DoctorStatus = "pass" | "fail" | "warn" | "skip";

/**
 * Outcome of the single, store-aware config resolution every doctor check
 * consumes (see `config-resolve.ts`).
 *
 * Exactly one of three shapes:
 * - `loadError` set — the file never made it to validation (missing,
 *   unparseable YAML, or not an object document);
 * - `validationIssues` set — the file parsed but the schema rejected it
 *   *after* `${VAR}` substitution; `unresolvedRefs` names any references
 *   neither env, `~/.comis/.env`, nor the encrypted secret store resolved
 *   (the usual root cause of placeholder-shaped validation noise);
 * - `config` set — the config the daemon would boot with.
 */
export interface DoctorConfigResolution {
  readonly config?: AppConfig;
  readonly foundPath?: string;
  readonly loadError?: {
    readonly kind: "missing" | "unparseable" | "not-object";
    readonly message: string;
  };
  readonly unresolvedRefs?: readonly UnresolvedEnvRef[];
  readonly validationIssues?: readonly string[];
}

/**
 * A single finding produced by a doctor check.
 *
 * Each finding has a category, check name, status, human-readable message,
 * optional suggestion, and whether it can be auto-repaired.
 */
export interface DoctorFinding {
  readonly category: string;
  readonly check: string;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly suggestion?: string;
  readonly repairable: boolean;
  /**
   * Numeric seconds until profile expiry.
   *
   * Exposed as a structured numeric so JSON-format consumers (log
   * aggregators, dashboards) can compare it against thresholds without
   * parsing the human-readable `message` string. Only `oauth-health.ts`
   * `profileExpiryFinding` populates this; all other doctor-check findings
   * leave it undefined. Value is `Math.floor(msUntilExpiry / 1000)`
   * (negative for already-expired profiles to preserve sign-of-direction).
   */
  readonly secsUntilExpiry?: number;
}

/**
 * A doctor check that can be executed against a diagnostic context.
 *
 * Each check has an ID, human-readable name, and a run function
 * that returns zero or more findings.
 */
export interface DoctorCheck {
  readonly id: string;
  readonly name: string;
  readonly run: (context: DoctorContext) => Promise<DoctorFinding[]>;
}

/**
 * Context passed to each doctor check during diagnostics.
 *
 * Provides the parsed config (if available), config file paths,
 * data directory, daemon PID file path, and optional gateway URL.
 */
export interface DoctorContext {
  readonly config?: AppConfig;
  /**
   * Full outcome of the shared config resolution, including WHY `config`
   * is absent when it is (load error, unresolved secret refs, validation
   * issues). Checks that skip on a missing `config` must consult this so
   * their skip message names the real cause instead of claiming nothing
   * is configured (live finding, 2026-06-12 C1 smoke run).
   */
  readonly configResolution?: DoctorConfigResolution;
  readonly configPaths: string[];
  readonly dataDir: string;
  readonly daemonPidFile: string;
  readonly gatewayUrl?: string;
  /**
   * Opt-in refresh-test toggle from the `--refresh-test` flag on
   * `comis doctor`. When true, the OAuth health check performs a real
   * refresh against the provider per profile -- a side effect that rotates
   * the refresh token at OpenAI's end (default OFF; --help warns the
   * operator).
   */
  readonly refreshTest?: boolean;
}

/**
 * Aggregated result of running all doctor checks.
 *
 * Includes all findings in check order, summary counts by status,
 * and a count of findings that can be auto-repaired.
 */
export interface DoctorResult {
  readonly findings: readonly DoctorFinding[];
  readonly checksRun: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly warnCount: number;
  readonly skipCount: number;
  readonly repairableCount: number;
}
