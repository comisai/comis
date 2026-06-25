// SPDX-License-Identifier: Apache-2.0
/**
 * SURFACE-04/05/06 learned-skill promote/demote — the resolve-seam loop body.
 *
 * Extracted to its own leaf (like `setup-learning-corroboration.ts`) so
 * `setup-learning.ts` stays under the 800-line cap. It imports `failureCorroborated`
 * from `setup-learning-corroboration.ts` (the SAME gate the memory failure-accrual path
 * uses) and the trend tracker from `setup-learning-skill-trend.ts` — NOTHING from
 * `setup-learning.ts` (one-directional — no cycle). The caller's `deps` is a superset of
 * the narrow {@link SkillTransitionDeps} declared here, so it passes `deps` verbatim.
 *
 * The loop iterates `verdict.usedSkillIds` (skill NAMES, ATTR-01) and AWAITS the
 * name-keyed store transition to read rows-changed (CR-01) so a 0-row write never
 * inflates the counters/emits. It scope-qualifies the corroboration/trend keys (WR-05)
 * and refreshes the per-agent surface cache on a real transition (WR-01). NEVER throws
 * (each store call is wrapped; a reject/err WARNs and is skipped).
 *
 * @module
 */

import type {
  ClockPort,
  ComisLogger,
  MentalModelStorePort,
  ResolvedOutcome,
  TypedEventBus,
} from "@comis/core";
import { failureCorroborated } from "./setup-learning-corroboration.js";
import type { SkillTrendTracker } from "./setup-learning-skill-trend.js";

/** The resolved scope the loop keys on (mirrors the setup-learning OutcomeScope). */
export interface SkillTransitionScope {
  tenantId: string;
  agentId: string;
  sessionId: string;
  trajectoryId: string;
}

/**
 * The NARROW structural deps the loop needs — a subset of `LearningOutcomeWiringDeps`
 * declared HERE so this leaf imports nothing back from `setup-learning.ts` (no cycle).
 */
export interface SkillTransitionDeps {
  eventBus: TypedEventBus;
  clock: ClockPort;
  logger: ComisLogger;
}

/** Per-call dependencies for {@link applySkillOutcomeTransitions} (the resolve-seam loop body). */
export interface SkillOutcomeDeps {
  /** The learned-skill adapter (the name-keyed promote/demote target). */
  skillStore: MentalModelStorePort;
  /** The per-agent `promoteAtProofCount` threshold (candidate→active proof bar). */
  threshold: number;
  /** WR-05: scope-qualified corroboration tally (skillGaugeKey → distinct failing sessions). */
  skillFailureCorroborationTally: Map<string, Set<string>>;
  /** WR-05: the decay-aware trend tracker (keyed on the SAME scope-qualified key). */
  skillTrend: SkillTrendTracker;
  /** WR-01: refresh the per-agent surface cache after a promote/demote moved a row, so
   *  the NEXT session's freeze captures the new active set (SURFACE-03 next-session
   *  pickup, never a frozen-snapshot mutation). Absent ⇒ no refresh. */
  refreshSurface?: (agentId: string) => void;
}

/**
 * WR-05: build the scope-qualified key the in-process skill gauges (corroboration
 * tally + trend tracker) MUST key on — `(tenantId, agentId, skillName)`. Keying on
 * the bare skill NAME aliases two different (tenant, agent) scopes that each surface
 * a skill of the same name, so tenant A's failures could drive tenant B's skill
 * toward demotion (a cross-tenant integrity leak). This composite is the same tuple
 * the store's row id derives from, so it is unique per (tenant, agent, name) without
 * a store round-trip. The space separators mirror `learnedSkillId`'s join.
 */
function skillGaugeKey(tenantId: string, agentId: string, skillName: string): string {
  return `${tenantId} ${agentId} ${skillName}`;
}

/**
 * SURFACE-04/05/06 + OBS-01 — the resolve-seam learned-skill promote/demote body,
 * fire-and-forget / non-fatal. AWAITS the name-keyed store transition to read
 * rows-changed (CR-01: the loop holds skill NAMES, not the hash id; the store resolves
 * name→id internally AND reports whether a row moved) and increments the counter +
 * emits ONLY when a row actually transitioned (the telemetry stops lying about 0-row
 * writes). Scope-qualifies the corroboration/trend keys (WR-05). On a real transition
 * it refreshes the per-agent surface cache (WR-01). NEVER throws (each store call is
 * wrapped; a reject/err WARNs and is skipped).
 */
export async function applySkillOutcomeTransitions(
  deps: SkillTransitionDeps,
  scope: SkillTransitionScope,
  verdict: ResolvedOutcome,
  skillDeps: SkillOutcomeDeps,
): Promise<void> {
  const { skillStore, threshold, skillFailureCorroborationTally, skillTrend, refreshSurface } = skillDeps;
  const skillScope = { tenantId: scope.tenantId, agentId: scope.agentId, now: deps.clock.now() };
  const skillStart = deps.clock.now();
  let promoted = 0;
  let demoted = 0;

  for (const skillName of verdict.usedSkillIds) {
    // WR-05: never key the in-process gauges on the bare name (cross-tenant alias).
    const gaugeKey = skillGaugeKey(scope.tenantId, scope.agentId, skillName);
    if (verdict.outcome === "success") {
      // SURFACE-04: promoteByName bumps proof_count; candidate→active at the proof
      // bar (store-side CASE). Count ONLY when a real row changed (CR-01). The
      // success also feeds the trend so a strong recent history resists a later
      // (possibly induced) demote.
      const changed = await runSkillTransition(deps, scope.agentId, "skill_promote", () =>
        skillStore.promoteByName(skillName, skillScope, threshold),
      );
      skillTrend.updateSkillTrend(gaugeKey, "success", deps.clock.now());
      if (changed) promoted += 1;
    } else if (verdict.outcome === "failure" || verdict.outcome === "corrected") {
      // SURFACE-05: corroboration gate (≥2 distinct-session OR 1 deterministic), THEN
      // the decay-aware trend — demote ONLY on a WEAKENING standing so a single
      // corroborated failure on a well-reused skill stays put (§12 first-RED).
      if (failureCorroborated(gaugeKey, scope.sessionId, verdict.sources, skillFailureCorroborationTally)) {
        const trend = skillTrend.updateSkillTrend(gaugeKey, "failure", deps.clock.now());
        if (trend === "weakening") {
          const changed = await runSkillTransition(deps, scope.agentId, "skill_demote", () =>
            skillStore.demoteByName(skillName, skillScope),
          );
          if (changed) demoted += 1;
        }
      }
    }
  }

  // SURFACE-06 emits — plain eventBus.emit (Plan 03 typed the keys + bridged them).
  // COUNTS ONLY — a body/script/id-list field is a compile error. Emitted ONLY on a
  // REAL transition count (CR-01: a 0-row write never reaches here).
  if (promoted > 0) deps.eventBus.emit("learning:skill_promoted", { agentId: scope.agentId, count: promoted, timestamp: deps.clock.now() });
  if (demoted > 0) deps.eventBus.emit("learning:skill_demoted", { agentId: scope.agentId, count: demoted, timestamp: deps.clock.now() });
  // OBS-01: one INFO completion line per resolve that moved a skill, with durationMs
  // (counts/ids only — never a procedure body).
  if (promoted > 0 || demoted > 0) {
    deps.logger.info(
      { agentId: scope.agentId, promoted, demoted, durationMs: deps.clock.now() - skillStart },
      "Learned-skill promote/demote complete",
    );
    // WR-01: a real transition changed the active set — refresh the per-agent surface
    // cache so the NEXT session's freeze captures it (next-session pickup, SURFACE-03).
    refreshSurface?.(scope.agentId);
  }
}

/**
 * Run one name-keyed skill transition, non-fatal, returning whether a row changed.
 * Mirrors `recordNonFatal` (WARNs with hint+errorKind on err/reject) but reads the
 * `{ changed }` result so the caller gates the counter/emit on a REAL row move. A
 * reject or err yields `false` (treated as "did not transition").
 */
async function runSkillTransition(
  deps: SkillTransitionDeps,
  agentId: string,
  kind: "skill_promote" | "skill_demote",
  run: () => Promise<{ ok: boolean; value?: { changed: boolean } }>,
): Promise<boolean> {
  try {
    const r = await run();
    if (!r.ok) {
      deps.logger.warn(
        {
          agentId,
          errorKind: "internal" as const,
          hint: `outcome ${kind} write failed; the ${kind} state transition was not persisted for this trajectory`,
        },
        `outcome ${kind} write failed (non-fatal)`,
      );
      return false;
    }
    return r.value?.changed === true;
  } catch (e: unknown) {
    deps.logger.warn(
      {
        agentId,
        err: e instanceof Error ? e : new Error(String(e)),
        errorKind: "internal" as const,
        hint: `outcome ${kind} write threw; the ${kind} state transition was not persisted for this trajectory`,
      },
      `outcome ${kind} write threw (non-fatal)`,
    );
    return false;
  }
}
