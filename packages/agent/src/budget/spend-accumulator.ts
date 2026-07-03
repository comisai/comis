// SPDX-License-Identifier: Apache-2.0
/**
 * The single daemon-wide spend accumulator — the load-bearing
 * correctness piece of the dollars kill-switch.
 *
 * Holds the enforcement STATE for three ceiling scopes — per-`(tenant,agent)`,
 * per-tenant, and a single daemon-`global` running total — rehydrated once at
 * boot from persisted `obs_token_usage.cost_total` and incremented LIVE from the
 * `observability:token_usage` event (the rows are its durability; there is NO
 * per-check SQL re-sum). It is the enforcement-state owner, SEPARATE from the
 * pure recorder `cost-tracker.ts` (recorder ≠ enforcer).
 *
 * The genuinely-new code shape — and the reason this module exists — is the
 * SYNCHRONOUS atomic {@link SpendAccumulator.checkAndReserve}. It models the
 * per-scope `Map` + injected {@link ClockPort} shape of
 * `safety/summarizer-spend-breaker.ts`, but COLLAPSES that precedent's non-atomic
 * `canSpend`→`await inner()`→`record` two-step into ONE synchronous body with NO
 * `await` between the headroom read and the reserve write. JS is single-threaded
 * per event-loop tick, so a synchronous check-and-reserve is atomic against other
 * JS callers: K event-loop-concurrent reservations each see the running total
 * left by the prior one, so concurrent ADMISSIONS are bounded to a single
 * in-flight turn's overshoot (`configured + perTurnMax`), never K turns' worth.
 *
 * Discipline (the `budget/` arch gates — this dir is NOT a sanctioned exception):
 *   - returns {@link Result}, NEVER `throw` (the raw-throw gate),
 *   - all time from the injected {@link ClockPort}, NEVER `Date.now`/timers (the
 *     globals gate),
 *   - content-free: it operates on dollar COUNTS only — no message/query/body.
 *
 * @module
 */
import type { ClockPort, SpendScopeKind } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";

// The closed scope of a ceiling breach IS the `SpendScopeKind` wire enum
// (agent|tenant|global). Imported from @comis/core (its source of truth — it
// rides the `observability:spend_*` events) rather than re-declared, so the
// enforcement scope and the event scope can never drift. Re-exported here so the
// accumulator's consumers (the budget-guard / bridge wiring) keep a single
// budget-local import site.
export type { SpendScopeKind };

/** The `(tenant, agent)` identity a reservation is made against. */
export interface SpendScope {
  tenantId: string;
  agentId: string;
}

/** A granted reservation — the handle {@link SpendAccumulator.reconcile} settles. */
export interface SpendReservation {
  /** The per-(tenant,agent) counter key this reservation accrued into. */
  scopeKey: string;
  /** The tenant counter key this reservation accrued into. */
  tenantKey: string;
  /** The estimated dollars reserved across all three counters. */
  reservedUsd: number;
}

/**
 * The DIMENSION whose post-reserve fraction crossed `warnAtFraction` on a granted
 * reserve. Carries the breaching scope + that dimension's
 * own post-reserve running total + cap — so the bridge emits an internally
 * CONSISTENT `observability:spend_warning` (correct scope, the dimension's total,
 * the dimension's cap) instead of hard-coding `scope:"agent"` + a session-local
 * amount + a first-non-null cap. Content-free: a closed enum + two NUMBERS only.
 */
export interface SpendWarn {
  /** Which ceiling dimension crossed the warn threshold. */
  scope: SpendScopeKind;
  /** That dimension's post-reserve cumulative total (USD). */
  totalUsd: number;
  /** That dimension's ceiling (USD). */
  capUsd: number;
}

/** The three running-total ceilings + the warn threshold. `null` = that ceiling is OFF. */
export interface SpendCeilings {
  /** Per-(tenant,agent) USD cap. `null` disables this dimension. */
  perAgentUsd: number | null;
  /** Per-tenant USD cap (the cross-tenant-DoS isolation dimension). `null` disables. */
  perTenantUsd: number | null;
  /** Daemon-wide global USD cap. `null` disables. */
  daemonGlobalUsd: number | null;
  /** Fraction of any ceiling at/above which a granted reserve carries `warn: true`. */
  warnAtFraction: number;
}

/**
 * The content-free error a breached {@link SpendAccumulator.checkAndReserve}
 * returns via `err()` (NEVER thrown — `budget/` is not a raw-throw root). Mirrors
 * `BudgetError` (budget-guard.ts) but carries the dollars scope + numeric amounts
 * only — never a message body.
 */
/** Which limb of the per-root autonomy.budget meter tripped. The priced
 *  $-ceiling gate leaves it undefined (→ the aggregate USD spend). The per-root
 *  token / wall-clock limbs set it so `explain` can name the exact knob + the
 *  correct unit — the `currentUsd`/`capUsd` numbers are tokens / ms (NOT dollars)
 *  for those limbs. */
export type SpendLimb = "aggregateUsd" | "tokens" | "wallClockMs";
export type SpendUnit = "usd" | "tokens" | "ms";

export class SpendError extends Error {
  public readonly name = "SpendError";

  constructor(
    public readonly scope: SpendScopeKind,
    public readonly currentUsd: number,
    public readonly capUsd: number,
    public readonly estUsd: number,
    /** The tripped per-root limb (undefined for the priced $-ceiling gate). */
    public readonly limb?: SpendLimb,
    /** The unit of `currentUsd`/`capUsd` for this limb (defaults to usd). */
    public readonly unit?: SpendUnit,
  ) {
    super(`Spend ceiling exceeded (${scope})`);
  }
}

/** The daemon-wide spend accumulator surface (the per-agent guards hold a reference). */
export interface SpendAccumulator {
  /**
   * Boot: seed the per-(tenant,agent), per-tenant, and global running totals from
   * persisted cost rows. The accumulator is agnostic — it accrues whatever rows it
   * is given (the boot read groups by `agent_id`; per-tenant may accrue
   * live-from-boot — a documented honest degradation).
   */
  rehydrate(rows: ReadonlyArray<{ agentId: string; tenantId: string; costUsd: number }>): void;
  /** Live: add an actual billed amount to all three counters (from the bus). */
  recordSpend(scope: SpendScope, actualUsd: number): void;
  /**
   * Pre-flight: atomically (ONE synchronous body, NO `await`) check headroom
   * across (tenant,agent) → tenant → global and RESERVE `estUsd` if all non-null
   * ceilings pass. On a breach returns `err(SpendError)` for the FIRST scope that
   * would be exceeded (checked in that order) WITHOUT mutating any counter. On
   * success mutates all three counters by `estUsd` BEFORE returning — so K
   * event-loop-concurrent callers serialize and each sees the prior reservation.
   * The granted reserve carries `warn`: the FIRST ceiling DIMENSION (checked in
   * (tenant,agent) → tenant → global order) whose post-reserve fraction is
   * at/above `warnAtFraction` (with that dimension's own total + cap), or `null`
   * when none crossed (a full dimension, not a bare `warn: boolean`, so
   * the bridge emits a scope-correct `observability:spend_warning`).
   */
  checkAndReserve(
    scope: SpendScope,
    estUsd: number,
  ): Result<SpendReservation & { warn: SpendWarn | null }, SpendError>;
  /**
   * Settle a reservation's estimate to the actual billed amount once the turn
   * completes: applies `actualUsd - reservation.reservedUsd` to all three counters
   * (can be negative — releases over-reserved headroom so an over-estimate does
   * not permanently consume the ceiling).
   */
  reconcile(reservation: SpendReservation, actualUsd: number): void;
  /**
   * Read-only snapshot of the three running totals for the OTel `comis_spend_*`
   * gauges (the headroom-gauge source). A PURE read: no
   * mutation, no wall-clock call, never throws (the `budget/` discipline). The
   * returned maps are FRESH COPIES — a caller mutating them cannot corrupt the
   * accumulator's authoritative enforcement counters (the kill-switch state).
   * Content-free: dollar COUNTS only, keyed by the `${tenantId} ${agentId}` /
   * `tenantId` scope keys — no message/query/body. `perAgent` reflects BOTH billed
   * spend (`recordSpend`/`rehydrate`) and in-flight reservations (`checkAndReserve`).
   */
  getSnapshot(): {
    perAgent: ReadonlyMap<string, number>;
    perTenant: ReadonlyMap<string, number>;
    global: number;
  };
}

/** Compose the per-(tenant,agent) counter key. */
function agentKeyOf(scope: SpendScope): string {
  return `${scope.tenantId} ${scope.agentId}`;
}

/**
 * Create the daemon-wide spend accumulator. ONE instance per daemon (wired at the
 * observability composition root); the per-agent budget guards hold a reference
 * and pass the scope key that selects which counter the check reads/writes.
 *
 * `deps.clock` is injected per the globals gate and to keep the module honest for
 * a future rolling-window variant; the shipped ceilings are plain running totals
 * (cumulative by design, not windowed), so no wall-clock call is
 * made in the hot path.
 */
export function createSpendAccumulator(deps: {
  clock: ClockPort;
  ceilings: SpendCeilings;
}): SpendAccumulator {
  const { ceilings } = deps;
  // Three lazy-created running totals (lazy exactly like `spendFor` in the breaker).
  const perAgent = new Map<string, number>();
  const perTenant = new Map<string, number>();
  let global = 0;

  function addToCounters(scope: SpendScope, deltaUsd: number): void {
    const aKey = agentKeyOf(scope);
    perAgent.set(aKey, (perAgent.get(aKey) ?? 0) + deltaUsd);
    perTenant.set(scope.tenantId, (perTenant.get(scope.tenantId) ?? 0) + deltaUsd);
    global += deltaUsd;
  }

  /**
   * The breaching warn DIMENSION: the FIRST non-null ceiling — checked in
   * the SAME (tenant,agent) → tenant → global order as the breach check — whose
   * post-reserve fraction is at/above `warnAtFraction`, with that dimension's own
   * post-reserve total + cap. `null` when none crossed. A null/non-positive cap is
   * OFF (never warns).
   */
  function firstWarnDimension(
    agentPost: number,
    tenantPost: number,
    globalPost: number,
  ): SpendWarn | null {
    const crossed = (post: number, cap: number | null): boolean =>
      cap !== null && cap > 0 && post / cap >= ceilings.warnAtFraction;
    if (crossed(agentPost, ceilings.perAgentUsd)) {
      return { scope: "agent", totalUsd: agentPost, capUsd: ceilings.perAgentUsd as number };
    }
    if (crossed(tenantPost, ceilings.perTenantUsd)) {
      return { scope: "tenant", totalUsd: tenantPost, capUsd: ceilings.perTenantUsd as number };
    }
    if (crossed(globalPost, ceilings.daemonGlobalUsd)) {
      return { scope: "global", totalUsd: globalPost, capUsd: ceilings.daemonGlobalUsd as number };
    }
    return null;
  }

  return {
    rehydrate(rows): void {
      for (const row of rows) {
        addToCounters({ tenantId: row.tenantId, agentId: row.agentId }, row.costUsd);
      }
    },

    recordSpend(scope, actualUsd): void {
      addToCounters(scope, actualUsd);
    },

    checkAndReserve(scope, estUsd): Result<SpendReservation & { warn: SpendWarn | null }, SpendError> {
      // ── SYNCHRONOUS atomic body: NO `await` between the reads and the writes. ──
      const aKey = agentKeyOf(scope);
      const agentTotal = perAgent.get(aKey) ?? 0;
      const tenantTotal = perTenant.get(scope.tenantId) ?? 0;
      const globalTotal = global;

      // Check each non-null ceiling in (tenant,agent) → tenant → global order;
      // err on the FIRST breach WITHOUT mutating any counter.
      if (ceilings.perAgentUsd !== null && agentTotal + estUsd > ceilings.perAgentUsd) {
        return err(new SpendError("agent", agentTotal, ceilings.perAgentUsd, estUsd));
      }
      if (ceilings.perTenantUsd !== null && tenantTotal + estUsd > ceilings.perTenantUsd) {
        return err(new SpendError("tenant", tenantTotal, ceilings.perTenantUsd, estUsd));
      }
      if (ceilings.daemonGlobalUsd !== null && globalTotal + estUsd > ceilings.daemonGlobalUsd) {
        return err(new SpendError("global", globalTotal, ceilings.daemonGlobalUsd, estUsd));
      }

      // All ceilings pass → RESERVE: mutate all three counters BEFORE returning,
      // so the next event-loop-concurrent caller sees this reservation.
      addToCounters(scope, estUsd);

      // Report the breaching warn DIMENSION (scope + that dimension's own
      // post-reserve total + cap), not a bare boolean — the bridge emits a
      // scope-correct observability:spend_warning from it.
      const warn = firstWarnDimension(
        agentTotal + estUsd,
        tenantTotal + estUsd,
        globalTotal + estUsd,
      );

      return ok({ scopeKey: aKey, tenantKey: scope.tenantId, reservedUsd: estUsd, warn });
    },

    reconcile(reservation, actualUsd): void {
      const delta = actualUsd - reservation.reservedUsd;
      if (delta === 0) return;
      const aPrev = perAgent.get(reservation.scopeKey) ?? 0;
      perAgent.set(reservation.scopeKey, aPrev + delta);
      const tPrev = perTenant.get(reservation.tenantKey) ?? 0;
      perTenant.set(reservation.tenantKey, tPrev + delta);
      global += delta;
    },

    getSnapshot(): {
      perAgent: ReadonlyMap<string, number>;
      perTenant: ReadonlyMap<string, number>;
      global: number;
    } {
      // Fresh shallow copies (the simplest correct read-only view): a caller
      // mutating the returned maps cannot reach the closure's authoritative
      // counters. No mutation, no clock call, never throws (budget/ discipline).
      return {
        perAgent: new Map(perAgent),
        perTenant: new Map(perTenant),
        global,
      };
    },
  };
}
