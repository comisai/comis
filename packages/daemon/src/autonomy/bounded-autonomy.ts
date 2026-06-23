// SPDX-License-Identifier: Apache-2.0
/**
 * `createBoundedAutonomy` — the single bounded-autonomy chokepoint (Phase 213-06,
 * RESEARCH §Pattern-1).
 *
 * ONE typed daemon-wide service that COMPOSES the five mechanism modules built in
 * Plans 04/05 into one place, keyed on `rootRunId`, so every bound decision is
 * reconstructable from a single seam — the seam the Phase-215 audit reads:
 *   - the per-`rootRunId` spawn semaphore (CEIL-01, {@link createRootRunSemaphore}):
 *     bounds a `for(;;) spawn()` fork-bomb tree-wide on concurrency/depth/fanout,
 *   - the per-`rootRunId` $/token/wall-clock budget meter (BUDGET-01/02/03,
 *     {@link createPerRootBudget}): aborts a self-spawning loop on cost, with token
 *     + wall-clock limbs that bite even a zero-price subscription/Codex model,
 *   - the per-key sliding-window call-rate limiter + connection-churn cap (RATE-01,
 *     {@link createCallRateLimiter}): bounds the RATE of cap-socket calls,
 *   - the outward quota (QUOTA-01/02, {@link createOutwardQuota}): the
 *     irreversible-action gate for agent-initiated outward sends.
 *
 * Plus two correlation/accessor seams the composite owns:
 *   - `registerRoot(rootRunId, leaseId, parentLeaseId?)` — anchors the budget's
 *     wall-clock deadline at the tree root AND records the rootRunId↔leaseId
 *     correlation (`leaseIdsForRoot`) for the audit/kill fan-out,
 *   - `cronCount(agentId)` — the NAMED RATE-02 cron-cap count source the
 *     capability endpoint reaches THROUGH this service (it has no cron store of
 *     its own): delegates to the injected `cronJobCount` provider Plan 07 binds to
 *     the per-agent `CronScheduler.getJobs().length`.
 *
 * Discipline (the daemon arch gates): EVERY numeric cap is sourced from the
 * resolved {@link ResolvedAutonomy} — no hard-coded limits except the structural
 * sliding-window sizes (1000ms call window / 60_000ms churn window) which are
 * documented. The service NEVER throws (it composes Result/discriminated-union
 * returning modules — the chokepoint converts a deny in Plans 07/08); all time is
 * the injected {@link ClockPort}/{@link TimerPort} (never the wall-clock global —
 * the globals gate). `destroy()` tears down the rate limiter's timers for clean
 * shutdown.
 *
 * @module
 */
import type { ClockPort, TimerPort, ResolvedAutonomy } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { LeaseManager } from "@comis/infra";
import type { SpendGateOutcome } from "@comis/agent";
import type { Result } from "@comis/shared";

import { createRootRunSemaphore, type SpawnDenyReason } from "./root-run-semaphore.js";
import { createPerRootBudget } from "./per-root-budget.js";
import { createCallRateLimiter } from "./call-rate-limiter.js";
import { createOutwardQuota, type QuotaError } from "./outward-quota.js";

// Structural window sizes (documented — NOT policy caps): the call-rate sliding
// window is per-second (1000ms) and the connection-churn window is per-minute
// (60_000ms). The PER-WINDOW counts come from config (rate.perRootCallsPerSec /
// rate.connectionChurnPerMin); only the window widths are fixed here.
const CALL_WINDOW_MS = 1_000;
const CHURN_WINDOW_MS = 60_000;
// The maxEntries leak-guard cap on the rate limiter's bucket maps (the unbounded
// distinct-key vector a for(;;) spawn() opens). A generous structural backstop —
// not a policy cap (which roots/sockets are admitted is the per-window count).
const RATE_MAX_ENTRIES = 100_000;

/** The composed bounded-autonomy surface — the single chokepoint (Phase 215 reads it). */
export interface BoundedAutonomy {
  /**
   * Atomically check + reserve one spawn slot for `rootRunId` (CEIL-01). Denies on
   * the depth → fanout → concurrency bounds (all from `config.spawn.*`). Delegates
   * to the per-root semaphore; the reserve is synchronous.
   */
  tryAcquireSpawn(
    rootRunId: string,
    depth: number,
    fanout: number,
  ): { ok: true } | { ok: false; reason: SpawnDenyReason };
  /** Release one spawn slot for `rootRunId` (paired with a prior `tryAcquireSpawn`). */
  releaseSpawn(rootRunId: string): void;
  /**
   * Record one cap-socket call (RATE-01). Composes the per-root AND per-socket
   * sliding-window limits — denies if EITHER trips (`config.rate.perRootCallsPerSec`).
   */
  tryCall(rootRunId: string, socketId: string): { ok: true } | { ok: false; reason: "rate" };
  /** Record one cap-socket (re)connection for `rootRunId` (the churn cap, RATE-01). */
  tryChurn(rootRunId: string): { ok: true } | { ok: false; reason: "churn" };
  /**
   * Reserve budget for one LLM/web call against the tree root (BUDGET-01/02/03).
   * Returns a {@link SpendGateOutcome} — `ok`/`free`/`unpriceable`/`exceeded`.
   */
  reserveBudget(
    rootRunId: string,
    provider: string,
    model: string,
    estUsd: number,
    estTokens: number,
  ): SpendGateOutcome;
  /** Gate one outward agent send (QUOTA-01/02). Returns `Result<void, QuotaError>`. */
  tryOutward(
    agentId: string,
    channelId: string,
    isOrigin: boolean,
    volume: number,
  ): Result<void, QuotaError>;
  /**
   * Register a tree root: anchor the budget wall-clock deadline AND record the
   * rootRunId↔leaseId correlation (for the audit/kill fan-out). Idempotent on the
   * budget anchor; additive on the lease index.
   */
  registerRoot(rootRunId: string, leaseId: string, parentLeaseId?: string): void;
  /** The set of leaseIds correlated to `rootRunId` (empty for an unknown root). */
  leaseIdsForRoot(rootRunId: string): ReadonlySet<string>;
  /**
   * The agent's live cron-job count (RATE-02) — the NAMED count source the cap
   * endpoint consults THROUGH this service. Delegates to the injected
   * `cronJobCount` provider; 0 when no provider is wired (fail-open on this limb).
   */
  cronCount(agentId: string): number;
  /** Tear down the rate limiter's scheduled timers (clean daemon shutdown). */
  destroy(): void;
}

/**
 * Construct the bounded-autonomy composite from the resolved autonomy posture.
 *
 * @param deps.clock - injected wall-clock for the budget wall-clock limb + the
 *   rate-limiter sliding windows (never the wall-clock global).
 * @param deps.timers - injected timer port for the rate-limiter TTL-evict timers.
 * @param deps.leaseManager - the credential-broker lease authority (the revoke
 *   fan-outs the daemon revoke/kill RPC drives; held here for the chokepoint to
 *   own the full bound surface in one place).
 * @param deps.config - the resolved {@link ResolvedAutonomy} — the SINGLE source
 *   of every numeric cap (spawn/budget/rate/outward + message.maxPerHour).
 * @param deps.cronJobCount - the per-agent cron-job count provider (the RATE-02
 *   count source). Optional — absent ⇒ `cronCount` returns 0 (Plan 07 binds it to
 *   the per-agent `CronScheduler.getJobs().length`).
 * @param deps.logger - structured logger threaded into the sub-modules.
 */
export function createBoundedAutonomy(deps: {
  clock: ClockPort;
  timers: TimerPort;
  leaseManager: LeaseManager;
  config: ResolvedAutonomy;
  cronJobCount?: (agentId: string) => number;
  logger: ComisLogger;
}): BoundedAutonomy {
  const { clock, timers, config } = deps;
  const logger = deps.logger.child({ submodule: "bounded-autonomy" });

  // ── Compose the five mechanism modules ONCE from the resolved config. ──
  const semaphore = createRootRunSemaphore({
    maxConcurrentSelfAgents: config.spawn.maxConcurrentSelfAgents,
    maxSpawnDepth: config.spawn.maxSpawnDepth,
    maxChildrenPerAgent: config.spawn.maxChildrenPerAgent,
  });

  const budget = createPerRootBudget({
    clock,
    config: {
      aggregateUsd: config.budget.aggregateUsd,
      tokens: config.budget.tokens,
      wallClockMs: config.budget.wallClockMs,
    },
    logger,
  });

  const rate = createCallRateLimiter({
    clock,
    timers,
    callWindowMs: CALL_WINDOW_MS,
    maxCallsPerWindow: config.rate.perRootCallsPerSec,
    churnWindowMs: CHURN_WINDOW_MS,
    maxChurnPerWindow: config.rate.connectionChurnPerMin,
    maxEntries: RATE_MAX_ENTRIES,
  });

  const quota = createOutwardQuota({
    clock,
    config: {
      originOnly: config.outward.originOnly,
      perTargetGrants: config.outward.perTargetGrants,
      volumeCap: config.outward.volumeCap,
      maxPerHour: config.message.maxPerHour,
    },
    logger,
  });

  // rootRunId → leaseIds correlation, recorded at registerRoot. The kill/revoke
  // fan-out (the daemon RPC) drives the leaseManager directly; this index is the
  // audit-side correlation the chokepoint owns alongside the bound mechanisms.
  const leaseIdsByRoot = new Map<string, Set<string>>();

  return {
    tryAcquireSpawn(rootRunId, depth, fanout): { ok: true } | { ok: false; reason: SpawnDenyReason } {
      return semaphore.tryAcquireSpawn(rootRunId, depth, fanout);
    },

    releaseSpawn(rootRunId): void {
      semaphore.releaseSpawn(rootRunId);
    },

    tryCall(rootRunId, socketId): { ok: true } | { ok: false; reason: "rate" } {
      // Compose the per-root AND per-socket sliding-window limits — deny if EITHER
      // trips. The per-root key bounds the whole tree's call rate; the per-socket
      // key bounds a single orchestration socket. Both ride the same window cap.
      const perRoot = rate.tryCall(`root:${rootRunId}`);
      if (!perRoot.ok) return perRoot;
      const perSocket = rate.tryCall(`socket:${socketId}`);
      if (!perSocket.ok) return perSocket;
      return { ok: true };
    },

    tryChurn(rootRunId): { ok: true } | { ok: false; reason: "churn" } {
      return rate.tryChurn(rootRunId);
    },

    reserveBudget(rootRunId, provider, model, estUsd, estTokens): SpendGateOutcome {
      return budget.reserveBudget(rootRunId, provider, model, estUsd, estTokens);
    },

    tryOutward(agentId, channelId, isOrigin, volume): Result<void, QuotaError> {
      return quota.tryOutward(agentId, channelId, isOrigin, volume);
    },

    registerRoot(rootRunId, leaseId, _parentLeaseId): void {
      // Anchor the budget wall-clock deadline at the tree root (idempotent).
      budget.registerRoot(rootRunId);
      // Record the rootRunId↔leaseId correlation (additive — a root has many
      // leases). The leaseManager already holds parentLeaseId for the cascade,
      // so the parentLeaseId arg is part of the seam shape but not re-indexed here.
      const set = leaseIdsByRoot.get(rootRunId) ?? new Set<string>();
      set.add(leaseId);
      leaseIdsByRoot.set(rootRunId, set);
    },

    leaseIdsForRoot(rootRunId): ReadonlySet<string> {
      return leaseIdsByRoot.get(rootRunId) ?? new Set<string>();
    },

    cronCount(agentId): number {
      // Delegate to the injected provider (the RATE-02 count source); the service
      // holds NO cron store of its own. Absent provider ⇒ 0 (fail-open on this
      // single limb — the endpoint gates origin/scope first).
      return deps.cronJobCount?.(agentId) ?? 0;
    },

    destroy(): void {
      rate.destroy();
    },
  };
}
