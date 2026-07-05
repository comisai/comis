// SPDX-License-Identifier: Apache-2.0
/**
 * `createBoundedAutonomy` — the single bounded-autonomy chokepoint.
 *
 * ONE typed daemon-wide service that COMPOSES the five mechanism modules
 * into one place, keyed on `rootRunId`, so every bound decision is
 * reconstructable from a single seam:
 *   - the per-`rootRunId` spawn semaphore ({@link createRootRunSemaphore}):
 *     bounds a `for(;;) spawn()` fork-bomb tree-wide on concurrency/depth/fanout,
 *   - the per-`rootRunId` $/token/wall-clock budget meter
 *     ({@link createPerRootBudget}): aborts a self-spawning loop on cost, with token
 *     + wall-clock limbs that bite even a zero-price subscription/Codex model,
 *   - the per-key sliding-window call-rate limiter + connection-churn cap
 *     ({@link createCallRateLimiter}): bounds the RATE of cap-socket calls,
 *   - the outward quota ({@link createOutwardQuota}): the
 *     irreversible-action gate for agent-initiated outward sends.
 *
 * Plus two correlation/accessor seams the composite owns:
 *   - `registerRoot(rootRunId, leaseId, parentLeaseId?)` — anchors the budget's
 *     wall-clock deadline at the tree root AND records the rootRunId↔leaseId
 *     correlation (`leaseIdsForRoot`) for the audit/kill fan-out,
 *   - `cronCount(agentId)` — the NAMED cron-cap count source the
 *     capability endpoint reaches THROUGH this service (it has no cron store of
 *     its own): delegates to the injected `cronJobCount` provider the daemon
 *     wiring binds to the per-agent `CronScheduler.getJobs().length`.
 *
 * Discipline (the daemon arch gates): EVERY numeric cap is sourced from the
 * resolved {@link ResolvedAutonomy} — no hard-coded limits except the structural
 * sliding-window sizes (1000ms call window / 60_000ms churn window) which are
 * documented. The service NEVER throws (it composes Result/discriminated-union
 * returning modules — the message-handler chokepoint converts a deny); all time is
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
import { createPerRootBudget, type PerRootBudget } from "./per-root-budget.js";
import { createCallRateLimiter } from "./call-rate-limiter.js";
import { createOutwardQuota, type OutwardQuota, type QuotaError } from "./outward-quota.js";

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

/** The composed bounded-autonomy surface — the single chokepoint every bound decision flows through. */
export interface BoundedAutonomy {
  /**
   * Atomically check + reserve one spawn slot for `rootRunId`. Denies on
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
   * Re-anchor an IDLE root's wall-clock + token limbs at a turn
   * boundary (the bridge calls this once per turn). A no-op when `rootRunId` has a
   * LIVE spawn (`activeCount > 0`) so a runaway-tree backstop is never weakened;
   * preserves the $ accumulator + the leaseId index (unlike `releaseSpawn`). Fixes
   * the interactive `root-session-*` root accumulating its wall-clock across the
   * whole conversation (it acquires no spawn slot, so `releaseSpawn` never evicts it).
   */
  evictRootIfIdle(rootRunId: string): void;
  /**
   * Record one cap-socket call. Composes the per-root AND per-socket
   * sliding-window limits — denies if EITHER trips: the per-root key on
   * `config.rate.perRootCallsPerSec`, the per-socket key on its OWN
   * `config.rate.perSocketCallsPerSec` (these are two distinct caps with
   * two distinct limiters, not one cap applied twice).
   */
  tryCall(rootRunId: string, socketId: string): { ok: true } | { ok: false; reason: "rate" };
  /** Record one cap-socket (re)connection for `rootRunId` (the churn cap). */
  tryChurn(rootRunId: string): { ok: true } | { ok: false; reason: "churn" };
  /**
   * Reserve budget for one LLM/web call against the tree root.
   * Returns a {@link SpendGateOutcome} — `ok`/`free`/`unpriceable`/`exceeded`.
   */
  reserveBudget(
    rootRunId: string,
    provider: string,
    model: string,
    estUsd: number,
    estTokens: number,
  ): SpendGateOutcome;
  /** Gate one outward agent send. Returns `Result<void, QuotaError>`. */
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
   * The composite remaining-state snapshot for one run — the read surface the
   * `capabilities.introspect`/`whoami` RPC reports. Composes the two
   * per-module {@link PerRootBudget.remaining} + {@link OutwardQuota.remaining}
   * accessors (delegating to the sub-modules the composite already holds) plus
   * the rootRunId↔leaseId correlation. A PURE read — no gate mutation, no window
   * advance, no budget reserve: it surfaces the SAME numbers the gates
   * enforce against (so the read always matches the gate).
   */
  snapshot(
    rootRunId: string,
    agentId: string,
    channelId: string,
  ): {
    budget: ReturnType<PerRootBudget["remaining"]>;
    outwardQuota: ReturnType<OutwardQuota["remaining"]>;
    leaseIds: ReadonlyArray<string>;
  };
  /**
   * The agent's live cron-job count — the NAMED count source the cap
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
 * @param deps.cronJobCount - the per-agent cron-job count provider (the cron-cap
 *   count source). Optional — absent ⇒ `cronCount` returns 0 (the daemon wiring
 *   binds it to the per-agent `CronScheduler.getJobs().length`).
 * @param deps.logger - structured logger threaded into the sub-modules.
 */
export function createBoundedAutonomy(deps: {
  clock: ClockPort;
  timers: TimerPort;
  leaseManager: LeaseManager;
  config: ResolvedAutonomy;
  cronJobCount?: (agentId: string) => number;
  logger: ComisLogger;
  /** Pre-trip budget warning hook, threaded verbatim into the per-root meter
   *  (fired once per (root, limb) at 80% of a limb's cap). Optional — the boot
   *  wiring emits `autonomy:budget_warning` from it. */
  onLimbWarning?: Parameters<typeof createPerRootBudget>[0]["onLimbWarning"];
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
    ...(deps.onLimbWarning !== undefined ? { onLimbWarning: deps.onLimbWarning } : {}),
    clock,
    config: {
      aggregateUsd: config.budget.aggregateUsd,
      tokens: config.budget.tokens,
      wallClockMs: config.budget.wallClockMs,
    },
    logger,
  });

  // The per-ROOT call limiter (+ the connection-churn cap, which is per-root).
  // `tryCall` applies its callWindow to the `root:<id>` key (the whole tree's
  // call rate).
  const rate = createCallRateLimiter({
    clock,
    timers,
    callWindowMs: CALL_WINDOW_MS,
    maxCallsPerWindow: config.rate.perRootCallsPerSec,
    churnWindowMs: CHURN_WINDOW_MS,
    maxChurnPerWindow: config.rate.connectionChurnPerMin,
    maxEntries: RATE_MAX_ENTRIES,
  });

  // A SEPARATE limiter for the per-SOCKET dimension. The
  // shared sliding-window body enforces ONE `maxPerWindow`, so a single limiter
  // cannot apply two different per-key caps — if both the root AND socket
  // keys rode the per-root cap, `perSocketCallsPerSec` (default 10) would be dead
  // config. This second limiter's callWindow uses `perSocketCallsPerSec` so the
  // `socket:<id>` key is bounded by its own configured cap. Its churn limb is
  // unused (churn is per-root, gated by `rate.tryChurn`); a positive placeholder
  // keeps the constructor's `int().positive()` contract without affecting the
  // socket call cap. Torn down in `destroy()`.
  const rateSocket = createCallRateLimiter({
    clock,
    timers,
    callWindowMs: CALL_WINDOW_MS,
    maxCallsPerWindow: config.rate.perSocketCallsPerSec,
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
      // When the tree has no live spawns left, evict ALL per-root state in
      // one place — the semaphore already dropped its own entry inside
      // releaseSpawn (active→0), so mirror that here for the budget meter's
      // wall-clock/token maps AND the leaseId correlation index, so a storm of
      // per-spawn / per-cron-fire roots that complete does not grow any of the
      // sibling maps without bound. activeCount reads 0 for the now-evicted root.
      if (semaphore.activeCount(rootRunId) === 0) {
        budget.evictRoot(rootRunId);
        leaseIdsByRoot.delete(rootRunId);
      }
    },

    evictRootIfIdle(rootRunId): void {
      // Re-anchor an IDLE root's wall-clock + token limbs at a turn
      // boundary. An interactive SESSION root (`root-session-*`) acquires NO spawn
      // slot, so `releaseSpawn` never fires for it and its wall-clock/token anchors
      // would accumulate across the WHOLE conversation — a session alive >
      // wallClockMs would then falsely abort EVERY subsequent turn.
      // The bridge calls this once per turn so each turn re-anchors
      // from its own start (the next reserveBudget re-anchors via the
      // first-reserve write). GUARD: only when `activeCount === 0` — a root with a
      // LIVE spawn is NOT reset, so the genuine runaway-TREE wall-clock backstop
      // holds. Drops ONLY the budget meter's wall-clock + token maps (via
      // budget.evictRoot); the $ accumulator is untouched (a per-session spend cap
      // stays cumulative) and the leaseId correlation is preserved (unlike
      // releaseSpawn — the session's live leases must survive a turn boundary).
      if (semaphore.activeCount(rootRunId) === 0) {
        budget.evictRoot(rootRunId);
      }
    },

    tryCall(rootRunId, socketId): { ok: true } | { ok: false; reason: "rate" } {
      // Compose the per-root AND per-socket sliding-window limits — deny if EITHER
      // trips. The per-root key bounds the whole tree's call rate
      // (`perRootCallsPerSec`); the per-socket key bounds a single orchestration
      // socket via its OWN limiter (`perSocketCallsPerSec`). Check the root
      // bound first (the tree-wide cap), then the socket bound.
      const perRoot = rate.tryCall(`root:${rootRunId}`);
      if (!perRoot.ok) return perRoot;
      const perSocket = rateSocket.tryCall(`socket:${socketId}`);
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

    snapshot(
      rootRunId,
      agentId,
      channelId,
    ): {
      budget: ReturnType<PerRootBudget["remaining"]>;
      outwardQuota: ReturnType<OutwardQuota["remaining"]>;
      leaseIds: ReadonlyArray<string>;
    } {
      // PURE read: delegate to the per-module remaining()
      // accessors (themselves pure) + materialize the lease-correlation set as an
      // array. No gate state is mutated here.
      return {
        budget: budget.remaining(rootRunId),
        outwardQuota: quota.remaining(agentId, channelId),
        leaseIds: [...(leaseIdsByRoot.get(rootRunId) ?? new Set<string>())],
      };
    },

    cronCount(agentId): number {
      // Delegate to the injected provider (the cron-cap count source); the service
      // holds NO cron store of its own. Absent provider ⇒ 0 (fail-open on this
      // single limb — the endpoint gates origin/scope first).
      return deps.cronJobCount?.(agentId) ?? 0;
    },

    destroy(): void {
      rate.destroy();
      rateSocket.destroy();
    },
  };
}
