// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * OutcomeSignalPort: the SEGREGATED hexagonal boundary for the v2.26 Verified
 * Learning outcome signal (WS1) — the durable record of a finished trajectory's
 * net task-outcome (success / failure / corrected / unknown) so that ALL
 * learning can gate on a real task-outcome signal instead of a text-overlap
 * proxy (design §WS1). It captures raw observations (`observe`), fuses them
 * precedence-first into one resolved verdict (`resolve`), and bounds the
 * append-only ledger by age (`prune`).
 *
 * This is a NEW port — like {@link MemoryUsefulnessStore} it deliberately does
 * NOT widen the security-reviewed `MemoryPort` (store/search/delete). The sole
 * adapter lives in @comis/memory (it owns the `db` handle and runs all SQL);
 * the outcome capture is invoked DAEMON-SIDE (the daemon depends on everything
 * and injects the adapter). Any future agent-side consumer (Phase 201 synthesis)
 * imports this port TYPE only — it cannot import @comis/memory (the agent↛memory
 * build cut). No new authority is granted beyond a scoped read/write within the
 * caller's own (tenant, agent).
 *
 * This file is type-only (mirrors memory-usefulness-store.ts): no zod, no
 * @comis/memory import. There is no memory-specific error type — every method
 * returns `Result<T, Error>` from @comis/shared.
 */

/**
 * The isolation boundary for every outcome operation. The sole adapter filters
 * every statement on `(tenantId, agentId)` and the table keys on
 * `(tenant_id, agent_id, trajectory_id, …)` — this is a load-bearing SECURITY
 * scope in a multi-agent DB (an observation under one (tenant, agent) must NEVER
 * be visible to a read under another), not a nicety. Unresolved `(tenant, agent)`
 * MUST fail-closed (raise/err) at the adapter — never default to a shared/global
 * pool (SEC-01, design §9). Mirrors {@link UsefulnessScope}'s shape with `now`
 * OPTIONAL (the resolve read path does not bookkeep a clock).
 */
export interface LearningScope {
  /** Tenant partition (isolation boundary). */
  tenantId: string;
  /** Agent partition (isolation boundary). */
  agentId: string;
  /**
   * Optional injected epoch ms. NEVER `Date.now()` — when a write path needs a
   * clock the caller supplies it from an injected clock so the path stays
   * deterministic/testable. Absent on the read (`resolve`) path.
   */
  now?: number;
}

/**
 * A single raw outcome observation captured from one signal source for one
 * trajectory. Idempotent at the row level on `(tenantId, agentId, trajectoryId,
 * source, observedAt)`: re-observing the same tuple is a no-op (the design's
 * UNIQUE backstop). Counts/ids/closed-enums only — NO message bodies or
 * model-asserted trust ever enter this layer (content-free, like the `memory:*`
 * bus events). `usedSkillIds` is an EMPTY sink in P0 (populated Phase 201).
 */
export interface OutcomeObservation {
  /** Tenant partition (isolation boundary). */
  tenantId: string;
  /** Agent partition (isolation boundary). */
  agentId: string;
  /** Conversation/session identity the trajectory belongs to. */
  sessionId: string;
  /** The trajectory identity (the stable `traceId` the trajectory + `comis explain` key on). */
  trajectoryId: string;
  /** The observed outcome from THIS source (closed union). */
  outcome: "success" | "failure" | "corrected" | "unknown";
  /** Which signal produced this observation (closed union). */
  source: "tool" | "pipeline" | "correction" | "judge" | "reaction" | "explicit";
  /** Source-reported confidence in [0, 1]. For the judge this is reward-capped in CODE, never trusted. */
  confidence: number;
  /** Optional sender-trust tag (reaction/correction provenance); never raises trust. */
  senderTrust?: string;
  /** Opaque recalled-memory ids attributed to this trajectory — ids only, never bodies. */
  recalledIds?: string[];
  /** Opaque used-skill ids — EMPTY in P0 (the WS2 attribution that populates it lands Phase 201). */
  usedSkillIds?: string[];
  /** Injected epoch ms the observation was made (part of the idempotency tuple). */
  observedAt: number;
}

/**
 * The fused verdict for one trajectory: the single net outcome after
 * precedence-first fusion (tool/pipeline > judge > reaction; max-confidence
 * within a tier) across every persisted observation. A finished trajectory with
 * no resolvable signal fuses to `outcome: "unknown"` and derives NO learning /
 * NO reward (fail-closed, OUTCOME-05); coverage telemetry must NOT count
 * `unknown` as resolved.
 */
export interface ResolvedOutcome {
  /** The fused net outcome (closed union). */
  outcome: "success" | "failure" | "corrected" | "unknown";
  /** Confidence of the winning tier's contributing observation. */
  confidence: number;
  /** The sources that contributed to the verdict (closed-union members, deduped). */
  sources: Array<"tool" | "pipeline" | "correction" | "judge" | "reaction" | "explicit">;
  /** Opaque recalled-memory ids attributed to this trajectory — ids only. */
  recalledIds: string[];
  /** Opaque used-skill ids — EMPTY sink in P0 (populated Phase 201). */
  usedSkillIds: string[];
}

/** Result of an age-based prune sweep over the ledger. */
export interface OutcomePruneResult {
  /** Rows deleted (older than the retention cutoff). */
  changes: number;
}

export interface OutcomeSignalPort {
  /**
   * WRITE (idempotent). Persist one raw outcome observation, upserting the
   * `(tenantId, agentId, trajectoryId, source, observedAt)` row via
   * `ON CONFLICT … DO NOTHING` (the design's UNIQUE backstop) plus a
   * deterministic-hash id so a replay upserts even if the row was deleted.
   * Returns `ok(undefined)` on success; never throws.
   */
  observe(obs: OutcomeObservation): Promise<Result<void, Error>>;

  /**
   * READ. Fuse every persisted observation for `trajectoryId` (scoped to
   * `(tenant, agent)`) into one {@link ResolvedOutcome}, precedence-first then
   * by confidence. When no tier resolves, returns `ok({ outcome: "unknown", … })`
   * and derives no learning (fail-closed, OUTCOME-05). Unresolved scope
   * fails-closed with `err(...)` at the adapter — never a shared/global pool.
   */
  resolve(trajectoryId: string, scope: LearningScope): Promise<Result<ResolvedOutcome, Error>>;

  /**
   * Age-based housekeeping. Delete every observation older than
   * `systemNowMs() - retentionDays * 86_400_000` (mirrors
   * `observability-store.prune`). Mandatory anti-DoS on the append-only ledger
   * (OUTCOME-07 / §V12); runs at daemon startup regardless of the per-agent
   * enable flag. Synchronous (a single SQLite transaction).
   */
  prune(retentionDays: number): OutcomePruneResult;

  /**
   * READ. Enumerate the DISTINCT per-turn `(trajectoryId, sessionId)` pairs the
   * ledger holds for this `(tenant, agent)` scope, most-recent-first (bounded).
   *
   * Exists so a consumer (skill synthesis, WS2) can discover the REAL per-turn
   * trajectory identities the outcome signal is keyed on and `resolve()` each —
   * instead of guessing an id from a session view. This closes the live-2026-06-18
   * defect where the synthesis source emitted the `sessionKey` while outcomes are
   * keyed by the per-turn `traceId`, so `resolve(sessionKey)` always fused to
   * `unknown` and NO skill could ever be selected on the single-agent path.
   *
   * OPTIONAL: only the sqlite adapter implements it; a consumer MUST fail-closed
   * (treat absent / `err` as "no source trajectories") rather than fall back to a
   * non-resolvable identity. Scoped + fail-closed on an unresolved scope, exactly
   * like {@link resolve}.
   */
  listTrajectoryIds?(
    scope: LearningScope,
  ): Promise<Result<Array<{ trajectoryId: string; sessionId: string }>, Error>>;
}
