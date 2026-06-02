// SPDX-License-Identifier: Apache-2.0
/**
 * The OFFLINE tuned-alpha bandit job (Phase 111 — LEARN-03, Track H2).
 *
 * The WRITE path of learning-to-rank. Mirrors {@link runUserRepresentationBuild}
 * STRUCTURALLY (a background cron seam OFF the recall hot path: default-OFF gate →
 * read signal → bound → compute → write → counts-only event → idempotent + non-fatal)
 * but DELETES the offline LLM seam: the bandit is DETERMINISTIC and KEYLESS. There
 * is NO injected model-call seam, NO operation-model resolution, NO provider API
 * key — the bandit reads the already-accrued FEED signal, runs the pure clamped
 * {@link computeTunedAlphas} step (111-01), and upserts a four-alpha vector. So this
 * job can NEVER make a network/model call or incur model cost (T-111-11).
 *
 * Security + correctness posture:
 * - DEFAULT-OFF gate (T-111-11): with `config.enabled === false` nothing is read or
 *   written and a counts-only event is emitted — byte-identical to today.
 * - TRUST-FREEZE (the OD2 ship-gate, belt #4 at the job layer): the bandit reads +
 *   writes a {@link TunedAlphaVector}, which structurally has no trust field, and the
 *   {@link FeedAggregate} it builds has no trust gradient — the bandit cannot move the
 *   trust weight (it stays config-sourced at the apply site, 111-03). The literal
 *   trust-weight field name is deliberately never written here (the grep-0 belt, the
 *   111-01/02 precedent — JSDoc paraphrases it as "the fifth scoring weight").
 * - CLAMP (Pitfall 2): the pure {@link computeTunedAlphas} clamps every output to
 *   `[0, 1]`, and the gradients are derived from the BOUNDED used-RATE in `[0, 1]`
 *   (NOT raw counts — Pitfall 2), so a pathological FEED signal can neither invert a
 *   boost (negative weight) nor run away (>1, overturning trust-first).
 * - NON-FATAL (T-111-13): a FEED-read failure OR a store-upsert rejection is a WARN +
 *   `ok({ updated: false })` — the bandit must never break a run. Idempotent: the
 *   upsert is keyed per `(tenant, agent)` (one row per scope, 111-02).
 * - OBSERVABILITY (T-111-14): emits a MINIMAL counts-only `memory:online_tuning_applied`
 *   event + counts-only logs — NEVER the FEED content or the alpha VALUES (AGENTS.md
 *   §2.7 + the binding constraint "counts/ids-only logging, NEVER the FEED content").
 *
 * The agent consumes the store as a port TYPE from `@comis/core` (the agent↛memory
 * cut); the daemon (111-04 wiring) injects the concrete adapter + scopes the
 * `readUsefulness` seam. NO memory-package import here, NO wall-clock global (the
 * injected `clock`), NO env read.
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
import { computeTunedAlphas, type FeedAggregate } from "../rag/tuned-alpha-update.js";

/**
 * The BASELINE four non-trust scoring alphas (from static `rag.scoring` config) the
 * bandit starts from when no tuned row exists yet for this scope — so the FIRST run
 * nudges away from the operator's configured weights, not from zero. The fifth
 * (trust) scoring weight is deliberately ABSENT: the bandit never reads or writes it
 * (the OD2 ship-gate — trust stays config-sourced at the apply site, 111-03).
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
}

/** The per-id FEED counts the bandit aggregates (counts only — never content). */
export interface OnlineTuningFeedEntry {
  /** Times this memory was recalled AND attributed as used. */
  usedCount: number;
  /** Times recalled but NOT used. */
  ignoredCount: number;
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
  /** Minimal counts-only event sink (mirrors the reasoning/userrep jobs' loose sink). */
  eventBus?: { emit(event: string, payload: unknown): void };
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
 * Aggregate the FEED counts Map into a bounded {@link FeedAggregate}. Each
 * per-memory used-RATE is `usedCount / (usedCount + ignoredCount)` in `[0, 1]`
 * (NOT raw counts — Pitfall 2), centered on `0.5` so a neutral memory contributes
 * `0`. We average the centered rates across the ids and project the mean onto the
 * USEFULNESS gradient — a positive net used-rate nudges `usefulnessAlpha` UP, a net
 * ignored-rate nudges it DOWN; the magnitude is bounded to `[-0.5, 0.5]`, so one
 * run can move the weight by at most `STEP * 0.5` (a small, deterministic nudge —
 * A2: no contextual/Thompson policy). The other three gradients are `0` this run:
 * the FEED signal speaks to usefulness directly (the recency/temporal/proof boosts
 * have no per-id used/ignored attribution to learn from here). A neutral / empty
 * signal yields the all-zero aggregate (a no-op — recall unchanged).
 */
function aggregateFeed(feed: Map<string, OnlineTuningFeedEntry>): FeedAggregate {
  let sumCentered = 0;
  let counted = 0;
  for (const { usedCount, ignoredCount } of feed.values()) {
    const total = usedCount + ignoredCount;
    if (total <= 0) continue; // never recalled — no signal
    const usedRate = usedCount / total; // bounded [0, 1]
    sumCentered += usedRate - 0.5; // centered on neutral
    counted++;
  }
  const usefulnessGradient = counted === 0 ? 0 : sumCentered / counted; // mean centered rate, [-0.5, 0.5]
  return {
    recencyGradient: 0,
    temporalGradient: 0,
    proofGradient: 0,
    usefulnessGradient,
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
 * Run one OFFLINE bandit pass for a single `(tenant, agent)`.
 *
 * Gate on `config.enabled` (default-OFF → counts-only emit, no read/write) → read
 * the accrued FEED signal via the injected seam (a READ failure is NON-FATAL →
 * WARN + `updated: false`) → read the current tuned vector (else the baseline
 * config alphas) → aggregate the FEED Map into a bounded {@link FeedAggregate} →
 * `computeTunedAlphas` (the pure clamped step) → `upsert` via the port (a rejecting
 * store → WARN + non-fatal) → emit a counts-only `memory:online_tuning_applied`
 * event. DETERMINISTIC + KEYLESS — no model, no key, no exploration randomness.
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
    // Counts-only (T-111-14): booleans/counts ONLY — NEVER the alpha values or the
    // FEED content (the binding constraint). Mirrors the userrep/reasoning jobs.
    eventBus?.emit("memory:online_tuning_applied", {
      agentId,
      updated,
      clampHits,
      signalCount,
      durationMs: clock.now() - startMs,
      timestamp: clock.now(),
    });
  };

  const stats = (): MemoryOnlineTuningStats => ({ updated, clampHits, signalCount });

  // T-111-11: the DEFAULT-OFF gate. No read, no write (the bandit is keyless anyway).
  if (!config.enabled) {
    logger.debug(
      { agentId, step: "online-tuning" as const },
      "Online tuning disabled (enabled=false) — skipping",
    );
    emit();
    return ok(stats());
  }

  // 1. Read the accrued FEED signal. NON-FATAL (T-111-13): a read failure must never
  //    break a run — WARN + return ok with nothing written (the bandit is a background
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

  // 2. Read the current tuned vector for this scope; fall back to the BASELINE config
  //    alphas (the four non-trust weights) when no row exists yet, so the first run
  //    nudges from the operator's configured weights. A read failure → baseline
  //    (non-fatal — same posture). The fifth (trust) weight is NEVER read here.
  const currentResult = await fromPromise(tunedAlphaStore.read({ tenantId, agentId }));
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

  // 3. Aggregate the FEED Map into the bounded gradient (the used-RATE, NOT raw
  //    counts — Pitfall 2) and run the PURE clamped step (111-01). A neutral/empty
  //    signal is a no-op (all-zero aggregate → next === current).
  const aggregate = aggregateFeed(feed);
  const next = computeTunedAlphas(current, aggregate);
  clampHits = countClampHits(next);

  // 4. Persist via the port. NON-FATAL (T-111-13): a rejecting/erroring store → WARN
  //    + return ok (the run continues; the ranker keeps its prior weights). Idempotent:
  //    one row per (tenant, agent) — re-running upsert-replaces in place (111-02).
  const upserted = await fromPromise(
    tunedAlphaStore.upsert(next, { tenantId, agentId, now: clock.now() }),
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
