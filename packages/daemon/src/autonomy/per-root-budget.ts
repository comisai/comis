// SPDX-License-Identifier: Apache-2.0
/**
 * The per-`rootRunId` aggregate budget meter (Phase 213-04, BUDGET-01/02/03) —
 * the cost-bound limb of the bounded-autonomy floor.
 *
 * A self-spawning loop is aborted on ANY of three limbs — $ / token / wall-clock —
 * keyed on the tree root (`rootRunId`), a DISTINCT scope from the daemon-wide
 * per-`(tenant,agent)` {@link SpendAccumulator} (RESEARCH §C). The $-limb REUSES
 * the shipped v2.28 3-state pricing gate {@link checkSpendCeiling} VERBATIM
 * (re-scoped to `{ tenantId: "_root", agentId: rootRunId }`), so the ffe11736
 * fail-closed semantics are inherited, NOT re-implemented:
 *   - a local/gateway-`free` model → `{ kind: "free" }`, NEVER trips the $-cap
 *     (a local-first deployment is not falsely DoSed),
 *   - a native-provider `unknown`-priced model that burned tokens → `{ kind:
 *     "unpriceable" }` — the $-cap REFUSES (BUDGET-03), never a phantom $0,
 *   - a priced model → the atomic per-root $ reserve.
 *
 * The NET-NEW value over the shipped gate is the per-root scope plus TWO limbs
 * that enforce REGARDLESS of pricing — so a zero-price (subscription/Codex)
 * native-provider loop, where the $-cap can never bite, STILL trips (BUDGET-02):
 *   - a TOKEN limb: the per-root running token total vs `config.tokens`,
 *   - a per-root WALL-CLOCK deadline: `clock.now() - rootStartMs > config.wallClockMs`
 *     (the anchor is set at {@link PerRootBudget.registerRoot}, NOT per call —
 *     it bounds the whole tree's elapsed time, RESEARCH Pitfall 4).
 *
 * Discipline (the daemon arch gates): all time is the injected {@link ClockPort}
 * (NEVER `Date.now` — the `globals.test.ts` gate); the meter returns a
 * {@link SpendGateOutcome}, NEVER throwing (`raw-throw.test.ts` — the chokepoint
 * converts an `exceeded` outcome to a turn abort in Plan 08); content-free — it
 * operates on token/dollar COUNTS keyed by an opaque `rootRunId` only.
 *
 * @module
 */
import type { ClockPort, ComisLogger } from "@comis/core";
import {
  checkSpendCeiling,
  createSpendAccumulator,
  SpendError,
  type SpendAccumulator,
  type SpendGateConfig,
  type SpendGateOutcome,
} from "@comis/agent";

/** The per-root budget surface (the composite `BoundedAutonomy` holds one — Plan 06). */
export interface PerRootBudget {
  /**
   * Register a tree root, anchoring its wall-clock deadline at `clock.now()`. Idempotent —
   * a re-registration of the same `rootRunId` keeps the original anchor (the elapsed
   * deadline measures from the FIRST registration, not the latest call).
   */
  registerRoot(rootRunId: string): void;
  /**
   * Evict a completed root's accounting (WR-05): drop its wall-clock anchor and
   * running token total so a `for(;;) spawn()` / cron storm of distinct roots
   * does not grow these maps without bound. Idempotent — a no-op for an unknown
   * root, never throws. A later `registerRoot` of the same id starts fresh.
   *
   * NOTE: the per-root $-accumulator is a shipped daemon-lifetime
   * {@link SpendAccumulator} with no per-scope eviction API; its per-root scope
   * map is NOT pruned here (evicting it would touch shipped v2.28 spend
   * semantics). The token + wall-clock maps owned by THIS module — the two
   * unbounded vectors 213-REVIEW WR-05 names — are the ones evicted.
   */
  evictRoot(rootRunId: string): void;
  /**
   * Reserve budget for one LLM/web call against the tree root. Runs the wall-clock
   * and token limbs FIRST (they enforce regardless of pricing — the limbs that bite
   * a zero-price loop), then the $-limb via the SHIPPED 3-state gate. Returns a
   * {@link SpendGateOutcome}: `ok` (reserved) | `free` (local — never $-trips) |
   * `unpriceable` (native unknown-priced — the $-cap refuses) | `exceeded` (a limb
   * breached — the chokepoint aborts the turn).
   *
   * @param rootRunId the tree root the spend accrues to (scope `agentId`).
   * @param provider the LLM/web provider id (consumed by the 3-state pricing gate).
   * @param model the model id at the provider (consumed by the 3-state pricing gate).
   * @param estUsd the conservative estimated dollars for this call (the $-limb).
   * @param estTokens the estimated tokens for this call (the token limb + the
   *   `burnedTokens` discriminator the 3-state gate reads).
   */
  reserveBudget(
    rootRunId: string,
    provider: string,
    model: string,
    estUsd: number,
    estTokens: number,
  ): SpendGateOutcome;
}

/**
 * Create the per-`rootRunId` budget meter. The $-cap is the resolved
 * `autonomy.budget.aggregateUsd`; the token cap is `autonomy.budget.tokens`; the
 * wall-clock deadline is `autonomy.budget.wallClockMs`.
 *
 * Constructs a SEPARATE {@link SpendAccumulator} keyed on `rootRunId` (via the
 * `{ tenantId: "_root", agentId: rootRunId }` scope) — it does NOT reuse the
 * daemon-wide accumulator instance (a DIFFERENT scope; RESEARCH §C scope gap).
 * Only the per-(tenant,agent) dimension is active (the per-root $-cap); the tenant
 * + daemon-global dimensions are off (`null`) here — the daemon-wide accumulator
 * owns those.
 */
export function createPerRootBudget(deps: {
  clock: ClockPort;
  config: { aggregateUsd: number; tokens: number; wallClockMs: number };
  logger: ComisLogger;
}): PerRootBudget {
  const { clock, config } = deps;
  const logger = deps.logger.child({ submodule: "per-root-budget" });

  // Per-root wall-clock anchors + token running totals.
  const rootStartMs = new Map<string, number>();
  const tokenTotals = new Map<string, number>();

  // A SEPARATE per-root $ accumulator — the per-(tenant,agent) dimension is the
  // per-root $-cap (scope agentId=rootRunId); tenant/global are off (the
  // daemon-wide accumulator owns those). warnAtFraction is set at the cap (1) so
  // a granted reserve carries no warn — this meter has no bus wiring (Plan 08
  // routes only the `exceeded` outcome).
  const perRootUsdAccumulator: SpendAccumulator = createSpendAccumulator({
    clock,
    ceilings: {
      perAgentUsd: config.aggregateUsd,
      perTenantUsd: null,
      daemonGlobalUsd: null,
      warnAtFraction: 1,
    },
  });

  // The 3-state gate's config: a transient pricing-resolve throw falls back to the
  // snapshot (treat as priced) and STILL enforces — never fail-open. onUnknownPricing
  // is "abort" so the unknown-priced surface is treated as the danger it is (the
  // bridge in Plan 08 acts on the unpriceable outcome).
  const spendCfg: SpendGateConfig = {
    onUnknownPricing: "abort",
    pricingFallback: "snapshot",
  };

  return {
    registerRoot(rootRunId): void {
      if (!rootStartMs.has(rootRunId)) {
        rootStartMs.set(rootRunId, clock.now());
      }
    },

    evictRoot(rootRunId): void {
      // WR-05: drop the two unbounded maps this module owns. Bounded by the
      // semaphore's release-to-zero hook (the composite calls this then).
      rootStartMs.delete(rootRunId);
      tokenTotals.delete(rootRunId);
    },

    reserveBudget(rootRunId, provider, model, estUsd, estTokens): SpendGateOutcome {
      // ── Limb 1: WALL-CLOCK (enforced regardless of pricing). ──
      // Anchor: the root's registration time, or now() for an unregistered root
      // (a call before registerRoot anchors here so the deadline still bounds it).
      const startMs = rootStartMs.get(rootRunId) ?? clock.now();
      const elapsedMs = clock.now() - startMs;
      if (elapsedMs > config.wallClockMs) {
        logger.warn(
          { rootRunId, elapsedMs, capMs: config.wallClockMs, errorKind: "resource" as const },
          "Per-root wall-clock budget exceeded",
        );
        // SpendError carries the limb's own (current, cap, est) in ms — scope
        // "agent" (the per-root agent-scope). The chokepoint routes on kind alone.
        return { kind: "exceeded", error: new SpendError("agent", elapsedMs, config.wallClockMs, 0) };
      }

      // ── Limb 2: TOKEN (enforced regardless of pricing — bites a zero-price loop). ──
      const priorTokens = tokenTotals.get(rootRunId) ?? 0;
      const nextTokens = priorTokens + estTokens;
      if (nextTokens > config.tokens) {
        logger.warn(
          { rootRunId, tokenTotal: priorTokens, capTokens: config.tokens, errorKind: "resource" as const },
          "Per-root token budget exceeded",
        );
        // Do NOT mutate the token total on a breach (no overshoot accrual).
        return { kind: "exceeded", error: new SpendError("agent", priorTokens, config.tokens, estTokens) };
      }
      tokenTotals.set(rootRunId, nextTokens);

      // ── Limb 3: $ via the SHIPPED 3-state gate (free→never trips; unknown+burn→
      // unpriceable/refuse; priced→atomic per-root reserve). burnedTokens = the
      // call actually consumed tokens. ──
      const r = checkSpendCeiling(
        perRootUsdAccumulator,
        { tenantId: "_root", agentId: rootRunId },
        provider,
        model,
        estUsd,
        spendCfg,
        /* burnedTokens */ estTokens > 0,
      );
      // checkSpendCeiling returns ok(...) on every branch (the breach is an
      // `exceeded` outcome, not an err); the Result err arm is defensive.
      return r.ok ? r.value : { kind: "exceeded", error: r.error };
    },
  };
}
