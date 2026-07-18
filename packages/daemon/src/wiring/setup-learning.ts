// SPDX-License-Identifier: Apache-2.0
/**
 * Outcome-signal write-back wiring.
 *
 * The composition-root glue between the deterministic completion bus events
 * (`tool:executed`, `graph:completed`, `diagnostic:message_processed`) and the
 * `OutcomeSignalPort` (@comis/memory adapter). The daemon is the ONLY place holding
 * BOTH the bus AND the adapter — the agent↛memory build cut means the agent emits
 * ids+counts on the bus and the daemon does the observe/resolve. Mirrors
 * `wireMemoryUsefulness`. The resolve→consume chain is shared by the DAG
 * (`graph:completed`) AND single-agent (`diagnostic:message_processed`) seams and
 * runs at most ONCE per trajectory (resolve() is a pure read; both events can fire
 * for one DAG turn). Counts + ids + closed-enums ONLY cross the bus — never
 * memory bodies or user content.
 *
 * BYTE-IDENTITY GATE: every handler's FIRST statement is the
 * `learningOutcomeEnabled(agentId)` short-circuit — default config observes/resolves/
 * emits NOTHING (the recall/score hot path is byte-identical). Fire-and-forget /
 * non-fatal: a failing observe/resolve warns and continues, never throwing out of the
 * handler or blocking the turn. An `unknown` resolved outcome derives no learning
 * (fail-closed) and is NOT counted as resolved coverage.
 *
 * @module
 */

import {
  tryGetContext,
  type TypedEventBus,
  type OutcomeSignalPort,
  type ResolvedOutcome,
  type MemoryUsefulnessStore,
  type MentalModelStorePort,
  type ClockPort,
  type ComisLogger,
  type AppConfig,
} from "@comis/core";

import { deriveTenantFromSessionKey } from "./setup-memory-usefulness-wiring.js";
import { createSkillTrendTracker } from "./setup-learning-skill-trend.js";
import { markTrajectoryResolved } from "./setup-learning-dedup.js";
import {
  failureCorroborated,
  CORROBORATION_MIN_INDEPENDENT,
  MAX_TRACKED_FAILURE_MEMORIES,
} from "./setup-learning-corroboration.js";
// The LLM outcome-judge fallback lives in its own leaf (no cycle: setup-learning → judge only).
import { maybeUpgradeWithJudge, type OutcomeJudge, type JudgeScope } from "./setup-learning-judge.js";
// The skill promote/demote loop lives in its own leaf (no cycle: it imports
// failureCorroborated from setup-learning-corroboration.ts, nothing from here).
import { applySkillOutcomeTransitions } from "./setup-learning-skill-transitions.js";
// Re-export for the existing importers (setup-learning.test.ts) — moved to the leaf
// to keep this file under the 800-line cap; the gate logic is unchanged.
export { failureCorroborated, CORROBORATION_MIN_INDEPENDENT, MAX_TRACKED_FAILURE_MEMORIES };

/** Dependencies for {@link wireLearningOutcome}. */
export interface LearningOutcomeWiringDeps {
  /** The daemon's typed event bus (source of the tool/graph completion events). */
  eventBus: TypedEventBus;
  /** The sole @comis/memory adapter for the outcome port (the observe/resolve target). */
  outcomeStore: OutcomeSignalPort;
  /**
   * The sole @comis/memory recall-utility adapter (the reward/failure write target).
   * The daemon is the ONLY place holding BOTH this AND
   * `OutcomeSignalPort.resolve()` — the agent↛memory build cut means the agent
   * never imports the store (closed graph). Injected from setup-memory.ts where it
   * is already constructed.
   */
  usefulnessStore: MemoryUsefulnessStore;
  /** Injected clock for `observedAt` — the deterministic time source (no ambient wall clock). */
  clock: ClockPort;
  /** Structured logger for the INFO completion line + the non-fatal failure WARN. */
  logger: ComisLogger;
  /**
   * Per-agent effective enable: true ONLY when the agent has `learning.enabled`
   * (the ONE collapsed learning flag) AND the master `memory.enabled` switch is on.
   * With `memory.enabled:false` → the subscriber is a no-op.
   */
  learningOutcomeEnabled: (agentId: string) => boolean;
  /**
   * Per-agent reward-write enable: true ONLY when the agent has
   * `learning.enabled` AND the master `memory.enabled` switch is on. Gates the
   * SUCCESS→`recordUsage` positive-reward write (wired behind the one collapsed flag).
   */
  learningTuningEnabled: (agentId: string) => boolean;
  /**
   * Per-agent failure-accrual enable: true ONLY when the agent has
   * `learning.enabled` AND the master `memory.enabled` switch is on. Gates the
   * FAILURE/CORRECTED→`recordFailure` accrual (itself corroboration-gated;
   * wired behind the one collapsed flag).
   */
  learningForgettingEnabled: (agentId: string) => boolean;
  /**
   * The sole @comis/memory learned-skill adapter (the promote/demote
   * write target). The daemon is the ONLY place holding BOTH this AND
   * `OutcomeSignalPort.resolve()` (the agent↛memory cut). OPTIONAL — when absent
   * (e.g. learning disabled) the promote/demote loop is a no-op
   * (byte-identical). Injected from setup-memory.ts where it is already constructed.
   */
  learnedSkillStore?: MentalModelStorePort;
  /**
   * Per-agent learned-skill promote/demote enable: true ONLY when the
   * agent has `learning.enabled` (the ONE collapsed flag) AND the master
   * `memory.enabled` switch is on. Gates the entire promote/demote loop (wired
   * behind the one flag). With `memory.enabled:false` → no promote/demote/emit (byte-identical).
   */
  learningSkillsEnabled?: (agentId: string) => boolean;
  /**
   * Per-agent promote threshold (the candidate→active transition crosses it —
   * `learning.reflect.promoteAtProofCount`, schema default 3). Passed verbatim into
   * `learnedSkillStore.promote(id, scope, threshold)` (the store-side CASE gate).
   */
  learningSkillsPromoteAt?: (agentId: string) => number;
  /**
   * Refresh a given agent's learned-skill SURFACE cache after a promote/demote
   * actually moved a row, so the NEXT session's prompt-skills freeze captures the new
   * active set (next-SESSION pickup — never a mid-session mutation of an
   * already-frozen snapshot). The per-agent surface caches live in setup-agents-runtime
   * and are reached via a shared registry; this closure looks the agent's cache up and
   * fires its async refresh fire-and-forget. OPTIONAL — absent (no registry threaded, or
   * learning disabled) ⇒ no refresh (byte-identical). The boot refresh still runs.
   */
  refreshLearnedSkillSurface?: (agentId: string) => void;
  /**
   * Conversational-breadth fallback (built in the setup-learning-judge leaf):
   * the cost-gated LLM outcome-judge seam, invoked ONLY when the deterministic resolve fused
   * to `unknown` AND {@link learningOutcomeJudgeEnabled} is on — i.e. a CONVERSATIONAL turn
   * with no tool/pipeline signal. Returns the verdict's `outcome` + the CODE-capped reward
   * (≤ 0.7) the daemon `observe()`s as a `source:"judge"` row. OPTIONAL — absent (no judge
   * wired, or the judge disabled for every agent) ⇒ the upgrade path is never entered
   * (byte-identical). The returned verdict also carries content-free model, rubric,
   * evidence, and policy provenance for the completion record. These three fields
   * ARE the {@link JudgeUpgradeDeps} structural subset.
   */
  outcomeJudge?: OutcomeJudge;
  /** Per-agent judge enable (memory.enabled && learningOutcome.enabled && judge.enabled); absent ⇒ never runs. */
  learningOutcomeJudgeEnabled?: (agentId: string) => boolean;
  /** LCD-backed per-turn transcript reader; absent/empty ⇒ the judge never runs (byte-identical). */
  readTurnTranscript?: (scope: JudgeScope) => string | undefined;
}

/** High-confidence default for a clean deterministic tool/pipeline signal. */
const DETERMINISTIC_CONFIDENCE = 0.9;
/** Slightly lower confidence for a content/detector-classified (non-transport) tool failure. */
const CLASSIFIED_FAILURE_CONFIDENCE = 0.8;
/**
 * Confidence for a pure skill-attribution row (memory:skill_used → observe).
 * LOW + paired with `outcome:"unknown"` so the row NEVER wins resolve() fusion — it
 * carries the `used_skill_ids` column only, asserting no outcome verdict.
 */
const ATTRIBUTION_CONFIDENCE = 0;

/** A resolved outcome scope keyed off the event/ALS context. */
interface OutcomeScope {
  tenantId: string;
  agentId: string;
  sessionId: string;
  trajectoryId: string;
  workspacePolicyHash?: string;
}

/**
 * Resolve the (tenant, agent, session, trajectory) scope for an observation. Payload
 * fields win when present (tool:executed / memory:skill_used / diagnostic:message_
 * processed all carry agentId/traceId/sessionKey); ALS is the fallback (graph:completed
 * carries only graphId). Returns `undefined` when neither source yields an agentId AND a
 * trajectory identity (caller skips). Tenant defaults to "default" only when absent; the
 * agentId is NEVER collapsed across agents (cross-agent isolation).
 */
function resolveScope(payload: {
  agentId?: string;
  traceId?: string;
  sessionKey?: string;
  workspacePolicyHash?: string;
}): OutcomeScope | undefined {
  const ctx = tryGetContext();
  const agentId = payload.agentId ?? ctx?.agentId;
  const trajectoryId = payload.traceId ?? ctx?.traceId;
  if (agentId === undefined || agentId.length === 0) return undefined;
  if (trajectoryId === undefined || trajectoryId.length === 0) return undefined;
  const sessionKey = payload.sessionKey ?? ctx?.sessionKey;
  const tenantId = deriveTenantFromSessionKey(sessionKey) ?? ctx?.tenantId ?? "default";
  // sessionId is the conversation identity; the events carry sessionKey (not a
  // distinct sessionId). Use sessionKey when present, else fall back to the
  // trajectory identity (a stable, scope-consistent key).
  const sessionId = sessionKey ?? trajectoryId;
  return {
    tenantId,
    agentId,
    sessionId,
    trajectoryId,
    ...(payload.workspacePolicyHash === undefined
      ? {}
      : { workspacePolicyHash: payload.workspacePolicyHash }),
  };
}

/**
 * Persist one raw observation, fire-and-forget / non-fatal. NEVER throws out of
 * the bus handler. Counts/ids/closed-enums only ever reach the store.
 */
function observeNonFatal(
  deps: LearningOutcomeWiringDeps,
  scope: OutcomeScope,
  outcome: "success" | "failure" | "unknown",
  source: "tool" | "pipeline" | "explicit",
  confidence: number,
  usedSkillIds?: ReadonlyArray<string>,
  recalledIds?: ReadonlyArray<string>,
  procedureDescriptor?: ReadonlyArray<string>,
): Promise<void> {
  return deps.outcomeStore
    .observe({
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      trajectoryId: scope.trajectoryId,
      outcome,
      source,
      confidence,
      // Thread the per-turn used-skill ids onto observe() so the
      // used_skill_ids COLUMN is written; resolve() union-dedups across rows. Omitted
      // (the tool/pipeline paths) ⇒ the column stays NULL — no behavior change for those paths.
      ...(usedSkillIds !== undefined && usedSkillIds.length > 0 ? { usedSkillIds: [...usedSkillIds] } : {}),
      // Thread the per-turn recalled+used memory
      // ids onto observe() so the recalled_ids COLUMN is written; resolve() union-dedups
      // them onto `verdict.recalledIds`, which is what the outcome-gated reward seam keys
      // on (success→recordUsage, failure/corrected→recordFailure → failure_count). Omitted
      // (tool/pipeline/skill paths) ⇒ NULL. Without this carrier the outcome-gated
      // recall reward would be dormant (recalledIds always empty).
      ...(recalledIds !== undefined && recalledIds.length > 0 ? { recalledIds: [...recalledIds] } : {}),
      // Thread the per-turn content-free tool-NAME descriptor onto observe() so the
      // procedure_descriptor COLUMN is written (the orchestrate:run_summary carrier). Omitted
      // (tool/pipeline/skill/recall paths) ⇒ the column stays NULL — no behavior change there.
      ...(procedureDescriptor !== undefined && procedureDescriptor.length > 0
        ? { procedureDescriptor: [...procedureDescriptor] }
        : {}),
      observedAt: deps.clock.now(),
    })
    .then((r) => {
      if (!r.ok) {
        deps.logger.warn(
          {
            agentId: scope.agentId,
            source,
            errorKind: "internal" as const,
            hint: "outcome observe failed; the outcome signal was not persisted for this trajectory",
          },
          "outcome observe failed (non-fatal)",
        );
      }
    })
    .catch((e: unknown) => {
      deps.logger.warn(
        {
          agentId: scope.agentId,
          source,
          err: e instanceof Error ? e : new Error(String(e)),
          errorKind: "internal" as const,
          hint: "outcome observe threw; the outcome signal was not persisted for this trajectory",
        },
        "outcome observe threw (non-fatal)",
      );
    });
}

// The failure-corroboration gate (failureCorroborated + its constants) lives in
// ./setup-learning-corroboration.js (imported + re-exported above) — extracted to keep
// this file under the 800-line cap; the gate logic is unchanged.

/**
 * Run one usefulness-store reward/failure write, fire-and-forget / non-fatal.
 * NEVER throws out of the bus handler. `kind` tags the WARN so an operator sees
 * which write (reward vs failure-accrual) was dropped. Counts/ids only reach the
 * store (the (tenant, agent) scope is the load-bearing isolation boundary).
 */
function recordNonFatal(
  deps: LearningOutcomeWiringDeps,
  agentId: string,
  kind: "reward" | "failure_accrual" | "skill_promote" | "skill_demote",
  run: () => Promise<{ ok: boolean }>,
): void {
  void Promise.resolve()
    .then(run)
    .then((r) => {
      if (!r.ok) {
        deps.logger.warn(
          {
            agentId,
            errorKind: "internal" as const,
            hint: `outcome ${kind} write failed; the ${kind} state transition was not persisted for this trajectory`,
          },
          `outcome ${kind} write failed (non-fatal)`,
        );
      }
    })
    .catch((e: unknown) => {
      deps.logger.warn(
        {
          agentId,
          err: e instanceof Error ? e : new Error(String(e)),
          errorKind: "internal" as const,
          hint: `outcome ${kind} write threw; the ${kind} state transition was not persisted for this trajectory`,
        },
        `outcome ${kind} write threw (non-fatal)`,
      );
    });
}

// The learned-skill promote/demote loop (applySkillOutcomeTransitions
// + runSkillTransition + skillGaugeKey + SkillOutcomeDeps) lives in the
// setup-learning-skill-transitions.ts leaf (imported above) to keep this file under the
// 800-line cap. It imports `failureCorroborated` from setup-learning-corroboration.ts
// directly (no back-import here → no cycle).

// `maybeUpgradeWithJudge` (the unknown→judge upgrade) lives in the
// setup-learning-judge.ts leaf (imported above) to keep this file under the 800-line cap.

/**
 * Stand up the observe/resolve subscriber on the daemon's bus. Fire-and-forget /
 * non-fatal; default-OFF via `learningOutcomeEnabled`.
 *
 * Wiring:
 *  - `tool:executed`               → observe a `tool` outcome (`success===false`→failure).
 *  - `memory:skill_used`           → observe the per-turn used-skill ids (attribution row).
 *  - `orchestrate:run_summary`     → observe the run's content-free tool-NAME descriptor (attribution row).
 *  - `graph:completed` (DAG)       → observe a `pipeline` outcome, then the shared
 *                                    resolve→consume chain. (`graph:driver_lifecycle`
 *                                    is NOT observed — per-node, floods the ledger.)
 *  - `diagnostic:message_processed` → the single-agent turn's resolve→consume (the
 *                                    common turn never fires graph:completed).
 *
 * The shared chain resolves the fused verdict, runs the reward/forgetting/skill consumers,
 * emits `learning:outcome_observed` (counts/ids only), updates the fail-closed coverage
 * gauge (`resolved` counts only a non-`unknown` outcome), and runs at most
 * ONCE per trajectory (a DAG turn fires BOTH completion events).
 */
export function wireLearningOutcome(deps: LearningOutcomeWiringDeps): void {
  // Daemon-lifetime coverage gauge (resets on restart). Counts only.
  let total = 0;
  let resolved = 0;
  // Failure-corroboration tally: memoryId → the DISTINCT sessions that failed it
  // (within this subscriber's lifetime). A NON-deterministic failure accrues
  // `failure_count` only once this reaches ≥2 distinct sessions; a deterministic
  // failure (tool/pipeline) bypasses it. Mirrors the coverage gauge's in-process
  // counters (resets on restart) — counts/ids only, never bodies.
  const failureCorroborationTally = new Map<string, Set<string>>();
  // A SECOND, independent daemon-lifetime corroboration tally for the
  // learned-SKILL demote path (skillId → DISTINCT failing sessions). Kept separate
  // from the memory tally above so the two write paths never alias an id. Reuses the
  // SAME failureCorroborated() gate (≥2 distinct-session OR 1 deterministic).
  const skillFailureCorroborationTally = new Map<string, Set<string>>();
  // The in-process, daemon-lifetime decay-aware trend (the WHEN-to-demote
  // decision). A corroborated failure demotes ONLY when the trend reaches WEAKENING —
  // so a single induced failure on a well-reused procedure does NOT archive it.
  // Its keys are scope-qualified (tenant+agent+name) by the caller (skillGaugeKey).
  const skillTrend = createSkillTrendTracker();
  // The per-agent surface-cache refresh closure (looked up from the shared
  // registry threaded via deps) — fired after a REAL promote/demote so the next
  // session sees the new active set. Undefined ⇒ no refresh (byte-identical).
  const refreshSurface = deps.refreshLearnedSkillSurface;
  // Idempotency: the per-trajectory resolve-dedup set (see setup-learning-dedup.ts).
  const resolvedTrajectories = new Set<string>();

  /**
   * The SHARED resolve→consume chain called by BOTH the `graph:completed` (DAG)
   * and `diagnostic:message_processed` (single-agent turn) handlers — factored out so
   * the reward/forget-accrual/skill-transition logic is NOT duplicated. Runs AT MOST
   * ONCE per trajectory ({@link markTrajectoryResolved}). The caller resolves the scope
   * from its own source (graph: ALS; diagnostic: the payload, which carries the ids
   * because the emit happens outside the ALS context) and, for the DAG path, observes
   * the pipeline row FIRST. Non-fatal — never throws.
   */
  function resolveAndConsume(scope: OutcomeScope, resolveStart: number): void {
    // Dedup FIRST (synchronous check-and-mark before the async resolve) so a
    // both-events DAG turn cannot slip a second chain through.
    if (!markTrajectoryResolved(scope.trajectoryId, resolvedTrajectories)) return;
    void deps.outcomeStore
      .resolve(scope.trajectoryId, { tenantId: scope.tenantId, agentId: scope.agentId })
      .then(async (r) => {
        total += 1;
        if (!r.ok) {
          deps.logger.warn(
            {
              agentId: scope.agentId,
              errorKind: "internal" as const,
              hint: "outcome resolve failed; no learning:outcome_observed emitted for this trajectory",
            },
            "outcome resolve failed (non-fatal)",
          );
          return;
        }
        // An `unknown` deterministic verdict (a CONVERSATIONAL turn with no
        // tool/pipeline signal) gets ONE cheap-model judge pass as the fallback source;
        // a non-`unknown` verdict is returned unchanged (the judge never runs). The
        // dedup already ran at the top — this is the SAME chain (no second chain).
        const verdict = await maybeUpgradeWithJudge(deps, scope, r.value);
        // Fail-closed coverage: an `unknown` verdict is NOT counted as resolved.
        if (verdict.outcome !== "unknown") resolved += 1;

        // ---- Reward/failure write (the agent↛memory cut: the
        // daemon holds BOTH this verdict AND the usefulness adapter). intent OMITTED →
        // the global '' bucket; an `unknown` verdict writes NOTHING (fail-closed). ----
        let failureAccrued = 0;
        if (verdict.outcome === "success") {
          if (deps.learningTuningEnabled(scope.agentId) && verdict.recalledIds.length > 0) {
            const rewardScope = { tenantId: scope.tenantId, agentId: scope.agentId, now: deps.clock.now() };
            // ONE batched reward write for ALL recalled ids (the store loops in
            // one transaction); the FAILURE branch below stays per-id (gated per memory).
            recordNonFatal(deps, scope.agentId, "reward", () =>
              deps.usefulnessStore.recordUsage(verdict.recalledIds, [], rewardScope),
            );
          }
        } else if (verdict.outcome === "failure" || verdict.outcome === "corrected") {
          if (deps.learningForgettingEnabled(scope.agentId)) {
            const failScope = { tenantId: scope.tenantId, agentId: scope.agentId, now: deps.clock.now() };
            for (const mid of verdict.recalledIds) {
              // Corroboration gate: accrue ONLY when corroborated (≥2 independent sessions
              // OR 1 deterministic source); past it the accrual is UNCONDITIONAL (no
              // daemon-side proof/trust read — the eviction exemption is store-side).
              if (failureCorroborated(mid, scope.sessionId, verdict.sources, failureCorroborationTally)) {
                failureAccrued += 1;
                recordNonFatal(deps, scope.agentId, "failure_accrual", () =>
                  deps.usefulnessStore.recordFailure(mid, failScope),
                );
              }
            }
          }
        }

        // ---- Learned-SKILL promote/demote: iterate the attributed
        // verdict.usedSkillIds — `success` PROMOTES each; a corroborated failure
        // DEMOTES only when the decay-aware trend reaches WEAKENING (anti-induced).
        // Gated default-OFF / no-store ⇒ byte-identical. AWAITS the store to read
        // rows-changed so a 0-row write does NOT inflate the counters. ----
        if (
          deps.learnedSkillStore !== undefined &&
          deps.learningSkillsEnabled?.(scope.agentId) === true
        ) {
          void applySkillOutcomeTransitions(deps, scope, verdict, {
            skillStore: deps.learnedSkillStore,
            threshold: deps.learningSkillsPromoteAt?.(scope.agentId) ?? 3,
            skillFailureCorroborationTally,
            skillTrend,
            refreshSurface,
          });
        }

        // Emit the resolved outcome (counts/ids/closed-enums ONLY — bridged for comis explain).
        deps.eventBus.emit("learning:outcome_observed", {
          agentId: scope.agentId,
          traceId: scope.trajectoryId,
          trajectoryId: scope.trajectoryId,
          outcome: verdict.outcome,
          source: verdict.sources[0] ?? "pipeline",
          confidence: verdict.confidence,
          timestamp: deps.clock.now(),
        });

        // When corroborated failures accrued (failure_count++) this resolve, emit the
        // eviction-causation precursor (count only, bridged for comis explain) so "why did/didn't
        // this memory evict" has an event trail — not just a DB column that changes over time. The
        // accrual is already corroboration-gated above.
        if (failureAccrued > 0) {
          deps.eventBus.emit("learning:memory_failure_attributed", {
            agentId: scope.agentId,
            count: failureAccrued,
            timestamp: deps.clock.now(),
          });
        }

        // One INFO completion line per resolve with durationMs + the
        // running coverage gauge + the corroborating `sources` (counts/ids only).
        deps.logger.info(
          {
            agentId: scope.agentId,
            outcome: verdict.outcome,
            sources: verdict.sources,
            corroboratingSourceCount: verdict.sources.length,
            resolvedCount: resolved,
            totalCount: total,
            durationMs: deps.clock.now() - resolveStart,
          },
          "Outcome resolved for trajectory",
        );
        // DEBUG: the corroboration outcome (counts only) so the gate decision is
        // reconstructable — recalled vs accrued. Never alpha values / memory bodies.
        deps.logger.debug(
          {
            agentId: scope.agentId,
            step: "outcome-resolve",
            sources: verdict.sources,
            recalledCount: verdict.recalledIds.length,
            failureAccrued,
          },
          "outcome resolve detail",
        );
      })
      .catch((e: unknown) => {
        deps.logger.warn(
          {
            agentId: scope.agentId,
            err: e instanceof Error ? e : new Error(String(e)),
            errorKind: "internal" as const,
            hint: "outcome resolve/emit threw; no learning:outcome_observed emitted for this trajectory",
          },
          "outcome resolve threw (non-fatal)",
        );
      });
  }

  // ---- Deterministic tool signal (the only source that ships ACTIVE) ----
  deps.eventBus.on("tool:executed", (p) => {
    // Byte-identity short-circuit (default OFF) — observe NOTHING.
    const agentId = p.agentId ?? tryGetContext()?.agentId;
    if (agentId === undefined || !deps.learningOutcomeEnabled(agentId)) return;

    const scope = resolveScope(p);
    if (scope === undefined) return;

    // The failure signal is the real `success` boolean field. A transport-level
    // / sdk_iserror failure is the highest-confidence deterministic signal; a
    // content/detector/mcp-classified failure is still a failure at a slightly
    // lower confidence (the fusion still ranks tool above judge regardless).
    const outcome: "success" | "failure" = p.success === false ? "failure" : "success";
    const confidence =
      outcome === "failure" && p.transportOk !== false && p.classifiedFailureBy !== "sdk_iserror"
        ? CLASSIFIED_FAILURE_CONFIDENCE
        : DETERMINISTIC_CONFIDENCE;

    void observeNonFatal(deps, scope, outcome, "tool", confidence);
  });

  // ---- Skill-use attribution write-back ----
  // The agent emits `memory:skill_used` after a turn whose `read` matched a
  // frozen learned-skill `<location>` — the per-turn used-skill ids (counts/ids only,
  // the memory:recall_used precedent). The daemon is the ONLY place holding BOTH the
  // bus AND the @comis/memory store (the agent↛memory cut), so the daemon does the
  // observe() write here: a neutral `explicit`/`unknown` attribution row carrying the
  // `usedSkillIds` so the `used_skill_ids` COLUMN is written. The `unknown` outcome +
  // low confidence means this row NEVER wins the resolve() fusion (the deterministic
  // tool/pipeline rows outrank it) — it is a pure attribution carrier; resolve()
  // union-dedups the column across ALL the trajectory's rows. Default-OFF via
  // `learningOutcomeEnabled` (byte-identical when off); a non-empty carrier is required.
  deps.eventBus.on("memory:skill_used", (p) => {
    const agentId = p.agentId ?? tryGetContext()?.agentId;
    if (agentId === undefined || !deps.learningOutcomeEnabled(agentId)) return;
    // Nothing attributed this turn → no write (avoids an empty attribution row).
    if (p.usedSkillIds.length === 0) return;

    const scope = resolveScope({
      agentId: p.agentId,
      traceId: p.traceId,
      sessionKey: p.sessionKey,
    });
    if (scope === undefined) return;

    // ATTRIBUTION_CONFIDENCE: a neutral, low-confidence `explicit`/`unknown` carrier —
    // it threads the used-skill ids onto the column WITHOUT asserting an outcome verdict
    // (resolve() fuses the real tool/pipeline outcome; this row only carries ids).
    void observeNonFatal(deps, scope, "unknown", "explicit", ATTRIBUTION_CONFIDENCE, p.usedSkillIds);
  });

  // ---- Recall-use attribution write-back ----
  // The executor emits `memory:recall_used` after a turn (executor-post-execution.ts) with
  // the recalled+used memory ids. wireMemoryUsefulness consumes it for the CORROBORATING
  // usage feed (used_count) — but without this handler nothing writes those ids onto the
  // OUTCOME ledger, so `verdict.recalledIds` stays empty and the PRIMARY outcome-gated
  // reward seam (resolve → success:recordUsage / failure:recordFailure→failure_count) is
  // dormant. Mirror the skill-use carrier: a neutral `explicit`/`unknown` row (NEVER wins
  // resolve() fusion — the deterministic tool/pipeline rows outrank it) that carries the
  // recalled ids so the recalled_ids COLUMN is written and resolve() union-dedups them.
  // Default-OFF via `learningOutcomeEnabled` (byte-identical when off); a non-empty
  // carrier required (no empty attribution row).
  deps.eventBus.on("memory:recall_used", (p) => {
    const agentId = p.agentId ?? tryGetContext()?.agentId;
    if (agentId === undefined || !deps.learningOutcomeEnabled(agentId)) return;
    if (p.usedIds.length === 0) return; // nothing recalled+used → no carrier row
    const scope = resolveScope({ agentId: p.agentId, traceId: p.traceId, sessionKey: p.sessionKey });
    if (scope === undefined) return;
    void observeNonFatal(deps, scope, "unknown", "explicit", ATTRIBUTION_CONFIDENCE, undefined, p.usedIds);
  });

  // ---- Procedure-descriptor attribution write-back ----
  // The orchestrate tool emits `orchestrate:run_summary` at run completion, SYNCHRONOUSLY
  // within the turn's ALS scope. It has NO other daemon-side ledger consumer (it is otherwise
  // only bridged to the trajectory), so this is a NEW carrier: a neutral `explicit`/`unknown`
  // row that threads the content-free `toolSequence` (the pre-flight tool-NAME footprint) onto
  // the `procedure_descriptor` COLUMN, keyed on the turn traceId. The `unknown` outcome + low
  // confidence means it NEVER wins resolve() fusion (the deterministic tool/pipeline rows
  // outrank it) — a pure attribution carrier; the descriptor rides the column for the reflection
  // input to read back. The payload carries NO agentId, so it resolves from the live ALS
  // (`tryGetContext()`) — valid because the emit is synchronous within the turn's async context.
  // Default-OFF via `learningOutcomeEnabled` (byte-identical when off); an empty toolSequence
  // writes no row (mirrors the skill_used length===0 guard). Content-free (§2.7): only the
  // tool-NAME set + correlators cross the bus — no body/args.
  deps.eventBus.on("orchestrate:run_summary", (p) => {
    const agentId = tryGetContext()?.agentId;
    if (agentId === undefined || !deps.learningOutcomeEnabled(agentId)) return;
    if (!p.toolSequence || p.toolSequence.length === 0) return; // no descriptor → no carrier row
    const scope = resolveScope({ agentId, traceId: p.traceId, sessionKey: p.sessionKey });
    if (scope === undefined) return;
    void observeNonFatal(deps, scope, "unknown", "explicit", ATTRIBUTION_CONFIDENCE, undefined, undefined, p.toolSequence);
  });

  // NB: `graph:driver_lifecycle` is intentionally NOT subscribed — it is
  // PER NODE, so observing it floods the ledger with O(nodes) `pipeline` rows and
  // makes the resolve() fusion order-dependent. `graph:completed` is the SINGLE
  // trajectory-level pipeline signal.

  // ---- DAG pipeline signal: observe the pipeline row FIRST (visible to the resolve),
  // then the SHARED resolve→consume chain. graph:completed fires ONLY for DAG runs. ----
  deps.eventBus.on("graph:completed", (p) => {
    const ctx = tryGetContext();
    const agentId = ctx?.agentId;
    if (agentId === undefined || !deps.learningOutcomeEnabled(agentId)) return;

    // graph:completed carries only graphId — recover the scope from ALS.
    const scope = resolveScope({});
    if (scope === undefined) return;

    // Success ONLY on a CLEAN completion; failed/cancelled/running → failure.
    const outcome: "success" | "failure" = p.status === "completed" ? "success" : "failure";
    const resolveStart = deps.clock.now();
    void observeNonFatal(deps, scope, outcome, "pipeline", DETERMINISTIC_CONFIDENCE).then(() =>
      resolveAndConsume(scope, resolveStart),
    );
  });

  // ---- Single-agent turn completion → resolve via the per-turn PAYLOAD ----
  // graph:completed fires ONLY for DAG runs, so without this handler a single-agent turn
  // never resolves — its tool:executed + memory:skill_used rows (keyed on traceId) go
  // unresolved. diagnostic:message_processed fires once per turn for single-agent turns
  // too (execution-pipeline.ts) and carries agentId/sessionKey/traceId on its PAYLOAD — so
  // resolve keys off the payload NOT the ALS (the emit is outside runWithContext).
  // The trajectoryId is the payload traceId = the SAME key the
  // tool/skill observe() wrote, so resolve finds the rows. NO pipeline observe; an
  // absent traceId → skip (fail-closed); the dedup makes a both-events DAG turn resolve once.
  deps.eventBus.on("diagnostic:message_processed", (p) => {
    if (!deps.learningOutcomeEnabled(p.agentId)) return;
    const scope = resolveScope({
      agentId: p.agentId,
      traceId: p.traceId,
      sessionKey: p.sessionKey,
      workspacePolicyHash: p.workspacePolicyHash,
    });
    if (scope === undefined) return; // no trajectory identity (absent traceId) → skip
    resolveAndConsume(scope, deps.clock.now());
  });

  // ---- Refresh the per-agent surface the MOMENT a
  // reflection run ADMITS a doc. Without this a freshly-admitted candidate stays invisible
  // until the next daemon boot — and promotion is USE-gated (the agent must SEE the skill to
  // use it), so the post-promote/demote refresh can NEVER fire: a second-order deadlock that
  // leaves a learned skill permanently dormant on a long-running daemon. `reflect:admitted.count`
  // IS the admitted count (events-learning.ts emits v.admitted). NOT gated by
  // learningOutcomeEnabled (this is a SKILLS signal); refreshSurface is undefined when no
  // registry is wired ⇒ byte-identical no-op. Mirrors the post-promote/demote refresh. ----
  deps.eventBus.on("reflect:admitted", (p) => {
    if (p.count > 0) refreshSurface?.(p.agentId);
  });

  // ---- Correction-driven demote: demote the learned skill a user CORRECTION invalidated. The
  // correction reader observed a `corrected` soft-failure against the PRIOR trajectory and emitted
  // `learning:correction_observed`; the normal resolve seam already CONSUMED that trajectory
  // (markTrajectoryResolved dedup), so the skill demote can ONLY happen here. We re-RESOLVE the prior
  // trajectory (read-only) to recover its CREDITED skills, then run ONLY the GATED skill-transition
  // with a `corrected` verdict — NOT the full resolveAndConsume (which would re-run failure-accrual /
  // re-emit / double-count). Reuses the SAME corroboration tally + decay-aware trend as the
  // resolve-seam demote, so the anti-flap belt holds: a single correction never stales a well-reused
  // skill; a corroborated (≥2 distinct (session,sender)) correction flips active/candidate→stale
  // (KEPT, not deleted — revivable). Gated default-OFF / no-store ⇒ byte-identical no-op. ----
  deps.eventBus.on("learning:correction_observed", (p) => {
    const skillStore = deps.learnedSkillStore;
    if (skillStore === undefined || deps.learningSkillsEnabled?.(p.agentId) !== true) return;
    void (async (): Promise<void> => {
      const r = await deps.outcomeStore.resolve(p.trajectoryId, { tenantId: p.tenantId, agentId: p.agentId });
      // No credited skill on the corrected turn → nothing to demote (fail-closed, non-fatal).
      if (!r.ok || r.value.usedSkillIds.length === 0) return;
      // One INFO line per correction that credits ≥1 skill — the re-resolve is OTHERWISE silent until
      // the 3rd corroborated correction actually demotes (anti-flap), so a single real correction
      // couldn't be confirmed live. Counts/ids only — the skill COUNT, never the procedure body/id-list
      // (memory bodies never reach the logs). Rare + load-bearing (a user correction feeding the demote gate is
      // the acute signal), so INFO (not DEBUG) — diagnosability must not depend on logLevel:debug having
      // been set before the incident.
      deps.logger.info(
        {
          agentId: p.agentId,
          tenantId: p.tenantId,
          sessionId: p.sessionId,
          trajectoryId: p.trajectoryId,
          creditedSkillCount: r.value.usedSkillIds.length,
          confidence: p.confidence,
          step: "correction-demote-reresolve",
        },
        "Correction re-resolve: feeding prior trajectory's credited skills to the gated demote",
      );
      const scope: OutcomeScope = { tenantId: p.tenantId, agentId: p.agentId, sessionId: p.sessionId, trajectoryId: p.trajectoryId };
      // An explicit `corrected` verdict carrying the prior turn's credited skills — the demote
      // branch of applySkillOutcomeTransitions (source:"correction" feeds the corroboration gate).
      const verdict: ResolvedOutcome = {
        outcome: "corrected",
        confidence: p.confidence,
        sources: ["correction"],
        recalledIds: [],
        usedSkillIds: r.value.usedSkillIds,
      };
      await applySkillOutcomeTransitions(deps, scope, verdict, {
        skillStore,
        threshold: deps.learningSkillsPromoteAt?.(p.agentId) ?? 3,
        skillFailureCorroborationTally,
        skillTrend,
        refreshSurface,
      });
    })();
  });
}

/** Dependencies for {@link setupLearningOutcomeWiring}. */
export interface SetupLearningOutcomeDeps {
  eventBus: TypedEventBus;
  outcomeStore: OutcomeSignalPort;
  /**
   * The recall-utility usefulness adapter (the reward/failure write
   * target). Already constructed in setup-memory.ts; threaded through here so the
   * agent never imports the store (closed graph).
   */
  usefulnessStore: MemoryUsefulnessStore;
  /**
   * The learned-skill adapter (the promote/demote write target). Already
   * constructed in setup-memory.ts; threaded through here so the agent never imports
   * the store (closed graph).
   */
  learnedSkillStore: MentalModelStorePort;
  clock: ClockPort;
  logger: ComisLogger;
  /** The parsed app config — the source of the master cost switch + per-agent flag. */
  config: AppConfig;
  /**
   * The shared per-agent learned-skill SURFACE registry (created in daemon.ts,
   * also threaded into setupAgents where each agent registers its refresh closure). The
   * resolve-seam promote/demote loop calls `refresh(agentId)` on it after a real
   * transition so the next session sees the new active set. OPTIONAL — absent ⇒ no
   * re-refresh (the boot snapshot stands; byte-identical for non-surfacing agents).
   */
  learnedSkillSurfaceRegistry?: import("./setup-agents/learned-skill-surface-registry.js").LearnedSkillSurfaceRegistry;
  /**
   * The cost-gated LLM outcome-judge fallback (built in the setup-learning-judge
   * leaf via `buildOutcomeJudgeWiring`, called from setup-memory.ts). OPTIONAL — when absent
   * (no agent has the judge on / no cheap-model key) the upgrade path is never entered.
   */
  outcomeJudge?: OutcomeJudge;
  /** Per-agent judge enable (memory.enabled && learningOutcome.enabled && judge.enabled). */
  learningOutcomeJudgeEnabled?: (agentId: string) => boolean;
  /** LCD-backed per-turn transcript reader for the judge to score. */
  readTurnTranscript?: (scope: JudgeScope) => string | undefined;
}

/**
 * Composition helper: compute the per-agent BYTE-IDENTITY enable gates from the
 * parsed config and stand up {@link wireLearningOutcome}.
 *
 * Every gate force-disables on the master cost switch (`memory.enabled !== false`)
 * AND requires the agent's own learning flag. The ONE `learning.enabled` gate covers
 * all four learning writes (outcome observe/resolve, reward, forgetting accrual, skill
 * promote/demote) — there is deliberately no per-feature split. With
 * `memory.enabled:false` every gate is `false` for every agent → the subscriber
 * observes/resolves/emits/writes NOTHING → ranking/recall/replies are byte-identical.
 */
export function setupLearningOutcomeWiring(deps: SetupLearningOutcomeDeps): void {
  // Master cost kill-switch: read defensively (`!== false`) so an absent block
  // fails OPEN to the per-agent flag rather than silently force-disabling.
  const costFeaturesEnabled = deps.config.memory?.enabled !== false;
  // Hoist the typed agents map once (mirrors setup-schedulers.ts:107) so the per-agent
  // lookup is a bracket access on a known Record (not a dynamic optional-chain sink).
  const agents = deps.config.agents ?? {};
  // The single collapsed learning gate: the four reward/promote WRITES all share this
  // one flag (`learning.enabled` under default-ON `memory.enabled`) — the per-feature
  // split is deliberately absent.
  const learningEnabled = (agentId: string): boolean =>
    costFeaturesEnabled && agents[agentId]?.learning?.enabled === true;
  wireLearningOutcome({
    eventBus: deps.eventBus,
    outcomeStore: deps.outcomeStore,
    usefulnessStore: deps.usefulnessStore,
    learnedSkillStore: deps.learnedSkillStore,
    clock: deps.clock,
    logger: deps.logger,
    learningOutcomeEnabled: learningEnabled, // the observe/resolve/emit subscriber
    learningTuningEnabled: learningEnabled, // SUCCESS→reward write
    learningForgettingEnabled: learningEnabled, // FAILURE→failure_count accrual
    // The learned-skill promote/demote gate — behind the one flag; the per-agent
    // promote threshold reads learning.reflect.promoteAtProofCount.
    learningSkillsEnabled: learningEnabled,
    learningSkillsPromoteAt: (agentId: string): number =>
      agents[agentId]?.learning?.reflect?.promoteAtProofCount ?? 3,
    // Route a post-transition re-refresh to the agent's surface cache (a no-op
    // for an unregistered/default-off agent). Undefined registry ⇒ undefined closure.
    refreshLearnedSkillSurface: deps.learnedSkillSurfaceRegistry
      ? (agentId: string): void => deps.learnedSkillSurfaceRegistry!.refresh(agentId)
      : undefined,
    // The conversational-breadth LLM-judge fallback (built in setup-memory via
    // buildOutcomeJudgeWiring). Absent ⇒ the upgrade path is never entered (byte-identical).
    outcomeJudge: deps.outcomeJudge,
    learningOutcomeJudgeEnabled: deps.learningOutcomeJudgeEnabled,
    readTurnTranscript: deps.readTurnTranscript,
  });
}
