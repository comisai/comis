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
 * ## LIVE soft eviction (gated; default-OFF) — two reachable disjuncts
 *
 * `runLifecycleSweep(scope)` is the cron-driven maintenance pass. It SELECTs the
 * scoped candidate rows and, when the policy is EVICTION-ENABLED (`evictionEnabled`
 * — the daemon threads `learningForgetting.eviction.enabled` ∧ `.enabled`),
 * soft-evicts each NON-exempt candidate that is either DORMANT past `maxDormantDays`
 * (disuse — days since last recall) OR corroborated-wrong (`failure_count >=
 * failureEvictionFloor`). The candidacy is exactly:
 *
 *   isEvictionCandidate = !exempt && (disuseDays > maxDormantDays ||
 *                                     (liveEviction && failureCount >= failureEvictionFloor))
 *
 * where `exempt` = pinned ∨ `trust_level === 'system'` ∨ `proof_count >=
 * highProofFloor` — the FORGET-03 anti-induced-eviction floors. (The FadeMem
 * strength-decay disjunct was DELETED in Phase 224: its strength formula floored at
 * `0.5·exp(…) ≥ ~0.25`, ABOVE the 0.2 strength floor, so the strength term could
 * never fire for a failure-implicated row — the EVI-STRENGTH-FLOOR dead branch. The
 * corroborated-`failure_count` floor is the reachable wrongness-eviction path that
 * replaces it.) A soft-evicted row has
 * `evicted_at` set NON-DESTRUCTIVELY (a marker, never a hard DELETE — the
 * `consolidated_at` precedent), preserving the raw row + provenance for audit/`asOf`.
 * The eviction is REVERSIBLE via {@link MemoryLifecyclePort.unevict} (clear
 * `evicted_at` on renewed usefulness). When the policy is NOT eviction-enabled (the
 * default), the sweep stays DORMANT — it scans but APPLIES NOTHING (report
 * `evicted`/`demoted` = 0, no UPDATE, no DELETE) — the byte-identity guarantee. Tier
 * demote/promote moves remain a deferred step (`promoted`/`demoted` are still 0 in
 * this build). The recall-side exclusion of evicted rows is enforced on EVERY live
 * recall path (CR-01), not here: `hybrid-search.ts` (the post-fusion `evicted_at IS
 * NULL`) AND `sqlite-memory-adapter.ts` (`hydrateLane`/`searchLanes` + the
 * vector-only `search()` per-id reads). The inspect/asOf raw reads stay UNFILTERED so
 * an evicted row is still audit/asOf-resolvable.
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
 * The lifecycle policy: the dormancy window PLUS the optional LIVE soft-eviction
 * behavior gate + the two FORGET-03/02 floors. The daemon passes the
 * operator-configured `learningForgetting` values via `deps`/`scope.policy` when it
 * wires the cron; until then the unit adapter uses {@link DEFAULT_POLICY}.
 */
export interface MemoryLifecyclePolicy {
  /**
   * Dormancy window (T_max, days): a memory UNUSED (not recalled-useful) for longer
   * than T_max is an eviction candidate. WR-02: "dormant" is measured from
   * `last_useful_at` (last recall), NOT `occurred_at` (event time) — a recently-
   * recalled memory about an OLD event is NOT dormant (FORGET-04). A never-recalled
   * memory falls back to event age, so genuinely-stale rows still reap.
   */
  maxDormantDays: number;

  // ── LIVE soft-eviction behavior (FORGET-01..04) ──
  // ALL optional + default-OFF: with `evictionEnabled` unset the sweep stays
  // DORMANT (evicts/demotes nothing — the byte-identity guarantee). The daemon
  // passes the operator-configured `learningForgetting` values (a later plan); the
  // unit adapter only evicts when an eviction-enabled policy is supplied.
  /**
   * Master gate for LIVE soft eviction. When `true`, NON-exempt candidates that are
   * DORMANT past `maxDormantDays` OR corroborated-wrong (`failure_count >=
   * failureEvictionFloor`) are soft-evicted (`evicted_at` set, never DELETE).
   * Default `undefined`/`false` → DORMANT (nothing evicts). Mirrors
   * `learningForgetting.eviction.enabled` ∧ `learningForgetting.enabled`.
   */
  evictionEnabled?: boolean;
  /**
   * The high-`proof_count` eviction-exemption floor (FORGET-03 anti-induced-
   * eviction): a memory with `proof_count >= highProofFloor` is NEVER soft-evicted,
   * no matter how many failures — a poisoner inducing failures cannot evict a
   * well-corroborated memory. Defaults to {@link DEFAULT_HIGH_PROOF_FLOOR}.
   */
  highProofFloor?: number;
  /**
   * The corroborated-`failure_count` eviction floor (FORGET-02, the EVI-STRENGTH-FLOOR
   * fix): the at/above-which a NON-EXEMPT memory is soft-evicted. This is the reachable
   * wrongness-eviction path (the deleted strength disjunct floored above its threshold
   * and never fired). Each `failure_count` increment is itself corroboration-gated (≥2
   * independent sessions OR a deterministic source, setup-learning-corroboration.ts).
   * SECURITY: gated by the SAME FORGET-03 exemptions (pinned / system / `proof_count >=
   * highProofFloor`), so an induced-failure attacker still cannot evict a
   * well-corroborated/pinned/system memory — the floor only reaches LOW-proof,
   * non-pinned, non-system rows. Default {@link DEFAULT_FAILURE_EVICTION_FLOOR}; a
   * higher value is more conservative. Only consulted when `evictionEnabled`.
   */
  failureEvictionFloor?: number;
}

/** The design-default DORMANT policy (only the dormancy window; eviction OFF). */
const DEFAULT_POLICY: MemoryLifecyclePolicy = {
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
   * The lifecycle policy: the dormancy window (default {@link DEFAULT_POLICY}) PLUS
   * the optional LIVE soft-eviction behavior gate + floors
   * (`evictionEnabled`/`highProofFloor`/`failureEvictionFloor`). The daemon passes
   * the operator-configured `learningForgetting` values; the unit adapter uses the
   * dormant defaults. With the eviction behavior UNSET (the default), the sweep
   * applies NOTHING (the byte-identity guarantee); it soft-evicts ONLY when
   * `evictionEnabled` is true.
   */
  policy?: MemoryLifecyclePolicy;
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

        // Is the LIVE soft-eviction policy active? Gated on an eviction-enabled policy
        // (`learningForgetting.eviction.enabled` ∧ `.enabled`). With it OFF the sweep stays
        // DORMANT — evicts/demotes nothing, the byte-identity guarantee.
        const liveEviction = effEvictionEnabled === true;
        const highProofFloor = policy.highProofFloor ?? DEFAULT_HIGH_PROOF_FLOOR;
        // The corroborated-failure eviction floor (the reachable wrongness path). Only
        // consulted under the LIVE policy; the FORGET-03 exemptions still gate it.
        const failureEvictionFloor = ov?.failureEvictionFloor ?? policy.failureEvictionFloor ?? DEFAULT_FAILURE_EVICTION_FLOOR;

        // Per-row eviction candidacy: the two reachable disjuncts (dormancy OR
        // corroborated-failure), minus the FORGET-03 exemptions. Under the LIVE policy
        // the eligible candidates are collected for the soft UPDATE below; under DORMANT
        // nothing is applied (the byte-identity guarantee).
        let evictionCandidates = 0;
        const toEvict: string[] = [];
        for (const row of rows) {
          // Event-time in epoch ms (occurred_at ?? created_at) — the fallback for a
          // never-recalled row's disuse age below. Uses the INJECTED scope.now, never Date.now.
          const eventMs = row.occurred_at ?? row.created_at;
          // WR-02: the DISUSE age — days since the memory was last RECALLED-useful
          // (last_useful_at), falling back to the event age when it was never recalled
          // (NULL). This — NOT the event age — gates the dormant-age candidacy disjunct,
          // so a recently-recalled memory about an OLD event is NOT "dormant" (FORGET-04:
          // wrong fades faster than merely old; a still-useful old fact is not reaped on
          // event-age alone). A never-recalled old memory falls back to event age, so the
          // age reaper still prunes genuinely dormant rows.
          const lastUsefulMs = row.last_useful_at ?? eventMs;
          const disuseDays = Math.max(0, (now - lastUsefulMs) / DAY_MS);
          const proof = row.proof_count ?? 0;
          const failureCount = row.failure_count ?? 0;

          // FORGET-03 anti-induced-eviction EXEMPTIONS (the store-side half of the
          // corroboration control): pinned / system-trust / high-proof memories are
          // NEVER evicted, no matter how many failures. A poisoner inducing failures
          // cannot evict a well-corroborated, pinned, or system memory.
          const exempt =
            row.pinned === 1 ||
            row.trust_level === "system" ||
            proof >= highProofFloor;

          // The eviction candidacy: DORMANT (UNUSED) beyond T_max OR corroborated-wrong
          // (`failure_count >= failureEvictionFloor`) — minus the exemptions. WR-02: the
          // age disjunct uses `disuseDays` (days since last recall), so a recently-recalled
          // old-event memory survives the age branch (FORGET-04); a never-recalled old
          // memory still trips it (disuseDays falls back to event age). The failure disjunct
          // is the reachable wrongness path — the deleted FadeMem strength disjunct floored
          // above its threshold and never fired (EVI-STRENGTH-FLOOR). The failure disjunct
          // is gated on `liveEviction` so the DORMANT-mode candidacy count stays
          // byte-identical; `!exempt` keeps the FORGET-03 guarantee (high-proof / pinned /
          // system are never reached, no matter how many failures).
          const isEvictionCandidate =
            !exempt &&
            (disuseDays > policy.maxDormantDays ||
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
