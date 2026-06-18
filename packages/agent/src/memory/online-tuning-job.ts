// SPDX-License-Identifier: Apache-2.0
/**
 * The OFFLINE tuned-alpha bandit job.
 *
 * The WRITE path of learning-to-rank. Mirrors {@link runUserRepresentationBuild}
 * STRUCTURALLY (a background cron seam OFF the recall hot path: default-OFF gate →
 * read signal → bound → compute → write → counts-only event → idempotent + non-fatal)
 * but DELETES the offline LLM seam: the bandit is DETERMINISTIC and KEYLESS. There
 * is NO injected model-call seam, NO operation-model resolution, NO provider API
 * key — the bandit reads the already-accrued FEED signal, runs the config-selected pure
 * clamped step ({@link computeBanditAlphas} UCB when `learner:'bandit'`, else the
 * {@link computeTunedAlphas} nudge), and upserts a four-alpha vector for the run's
 * `(tenant, agent, intent)` bucket. So this job can NEVER make a network/model call or
 * incur model cost.
 *
 * Security + correctness posture:
 * - DEFAULT-OFF gate: with `config.enabled === false` nothing is read or written and
 *   a counts-only event is emitted — byte-identical to today.
 * - TRUST-FREEZE (the OD2 ship-gate, belt #4 at the job layer): the bandit reads +
 *   writes a {@link TunedAlphaVector}, which structurally has no trust field, and the
 *   {@link FeedAggregate} it builds has no trust gradient — the bandit cannot move the
 *   trust weight (it stays config-sourced at the apply site). The literal
 *   trust-weight field name is deliberately never written here (the grep-0 belt —
 *   JSDoc paraphrases it as "the fifth scoring weight").
 * - CLAMP (Pitfall 2): BOTH pure steps clamp every output to `[0, 1]`, and the gradients
 *   are derived from the BOUNDED used-RATE in `[0, 1]` (NOT raw counts — Pitfall 2), so a
 *   pathological FEED signal / poisoned reward can neither invert a boost (negative weight)
 *   nor run away (>1, overturning trust-first).
 * - NON-FATAL: a FEED-read failure OR a store-upsert rejection is a WARN +
 *   `ok({ updated: false })` — the bandit must never break a run. Idempotent: the
 *   upsert is keyed per `(tenant, agent, intent)` (one row per scope+intent bucket).
 * - OBSERVABILITY: emits a MINIMAL counts-only `memory:online_tuning_applied`
 *   event + counts-only logs — NEVER the FEED content or the alpha VALUES (AGENTS.md
 *   §2.7 + the binding constraint "counts/ids-only logging, NEVER the FEED content").
 *
 * The agent consumes the store as a port TYPE from `@comis/core` (the agent↛memory
 * cut); the daemon injects the concrete adapter + scopes the `readUsefulness` seam.
 * NO memory-package import here, NO wall-clock global (the injected `clock`), NO env
 * read.
 *
 * @module
 */

import { ok, fromPromise, type Result } from "@comis/shared";
import type {
  TunedAlphaStore,
  TunedAlphaVector,
  ClockPort,
  ComisLogger,
} from "@comis/core";
import {
  computeTunedAlphas,
  computeBanditAlphas,
  type FeedAggregate,
  type BanditPosterior,
} from "../rag/tuned-alpha-update.js";

/**
 * The BASELINE four non-trust scoring alphas (from static `rag.scoring` config) the
 * bandit starts from when no tuned row exists yet for this scope — so the FIRST run
 * nudges away from the operator's configured weights, not from zero. The fifth
 * (trust) scoring weight is deliberately ABSENT: the bandit never reads or writes it
 * (the OD2 ship-gate — trust stays config-sourced at the apply site).
 */
export interface OnlineTuningBaselineAlphas {
  recencyAlpha: number;
  temporalAlpha: number;
  proofAlpha: number;
  usefulnessAlpha: number;
}

/** Configuration for one offline bandit run (the per-agent cron knob subset). */
export interface MemoryOnlineTuningConfig {
  /** DEFAULT-OFF gate. When false: no read, no write (and the bandit is keyless anyway). */
  enabled: boolean;
  /**
   * INPUT bound: the max recent candidate memories whose FEED signal is read +
   * aggregated this run (bounds the read; the daemon applies it when building the
   * `readUsefulness` seam's id set). Optional: the bound lives daemon-side, this is
   * forwarded for completeness.
   */
  maxSourceMemories?: number;
  /**
   * RANK-03 learner selection (`learningTuning.learner`). `"bandit"` → the deterministic
   * UCB `computeBanditAlphas` (the FULL 4-alpha vector learns from the outcome-attributed
   * reward mean that rides every axis); `"nudge"` (or omitted) → the conservative
   * `STEP=0.05` `computeTunedAlphas` fallback (only usefulness moves, the other gradients
   * are 0). A FORWARD choice (I8), NOT a back-compat toggle. Omitted → nudge (the existing
   * byte-identical behaviour; the daemon passes "bandit" only when `learningTuning.enabled`).
   */
  learner?: "bandit" | "nudge";
  /**
   * RANK-03 UCB confidence-weight (`learningTuning.exploration`, [0,1], default 0.1). Only
   * consulted by the `"bandit"` learner — the deterministic optimism bonus weight (NOT an
   * RNG temperature). Ignored by the nudge.
   */
  exploration?: number;
  /**
   * RANK-02 the per-intent bucket this run tunes. When present the read/upsert key on
   * `(tenant, agent, intent)` and the emit carries it; omitted → the GLOBAL '' bucket
   * (byte-identical to the pre-intent behaviour). The closed-union value comes from the
   * daemon's iteration over the deterministic intents; typed as a plain string at the
   * job boundary (no cross-package type leak).
   */
  intent?: string;
}

/** The per-id FEED counts the bandit aggregates (counts only — never content). */
export interface OnlineTuningFeedEntry {
  /** Times this memory was recalled AND attributed as used. */
  usedCount: number;
  /** Times recalled but NOT used. */
  ignoredCount: number;
  /**
   * WR-03 (RANK-01): outcome-attributed task FAILURE count for this memory — the
   * NEGATIVE-reward term. A memory in the `recalled_ids` of a `failure`/`corrected`
   * trajectory accrues `failure_count` (daemon reward seam, corroboration-gated). The
   * bandit projects it into the posterior as a negative reward so a failure-implicated
   * memory is DOWN-weighted per intent (RANK-01: "negative reward to feed the ranker").
   * Optional: an older feed seam / a clean memory omits it → treated as 0 (byte-identical
   * to the positive-only behaviour). NEVER touches the recall hot-path `usefulnessNorm`.
   */
  failureCount?: number;
}

/** Dependencies injected into the offline bandit handler. NO LLM/key seam (keyless). */
export interface MemoryOnlineTuningDeps {
  agentId: string;
  tenantId: string;
  config: MemoryOnlineTuningConfig;
  /**
   * The SEGREGATED tuned-alpha store (port TYPE from `@comis/core`) — the
   * `read` (current vector) + `upsert` (next vector) path. The daemon injects the
   * concrete adapter; the agent cannot import that package (the agent↛memory cut).
   */
  tunedAlphaStore: TunedAlphaStore;
  /**
   * The INJECTED FEED-read seam: the accrued per-memory usefulness counts for the
   * bounded recent candidate set, scoped to `(tenant, agent[, intent])` by the
   * daemon (mirrors {@link runUserRepresentationBuild}'s `readSources`). Abstracted
   * so the job imports no memory package. A READ failure is NON-FATAL here — the
   * bandit must never break a run (returns `updated: false`).
   */
  readUsefulness: () => Promise<Result<Map<string, OnlineTuningFeedEntry>, Error>>;
  /**
   * The BASELINE four non-trust alphas (the static `rag.scoring` config) used as the
   * current vector when no tuned row exists yet. NEVER carries the trust weight.
   */
  configScoring: OnlineTuningBaselineAlphas;
  /** Wall-clock reads — the upsert scope `now`. NEVER a wall-clock global. */
  clock: ClockPort;
  logger: ComisLogger;
  /**
   * Counts-only event sink (the loose-typed sink mirroring the reasoning/userrep jobs). RANK-06:
   * REQUIRED (no longer optional) so the emit is a PLAIN `eventBus.emit(...)` — the `?.`-chained
   * form evaded the EMIT_REGEX architecture gate AND the type system + trajectory. The daemon
   * always injects `container.eventBus`.
   */
  eventBus: { emit(event: string, payload: unknown): void };
}

/** Counts-only outcome of one bandit run (never carries the alpha VALUES or FEED content). */
export interface MemoryOnlineTuningStats {
  /** True when a next vector was upserted (false when off / no signal / read failed / upsert rejected). */
  updated: boolean;
  /** How many of the four alphas hit a clamp bound (0/1 boundary) this run. */
  clampHits: number;
  /** Number of FEED-signal ids aggregated this run (0 ⇒ no nudge). */
  signalCount: number;
}

/** The job's Result alias (exported for the test + the daemon onComplete mapping). */
export type MemoryOnlineTuningResult = Result<MemoryOnlineTuningStats, Error>;

// ---------------------------------------------------------------------------
// FEED aggregation (the bounded used-RATE → gradient, Pitfall 2)
// ---------------------------------------------------------------------------

/**
 * WR-03 failure-reward weight: the max negative reward an all-failure memory
 * contributes (mirrors the lifecycle store's `failurePenalty` magnitude, 0.5). The
 * saturating term `failureCount / (failureCount + K)` ∈ [0, 1) scales it, so one
 * failure costs a little and many failures approach (never reach) the full weight.
 */
const FAILURE_REWARD_WEIGHT = 0.5;
/**
 * WR-03 failure saturation constant K (mirrors the lifecycle store's
 * FAILURE_SATURATION_K): ~3 failures reach half the penalty. Keeps the negative
 * reward bounded + monotone so a poisoned/pathological failure burst cannot run the
 * posterior away (the downstream `clampAlpha` is the hard floor regardless).
 */
const FAILURE_SATURATION_K = 3;

/**
 * Per-id net reward in [-0.5, 0.5], centered on a neutral 0: the bounded used-RATE
 * deviation MINUS a saturating failure penalty (WR-03). `usedRate` is
 * `usedCount/(usedCount+ignoredCount)` in [0,1] (NOT raw counts — Pitfall 2); when a
 * memory has no used/ignored signal the rate is the neutral 0.5 so a PURE-failure
 * memory still registers (its failure term pushes it negative rather than being
 * skipped as "never recalled"). The failure penalty is
 * `FAILURE_REWARD_WEIGHT * failureCount/(failureCount+K)` ∈ [0, 0.5). Clamped to
 * [-0.5, 0.5] so the mean stays in the FeedAggregate gradient's documented range.
 */
function netCenteredReward(entry: OnlineTuningFeedEntry): number {
  const used = entry.usedCount;
  const ignored = entry.ignoredCount;
  const failures = entry.failureCount ?? 0;
  const usageTotal = used + ignored;
  // No used/ignored → neutral 0.5 baseline (so a pure-failure memory is not skipped);
  // else the genuine used-rate. Centered on 0.5 below.
  const usedRate = usageTotal > 0 ? used / usageTotal : 0.5;
  const failurePenalty = failures > 0 ? FAILURE_REWARD_WEIGHT * (failures / (failures + FAILURE_SATURATION_K)) : 0;
  const centered = usedRate - 0.5 - failurePenalty;
  // Clamp to the [-0.5, 0.5] band the usefulness gradient + posterior expect.
  return Math.min(0.5, Math.max(-0.5, centered));
}

/**
 * Aggregate the FEED counts Map into a bounded {@link FeedAggregate} AND the
 * {@link BanditPosterior} the UCB learner consumes. Each per-memory NET reward is the
 * bounded used-RATE deviation MINUS a saturating failure penalty (WR-03 / RANK-01),
 * in `[-0.5, 0.5]` and centered on `0` so a neutral memory contributes `0`. We average
 * the net rewards across the ids and project the mean onto the USEFULNESS gradient — a
 * positive net used-rate nudges `usefulnessAlpha` UP, a net ignored/FAILED signal nudges
 * it DOWN; the magnitude is bounded (so the nudge moves the weight by at most `STEP * 0.5`).
 * The other three gradients are `0` this run: the feed has no per-axis recency/temporal/
 * proof attribution — but under the BANDIT learner those axes still MOVE, because the
 * posterior's outcome-attributed reward MEAN rides every axis's exploit term (the RANK-04
 * keystone mechanism; the recency/temporal/proof gradients become learnable).
 *
 * The posterior derives from the SAME outcome-enriched feed (the reward seam — Plan 04 —
 * writes `recordUsage` on a `success` trajectory and `recordFailure` on a `failure`/
 * `corrected` one): `rewardSum` is the SIGNED sum of per-id net rewards (success → +,
 * ignore/FAILURE → −) and `n` the count of signal-bearing ids (the UCB arm-pull count).
 * A memory with NO used/ignored/failure signal is skipped (never recalled — no arm pull).
 * Deterministic — no RNG, no clock. A neutral / empty signal yields the all-zero aggregate
 * + `{rewardSum:0, n:0}` (a no-op — recall unchanged under both learners).
 */
function aggregateFeed(feed: Map<string, OnlineTuningFeedEntry>): {
  aggregate: FeedAggregate;
  posterior: BanditPosterior;
} {
  let sumCentered = 0;
  let counted = 0;
  for (const entry of feed.values()) {
    // A signal-bearing id has at least one of used / ignored / failure. A memory with
    // NONE was never recalled AND never failed — no arm pull, no reward.
    if (entry.usedCount + entry.ignoredCount + (entry.failureCount ?? 0) <= 0) continue;
    sumCentered += netCenteredReward(entry); // signed net reward in [-0.5, 0.5]
    counted++;
  }
  const usefulnessGradient = counted === 0 ? 0 : sumCentered / counted; // mean net reward, [-0.5, 0.5]
  return {
    aggregate: {
      recencyGradient: 0,
      temporalGradient: 0,
      proofGradient: 0,
      usefulnessGradient,
    },
    // The outcome-attributed posterior: rewardSum = signed net (success → +, ignore/FAILURE → −),
    // n = the arm-pull count. Both deterministic; the bandit's reward mean = rewardSum/max(1,n).
    posterior: { rewardSum: sumCentered, n: counted },
  };
}

/** Count how many of the four alphas sit exactly on a clamp bound (0 or 1). */
function countClampHits(v: TunedAlphaVector): number {
  const onBound = (x: number): boolean => x === 0 || x === 1;
  return (
    (onBound(v.recencyAlpha) ? 1 : 0) +
    (onBound(v.temporalAlpha) ? 1 : 0) +
    (onBound(v.proofAlpha) ? 1 : 0) +
    (onBound(v.usefulnessAlpha) ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Run one OFFLINE bandit pass for a single `(tenant, agent, intent)` bucket (the daemon
 * iterates the intents).
 *
 * Gate on `config.enabled` (default-OFF → counts-only emit, no read/write) → read the
 * accrued FEED signal via the injected seam (a READ failure is NON-FATAL → WARN +
 * `updated: false`) → read the current tuned vector for this intent bucket (else the
 * baseline config alphas) → aggregate the FEED Map into a bounded {@link FeedAggregate} +
 * the outcome posterior → run the config-selected pure clamped step ({@link computeBanditAlphas}
 * UCB when `learner:'bandit'`, else the {@link computeTunedAlphas} nudge) → `upsert` the
 * intent bucket via the port (a rejecting store → WARN + non-fatal) → emit a counts-only
 * `memory:online_tuning_applied` event (the per-intent dim included). DETERMINISTIC +
 * KEYLESS — no model, no key, no RNG (UCB exploration is a deterministic bonus).
 *
 * @returns `ok(stats)` always on a reached run (the bandit is non-fatal); the
 *   `updated` flag distinguishes a real write from an off/no-signal/failed pass.
 */
export async function runOnlineTuning(
  deps: MemoryOnlineTuningDeps,
): Promise<MemoryOnlineTuningResult> {
  const { config, agentId, tenantId, tunedAlphaStore, configScoring, eventBus, logger, clock } = deps;
  const startMs = clock.now();

  let updated = false;
  let clampHits = 0;
  let signalCount = 0;

  const emit = (): void => {
    // Counts-only: booleans/counts + the per-intent dim ONLY — NEVER the alpha values or the
    // FEED content (the binding SEC-01 constraint, the `.not.toMatch(/alpha/i)` belt). RANK-06:
    // a PLAIN `eventBus.emit` (the `?.` dropped) so EMIT_REGEX + the type system + the trajectory
    // all see it; the loose-sink dep stays optional, but the emit itself is unconditional below.
    eventBus.emit("memory:online_tuning_applied", {
      agentId,
      updated,
      clampHits,
      signalCount,
      ...(config.intent !== undefined ? { intent: config.intent } : {}),
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
  };

  const stats = (): MemoryOnlineTuningStats => ({ updated, clampHits, signalCount });

  // The DEFAULT-OFF gate. No read, no write (the bandit is keyless anyway).
  if (!config.enabled) {
    logger.debug(
      { agentId, step: "online-tuning" as const },
      "Online tuning disabled (enabled=false) — skipping",
    );
    emit();
    return ok(stats());
  }

  // 1. Read the accrued FEED signal. NON-FATAL: a read failure must never break a
  //    run — WARN + return ok with nothing written (the bandit is a background
  //    optimizer, not a correctness dependency). This is the delta vs the userrep job
  //    (whose source read is FATAL): a missing FEED signal simply means "no nudge".
  const feedResult = await fromPromise(deps.readUsefulness());
  if (!feedResult.ok || !feedResult.value.ok) {
    logger.warn(
      {
        agentId,
        errorKind: "dependency" as const,
        step: "online-tuning" as const,
        hint: "FEED signal read failed — no tuned-alpha update this run (non-fatal; the ranker keeps its current weights)",
      },
      "Online tuning FEED read failed (non-fatal)",
    );
    emit();
    return ok(stats());
  }
  const feed = feedResult.value.value;
  signalCount = feed.size;

  // 2. Read the current tuned vector for this (tenant, agent, intent) bucket; fall back to
  //    the BASELINE config alphas (the four non-trust weights) when no row exists yet, so the
  //    first run nudges from the operator's configured weights. A read failure → baseline
  //    (non-fatal — same posture). RANK-02: the per-intent bucket (omitted → the global '').
  //    The fifth (trust) weight is NEVER read here.
  const intentScope = config.intent !== undefined ? { intent: config.intent } : {};
  const currentResult = await fromPromise(
    tunedAlphaStore.read({ tenantId, agentId, ...intentScope }),
  );
  const baseline: TunedAlphaVector = {
    recencyAlpha: configScoring.recencyAlpha,
    temporalAlpha: configScoring.temporalAlpha,
    proofAlpha: configScoring.proofAlpha,
    usefulnessAlpha: configScoring.usefulnessAlpha,
  };
  const current: TunedAlphaVector =
    currentResult.ok && currentResult.value.ok && currentResult.value.value !== undefined
      ? currentResult.value.value
      : baseline;

  // 3. Aggregate the FEED Map into the bounded gradient + the outcome-attributed posterior
  //    (the used-RATE, NOT raw counts — Pitfall 2), then run the config-selected PURE clamped
  //    step. RANK-03: `learner:'bandit'` → the deterministic UCB `computeBanditAlphas` (the
  //    full 4-alpha vector moves via the reward mean that rides every axis); `'nudge'` (or
  //    omitted) → the conservative `computeTunedAlphas` (only usefulness moves). A neutral/empty
  //    signal is a no-op under both (all-zero aggregate + zero posterior → next === current).
  const { aggregate, posterior } = aggregateFeed(feed);
  const next =
    config.learner === "bandit"
      ? computeBanditAlphas(current, aggregate, posterior, config.exploration ?? 0.1)
      : computeTunedAlphas(current, aggregate);
  clampHits = countClampHits(next);

  // 4. Persist via the port. NON-FATAL: a rejecting/erroring store → WARN + return ok
  //    (the run continues; the ranker keeps its prior weights). Idempotent: one row per
  //    (tenant, agent, intent) — re-running upsert-replaces THAT bucket in place.
  const upserted = await fromPromise(
    tunedAlphaStore.upsert(next, { tenantId, agentId, now: clock.now(), ...intentScope }),
  );
  if (!upserted.ok || !upserted.value.ok) {
    logger.warn(
      {
        agentId,
        errorKind: "dependency" as const,
        step: "online-tuning" as const,
        hint: "tunedAlphaStore.upsert failed/rejected — the ranker keeps its current weights (non-fatal)",
      },
      "Failed to upsert tuned-alpha vector (non-fatal)",
    );
    emit();
    return ok(stats());
  }
  updated = true;

  logger.info(
    {
      agentId,
      step: "online-tuning" as const,
      updated,
      clampHits,
      signalCount,
      durationMs: clock.now() - startMs,
    },
    "Online tuning applied",
  );
  emit();
  return ok(stats());
}
