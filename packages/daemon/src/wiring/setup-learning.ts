// SPDX-License-Identifier: Apache-2.0
/**
 * Outcome-signal (Verified Learning WS1) write-back wiring.
 *
 * The composition-root glue between the deterministic tool/pipeline completion
 * bus events (`tool:executed`, `graph:completed`) and the `OutcomeSignalPort`
 * (the @comis/memory adapter). The daemon is the ONLY
 * place holding BOTH the bus AND the adapter — the agent↛memory build cut means
 * the agent emits ids+counts on the bus and the daemon does the observe/resolve.
 * Mirrors `wireMemoryUsefulness` (setup-memory-usefulness-wiring.ts). Counts + ids
 * + closed-enums ONLY ever cross the bus (AGENTS.md §2.7 / SEC-01) — never bodies.
 *
 * BYTE-IDENTITY GATE (P0): every handler's FIRST statement is the
 * `learningOutcomeEnabled(agentId)` short-circuit. With the default config
 * (`learningOutcome.enabled:false`, or the master `memory.costFeatures.enabled:false`
 * force-disable) the subscriber observes/resolves/emits NOTHING — the recall/score
 * hot path (`score.ts`/`scoring-overlay.ts`, untouched in P0) is byte-identical.
 *
 * Fire-and-forget / non-fatal: a failing or slow `observe`/`resolve` warns and
 * continues; it NEVER throws out of the bus handler and never blocks the turn
 * (the turn already completed). The `unknown` resolved outcome derives no
 * learning (fail-closed, OUTCOME-05) and is NOT counted as resolved coverage.
 *
 * @module
 */

import {
  tryGetContext,
  type TypedEventBus,
  type OutcomeSignalPort,
  type MemoryUsefulnessStore,
  type LearnedSkillStorePort,
  type ResolvedOutcome,
  type ClockPort,
  type ComisLogger,
  type AppConfig,
} from "@comis/core";

import { deriveTenantFromSessionKey } from "./setup-memory-usefulness-wiring.js";
import { createSkillTrendTracker, type SkillTrendTracker } from "./setup-learning-skill-trend.js";

/** Dependencies for {@link wireLearningOutcome}. */
export interface LearningOutcomeWiringDeps {
  /** The daemon's typed event bus (source of the tool/graph completion events). */
  eventBus: TypedEventBus;
  /** The sole @comis/memory adapter for the outcome port (the observe/resolve target). */
  outcomeStore: OutcomeSignalPort;
  /**
   * The sole @comis/memory recall-utility adapter (the reward/failure write target,
   * RANK-01/FORGET-02). The daemon is the ONLY place holding BOTH this AND
   * `OutcomeSignalPort.resolve()` — the agent↛memory build cut means the agent
   * never imports the store (closed graph). Injected from setup-memory.ts where it
   * is already constructed.
   */
  usefulnessStore: MemoryUsefulnessStore;
  /** Injected clock for `observedAt` — the deterministic time source (no ambient wall clock). */
  clock: ClockPort;
  /** Structured logger for the OBS-01 INFO completion line + the non-fatal failure WARN. */
  logger: ComisLogger;
  /**
   * Per-agent effective enable: true ONLY when the agent has
   * `learningOutcome.enabled` AND the master `memory.costFeatures.enabled` switch
   * is on. Default-OFF (no agent opts in) → the subscriber is a no-op.
   */
  learningOutcomeEnabled: (agentId: string) => boolean;
  /**
   * Per-agent reward-write enable (RANK-01): true ONLY when the agent has
   * `learningTuning.enabled` AND the master `memory.costFeatures.enabled` switch is
   * on. Gates the SUCCESS→`recordUsage` positive-reward write. Default-OFF → no
   * reward write (byte-identical).
   */
  learningTuningEnabled: (agentId: string) => boolean;
  /**
   * Per-agent failure-accrual enable (FORGET-02): true ONLY when the agent has
   * `learningForgetting.enabled` AND the master `memory.costFeatures.enabled`
   * switch is on. Gates the FAILURE/CORRECTED→`recordFailure` accrual (itself
   * corroboration-gated, FORGET-03). Default-OFF → no failure accrual (byte-identical).
   */
  learningForgettingEnabled: (agentId: string) => boolean;
  /**
   * The sole @comis/memory learned-skill adapter (the SURFACE-04/05 promote/demote
   * write target). The daemon is the ONLY place holding BOTH this AND
   * `OutcomeSignalPort.resolve()` (the agent↛memory cut). OPTIONAL — when absent (a
   * pre-Plan-05 caller, or learning disabled) the promote/demote loop is a no-op
   * (byte-identical). Injected from setup-memory.ts where it is already constructed.
   */
  learnedSkillStore?: LearnedSkillStorePort;
  /**
   * Per-agent learned-skill promote/demote enable (SURFACE-04/05): true ONLY when the
   * agent has `learningSkills.enabled` AND the master `memory.costFeatures.enabled`
   * switch is on. Gates the entire promote/demote loop. DEFAULT-OFF
   * (`learningSkills.enabled` defaults false) → no promote/demote/emit (byte-identical).
   */
  learningSkillsEnabled?: (agentId: string) => boolean;
  /**
   * Per-agent `promoteAtProofCount` (the threshold the candidate→active transition
   * crosses — schema default 3). Passed verbatim into `learnedSkillStore.promote(id,
   * scope, threshold)` (the Plan 02 D2 store-side CASE gate). Read once per agent.
   */
  learningSkillsPromoteAt?: (agentId: string) => number;
  /**
   * WR-01: refresh a given agent's learned-skill SURFACE cache after a promote/demote
   * actually moved a row, so the NEXT session's prompt-skills freeze captures the new
   * active set (SURFACE-03 next-SESSION pickup — never a mid-session mutation of an
   * already-frozen snapshot). The per-agent surface caches live in setup-agents-runtime
   * and are reached via a shared registry; this closure looks the agent's cache up and
   * fires its async refresh fire-and-forget. OPTIONAL — absent (no registry threaded, or
   * learning disabled) ⇒ no refresh (byte-identical). The boot refresh still runs.
   */
  refreshLearnedSkillSurface?: (agentId: string) => void;
}

/** High-confidence default for a clean deterministic tool/pipeline signal. */
const DETERMINISTIC_CONFIDENCE = 0.9;
/** Slightly lower confidence for a content/detector-classified (non-transport) tool failure. */
const CLASSIFIED_FAILURE_CONFIDENCE = 0.8;
/**
 * ATTR-02: confidence for a pure skill-attribution row (memory:skill_used → observe).
 * Deliberately LOW + paired with `outcome:"unknown"` so the row NEVER wins resolve()
 * fusion — it carries the `used_skill_ids` column only, asserting no outcome verdict.
 */
const ATTRIBUTION_CONFIDENCE = 0;

/** A resolved outcome scope keyed off the event/ALS context. */
interface OutcomeScope {
  tenantId: string;
  agentId: string;
  sessionId: string;
  trajectoryId: string;
}

/**
 * Resolve the (tenant, agent, session, trajectory) scope for an observation.
 *
 * The deterministic tool event carries `agentId`/`traceId`/`sessionKey` on its
 * payload; the graph completion events do NOT (only `graphId`), so their scope is
 * recovered from the ambient request context (AsyncLocalStorage). Payload fields
 * win when present; ALS is the fallback. Returns `undefined` when neither source
 * yields an agentId AND a trajectory identity (we cannot scope/attribute then) —
 * the caller skips. The tenant defaults to "default" only when absent; the agentId
 * is NEVER collapsed across agents (cross-agent isolation, T-198-16).
 */
function resolveScope(payload: {
  agentId?: string;
  traceId?: string;
  sessionKey?: string;
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
  return { tenantId, agentId, sessionId, trajectoryId };
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
      // ATTR-02: the per-turn used-skill ids (Plan 03's memory:skill_used carrier)
      // thread onto the observe() so the used_skill_ids COLUMN is written; resolve()
      // union-dedups it across rows. Omitted (the deterministic tool/pipeline paths)
      // ⇒ the column stays NULL, byte-identical to pre-ATTR-02.
      ...(usedSkillIds !== undefined && usedSkillIds.length > 0 ? { usedSkillIds: [...usedSkillIds] } : {}),
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

/** The DETERMINISTIC fused-verdict sources — a single one of these satisfies the FORGET-03 gate. */
const DETERMINISTIC_FUSION_SOURCES: ReadonlySet<string> = new Set(["tool", "pipeline"]);
/** Independent (distinct-session) failures required to corroborate a NON-deterministic failure. */
export const CORROBORATION_MIN_INDEPENDENT = 2;

/**
 * WR-01 bound on the FORGET-03 corroboration tally — the max distinct memoryIds the
 * `failureCorroborationTally` Map tracks before it evicts the oldest. The tally is a
 * daemon-lifetime in-process gauge (resets on restart); without a cap a busy fleet
 * (or an adversary on rotating session keys) grows it without bound. 50_000 mirrors
 * the reaction/session trajectory maps' `maxEntries` (setup-learning-reactions.ts).
 * Past this many distinct failing memories the oldest-touched id is dropped — a soft
 * forget of the stalest corroboration state, never a correctness loss (the eviction
 * exemption itself is store-side, Plan 05).
 */
export const MAX_TRACKED_FAILURE_MEMORIES = 50_000;

/**
 * FORGET-03 anti-induced-eviction corroboration gate (a SECURITY control). A
 * `failure_count` accrual is permitted ONLY when the failure is corroborated:
 *  - (a) the fused verdict has a DETERMINISTIC source (`tool`/`pipeline`) — one
 *    deterministic failure suffices (it cannot be spoofed by an external sender), OR
 *  - (b) the daemon has now seen ≥2 INDEPENDENT failures (distinct sessions) for
 *    this memory within the subscriber's lifetime.
 * Below the gate → no accrual (Defer ≠ Retry — a single low-trust/`external`
 * failure is benign). This is the daemon-side half of the two-layer control; the
 * high-`proof_count`/`system`/`pinned` EVICTION exemption is enforced store-side
 * (Plan 05's eviction predicate), so the daemon reads NO per-memory
 * proof/trust/pinned here (`ResolvedOutcome` carries none — no hot-path DB read).
 *
 * Mutates `tally` (memoryId → distinct sessionIds seen failing it) as a side effect
 * so the across-call distinct-session count accumulates, mirroring the in-process
 * coverage gauge. Returns true when the accrual should fire.
 *
 * WR-01 BOUNDED (two caps, no daemon-lifetime growth): (1) the inner per-memory Set
 * STOPS growing at `CORROBORATION_MIN_INDEPENDENT` — once the gate can be met the
 * exact distinct-session count is irrelevant, so we never accumulate every session;
 * (2) the outer Map is capped at `maxTracked` (default {@link MAX_TRACKED_FAILURE_MEMORIES})
 * and evicts the OLDEST-touched memoryId (Map insertion order = recency, refreshed via
 * delete-before-set) when a NEW memoryId would exceed the cap. Both keep the gate
 * decision byte-identical for any realistic workload — the caps only bite the
 * pathological/adversarial unbounded case.
 */
export function failureCorroborated(
  memoryId: string,
  sessionId: string,
  sources: ReadonlyArray<string>,
  tally: Map<string, Set<string>>,
  maxTracked: number = MAX_TRACKED_FAILURE_MEMORIES,
): boolean {
  // Record this failure's session BEFORE the decision so the distinct-session
  // count includes the current occurrence (the 2nd distinct session corroborates).
  let sessions = tally.get(memoryId);
  if (sessions === undefined) {
    // Cap the number of tracked memoryIds: when a NEW memoryId would exceed the cap,
    // evict the OLDEST-touched one (the first key — Map insertion order is recency
    // because a re-touch deletes-before-re-sets below).
    if (tally.size >= maxTracked) {
      const oldestKey = tally.keys().next().value;
      if (oldestKey !== undefined) tally.delete(oldestKey);
    }
    sessions = new Set<string>();
    tally.set(memoryId, sessions);
  } else {
    // Refresh recency: delete-before-set moves this memoryId to the Map's tail so the
    // evict-oldest (first key) above stays the genuine least-recently-touched id.
    tally.delete(memoryId);
    tally.set(memoryId, sessions);
  }
  // Stop growing the inner Set once the corroboration floor is reachable — past
  // CORROBORATION_MIN_INDEPENDENT the precise count never changes the gate decision.
  if (sessions.size < CORROBORATION_MIN_INDEPENDENT) sessions.add(sessionId);
  if (sources.some((s) => DETERMINISTIC_FUSION_SOURCES.has(s))) return true;
  return sessions.size >= CORROBORATION_MIN_INDEPENDENT;
}

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

/** Per-call dependencies for {@link applySkillOutcomeTransitions} (the resolve-seam loop body). */
interface SkillOutcomeDeps {
  /** The learned-skill adapter (the name-keyed promote/demote target). */
  skillStore: LearnedSkillStorePort;
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
 * SURFACE-04/05/06 + OBS-01 — the resolve-seam learned-skill promote/demote body,
 * fire-and-forget / non-fatal. AWAITS the name-keyed store transition to read
 * rows-changed (CR-01: the loop holds skill NAMES, not the hash id; the store resolves
 * name→id internally AND reports whether a row moved) and increments the counter +
 * emits ONLY when a row actually transitioned (the telemetry stops lying about 0-row
 * writes). Scope-qualifies the corroboration/trend keys (WR-05). On a real transition
 * it refreshes the per-agent surface cache (WR-01). NEVER throws (each store call is
 * wrapped; a reject/err WARNs and is skipped).
 */
async function applySkillOutcomeTransitions(
  deps: LearningOutcomeWiringDeps,
  scope: OutcomeScope,
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
 * Mirrors {@link recordNonFatal} (WARNs with hint+errorKind on err/reject) but reads the
 * `{ changed }` result so the caller gates the counter/emit on a REAL row move. A
 * reject or err yields `false` (treated as "did not transition").
 */
async function runSkillTransition(
  deps: LearningOutcomeWiringDeps,
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

/**
 * Stand up the deterministic tool/pipeline → observe/resolve subscriber on the
 * daemon's bus. Fire-and-forget / non-fatal; default-OFF via `learningOutcomeEnabled`.
 *
 * Wiring:
 *  - `tool:executed`            → observe a `tool` outcome (`success===false` → failure).
 *  - `graph:completed`          → observe a `pipeline` outcome (status `completed` → success,
 *                                 else failure) AND, as the trajectory-completion signal,
 *                                 resolve the fused verdict, emit `learning:outcome_observed`
 *                                 (counts/ids only), and update coverage telemetry.
 *                                 (`graph:driver_lifecycle` is deliberately NOT observed —
 *                                 it is per-node and would flood the ledger; WR-02.)
 *
 * Coverage telemetry: a daemon-lifetime gauge of % finished trajectories with a
 * RESOLVABLE outcome. `total` increments per completion; `resolved` increments
 * ONLY when the fused outcome is NOT `unknown` (fail-closed, T-198-18) — a
 * no-signal trajectory is visibly unresolved.
 */
export function wireLearningOutcome(deps: LearningOutcomeWiringDeps): void {
  // Daemon-lifetime coverage gauge (resets on restart). Counts only.
  let total = 0;
  let resolved = 0;
  // FORGET-03 corroboration tally: memoryId → the DISTINCT sessions that failed it
  // (within this subscriber's lifetime). A NON-deterministic failure accrues
  // `failure_count` only once this reaches ≥2 distinct sessions; a deterministic
  // failure (tool/pipeline) bypasses it. Mirrors the coverage gauge's in-process
  // counters (resets on restart) — counts/ids only, never bodies.
  const failureCorroborationTally = new Map<string, Set<string>>();
  // SURFACE-05: a SECOND, independent daemon-lifetime corroboration tally for the
  // learned-SKILL demote path (skillId → DISTINCT failing sessions). Kept separate
  // from the memory tally above so the two write paths never alias an id. Reuses the
  // SAME failureCorroborated() gate (≥2 distinct-session OR 1 deterministic).
  const skillFailureCorroborationTally = new Map<string, Set<string>>();
  // SURFACE-05: the in-process, daemon-lifetime decay-aware trend (the WHEN-to-demote
  // decision). A corroborated failure demotes ONLY when the trend reaches WEAKENING —
  // so a single induced failure on a well-reused procedure does NOT archive it. WR-05:
  // its keys are scope-qualified (tenant+agent+name) by the caller (skillGaugeKey).
  const skillTrend = createSkillTrendTracker();
  // WR-01: the per-agent surface-cache refresh closure (looked up from the shared
  // registry threaded via deps) — fired after a REAL promote/demote so the next
  // session sees the new active set. Undefined ⇒ no refresh (byte-identical).
  const refreshSurface = deps.refreshLearnedSkillSurface;

  // ---- Deterministic tool signal (the only source that ships ACTIVE, OUTCOME-03) ----
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

  // ---- ATTR-02 skill-use attribution write-back (the loop-close, Plan 07) ----
  // The agent emits `memory:skill_used` (Plan 03) after a turn whose `read` matched a
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

    const scope = resolveScope({ agentId: p.agentId, traceId: p.traceId, sessionKey: p.sessionKey });
    if (scope === undefined) return;

    // ATTRIBUTION_CONFIDENCE: a neutral, low-confidence `explicit`/`unknown` carrier —
    // it threads the used-skill ids onto the column WITHOUT asserting an outcome verdict
    // (resolve() fuses the real tool/pipeline outcome; this row only carries ids).
    void observeNonFatal(deps, scope, "unknown", "explicit", ATTRIBUTION_CONFIDENCE, p.usedSkillIds);
  });

  // NB: `graph:driver_lifecycle` is intentionally NOT subscribed (WR-02). It is
  // emitted PER NODE, so observing it would write O(nodes) same-tier `pipeline`
  // rows per DAG turn (each at a distinct observedAt, so idempotency does not
  // collapse them) — flooding the append-only ledger and amplifying the WR-01
  // intra-tier fusion non-determinism. `graph:completed` (gated on the clean
  // GraphStatus below) is the SINGLE trajectory-level pipeline signal.

  // ---- Deterministic pipeline signal + trajectory-completion resolve/emit ----
  deps.eventBus.on("graph:completed", (p) => {
    const ctx = tryGetContext();
    const agentId = ctx?.agentId;
    if (agentId === undefined || !deps.learningOutcomeEnabled(agentId)) return;

    // graph:completed carries only graphId — recover the scope from ALS.
    const scope = resolveScope({});
    if (scope === undefined) return;

    // Success ONLY on a CLEAN completion; failed/cancelled/running → failure
    // (the real GraphStatus field is the signal — gated on an exact "completed").
    const outcome: "success" | "failure" = p.status === "completed" ? "success" : "failure";
    const resolveStart = deps.clock.now();

    // Observe the pipeline outcome FIRST, then resolve the fused verdict (so the
    // just-written row is visible) and emit. The whole chain is fire-and-forget /
    // non-fatal — it never throws out of the handler.
    void observeNonFatal(deps, scope, outcome, "pipeline", DETERMINISTIC_CONFIDENCE)
      .then(() => deps.outcomeStore.resolve(scope.trajectoryId, { tenantId: scope.tenantId, agentId: scope.agentId }))
      .then((r) => {
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
        const verdict = r.value;
        // Fail-closed coverage: an `unknown` verdict is NOT counted as resolved.
        if (verdict.outcome !== "unknown") resolved += 1;

        // ---- RANK-01 / FORGET-02 reward/failure write at resolve() time ----
        // The daemon is the only place holding BOTH this resolved verdict AND the
        // @comis/memory usefulness adapter (the agent↛memory cut). Thread the
        // resolved recalledIds + outcome into the per-intent reward/failure write,
        // fire-and-forget / non-fatal (the turn already completed). intent is
        // OMITTED → the global '' bucket (ResolvedOutcome carries no intent; the
        // bandit reads per-intent). An `unknown` verdict writes NOTHING (fail-closed).
        let failureAccrued = 0;
        if (verdict.outcome === "success") {
          if (deps.learningTuningEnabled(scope.agentId) && verdict.recalledIds.length > 0) {
            const rewardScope = { tenantId: scope.tenantId, agentId: scope.agentId, now: deps.clock.now() };
            // IN-01: ONE batched reward write for ALL recalled ids — the store's
            // recordUsage loops internally in a single transaction, so the per-id loop
            // (O(recalledIds) Promises + transactions) is needless. The FAILURE branch
            // below stays per-id (it is corroboration-gated per memory).
            recordNonFatal(deps, scope.agentId, "reward", () =>
              deps.usefulnessStore.recordUsage(verdict.recalledIds, [], rewardScope),
            );
          }
        } else if (verdict.outcome === "failure" || verdict.outcome === "corrected") {
          if (deps.learningForgettingEnabled(scope.agentId)) {
            const failScope = { tenantId: scope.tenantId, agentId: scope.agentId, now: deps.clock.now() };
            for (const mid of verdict.recalledIds) {
              // FORGET-03 corroboration gate: accrue ONLY when the failure is
              // corroborated (≥2 independent sessions OR 1 deterministic source).
              // Past the gate the accrual is UNCONDITIONAL — no daemon-side
              // proof/trust/pinned read (the eviction exemption is store-side, Plan 05).
              if (failureCorroborated(mid, scope.sessionId, verdict.sources, failureCorroborationTally)) {
                failureAccrued += 1;
                recordNonFatal(deps, scope.agentId, "failure_accrual", () =>
                  deps.usefulnessStore.recordFailure(mid, failScope),
                );
              }
            }
          }
        }

        // ---- SURFACE-04/05/06 learned-SKILL promote/demote at resolve() ----
        // Beside the RANK-01/FORGET-02 block (which iterates verdict.recalledIds),
        // iterate the ATTR-02 attributed verdict.usedSkillIds. On `success` PROMOTE
        // each; on a corroborated `failure`/`corrected` DEMOTE only when the
        // decay-aware trend reaches WEAKENING (anti-induced-demotion). Gated on
        // learningSkillsEnabled + learnedSkillStore present (default-OFF / no-store
        // ⇒ byte-identical no-op). Fire-and-forget / non-fatal: it AWAITS the store
        // transition to read rows-changed (so a 0-row write does NOT inflate the
        // counters — CR-01), then emits/logs the REAL counts.
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

        // Emit the resolved outcome (counts/ids/closed-enums ONLY — plain emit so it
        // lands on the trajectory and is type-checked; bridged for comis explain).
        deps.eventBus.emit("learning:outcome_observed", {
          agentId: scope.agentId,
          traceId: scope.trajectoryId,
          trajectoryId: scope.trajectoryId,
          outcome: verdict.outcome,
          source: verdict.sources[0] ?? "pipeline",
          confidence: verdict.confidence,
          timestamp: deps.clock.now(),
        });

        // OBS-01/02: one INFO completion line per resolve with durationMs + the
        // running coverage gauge + the corroborating `sources` (so an operator sees
        // e.g. ["tool","reaction"] — the reaction CORROBORATING the deterministic
        // winner, NOT replacing it). Counts/ids/closed-enums only.
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
        deps.logger.debug(
          {
            agentId: scope.agentId,
            step: "outcome-resolve",
            sources: verdict.sources,
            // OBS-01: the corroboration outcome (counts only) so the gate decision
            // is reconstructable — how many recalled memories accrued failure_count
            // vs how many were recalled. Never alpha values / memory bodies.
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
  });
}

/** Dependencies for {@link setupLearningOutcomeWiring}. */
export interface SetupLearningOutcomeDeps {
  eventBus: TypedEventBus;
  outcomeStore: OutcomeSignalPort;
  /**
   * The recall-utility usefulness adapter (RANK-01/FORGET-02 reward/failure write
   * target). Already constructed in setup-memory.ts; threaded through here so the
   * agent never imports the store (closed graph).
   */
  usefulnessStore: MemoryUsefulnessStore;
  /**
   * The learned-skill adapter (SURFACE-04/05 promote/demote write target). Already
   * constructed in setup-memory.ts; threaded through here so the agent never imports
   * the store (closed graph). Folded onto the existing call so setup-memory.ts stays
   * net-zero on lines.
   */
  learnedSkillStore: LearnedSkillStorePort;
  clock: ClockPort;
  logger: ComisLogger;
  /** The parsed app config — the source of the master cost switch + per-agent flag. */
  config: AppConfig;
  /**
   * WR-01: the shared per-agent learned-skill SURFACE registry (created in daemon.ts,
   * also threaded into setupAgents where each agent registers its refresh closure). The
   * resolve-seam promote/demote loop calls `refresh(agentId)` on it after a real
   * transition so the next session sees the new active set. OPTIONAL — absent ⇒ no
   * re-refresh (the boot snapshot stands; byte-identical for non-surfacing agents).
   */
  learnedSkillSurfaceRegistry?: import("./setup-agents/learned-skill-surface-registry.js").LearnedSkillSurfaceRegistry;
}

/**
 * Composition helper: compute the per-agent BYTE-IDENTITY enable gates from the
 * parsed config and stand up {@link wireLearningOutcome}.
 *
 * Every gate force-disables on the master cost switch
 * (`memory.costFeatures.enabled !== false` — exactly like the six cost crons,
 * OUTCOME-09) AND requires the agent's own per-feature flag (all default OFF):
 *  - `learningOutcome.enabled`    → the observe/resolve/emit subscriber (Phase 198).
 *  - `learningTuning.enabled`     → the SUCCESS→reward write (RANK-01).
 *  - `learningForgetting.enabled` → the FAILURE/CORRECTED→failure_count accrual (FORGET-02).
 * With the default config every gate is `false` for every agent → the subscriber
 * observes/resolves/emits/writes NOTHING → ranking/recall/replies are byte-identical.
 */
export function setupLearningOutcomeWiring(deps: SetupLearningOutcomeDeps): void {
  // Master cost kill-switch: read defensively (`!== false`) so an absent block
  // fails OPEN to the per-agent flag rather than silently force-disabling.
  const costFeaturesEnabled = deps.config.memory?.costFeatures?.enabled !== false;
  // Hoist the typed agents map once (mirrors setup-schedulers.ts:107) so the per-agent
  // lookup is a bracket access on a known Record (not a dynamic optional-chain sink).
  const agents = deps.config.agents ?? {};
  wireLearningOutcome({
    eventBus: deps.eventBus,
    outcomeStore: deps.outcomeStore,
    usefulnessStore: deps.usefulnessStore,
    learnedSkillStore: deps.learnedSkillStore,
    clock: deps.clock,
    logger: deps.logger,
    learningOutcomeEnabled: (agentId: string): boolean =>
      costFeaturesEnabled && agents[agentId]?.learningOutcome?.enabled === true,
    learningTuningEnabled: (agentId: string): boolean =>
      costFeaturesEnabled && agents[agentId]?.learningTuning?.enabled === true,
    learningForgettingEnabled: (agentId: string): boolean =>
      costFeaturesEnabled && agents[agentId]?.learningForgetting?.enabled === true,
    // SURFACE-04/05: the learned-skill promote/demote gate (default-OFF —
    // `learningSkills.enabled` defaults false) + the per-agent promote threshold.
    learningSkillsEnabled: (agentId: string): boolean =>
      costFeaturesEnabled && agents[agentId]?.learningSkills?.enabled === true,
    learningSkillsPromoteAt: (agentId: string): number =>
      agents[agentId]?.learningSkills?.promoteAtProofCount ?? 3,
    // WR-01: route a post-transition re-refresh to the agent's surface cache (a no-op
    // for an unregistered/default-off agent). Undefined registry ⇒ undefined closure.
    refreshLearnedSkillSurface: deps.learnedSkillSurfaceRegistry
      ? (agentId: string): void => deps.learnedSkillSurfaceRegistry!.refresh(agentId)
      : undefined,
  });
}
