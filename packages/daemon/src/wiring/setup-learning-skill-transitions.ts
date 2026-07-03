// SPDX-License-Identifier: Apache-2.0
/**
 * Learned-skill promote/demote — the resolve-seam loop body.
 *
 * Extracted to its own leaf (like `setup-learning-corroboration.ts`) so
 * `setup-learning.ts` stays under the 800-line cap. It imports `failureCorroborated`
 * from `setup-learning-corroboration.ts` (the SAME gate the memory failure-accrual path
 * uses) and the trend tracker from `setup-learning-skill-trend.ts` — NOTHING from
 * `setup-learning.ts` (one-directional — no cycle). The caller's `deps` is a superset of
 * the narrow {@link SkillTransitionDeps} declared here, so it passes `deps` verbatim.
 *
 * The loop iterates `verdict.usedSkillIds` (skill NAMES) and AWAITS the
 * name-keyed store transition to read rows-changed so a 0-row write never
 * inflates the counters/emits. It scope-qualifies the corroboration/trend keys
 * and refreshes the per-agent surface cache on a real transition. NEVER throws
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
  /** Scope-qualified corroboration tally (skillGaugeKey → distinct failing sessions). */
  skillFailureCorroborationTally: Map<string, Set<string>>;
  /** The decay-aware trend tracker (keyed on the SAME scope-qualified key). */
  skillTrend: SkillTrendTracker;
  /** Refresh the per-agent surface cache after a promote/demote moved a row, so
   *  the NEXT session's freeze captures the new active set (next-session
   *  pickup, never a frozen-snapshot mutation). Absent ⇒ no refresh. */
  refreshSurface?: (agentId: string) => void;
}

/**
 * Build the scope-qualified key the in-process skill gauges (corroboration
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
 * The resolve-seam learned-skill promote/demote body,
 * fire-and-forget / non-fatal. AWAITS the name-keyed store transition to read
 * rows-changed (the loop holds skill NAMES, not the hash id; the store resolves
 * name→id internally AND reports whether a row moved) and increments the counter +
 * emits ONLY when a row actually transitioned (the telemetry stops lying about 0-row
 * writes). Scope-qualifies the corroboration/trend keys. On a real transition
 * it refreshes the per-agent surface cache. NEVER throws (each store call is
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
  // Count of successful reuses whose promotion credit was VALUE-GATED (the skill
  // was in a sustained-failure standing → it must earn back trust before accruing proof).
  let promotionGated = 0;
  // Collect the demoted skill NAMES (not just the count) so the emit can name WHICH
  // skills demoted (id-class, never a body).
  const demotedNames: string[] = [];
  // The skill NAMES whose promotion was value-gated this resolve (id-class, never a body)
  // — so "why didn't my skill promote despite a successful reuse?" is answerable from obs.
  const gatedNames: string[] = [];

  for (const skillName of verdict.usedSkillIds) {
    // Never key the in-process gauges on the bare name (cross-tenant alias).
    const gaugeKey = skillGaugeKey(scope.tenantId, scope.agentId, skillName);
    if (verdict.outcome === "success") {
      // VALUE-GATED PROMOTION: PEEK the skill's standing BEFORE folding this success.
      // A skill in a SUSTAINED-failure ("weakening") standing must EARN BACK trust — an interleaved
      // success recovers the trend but does NOT accrue promotion credit (proof_count), so promotion
      // reflects a reliable track record, not raw reuse count (otherwise a skill promotes on usage
      // even when its reuses did not help). A fresh/clean or single-failure skill is
      // "stable" (never "weakening") → promotes normally (no regression on the healthy loop).
      const standingBefore = skillTrend.peekSkillTrend(gaugeKey, deps.clock.now());
      // The success ALWAYS feeds the trend (so a recovering procedure re-strengthens) — peek was BEFORE.
      skillTrend.updateSkillTrend(gaugeKey, "success", deps.clock.now());
      if (standingBefore === "weakening") {
        promotionGated += 1;
        gatedNames.push(skillName);
      } else {
        // promoteByName bumps proof_count; candidate→active at the proof bar
        // (store-side CASE). Count ONLY when a real row changed.
        const changed = await runSkillTransition(deps, scope.agentId, "skill_promote", () =>
          skillStore.promoteByName(skillName, skillScope, threshold),
        );
        if (changed) promoted += 1;
      }
    } else if (verdict.outcome === "failure" || verdict.outcome === "corrected") {
      // Corroboration gate (≥2 distinct-session OR 1 deterministic), THEN
      // the decay-aware trend — demote ONLY on a WEAKENING standing so a single
      // corroborated failure on a well-reused skill stays put.
      if (failureCorroborated(gaugeKey, scope.sessionId, verdict.sources, skillFailureCorroborationTally)) {
        const trend = skillTrend.updateSkillTrend(gaugeKey, "failure", deps.clock.now());
        if (trend === "weakening") {
          const changed = await runSkillTransition(deps, scope.agentId, "skill_demote", () =>
            skillStore.demoteByName(skillName, skillScope),
          );
          if (changed) {
            demoted += 1;
            demotedNames.push(skillName);
          }
        }
      }
    }
  }

  // Skill-transition emits — plain eventBus.emit (the keys are typed + bridged).
  // COUNTS ONLY — a body/script/id-list field is a compile error. Emitted ONLY on a
  // REAL transition count (a 0-row write never reaches here).
  if (promoted > 0) deps.eventBus.emit("learning:skill_promoted", { agentId: scope.agentId, count: promoted, timestamp: deps.clock.now() });
  if (demoted > 0)
    deps.eventBus.emit("learning:skill_demoted", {
      agentId: scope.agentId,
      count: demoted,
      // Name WHICH skills demoted + the trigger trajectory (the WHY) — content-free ids.
      demotedSkillNames: demotedNames,
      triggerTrajectoryId: scope.trajectoryId,
      timestamp: deps.clock.now(),
    });
  // One INFO completion line per resolve that moved a skill OR value-gated a promotion,
  // with durationMs (counts/ids only — never a procedure body). Adds promotionGated +
  // the gated skill NAMES so a stalled-but-succeeding skill is diagnosable ("why no promote?").
  if (promoted > 0 || demoted > 0 || promotionGated > 0) {
    deps.logger.info(
      {
        agentId: scope.agentId,
        promoted,
        demoted,
        promotionGated,
        ...(promotionGated > 0 ? { gatedSkillNames: gatedNames } : {}),
        durationMs: deps.clock.now() - skillStart,
      },
      "Learned-skill promote/demote complete",
    );
  }
  // A real transition changed the active set — refresh the per-agent surface cache so the
  // NEXT session's freeze captures it (next-session pickup). A value-GATED promotion
  // moved NO row → no refresh.
  if (promoted > 0 || demoted > 0) {
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
