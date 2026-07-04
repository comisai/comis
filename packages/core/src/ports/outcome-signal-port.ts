// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * OutcomeSignalPort: the SEGREGATED hexagonal boundary for the verified-learning
 * outcome signal — the durable record of a finished trajectory's
 * net task-outcome (success / failure / corrected / unknown) so that ALL
 * learning can gate on a real task-outcome signal instead of a text-overlap
 * proxy. It captures raw observations (`observe`), fuses them
 * precedence-first into one resolved verdict (`resolve`), and bounds the
 * append-only ledger by age (`prune`).
 *
 * This is a deliberately separate port — like {@link MemoryUsefulnessStore} it does
 * NOT widen the security-reviewed `MemoryPort` (store/search/delete). The sole
 * adapter lives in @comis/memory (it owns the `db` handle and runs all SQL);
 * the outcome capture is invoked DAEMON-SIDE (the daemon depends on everything
 * and injects the adapter). Any agent-side consumer (skill synthesis)
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
 * pool. Mirrors {@link UsefulnessScope}'s shape with `now`
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
 * source, observedAt)`: re-observing the same tuple is a no-op (a UNIQUE-
 * constraint backstop). Counts/ids/closed-enums only — NO message bodies or
 * model-asserted trust ever enter this layer (content-free, like the `memory:*`
 * bus events).
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
  /** Opaque used-skill ids attributed to this trajectory — ids only, never bodies; absent when no skill use was attributed. */
  usedSkillIds?: string[];
  /**
   * Content-free procedure descriptor for this trajectory — the run's bounded tool-NAME
   * set (the pre-flight footprint); NAMES only, never args/bodies/secrets. Absent when no
   * cap-mapped tool call sites were declared. Persisted JSON-encoded to `procedure_descriptor`;
   * NOT part of any key/index (the sha256 id tuple is untouched).
   */
  procedureDescriptor?: ReadonlyArray<string>;
  /** Injected epoch ms the observation was made (part of the idempotency tuple). */
  observedAt: number;
}

/**
 * The fused verdict for one trajectory: the single net outcome after
 * precedence-first fusion (tool/pipeline > judge > reaction; max-confidence
 * within a tier) across every persisted observation. A finished trajectory with
 * no resolvable signal fuses to `outcome: "unknown"` and derives NO learning /
 * NO reward (fail-closed); coverage telemetry must NOT count
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
  /** Opaque used-skill ids attributed to this trajectory — ids only; empty when no skill use was attributed. */
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
   * `ON CONFLICT … DO NOTHING` (the UNIQUE-constraint backstop) plus a
   * deterministic-hash id so a replay upserts even if the row was deleted.
   * Returns `ok(undefined)` on success; never throws.
   */
  observe(obs: OutcomeObservation): Promise<Result<void, Error>>;

  /**
   * READ. Fuse every persisted observation for `trajectoryId` (scoped to
   * `(tenant, agent)`) into one {@link ResolvedOutcome}, precedence-first then
   * by confidence. When no tier resolves, returns `ok({ outcome: "unknown", … })`
   * and derives no learning (fail-closed). Unresolved scope
   * fails-closed with `err(...)` at the adapter — never a shared/global pool.
   */
  resolve(trajectoryId: string, scope: LearningScope): Promise<Result<ResolvedOutcome, Error>>;

  /**
   * Age-based housekeeping. Delete every observation older than
   * `systemNowMs() - retentionDays * 86_400_000` (mirrors
   * `observability-store.prune`). Mandatory anti-DoS on the append-only ledger;
   * runs at daemon startup regardless of the per-agent
   * enable flag. Synchronous (a single SQLite transaction).
   */
  prune(retentionDays: number): OutcomePruneResult;

  /**
   * READ. Enumerate the DISTINCT per-turn `(trajectoryId, sessionId)` pairs the
   * ledger holds for this `(tenant, agent)` scope, most-recent-first (bounded).
   *
   * Exists so a consumer (skill synthesis) can discover the REAL per-turn
   * trajectory identities the outcome signal is keyed on and `resolve()` each —
   * instead of guessing an id from a session view. This matters because outcomes
   * are keyed by the per-turn `traceId`, NOT the `sessionKey`: a consumer that
   * calls `resolve(sessionKey)` always fuses to `unknown`, and no skill could
   * ever be selected on the single-agent path.
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
