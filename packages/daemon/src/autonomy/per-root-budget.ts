// SPDX-License-Identifier: Apache-2.0
/**
 * The per-`rootRunId` aggregate budget meter — the cost-bound limb of the
 * bounded-autonomy floor.
 *
 * A self-spawning loop is aborted on ANY of three limbs — $ / token / wall-clock —
 * keyed on the tree root (`rootRunId`), a DISTINCT scope from the daemon-wide
 * per-`(tenant,agent)` {@link SpendAccumulator}. The $-limb REUSES
 * the 3-state pricing gate {@link checkSpendCeiling} VERBATIM
 * (re-scoped to `{ tenantId: "_root", agentId: rootRunId }`), so the
 * fail-closed semantics are inherited, NOT re-implemented:
 *   - a local/gateway-`free` model → `{ kind: "free" }`, NEVER trips the $-cap
 *     (a local-first deployment is not falsely DoSed),
 *   - a native-provider `unknown`-priced model that burned tokens → `{ kind:
 *     "unpriceable" }` — the $-cap REFUSES, never a phantom $0,
 *   - a priced model → the atomic per-root $ reserve.
 *
 * The NET-NEW value over the base gate is the per-root scope plus TWO limbs
 * that enforce REGARDLESS of pricing — so a zero-price (subscription) native-
 * provider loop, where the $-cap can never bite, STILL trips:
 *   - a TOKEN limb: the per-root running token total vs `config.tokens`,
 *   - a per-root WALL-CLOCK deadline: `clock.now() - rootStartMs > config.wallClockMs`
 *     (the anchor is set at {@link PerRootBudget.registerRoot}, NOT per call —
 *     it bounds the whole tree's elapsed time).
 *
 * Discipline (the daemon arch gates): all time is the injected {@link ClockPort}
 * (NEVER `Date.now` — the `globals.test.ts` gate); the meter returns a
 * {@link SpendGateOutcome}, NEVER throwing (`raw-throw.test.ts` — the chokepoint
 * converts an `exceeded` outcome to a turn abort); content-free — it
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

/** The per-root budget surface (the composite `BoundedAutonomy` holds one). */
export interface PerRootBudget {
  /**
   * Register a tree root, anchoring its wall-clock deadline at `clock.now()`. Idempotent —
   * a re-registration of the same `rootRunId` keeps the original anchor (the elapsed
   * deadline measures from the FIRST registration, not the latest call).
   */
  registerRoot(rootRunId: string): void;
  /**
   * Evict a completed root's accounting: drop its wall-clock anchor and
   * running token total so a `for(;;) spawn()` / cron storm of distinct roots
   * does not grow these maps without bound. Idempotent — a no-op for an unknown
   * root, never throws. A later `registerRoot` of the same id starts fresh.
   *
   * NOTE: the per-root $-accumulator is a daemon-lifetime
   * {@link SpendAccumulator} with no per-scope eviction API; its per-root scope
   * map is NOT pruned here (evicting it would touch the shared spend
   * semantics). The token + wall-clock maps owned by THIS module — the two
   * unbounded vectors — are the ones evicted.
   */
  evictRoot(rootRunId: string): void;
  /**
   * Reserve budget for one LLM/web call against the tree root. Runs the wall-clock
   * and token limbs FIRST (they enforce regardless of pricing — the limbs that bite
   * a zero-price loop), then the $-limb via the existing 3-state gate. Returns a
   * {@link SpendGateOutcome}: `ok` (reserved) | `free` (local — never $-trips) |
   * `unpriceable` (native unknown-priced — the $-cap refuses) | `exceeded` (a limb
   * breached — the chokepoint aborts the turn).
   *
   * @param rootRunId the tree root the spend accrues to (scope `agentId`).
   * @param provider the LLM/web provider id (consumed by the 3-state pricing gate).
   * @param model the model id at the provider (consumed by the 3-state pricing gate).
   * @param estUsd the dollars this call accrues into the $-limb. The accumulator
   *   has NO separate actual-adder and nothing reconciles a reserve after the
   *   fact — whatever is passed here IS the root's recorded spend, so callers
   *   pass the actual billed cost when known (the bridge reserves post-record).
   *   A worst-case estimate here permanently consumes the ceiling.
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
  /**
   * The per-root remaining headroom on all three limbs — a PURE read (the source
   * the `capabilities.introspect`/`whoami` RPC reports). NO mutation:
   * it does NOT anchor a wall-clock window, advance the token total, or reserve $
   * (unlike {@link PerRootBudget.reserveBudget}); it reads `clock.now()` ONLY to
   * compute the live elapsed window.
   *
   *   - `tokensRemaining`   = `config.tokens - <accumulated tokens>` (≥ 0).
   *   - `wallClockMsRemaining` = `config.wallClockMs - (clock.now() - rootStartMs)`
   *     (≥ 0). An UNREGISTERED root has no anchor → the FULL allowance is reported
   *     and NO anchor is written (the read never starts the clock).
   *   - `usdRemaining` = `config.aggregateUsd - <priced spend>` from the SAME
   *     `perRootUsdAccumulator` the $-gate enforces against (a REAL
   *     number, so the read matches the gate). It is `number | null` on
   *     the type for the honest-degrade contract; the impl returns a real number.
   *     CAVEAT: the accumulator total reflects only PRICED spend — if a node hit
   *     an unpriceable model the $ figure is "priced-spend only", but the
   *     token/wall-clock limbs remain authoritative regardless.
   */
  remaining(rootRunId: string): {
    tokensRemaining: number;
    wallClockMsRemaining: number;
    usdRemaining: number | null;
  };
}

/**
 * Create the per-`rootRunId` budget meter. The $-cap is the resolved
 * `autonomy.budget.aggregateUsd`; the token cap is `autonomy.budget.tokens`; the
 * wall-clock deadline is `autonomy.budget.wallClockMs`.
 *
 * Constructs a SEPARATE {@link SpendAccumulator} keyed on `rootRunId` (via the
 * `{ tenantId: "_root", agentId: rootRunId }` scope) — it does NOT reuse the
 * daemon-wide accumulator instance (a DIFFERENT scope).
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
  // a granted reserve carries no warn — this meter has no bus wiring (the routing
  // layer acts only on the `exceeded` outcome).
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
  // bridge acts on the unpriceable outcome).
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
      // Drop the two unbounded maps this module owns. Bounded by the
      // semaphore's release-to-zero hook (the composite calls this then).
      rootStartMs.delete(rootRunId);
      tokenTotals.delete(rootRunId);
    },

    reserveBudget(rootRunId, provider, model, estUsd, estTokens): SpendGateOutcome {
      // ── Limb 1: WALL-CLOCK (enforced regardless of pricing). ──
      // Anchor: the root's registration time, or now() for an unregistered root.
      // PERSIST the anchor on the first reserve for an unknown
      // root, so the deadline measures from this FIRST call onward (matching the
      // documented "a call before registerRoot anchors here so the deadline still
      // bounds it" intent). Without the write, every call for an unregistered
      // root re-anchored at now() → elapsedMs stayed ~0 and the wall-clock limb
      // could NEVER fire (the token limb still gated, but the wall-clock backstop
      // was silently inert). This also covers a root re-used after eviction.
      let startMs = rootStartMs.get(rootRunId);
      if (startMs === undefined) {
        startMs = clock.now();
        rootStartMs.set(rootRunId, startMs);
      }
      const elapsedMs = clock.now() - startMs;
      if (elapsedMs > config.wallClockMs) {
        logger.warn(
          { rootRunId, elapsedMs, capMs: config.wallClockMs, errorKind: "resource" as const },
          "Per-root wall-clock budget exceeded",
        );
        // SpendError carries the limb's own (current, cap, est) in ms — scope
        // "agent" (the per-root agent-scope). The chokepoint routes on kind alone.
        return { kind: "exceeded", error: new SpendError("agent", elapsedMs, config.wallClockMs, 0, "wallClockMs", "ms") };
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
        return { kind: "exceeded", error: new SpendError("agent", priorTokens, config.tokens, estTokens, "tokens", "tokens") };
      }
      tokenTotals.set(rootRunId, nextTokens);

      // ── Limb 3: $ via the existing 3-state gate (free→never trips; unknown+burn→
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

    remaining(rootRunId): {
      tokensRemaining: number;
      wallClockMsRemaining: number;
      usdRemaining: number | null;
    } {
      // PURE read: NO rootStartMs.set, NO tokenTotals.set,
      // NO reserve. `clock.now()` is read ONLY to compute the live elapsed window.
      const usedTokens = tokenTotals.get(rootRunId) ?? 0;
      const startMs = rootStartMs.get(rootRunId);
      // An unregistered root has no anchor → 0 elapsed (full wall-clock allowance);
      // the read does NOT anchor a window (unlike reserveBudget's first-call write).
      const elapsedMs = startMs === undefined ? 0 : clock.now() - startMs;
      // The $ remaining is computed from the SAME per-root accumulator
      // the $-gate enforces against — `aggregateUsd` minus the per-root scope's
      // recorded (priced) spend. The scope key is `_root ${rootRunId}` (the
      // `${tenantId} ${agentId}` format `agentKeyOf` uses, tenantId "_root"). A
      // REAL number, so the read matches the gate.
      const usedUsd = perRootUsdAccumulator.getSnapshot().perAgent.get(`_root ${rootRunId}`) ?? 0;
      return {
        tokensRemaining: Math.max(0, config.tokens - usedTokens),
        wallClockMsRemaining: Math.max(0, config.wallClockMs - elapsedMs),
        usdRemaining: Math.max(0, config.aggregateUsd - usedUsd),
      };
    },
  };
}
