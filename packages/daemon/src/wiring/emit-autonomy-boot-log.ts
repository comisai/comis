// SPDX-License-Identifier: Apache-2.0
/**
 * `emitAutonomyBootLog` — the legible resolved-autonomy boot-log emission
 * (PROFILE-03 / 210-06), extracted from `daemon.ts`'s `emitStartupBanner`
 * WITHOUT behavior change (daemon.ts line-cap, arch invariant ≤ 3000).
 *
 * Emits one INFO line per agent stating the resolved autonomy profile, the
 * caps it enabled, the budget ceiling, and the ONE field to change it
 * (`autonomy.profile`) plus the M1 over-grant notice; then, when the host
 * namespace preflight failed, a single WARN naming the downshift to the
 * `assistant` profile (a doctor finding — autonomy degrades, the daemon still
 * serves; no silent unjailed fallback). Promoted to INFO per CLAUDE.md: an
 * operator must read what each agent was granted, and how to change it, from
 * boot logs alone — without `logLevel: debug`.
 *
 * @module
 */

import { buildAutonomyBootLog, buildNamespaceDownshiftFinding } from "./preflight-doctor.js";
import type { LoggingResult } from "./setup-logging.js";

/** Deps for {@link emitAutonomyBootLog} — the subset emitStartupBanner closes over. */
export interface AutonomyBootLogDeps {
  /** The module-bound daemon logger (the boot-banner sink). */
  readonly daemonLogger: LoggingResult["daemonLogger"];
  /** The daemon's agents config map (only `autonomy` is read). */
  readonly agents: Parameters<typeof buildAutonomyBootLog>[0];
  /**
   * PROFILE-03 host preflight RESULT — whether the unprivileged-user-namespace
   * preflight passed. Defaults to `true` in M1 (no probe yet); Phase 211
   * (JAIL-03) supplies the real value. `false` triggers the autonomy-downshift
   * WARN naming the fall to `assistant`.
   */
  readonly namespacePreflightOk?: boolean;
}

/**
 * Emit the per-agent autonomy INFO lines and the optional downshift WARN.
 *
 * The preflight RESULT is an input that defaults to OK in M1; the
 * bubblewrap/namespace probe that fills it is Phase 211 (JAIL-03), wired
 * through `namespacePreflightOk` without re-plumbing here.
 */
export function emitAutonomyBootLog(deps: AutonomyBootLogDeps): void {
  const { daemonLogger, agents } = deps;
  const namespacePreflightOk = deps.namespacePreflightOk ?? true;
  for (const rec of buildAutonomyBootLog(agents)) {
    // `submodule` (not `module`): the daemon logger already binds the parent
    // `module` field; a payload `module:` would duplicate it on the JSON line
    // (the no-restricted-syntax log-payload rule). `submodule` is the call-site
    // scope tag (CLAUDE.md logging fields).
    daemonLogger.info({
      agentId: rec.agentId, submodule: "autonomy",
      profile: rec.profile, enabled: rec.enabled, capabilities: rec.capabilities,
      aggregateBudgetUsd: rec.aggregateBudgetUsd, changeField: rec.changeField,
      ...(rec.m1Notice !== undefined ? { m1Notice: rec.m1Notice } : {}),
    }, "Resolved agent autonomy profile");
  }
  const downshiftFinding = buildNamespaceDownshiftFinding({ namespacePreflightOk });
  if (downshiftFinding) {
    daemonLogger.warn({
      submodule: "autonomy", errorKind: downshiftFinding.errorKind,
      hint: downshiftFinding.hint,
    }, downshiftFinding.message);
  }
}
