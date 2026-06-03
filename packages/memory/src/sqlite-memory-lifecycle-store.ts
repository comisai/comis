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
 * ## SCAFFOLD-DORMANT
 *
 * `runLifecycleSweep(scope)` is the cron-driven maintenance pass. It SELECTs the
 * scoped candidate rows, computes each one's importance-decayed `strength` + its
 * hysteresis-banded tier — and then APPLIES NOTHING. The demote/evict/promote step
 * is a NO-OP: no row is DELETEd, no marker column is UPDATEd, and the report's
 * `promoted`/`demoted`/`evicted` are ALWAYS 0 — whether the live policy WOULD touch
 * a row or not. Live eviction is the deferred operator step. The apply branch
 * is dead BY CONSTRUCTION behind `LIVE_EVICTION = false as const` (so the
 * eviction-candidacy computation stays exercised + documented, while the mutation
 * is statically unreachable — RED-proven by the off-policy fixture test). When the
 * live policy lands it will set `lifecycle_demoted_at` / `evicted_at`
 * NON-DESTRUCTIVELY (a marker, never a hard DELETE — the `consolidated_at`
 * precedent), preserving the raw row + provenance for audit.
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
  /** Dormancy window (T_max, days): the live step would evict dormant > T_max. */
  maxDormantDays: number;
}

/** The design-default DORMANT policy (mirrors MemoryLifecycleConfigSchema defaults). */
const DEFAULT_POLICY: MemoryLifecyclePolicy = {
  thetaPromote: 0.7,
  thetaDemote: 0.3,
  epsilonPrune: 0.05,
  maxDormantDays: 90,
};

/**
 * Bound on the candidate scan per sweep — the sum of the design capacity caps
 * (durable LML 1000 + ephemeral SML 500) with headroom, so a chatty agent cannot
 * grow the per-sweep working set unboundedly. A bound `?` LIMIT param.
 */
const SCAN_CAP = 2000;

/**
 * THE SCAFFOLD-DORMANT FLAG. `false as const` — the
 * demote/evict/promote APPLY branch is dead BY CONSTRUCTION. The eviction-candidacy
 * + tier computation above it stays exercised (so the math + the deferral are
 * documented and tested), but NO marker is ever written and NO row is ever deleted.
 * Flipping this to `true` is the deferred operator live step — out of scope
 * for this plan. RED-proven dead: an off-policy fixture (strength far below
 * ε_prune, dormant beyond T_max) still yields evicted/demoted = 0.
 */
const LIVE_EVICTION = false as const;

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
   * The DORMANT policy constants (defaults to {@link DEFAULT_POLICY}). The daemon
   * passes the operator-configured `MemoryLifecycleConfigSchema` values;
   * the unit adapter uses the defaults. Even with these set, the SCAFFOLD applies
   * NOTHING (LIVE_EVICTION is false).
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

  // The scoped candidate scan. The `tenant_id = ? AND agent_id = ?`
  // filter is the load-bearing 2-way ISOLATION boundary: a sweep run under one
  // scope can NEVER read another tenant/agent's rows. The LIMIT (a bound `?`)
  // bounds the per-sweep working set. Bound params only — never concatenated.
  const scanCandidates = db.prepare(
    "SELECT id, memory_type, occurred_at, created_at, proof_count, " +
      "lifecycle_demoted_at, evicted_at, strength " +
      "FROM memories " +
      "WHERE tenant_id = ? AND agent_id = ? " +
      "LIMIT ?",
  );

  return {
    async runLifecycleSweep(
      scope: MemoryLifecycleScope,
    ): Promise<Result<LifecycleSweepReport, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, now } = scope;
      try {
        // The 2-way scoped, bounded candidate scan.
        const rawRows = scanCandidates.all(tenantId, agentId, SCAN_CAP);
        const parsed = lifecycleRowMapper.parseRows(rawRows);
        if (!parsed.ok) return err(new Error(parsed.error.message));
        const rows = parsed.value;

        // COMPUTE per-row: the importance-decayed strength + the hysteresis-banded
        // tier + the eviction candidacy. This is the DORMANT computation — it
        // informs NOTHING that mutates the DB; it exists so the math + the deferral
        // are exercised and documented (and so the live step is a one-flag flip).
        let evictionCandidates = 0;
        for (const row of rows) {
          // Event-age in days, EVENT-TIME (occurred_at ?? created_at), clamped at 0
          // for future-dated rows — using the INJECTED scope.now, never Date.now.
          const eventMs = row.occurred_at ?? row.created_at;
          const dormantDays = Math.max(0, (now - eventMs) / DAY_MS);
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
          const strength = clamp01(0.5 + 0.5 * Math.exp(-lambda * Math.pow(dormantDays, beta)));

          // The hysteresis-banded tier the live step WOULD move the row to
          // (θ_promote 0.7 > θ_demote 0.3 dead-band; else keep). Computed, applied
          // to NOTHING.
          const currentTier = tierForType(row.memory_type);
          const targetTier: MemoryTier =
            imp >= policy.thetaPromote
              ? "durable"
              : imp < policy.thetaDemote
                ? "ephemeral"
                : currentTier;
          void targetTier; // DORMANT: the tier move is the deferred live step.

          // The eviction candidacy the live step WOULD act on (strength below ε OR
          // dormant beyond T_max) — counted for observability, ACTED on by NOTHING.
          const isEvictionCandidate =
            strength < policy.epsilonPrune || dormantDays > policy.maxDormantDays;
          if (isEvictionCandidate) evictionCandidates += 1;
        }

        // APPLY NOTHING — the SCAFFOLD-DORMANT contract. The
        // demote/evict/promote step is dead by construction behind LIVE_EVICTION:
        // no UPDATE of a marker column, no DELETE. promoted/demoted/evicted = 0.
        // `promoted`/`demoted` are `const` (never reassigned even by the deferred
        // live branch — that branch marks evictions only); `evicted` stays `let`
        // because the statically-dead live branch textually reassigns it.
        const promoted = 0;
        const demoted = 0;
        let evicted = 0;
        if (LIVE_EVICTION) {
          // DEFERRED LIVE POLICY (operator): mark eviction candidates
          // NON-DESTRUCTIVELY (set evicted_at = now) + apply the tier moves
          // (set lifecycle_demoted_at). Statically unreachable in this plan.
          /* c8 ignore next */
          evicted = evictionCandidates;
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
            durationMs: systemNowMs() - startMs,
          },
          "Memory lifecycle sweep complete (DORMANT — evicts/demotes nothing)",
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
  };
}
