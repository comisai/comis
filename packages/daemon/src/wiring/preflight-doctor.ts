// SPDX-License-Identifier: Apache-2.0
/**
 * Preflight native-dependency doctor — extracted from `daemon.ts` to keep the
 * composition root under its 3000-line architecture cap (the v2.25 audio wiring
 * pushed daemon.ts to 3001; this self-contained, behavior-neutral probe is the
 * natural extraction). `daemon.ts` re-exports `runPreflightDoctor` so its public
 * surface (and `daemon.test.ts`'s `import … from "./daemon.js"`) is unchanged.
 *
 * The timestamp is read via `@comis/core`'s `systemNowDate()` (the sanctioned
 * runtime-root clock indirection) rather than a bare `new Date()`: extracting
 * this probe out of the globals-exempt `daemon.ts` bootstrap root would
 * otherwise trip the `globals` architecture gate (Phase 196 CR-01). The helper
 * keeps the same wall-clock behavior while routing the read through the
 * classifier-exempt `packages/core/src/runtime/` root.
 *
 * @module
 */

import {
  systemNowDate,
  resolveAutonomy,
  degradeAutonomy,
  type AutonomyConfig,
  type AutonomyProfileName,
  type AgentCapability,
  type AutonomyPreflightResult,
} from "@comis/core";

interface PreflightProbeDatabase {
  prepare(sql: string): { get(): unknown };
  close(): void;
}
type PreflightDatabaseCtor = new (path: string) => PreflightProbeDatabase;

/**
 * Probe better-sqlite3 before any subsystem init. A missing transitive
 * `bindings` folder (known failure mode from partial npm upgrades) makes
 * better-sqlite3 throw at first require, which otherwise surfaces as an
 * opaque mid-boot crash and a systemd restart loop. Here we catch it up
 * front and exit 78 (EX_CONFIG) with an actionable hint, so operators can
 * repair instead of chasing a cascading failure.
 */
export async function runPreflightDoctor(
  exitFn: (code: number) => void,
  opts: {
    stderrWrite?: (s: string) => void;
    loadBetterSqlite3?: () => Promise<PreflightDatabaseCtor>;
  } = {},
): Promise<void> {
  const write = opts.stderrWrite ?? ((s: string) => { process.stderr.write(s); });
  const load = opts.loadBetterSqlite3
    ?? (async () => (await import("better-sqlite3")).default as unknown as PreflightDatabaseCtor);
  try {
    const Database = await load();
    const db = new Database(":memory:");
    try {
      const row = db.prepare("select 1 as ok").get();
      if (!row) throw new Error("better-sqlite3 returned no row from sentinel query");
    } finally {
      db.close();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    write(JSON.stringify({
      level: 60,
      time: systemNowDate().toISOString(),
      name: "comis-daemon",
      submodule: "preflight",
      errorKind: "dependency",
      err: message,
      hint: "Native module 'better-sqlite3' failed to load. Try: npm rebuild better-sqlite3 (or re-run install.sh). If this persists, reinstall comisai from a fresh tarball.",
      msg: "Preflight check failed: better-sqlite3 unavailable",
    }) + "\n");
    exitFn(78);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE-03 — legible resolved-profile boot logging + the honest-degrade
// `doctor` finding. Both helpers are PURE (a function of their inputs only —
// AGENTS §2.2): the boot-log builder of the agents config, the finding builder
// of a preflight-RESULT INPUT. The namespace probe that produces that boolean
// is Phase 211 (JAIL-03 / RESEARCH Pitfall 5) — here it is an input, so neither
// helper touches the daemon's sandbox-provider layer. `daemon.ts`'s boot banner
// iterates the records (INFO, one line per agent) + logs a WARN on a downshift.
// ─────────────────────────────────────────────────────────────────────────────

/** The agent-config shape the boot-log builder reads (only the autonomy block). */
interface AgentAutonomySlice {
  readonly autonomy?: AutonomyConfig;
}

/**
 * One per-agent record the boot banner logs at INFO — the legible resolved
 * posture (PROFILE-03 / CLAUDE.md "promote load-bearing evidence to INFO").
 * Carries exactly the four legibility facts (profile, enabled caps, the budget
 * ceiling, the one field to change it) plus the M1 over-grant notice.
 */
export interface AutonomyBootLogRecord {
  readonly agentId: string;
  readonly profile: AutonomyProfileName;
  readonly enabled: boolean;
  /** The resolved orch:* caps the profile turned on. */
  readonly capabilities: readonly AgentCapability[];
  /** The per-root-run aggregate $ ceiling (the budget guard, §8.7). */
  readonly aggregateBudgetUsd: number;
  /** The ONE config field that changes all of the above — the legibility contract. */
  readonly changeField: "autonomy.profile";
  /** Present for `unattended` (Phase-217 mode-active notice) + `max` (M3 clamp notice). */
  readonly m1Notice?: string;
}

/**
 * Build the per-agent legible-posture records the boot banner logs at INFO.
 *
 * PURE — resolves each agent's `autonomy` block via {@link resolveAutonomy} and
 * projects the four legibility facts + the M1 notice. One record per agent, in
 * config order. The daemon logs each as an INFO line so an operator can read,
 * from boot logs alone, exactly what every agent was granted and how to change
 * it — without `logLevel: debug`.
 *
 * @param agents the daemon's agents config map (only `autonomy` is read).
 */
export function buildAutonomyBootLog(
  agents: Record<string, AgentAutonomySlice>,
): AutonomyBootLogRecord[] {
  return Object.entries(agents).map(([agentId, cfg]) => {
    const resolved = resolveAutonomy(cfg.autonomy);
    return {
      agentId,
      profile: resolved.profile,
      enabled: resolved.enabled,
      capabilities: resolved.capabilities,
      aggregateBudgetUsd: resolved.aggregateBudgetUsd,
      changeField: "autonomy.profile",
      ...(resolved.m1Notice !== undefined ? { m1Notice: resolved.m1Notice } : {}),
    };
  });
}

/**
 * A `doctor` finding mirroring the file's existing finding shape (severity +
 * message + hint + errorKind). The PROFILE-03 namespace-downshift finding is
 * WARN-class — autonomy degrades to `assistant`, the daemon still serves — so it
 * never exits the process (unlike the fatal better-sqlite3 probe above).
 */
export interface PreflightFinding {
  readonly severity: "warn";
  readonly message: string;
  readonly hint: string;
  readonly errorKind: "precondition";
}

/**
 * Build the namespace-preflight downshift `doctor` finding (PROFILE-03).
 *
 * PURE — driven by the preflight-RESULT INPUT (the probe is Phase 211). Returns
 * `undefined` when the preflight passed. When it failed, derives the finding's
 * reason/hint from {@link degradeAutonomy} (a `standard` posture is the canonical
 * "would have been autonomy-bearing" case) so the doctor finding and the
 * resolver's surfaced WARN share ONE source of truth — same hint, same
 * `errorKind`, no drift.
 *
 * @param preflight the host preconditions (210: caller-supplied; 211: probed).
 */
export function buildNamespaceDownshiftFinding(
  preflight: AutonomyPreflightResult,
): PreflightFinding | undefined {
  // Ask the resolver what a representative autonomy-bearing posture would do
  // under this preflight. `resolveAutonomy(undefined)` is the zero-config
  // `standard` posture (no need to hand-build a fully-defaulted config — the
  // resolver param is the OUTPUT type). Passing preflight → no downshift → no
  // finding.
  const { downshift } = degradeAutonomy(resolveAutonomy(undefined), preflight);
  if (!downshift) return undefined;
  return {
    severity: "warn",
    message:
      "Agent autonomy downshifted to the 'assistant' profile: the namespace preflight failed, so the jail cannot be built and autonomy surfaces are disabled (no silent unjailed fallback).",
    hint: downshift.hint,
    errorKind: downshift.errorKind,
  };
}
