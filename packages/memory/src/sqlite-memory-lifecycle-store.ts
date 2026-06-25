// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryLifecycleStore: the SOLE adapter for the segregated
 * `MemoryLifecyclePort` port (@comis/core). It
 * owns ALL the per-(tenant, agent) lifecycle SQL over the `memories` table + its
 * additive NON-DESTRUCTIVE marker columns (`lifecycle_demoted_at`/`evicted_at`/
 * `strength` — `ensureMemoryColumns` in schema.ts) — the only place SQL is written
 * for this capability. The agent package never imports it (the agent↛memory cut);
 * it consumes the `MemoryLifecyclePort` TYPE from @comis/core.
 *
 * ## LIVE soft eviction (gated; default-OFF)
 *
 * `runLifecycleSweep(scope)` is the cron-driven maintenance pass. It SELECTs the
 * scoped candidate rows and computes each one's importance-decayed `strength`
 * (FORGET-02-coupled: a memory's SUMmed `failure_count` lowers its strength via a
 * bounded, monotone `failurePenalty`). When the policy is EVICTION-ENABLED
 * (`evictionEnabled` — the daemon threads `learningForgetting.eviction.enabled` ∧
 * `.enabled`), a candidate whose strength falls below `strengthThreshold` AND is
 * NOT exempt (not pinned, `trust_level != 'system'`, `proof_count < highProofFloor`
 * — the FORGET-03 anti-induced-eviction floors) is SOFT-evicted: `evicted_at` is
 * set NON-DESTRUCTIVELY (a marker, never a hard DELETE — the `consolidated_at`
 * precedent), preserving the raw row + provenance for audit/`asOf`. The eviction is
 * REVERSIBLE via {@link MemoryLifecyclePort.unevict} (clear `evicted_at` on renewed
 * usefulness). When the policy is NOT eviction-enabled (the default), the sweep
 * stays DORMANT — it computes but APPLIES NOTHING (report `evicted`/`demoted` = 0,
 * no UPDATE, no DELETE) — the byte-identity guarantee. Tier demote/promote moves
 * remain a deferred step (`promoted`/`demoted` are still 0 in this build). The
 * recall-side exclusion of evicted rows is enforced on EVERY live recall path (CR-01),
 * not here: `hybrid-search.ts` (the post-fusion `evicted_at IS NULL`) AND
 * `sqlite-memory-adapter.ts` (`hydrateLane`/`searchLanes` + the vector-only `search()`
 * per-id reads). The inspect/asOf raw reads stay UNFILTERED so an evicted row is still
 * audit/asOf-resolvable.
 *
 * ## Isolation is the load-bearing security boundary (the §5.2 invariant)
 *
 * Comis runs many agents and many tenants in ONE DB. The candidate SELECT filters
 * `WHERE tenant_id = ? AND agent_id = ?` (bound params), so a sweep run under one
 * (tenant, agent) NEVER reads or touches another scope's rows. The 2-way filter is
 * load-bearing, not a nicety (RED-proven: dropping either column leaks). The scan
 * is bounded by a sane cap so a chatty agent cannot grow it unboundedly.
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in via
 * `getDb()`); the handle's lifecycle (open/close, pragmas) is owned by the caller —
 * this factory neither opens nor closes it.
 *
 * ## Untyped-SQLite + clock + logging discipline
 *
 * Every read parses through `createRowMapper` (no `as Foo[]` casts;
 * `untyped-sqlite.test.ts`). The age/dormancy math uses the injected `scope.now`,
 * NEVER `Date.now()` (globals.test.ts bans the wall clock in src). The adapter logs
 * COUNTS only — NEVER a memory body or query text (AGENTS.md §2.7); the report is
 * pure numbers.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type {
  MemoryLifecyclePort,
  MemoryLifecycleScope,
  MemoryTier,
  LifecycleSweepReport,
} from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper } from "./row-mapper.js";
import { MemoryLifecycleRowSchema } from "./row-schemas.js";

/** Minimal pino-compatible logger (mirrors sqlite-tuned-alpha-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The DORMANT policy constants the live (deferred) step WOULD apply (FadeMem
 * Eq.3/5/6, the design defaults; mirror `MemoryLifecycleConfigSchema`). The
 * SCAFFOLD computes strengths/tiers/candidacy with these but ACTS on nothing. The
 * daemon will pass the operator-configured values via `deps` when it
 * wires the cron; until then the unit adapter uses these defaults.
 */
export interface MemoryLifecyclePolicy {
  /** Hysteresis PROMOTE threshold: imp ≥ θ_promote → durable tier. */
  thetaPromote: number;
  /** Hysteresis DEMOTE threshold: imp < θ_demote → ephemeral tier. */
  thetaDemote: number;
  /** Strength floor (ε_prune): the live step would evict strength < ε. */
  epsilonPrune: number;
  /**
   * Dormancy window (T_max, days): a memory UNUSED (not recalled-useful) for longer
   * than T_max is an eviction candidate. WR-02: "dormant" is measured from
   * `last_useful_at` (last recall), NOT `occurred_at` (event time) — a recently-
   * recalled memory about an OLD event is NOT dormant (FORGET-04). A never-recalled
   * memory falls back to event age, so genuinely-stale rows still reap.
   */
  maxDormantDays: number;

  // ── LIVE soft-eviction behavior (v2.26 WS4 / FORGET-01..04) ──
  // ALL optional + default-OFF: with these unset the sweep stays SCAFFOLD-DORMANT
  // (evicts/demotes nothing — the byte-identity guarantee). The daemon passes the
  // operator-configured `learningForgetting` values (a later plan); the unit
  // adapter only evicts when an eviction-enabled policy is supplied.
  /**
   * Master gate for LIVE soft eviction. When `true`, candidates below
   * `strengthThreshold` (and not exempt) are soft-evicted (`evicted_at` set,
   * never DELETE). Default `undefined`/`false` → DORMANT (nothing evicts).
   * Mirrors `learningForgetting.eviction.enabled` ∧ `learningForgetting.enabled`.
   */
  evictionEnabled?: boolean;
  /**
   * Strength floor [0,1] below which a non-exempt candidate is soft-evicted under
   * the LIVE policy (`learningForgetting.eviction.strengthThreshold`, default 0.2).
   * DISTINCT from `epsilonPrune` (0.05) — the new behavior gate, not the dormant
   * candidacy constant. Only consulted when `evictionEnabled`.
   */
  strengthThreshold?: number;
  /**
   * Wrongness coupling weight [0,1] (`learningForgetting.failurePenalty`, default
   * 0.5): a recalled memory's SUMmed `failure_count` lowers its decayed strength
   * (bounded + monotone: more failures → lower strength → earlier eviction).
   */
  failurePenalty?: number;
  /**
   * The high-`proof_count` eviction-exemption floor (FORGET-03 anti-induced-
   * eviction): a memory with `proof_count >= highProofFloor` is NEVER soft-evicted,
   * regardless of strength — a poisoner inducing failures cannot evict a
   * well-corroborated memory. Defaults to {@link DEFAULT_HIGH_PROOF_FLOOR}.
   */
  highProofFloor?: number;
  /**
   * RC-3 (EVI-STRENGTH-FLOOR fix): the corroborated-`failure_count` floor at/above which
   * a NON-EXEMPT memory is soft-evicted regardless of its decayed strength. This makes
   * "wrongness eviction" actually reachable: the `strength` math floors at >0.25 (above
   * the 0.2 strengthThreshold), so the strength disjunct alone can NEVER evict a
   * failure-implicated memory — only the 90-day dormant-age disjunct ever fired. A
   * memory repeatedly + corroboratedly implicated in failures (each `failure_count`
   * increment is itself corroboration-gated — ≥2 independent sessions OR a deterministic
   * source, setup-learning-corroboration.ts) is forgotten. SECURITY: gated entirely by
   * the SAME FORGET-03 exemptions (pinned / system / `proof_count >= highProofFloor`),
   * so an induced-failure attacker still cannot evict a well-corroborated/pinned/system
   * memory — the floor only reaches LOW-proof, non-pinned, non-system rows. Default
   * {@link DEFAULT_FAILURE_EVICTION_FLOOR}; a higher value is more conservative.
   */
  failureEvictionFloor?: number;
}

/** The design-default DORMANT policy (mirrors MemoryLifecycleConfigSchema defaults). */
const DEFAULT_POLICY: MemoryLifecyclePolicy = {
  thetaPromote: 0.7,
  thetaDemote: 0.3,
  epsilonPrune: 0.05,
  maxDormantDays: 90,
};

/**
 * The default high-`proof_count` eviction-exemption floor (FORGET-03). A memory
 * corroborated by >= 5 independent observations is treated as durably-trusted and
 * is never soft-evicted — the anti-cache-poisoning guarantee at the store. Mirrors
 * the design's high-proof exemption; the daemon can override via the policy.
 */
const DEFAULT_HIGH_PROOF_FLOOR = 5;

/**
 * RC-3: the default corroborated-`failure_count` eviction floor. Each `failure_count`
 * increment is corroboration-gated (≥2 independent sessions OR a deterministic source),
 * so 3 means a memory implicated in failures across multiple independent corroborated
 * events — sustained wrongness, not a stray transient. Deliberately conservative; only
 * reaches LOW-proof, non-pinned, non-system rows (the FORGET-03 exemptions still hold).
 */
const DEFAULT_FAILURE_EVICTION_FLOOR = 3;

/**
 * The wrongness-coupling saturation constant K (FORGET-02). The bounded monotone
 * shape `failure_count / (failure_count + K)` ∈ [0, 1) saturates as failures grow:
 * one failure costs a little, many failures approach (but never reach) the full
 * `failurePenalty`. K=3 means ~3 failures reach half the penalty — enough that a
 * sustained-wrong, weakly-corroborated memory drops below threshold while a single
 * stray failure barely moves a strong one.
 */
const FAILURE_SATURATION_K = 3;

/**
 * Bound on the candidate scan per sweep — the sum of the design capacity caps
 * (durable LML 1000 + ephemeral SML 500) with headroom, so a chatty agent cannot
 * grow the per-sweep working set unboundedly. A bound `?` LIMIT param.
 */
const SCAN_CAP = 2000;

const DAY_MS = 86_400_000;

// Row mapper — the sanctioned read path (no `as Foo[]`). Parses the scoped
// candidate-scan projection before any computation.
const lifecycleRowMapper = createRowMapper(MemoryLifecycleRowSchema);

/** Constructor deps for {@link createSqliteMemoryLifecycleStore}. */
export interface MemoryLifecycleStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
  /**
   * The lifecycle policy: the dormant decay/tier constants (default
   * {@link DEFAULT_POLICY}) PLUS the optional LIVE soft-eviction behavior
   * (`evictionEnabled`/`strengthThreshold`/`failurePenalty`/`highProofFloor`). The
   * daemon passes the operator-configured `MemoryLifecycleConfigSchema` +
   * `learningForgetting` values; the unit adapter uses the dormant defaults. With
   * the eviction behavior UNSET (the default), the sweep applies NOTHING (the
   * byte-identity guarantee); it soft-evicts ONLY when `evictionEnabled` is true.
   */
  policy?: MemoryLifecyclePolicy;
}

/**
 * The clamp helper — bound a value into [0, 1] (the importance/strength domain).
 */
function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * The per-type decay shape exponent β (FadeMem Eq.6): durable types decay with a
 * slow sub-linear tail (β 0.8), ephemeral types with a sharp super-linear drop (β
 * 1.2); an absent/unknown type falls back to the parity exponential (β 1.0). A
 * closed-union mapping — mirror the `trustWeight` closed switch in score.ts.
 */
function betaForType(memoryType: string): number {
  switch (memoryType) {
    case "semantic":
    case "procedural":
      return 0.8; // durable — slow tail
    case "episodic":
    case "working":
      return 1.2; // ephemeral — sharp drop
    default:
      return 1.0; // parity (legacy / unknown) — pure exponential
  }
}

/** The tier the type currently belongs to (durable vs ephemeral classes). */
function tierForType(memoryType: string): MemoryTier {
  return memoryType === "semantic" || memoryType === "procedural" ? "durable" : "ephemeral";
}

/**
 * Create the SQLite-backed {@link MemoryLifecyclePort} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller (the
 * memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteMemoryLifecycleStore(
  deps: MemoryLifecycleStoreDeps,
): MemoryLifecyclePort {
  const { db, logger } = deps;
  const policy = deps.policy ?? DEFAULT_POLICY;

  // The scoped candidate scan. The `m.tenant_id = ? AND m.agent_id = ?`
  // filter is the load-bearing 2-way ISOLATION boundary: a sweep run under one
  // scope can NEVER read another tenant/agent's rows. The LIMIT (a bound `?`)
  // bounds the per-sweep working set. Bound params only — never concatenated.
  //
  // The LEFT JOIN folds in the FORGET-02 wrongness signal: the per-(tenant, agent,
  // memory) `failure_count` SUMmed across intents (a memory may accrue failures in
  // several intent buckets). WR-02: it ALSO folds in the last-recall recency
  // `MAX(last_useful_at)` across intents — the DISUSE signal the dormant-age branch
  // keys off (NOT occurred_at, the event time), so a recently-recalled old-event
  // memory is not "dormant". The subquery is scoped to the SAME (tenant, agent) as
  // the outer scan (it cannot leak another scope's failures/recency), and the LEFT
  // JOIN keeps memories with no usefulness row (NULL → coalesced below; an absent
  // last_useful_at falls back to event age so a never-recalled old memory still
  // reaps). `pinned` and `trust_level` feed the FORGET-03 exemptions.
  const scanCandidates = db.prepare(
    "SELECT m.id, m.memory_type, m.occurred_at, m.created_at, m.proof_count, " +
      "m.lifecycle_demoted_at, m.evicted_at, m.strength, m.pinned, m.trust_level, " +
      "u.failure_count AS failure_count, u.last_useful_at AS last_useful_at " +
      "FROM memories m " +
      "LEFT JOIN ( " +
      "  SELECT memory_id, SUM(failure_count) AS failure_count, MAX(last_useful_at) AS last_useful_at " +
      "  FROM memory_usefulness " +
      "  WHERE tenant_id = ? AND agent_id = ? " +
      "  GROUP BY memory_id " +
      ") u ON u.memory_id = m.id " +
      "WHERE m.tenant_id = ? AND m.agent_id = ? " +
      "LIMIT ?",
  );

  // The NON-DESTRUCTIVE soft-eviction UPDATE (FORGET-01): set the `evicted_at`
  // marker, NEVER DELETE. Scoped to (tenant, agent) so a sweep can only mark its
  // own rows. The `evicted_at IS NULL` guard makes a re-eviction a no-op (idempotent;
  // never re-stamps an already-evicted row's timestamp).
  const softEvict = db.prepare(
    "UPDATE memories SET evicted_at = ? " +
      "WHERE id = ? AND tenant_id = ? AND agent_id = ? AND evicted_at IS NULL",
  );

  // The REVERSAL (FORGET-04): clear the marker on renewed usefulness. Scoped to
  // (tenant, agent) — the isolation boundary holds on the un-evict too.
  const clearEvict = db.prepare(
    "UPDATE memories SET evicted_at = NULL WHERE id = ? AND tenant_id = ? AND agent_id = ?",
  );

  return {
    async runLifecycleSweep(
      scope: MemoryLifecycleScope,
    ): Promise<Result<LifecycleSweepReport, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, now } = scope;
      try {
        // The 2-way scoped, bounded candidate scan. The first (tenantId, agentId)
        // pair scopes the failure_count subquery; the second scopes the outer scan.
        const rawRows = scanCandidates.all(tenantId, agentId, tenantId, agentId, SCAN_CAP);
        const parsed = lifecycleRowMapper.parseRows(rawRows);
        if (!parsed.ok) return err(new Error(parsed.error.message));
        const rows = parsed.value;

        // The EFFECTIVE policy = the per-call `scope.policy` override (the daemon's per-agent
        // `learningForgetting`, FORGET-06) layered over the constructor policy. The store is
        // shared across agents but the eviction behavior is PER-AGENT, so the gate rides the
        // call: an absent override → the constructor policy (DORMANT by default — byte-identity).
        const ov = scope.policy;
        const effEvictionEnabled = ov?.evictionEnabled ?? policy.evictionEnabled;
        const effStrengthThreshold = ov?.strengthThreshold ?? policy.strengthThreshold;
        const effFailurePenalty = ov?.failurePenalty ?? policy.failurePenalty;

        // Is the LIVE soft-eviction policy active? Gated on an eviction-enabled policy
        // (`learningForgetting.eviction.enabled` ∧ `.enabled`). With it OFF the sweep stays
        // SCAFFOLD-DORMANT — evicts/demotes nothing, the byte-identity guarantee.
        const liveEviction = effEvictionEnabled === true;
        // The behavior gate's strength floor (DISTINCT from the dormant epsilonPrune).
        const strengthThreshold = effStrengthThreshold ?? policy.epsilonPrune;
        const failurePenalty = effFailurePenalty ?? 0;
        const highProofFloor = policy.highProofFloor ?? DEFAULT_HIGH_PROOF_FLOOR;
        // RC-3: the corroborated-failure eviction floor (the EVI-STRENGTH-FLOOR fix). Only
        // consulted under the LIVE policy; the FORGET-03 exemptions still gate it.
        const failureEvictionFloor = ov?.failureEvictionFloor ?? policy.failureEvictionFloor ?? DEFAULT_FAILURE_EVICTION_FLOOR;

        // COMPUTE per-row: the importance-decayed strength + the hysteresis-banded
        // tier + the eviction candidacy. Under the LIVE policy the eligible
        // candidates are collected for the soft UPDATE below; under DORMANT the
        // computation still runs (so the math + deferral stay exercised) but acts on
        // nothing.
        let evictionCandidates = 0;
        const toEvict: string[] = [];
        for (const row of rows) {
          // Event-age in days, EVENT-TIME (occurred_at ?? created_at), clamped at 0
          // for future-dated rows — using the INJECTED scope.now, never Date.now.
          // This drives the FadeMem strength DECAY shape (which is legitimately a
          // function of how old the EVENT is) — NOT the dormant-age candidacy below.
          const eventMs = row.occurred_at ?? row.created_at;
          const dormantDays = Math.max(0, (now - eventMs) / DAY_MS);
          // WR-02: the DISUSE age — days since the memory was last RECALLED-useful
          // (last_useful_at), falling back to the event age when it was never recalled
          // (NULL). This — NOT the event age — gates the dormant-age candidacy disjunct,
          // so a recently-recalled memory about an OLD event is NOT "dormant" (FORGET-04:
          // wrong fades faster than merely old; a still-useful old fact is not reaped on
          // event-age alone). A never-recalled old memory falls back to event age, so the
          // age reaper still prunes genuinely dormant rows.
          const lastUsefulMs = row.last_useful_at ?? eventMs;
          const disuseDays = Math.max(0, (now - lastUsefulMs) / DAY_MS);
          const beta = betaForType(row.memory_type);
          // A bounded saturating importance proxy from the corroboration signal
          // (the full FadeMem `imp` superset is computed on the recall hot path in
          // score.ts; the sweep only needs a coarse strength for candidacy). proof
          // ⇒ higher importance ⇒ slower decay.
          const proof = row.proof_count ?? 0;
          const imp = clamp01(proof / (1 + proof));
          // The 0.5-centered bounded recall-shape strength (FadeMem Eq.3 form),
          // importance-modulated rate; ∈ [0.5, 1] before the floor check.
          const lambda = (Math.LN2 / policy.maxDormantDays) * Math.exp(-imp);
          const baseStrength = clamp01(
            0.5 + 0.5 * Math.exp(-lambda * Math.pow(dormantDays, beta)),
          );

          // FORGET-02 wrongness coupling: fold the SUMmed failure_count into the
          // strength with a bounded, monotone penalty. `f = fc / (fc + K)` ∈ [0, 1)
          // so the penalty saturates — more failures → lower strength → earlier
          // eviction, but a single stray failure barely moves a strong memory. The
          // coupling is multiplicative on the 0.5-centred base so a sustained-wrong
          // memory can be driven below the threshold.
          const failureCount = row.failure_count ?? 0;
          const failureFactor =
            failurePenalty <= 0 || failureCount <= 0
              ? 0
              : failurePenalty * (failureCount / (failureCount + FAILURE_SATURATION_K));
          const strength = clamp01(baseStrength * (1 - failureFactor));

          // The hysteresis-banded tier the live step WOULD move the row to
          // (θ_promote 0.7 > θ_demote 0.3 dead-band; else keep). Computed, applied
          // to NOTHING in this plan (the demote move is a later concern).
          const currentTier = tierForType(row.memory_type);
          const targetTier: MemoryTier =
            imp >= policy.thetaPromote
              ? "durable"
              : imp < policy.thetaDemote
                ? "ephemeral"
                : currentTier;
          void targetTier; // the tier move is a deferred step.

          // FORGET-03 anti-induced-eviction EXEMPTIONS (the store-side half of the
          // corroboration control): pinned / system-trust / high-proof memories are
          // NEVER evicted, regardless of strength. A poisoner inducing failures
          // cannot evict a well-corroborated, pinned, or system memory.
          const exempt =
            row.pinned === 1 ||
            row.trust_level === "system" ||
            proof >= highProofFloor;

          // The eviction candidacy: strength below the behavior threshold OR DORMANT
          // (UNUSED) beyond T_max — minus the exemptions. WR-02: the age disjunct uses
          // `disuseDays` (days since last recall), NOT `dormantDays` (event age), so a
          // recently-recalled old-event memory survives the age branch (FORGET-04); a
          // never-recalled old memory still trips it (disuseDays falls back to event age).
          // RC-3: the corroborated-failure disjunct makes wrongness-eviction REACHABLE —
          // the strength math floors >0.25 (above strengthThreshold), so a failure-
          // implicated memory could never evict on strength alone (EVI-STRENGTH-FLOOR).
          // Gated on `liveEviction` so the DORMANT candidacy count stays byte-identical;
          // `!exempt` keeps the FORGET-03 anti-induced-eviction guarantee (high-proof /
          // pinned / system are never reached, no matter how many failures).
          const isEvictionCandidate =
            !exempt &&
            (strength < strengthThreshold ||
              disuseDays > policy.maxDormantDays ||
              (liveEviction && failureCount >= failureEvictionFloor));
          if (isEvictionCandidate) {
            evictionCandidates += 1;
            // Only mark rows not already evicted (idempotent re-sweeps).
            if (row.evicted_at === null) toEvict.push(row.id);
          }
        }

        // APPLY: under the LIVE policy, soft-evict the collected candidates
        // NON-DESTRUCTIVELY (set evicted_at = scope.now, NEVER DELETE). Under
        // DORMANT this stays a no-op (promoted/demoted/evicted = 0). `promoted`/
        // `demoted` remain 0 in this plan (tier moves are deferred); `evicted`
        // counts the rows actually marked.
        const promoted = 0;
        const demoted = 0;
        let evicted = 0;
        if (liveEviction && toEvict.length > 0) {
          // One bounded transaction for the batch of soft-evictions (atomic + fast).
          const applyEvictions = db.transaction((ids: string[]): number => {
            let n = 0;
            for (const id of ids) {
              const info = softEvict.run(now, id, tenantId, agentId);
              n += info.changes;
            }
            return n;
          });
          evicted = applyEvictions(toEvict);
        }

        // Counts ONLY — never a memory body or query text (§2.7).
        logger?.debug(
          {
            step: "lifecycle-sweep",
            submodule: "memory-lifecycle",
            tenantId,
            agentId,
            scanned: rows.length,
            evictionCandidates,
            promoted,
            demoted,
            evicted,
            liveEviction,
            durationMs: systemNowMs() - startMs,
          },
          liveEviction
            ? "Memory lifecycle sweep complete (LIVE soft eviction)"
            : "Memory lifecycle sweep complete (DORMANT — evicts/demotes nothing)",
        );

        const report: LifecycleSweepReport = {
          scanned: rows.length,
          promoted,
          demoted,
          evicted,
        };
        return ok(report);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "lifecycle-sweep",
            submodule: "memory-lifecycle",
            tenantId,
            agentId,
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "lifecycle sweep failed — no row was promoted/demoted/evicted",
          },
          "Memory lifecycle sweep failed",
        );
        return err(error);
      }
    },

    async unevict(
      memoryId: string,
      scope: MemoryLifecycleScope,
    ): Promise<Result<void, Error>> {
      const { tenantId, agentId } = scope;
      try {
        // Scoped reversal — clears evicted_at back to NULL for the caller's
        // (tenant, agent) ONLY. A foreign-scope marker is never reached (the WHERE
        // pins both columns). Idempotent: a live/absent row → 0 changes → ok.
        const info = clearEvict.run(memoryId, tenantId, agentId);
        logger?.debug(
          {
            step: "lifecycle-unevict",
            submodule: "memory-lifecycle",
            tenantId,
            agentId,
            restored: info.changes,
          },
          "Memory un-evicted (evicted_at cleared on renewed usefulness)",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "lifecycle-unevict",
            submodule: "memory-lifecycle",
            tenantId,
            agentId,
            err: error,
            errorKind: "internal" as const,
            hint: "un-evict failed — the evicted_at marker was not cleared",
          },
          "Memory un-evict failed",
        );
        return err(error);
      }
    },
  };
}
