// SPDX-License-Identifier: Apache-2.0
/**
 * Decay-aware learned-skill TREND (Verified Learning WS4 / §17 hindsight Trend) —
 * the in-process decision of WHEN a corroborated failure should drive a `demote()`.
 *
 * The promote/demote loop (setup-learning.ts) calls {@link createSkillTrendTracker}
 * once at daemon-lifetime and feeds it the execution-validated reuse outcome of each
 * attributed `usedSkillId`. The tracker keeps a per-skill recency-weighted
 * success/failure STANDING and classifies it as `"strengthening" | "stable" |
 * "weakening"`. The caller demotes ONLY on a `"weakening"` standing — so the durable
 * `active → stale` move (the store's `demote()`) fires on a SUSTAINED corroborated
 * failure, not a raw counter.
 *
 * The load-bearing invariant (Pitfall 4 / the §12 first-RED, anti-induced-demotion):
 * a SINGLE corroborated failure against many recent successes keeps the standing
 * STABLE/STRENGTHENING — only SUSTAINED corroborated failure reaches WEAKENING. A
 * well-reused procedure is NOT archived by one (possibly induced) failure.
 *
 * Math — reuses the FORGET-02 saturating-penalty SHAPE (`f = fc/(fc+K)`, K=3, the
 * READ-ONLY pattern at sqlite-memory-lifecycle-store.ts:354-359) adapted to a
 * recency-decayed score:
 *  - keep a per-skill `{ score, failureCount, lastUpdateMs }`;
 *  - on each update, DECAY the prior score toward the neutral midpoint by the elapsed
 *    time (exponential, half-life {@link SCORE_HALF_LIFE_MS}) so an old success/failure
 *    fades — recency-weighted by construction;
 *  - on `success`: nudge the score UP (bounded) and let the running `failureCount`
 *    decay so a recovered procedure re-strengthens;
 *  - on `failure`: subtract a SATURATING penalty driven by the accumulated
 *    `failureCount` (`penalty * fc/(fc+K)`) so the FIRST failure barely moves a strong
 *    score but SUSTAINED failure compounds toward the floor;
 *  - classify against two bands: ≥ {@link STRENGTHENING_BAND} → "strengthening",
 *    ≤ {@link WEAKENING_BAND} → "weakening", else "stable".
 *
 * In-process / daemon-lifetime (A3 — resets on restart, exactly like the FORGET-03
 * corroboration tally). BOUNDED: the per-skill map caps at `maxTracked` and evicts the
 * OLDEST-touched skill (Map insertion order = recency, refreshed via delete-before-set)
 * so a busy/adversarial fleet never grows it without bound. Counts/ids only — never a
 * procedure body. The `nowMs` is ALWAYS the injected caller clock (never an ambient
 * wall-clock read — globals.test.ts forbids it).
 *
 * @module
 */

/** The §17 hindsight trend standing — a closed union (AGENTS.md §2.8: exhaustive). */
export type SkillTrend = "strengthening" | "stable" | "weakening";

/** Neutral midpoint a fresh skill starts at and a decayed score relaxes toward. */
const NEUTRAL_SCORE = 0.5;
/** Score at/above which the standing is "strengthening" (success dominates). */
const STRENGTHENING_BAND = 0.6;
/** Score at/below which the standing is "weakening" (sustained failure). */
const WEAKENING_BAND = 0.3;
/** The success nudge per reinforced reuse (bounded, additive on the decayed score). */
const SUCCESS_STEP = 0.18;
/** The MAX failure penalty (the `failurePenalty` of the saturating shape `p * fc/(fc+K)`). */
const FAILURE_PENALTY = 0.55;
/**
 * The FORGET-02 saturation constant — ~K failures reach half the penalty, so the
 * penalty saturates (a single failure barely moves a strong score; sustained failure
 * compounds). Mirrors `FAILURE_SATURATION_K` in sqlite-memory-lifecycle-store.ts.
 */
const FAILURE_SATURATION_K = 3;
/**
 * Half-life of the recency decay: a success/failure's contribution to the standing
 * halves every ~3 days of idle time, so an OLD success protects LESS than a fresh one
 * (the recency-decayed §17 Trend). The score relaxes toward {@link NEUTRAL_SCORE}.
 */
const SCORE_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * Half-life of the accumulated `failureCount` itself — so a long run of successes
 * after a bad patch lets the failure pressure fade (a recovered procedure
 * re-strengthens instead of being permanently penalized).
 */
const FAILURE_COUNT_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * WR-01 bound on the number of tracked skills (daemon-lifetime, resets on restart).
 * Past this the oldest-touched skill id is evicted. Mirrors the FORGET-03 tally cap
 * (`MAX_TRACKED_FAILURE_MEMORIES`) — a soft forget of the stalest standing, never a
 * correctness loss (the store's durable proof_count/state is the source of truth).
 */
export const MAX_TRACKED_SKILL_TRENDS = 50_000;

/** Per-skill recency-weighted standing (in-process, daemon-lifetime). */
interface SkillStanding {
  /** The current recency-decayed score ∈ [0, 1] (0.5 neutral). */
  score: number;
  /** The accumulated (recency-decayed) failure pressure driving the saturating penalty. */
  failureCount: number;
  /** Last touch (the injected nowMs) — the decay clock. */
  lastUpdateMs: number;
}

/** The trend tracker handle returned by {@link createSkillTrendTracker}. */
export interface SkillTrendTracker {
  /**
   * Fold one execution-validated reuse outcome into skill `skillId`'s standing and
   * return the resulting {@link SkillTrend}. `outcome` is the resolved verdict for a
   * reuse (success vs failure/corrected, mapped by the caller). `nowMs` is the
   * injected caller clock (NEVER an ambient wall-clock read).
   */
  updateSkillTrend(skillId: string, outcome: "success" | "failure", nowMs: number): SkillTrend;
  /**
   * READ-ONLY (REFLECT-03): the skill's CURRENT standing decayed to `nowMs`, WITHOUT
   * folding a new outcome — does NOT mutate the score, failureCount, recency, or the
   * Map. A never-seen skill returns `"stable"` (the neutral starting standing). The
   * promote path peeks this BEFORE applying a success so a skill in a SUSTAINED-failure
   * (`"weakening"`) standing does not accrue promotion credit on an interleaved success
   * (it must earn back trust first) — the value-gated-promotion counterpart to the
   * demote-on-weakening gate. `nowMs` is the injected caller clock.
   */
  peekSkillTrend(skillId: string, nowMs: number): SkillTrend;
}

/** Clamp to [0, 1] (the bounded score range). */
function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Exponential decay factor for `elapsedMs` at a given `halfLifeMs` (∈ (0, 1]). */
function decayFactor(elapsedMs: number, halfLifeMs: number): number {
  if (elapsedMs <= 0) return 1;
  return Math.pow(0.5, elapsedMs / halfLifeMs);
}

/** Classify a decayed score into the closed {@link SkillTrend} union (exhaustive bands). */
function classify(score: number): SkillTrend {
  if (score >= STRENGTHENING_BAND) return "strengthening";
  if (score <= WEAKENING_BAND) return "weakening";
  return "stable";
}

/**
 * Stand up an in-process, daemon-lifetime, per-skill decay-aware trend tracker. See
 * the module doc for the shape + the anti-induced-demotion invariant. `maxTracked`
 * defaults to {@link MAX_TRACKED_SKILL_TRENDS}; pass a small value in tests to make
 * the eviction observable.
 */
export function createSkillTrendTracker(opts?: { maxTracked?: number }): SkillTrendTracker {
  const maxTracked = opts?.maxTracked ?? MAX_TRACKED_SKILL_TRENDS;
  const standings = new Map<string, SkillStanding>();

  function touch(skillId: string): SkillStanding {
    const existing = standings.get(skillId);
    if (existing !== undefined) {
      // Refresh recency: delete-before-set moves this id to the Map's tail so the
      // evict-oldest (first key) below stays the genuine least-recently-touched id.
      standings.delete(skillId);
      standings.set(skillId, existing);
      return existing;
    }
    // A NEW skill would exceed the cap → evict the OLDEST-touched one (first key —
    // Map insertion order is recency because a re-touch deletes-before-re-sets).
    if (standings.size >= maxTracked) {
      const oldestKey = standings.keys().next().value;
      if (oldestKey !== undefined) standings.delete(oldestKey);
    }
    const fresh: SkillStanding = { score: NEUTRAL_SCORE, failureCount: 0, lastUpdateMs: 0 };
    standings.set(skillId, fresh);
    return fresh;
  }

  function updateSkillTrend(skillId: string, outcome: "success" | "failure", nowMs: number): SkillTrend {
    const s = touch(skillId);

    // Recency decay: relax the prior score toward neutral and fade the failure
    // pressure by the elapsed time (a fresh standing has lastUpdateMs 0 → no decay).
    if (s.lastUpdateMs > 0) {
      const elapsed = Math.max(0, nowMs - s.lastUpdateMs);
      const scoreDecay = decayFactor(elapsed, SCORE_HALF_LIFE_MS);
      s.score = NEUTRAL_SCORE + (s.score - NEUTRAL_SCORE) * scoreDecay;
      s.failureCount *= decayFactor(elapsed, FAILURE_COUNT_HALF_LIFE_MS);
    }
    s.lastUpdateMs = nowMs;

    if (outcome === "success") {
      // A success nudges the score up (bounded) and lets the failure pressure fade
      // a little extra so a recovered procedure re-strengthens.
      s.score = clamp01(s.score + SUCCESS_STEP);
      s.failureCount = Math.max(0, s.failureCount - 1);
      return classify(s.score);
    }

    // outcome === "failure": accrue failure pressure and subtract the SATURATING
    // penalty (`p * fc/(fc+K)`) — the first failure barely moves a strong score;
    // sustained failure compounds toward the floor.
    s.failureCount += 1;
    const penalty = FAILURE_PENALTY * (s.failureCount / (s.failureCount + FAILURE_SATURATION_K));
    s.score = clamp01(s.score - penalty);
    return classify(s.score);
  }

  function peekSkillTrend(skillId: string, nowMs: number): SkillTrend {
    const s = standings.get(skillId);
    // Never-seen skill → neutral starting standing (a fresh/clean skill is "stable", so the
    // promote gate never blocks a skill that has not yet failed — no regression on the normal loop).
    if (s === undefined) return "stable";
    if (s.lastUpdateMs <= 0) return classify(s.score);
    // Apply the SAME recency decay updateSkillTrend would, but to a COPY — never persist it
    // (the next real update decays from the stored lastUpdateMs unchanged).
    const elapsed = Math.max(0, nowMs - s.lastUpdateMs);
    const decayed = NEUTRAL_SCORE + (s.score - NEUTRAL_SCORE) * decayFactor(elapsed, SCORE_HALF_LIFE_MS);
    return classify(decayed);
  }

  return { updateSkillTrend, peekSkillTrend };
}
