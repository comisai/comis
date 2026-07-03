// SPDX-License-Identifier: Apache-2.0
/**
 * Per-tenant summarizer spend cap + circuit breaker.
 *
 * Wraps the injected {@link LeafSummarizer} seam with (a) a per-tenant circuit
 * breaker and (b) a per-tenant rolling-window token-spend tracker. When the
 * tenant's breaker is open OR the tenant is over its token cap, the wrapper
 * BYPASSES the inner LLM call by THROWING the degrade signal — the leaf/condense
 * ladder already catches a throw from `summarize(...)` and falls through to the
 * deterministic Level-3 floor (truncation-only assembly), so the turn proceeds
 * with no crash and no hang. It NEVER retries the inner call when the breaker is
 * open (a retry would defeat the breaker). On a successful inner call it records
 * success + actual token usage; on a thrown inner call it records a failure.
 *
 * `safety/` is a sanctioned raw-throw boundary (`raw-throw.test.ts` exempts
 * `packages/*\/src/safety/`), so the degrade throw needs no `@allow-throw`.
 *
 * Per-TENANT by construction: one tenant's failures or
 * spend can never open another tenant's breaker or consume another tenant's
 * window — both are keyed in `Map<tenantId, …>` and lazily created per tenant.
 *
 * Pure mechanism: NO logging, NO infra import, NO message/summary content — it
 * operates on token COUNTS/estimates only. Observability (breaker-trip WARN +
 * eventBus) is added at the wiring site, where the injected logger lives.
 * All time comes from the injected {@link ClockPort} (no raw clock/timer globals —
 * the globals gate).
 *
 * @module
 */
import type { CircuitBreakerConfig, ClockPort } from "@comis/core";
import type {
  LeafSummarizer,
  LeafSummarizeOptions,
} from "../context-engine/lcd-leaf-summarizer.js";
import { createCircuitBreaker, type CircuitBreaker } from "./circuit-breaker.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Per-tenant rolling-window token ceilings. A cap of `0` DISABLES that window. */
export interface SummarizerSpendConfig {
  /** Max summarizer tokens per tenant in a rolling hour. `0` disables the hour window. */
  maxTokensPerTenantPerHour: number;
  /** Max summarizer tokens per tenant in a rolling day. `0` disables the day window. */
  maxTokensPerTenantPerDay: number;
}

/** Dependencies for {@link createSummarizerSpendBreaker}. */
export interface SummarizerSpendBreakerDeps {
  /** Reused per tenant — the embedding-resilience breaker primitive. */
  breakerConfig: CircuitBreakerConfig;
  /** Per-tenant rolling token ceilings. */
  spendConfig: SummarizerSpendConfig;
  /** Injected clock — drives the breaker timers AND the rolling spend windows. */
  clock: ClockPort;
  /** Estimate INPUT tokens for a summarizer call (production: `estimateMessageTokens` sum). */
  estimateInputTokens: (messages: Parameters<LeafSummarizer>[0], opts: LeafSummarizeOptions) => number;
  /** Estimate OUTPUT tokens for the produced summary string. */
  estimateOutputTokens: (out: string) => number;
}

/** The spend-breaker gate factory return shape. */
export interface SummarizerSpendBreaker {
  /**
   * Wrap an inner {@link LeafSummarizer} with the given tenant's breaker + spend
   * gate. Returns a `LeafSummarizer` that bypasses (throws) on open-breaker or
   * over-cap, otherwise calls `inner` and records success/usage/failure.
   */
  gate(tenantId: string, inner: LeafSummarizer): LeafSummarizer;
}

/** Closed reason for a degrade BYPASS — maps 1:1 onto the `context:dag_degraded`
 *  reserved reasons so the wiring can emit the right event/errorKind. */
export type SummarizerDegradeReason = "breaker_open" | "spend_cap";

/**
 * The discriminated error the gate THROWS when it bypasses the inner LLM call
 * (open breaker / over-cap). Carries the closed {@link SummarizerDegradeReason}
 * so the wiring boundary can classify the WARN (`errorKind` dependency vs
 * resource) + the `context:dag_degraded` reason WITHOUT string-parsing. The
 * leaf/condense ladder catches it like any other throw and floors. Content-free.
 */
export class SummarizerDegradeError extends Error {
  readonly degradeReason: SummarizerDegradeReason;
  constructor(degradeReason: SummarizerDegradeReason) {
    super(`summarizer degraded (${degradeReason})`);
    this.name = "SummarizerDegradeError";
    this.degradeReason = degradeReason;
  }
}

/** Narrow an unknown caught value to a {@link SummarizerDegradeError} (the gate's
 *  bypass) — distinguishes a degrade BYPASS from an inner-call failure at the
 *  wiring boundary. */
export function isSummarizerDegradeError(e: unknown): e is SummarizerDegradeError {
  return e instanceof SummarizerDegradeError;
}

/** Internal timestamped usage entry for a tenant's rolling windows. */
interface SpendEntry {
  timestamp: number;
  tokens: number;
}

/** Per-tenant rolling-window token tracker. */
interface TenantSpend {
  /** Would adding `estTokens` keep BOTH the hour and day windows within cap? */
  canSpend(estTokens: number): boolean;
  /** Record `actualTokens` of usage at the current clock time. */
  record(actualTokens: number): void;
}

/**
 * Create a per-tenant summarizer spend cap + circuit breaker.
 *
 * The breaker is `createCircuitBreaker(deps.breakerConfig, deps.clock)` per tenant
 * (reuses the state machine verbatim; does not reimplement it). The spend tracker
 * replicates the budget-guard rolling-window math, but keyed on the injected clock
 * and scoped PER TENANT (not per-execution).
 */
export function createSummarizerSpendBreaker(
  deps: SummarizerSpendBreakerDeps,
): SummarizerSpendBreaker {
  const { breakerConfig, spendConfig, clock, estimateInputTokens, estimateOutputTokens } = deps;

  const breakers = new Map<string, CircuitBreaker>();
  const trackers = new Map<string, TenantSpend>();

  function breakerFor(tenantId: string): CircuitBreaker {
    let breaker = breakers.get(tenantId);
    if (!breaker) {
      breaker = createCircuitBreaker(breakerConfig, clock);
      breakers.set(tenantId, breaker);
    }
    return breaker;
  }

  function spendFor(tenantId: string): TenantSpend {
    let tracker = trackers.get(tenantId);
    if (!tracker) {
      tracker = createTenantSpend(spendConfig, clock);
      trackers.set(tenantId, tracker);
    }
    return tracker;
  }

  return {
    gate(tenantId: string, inner: LeafSummarizer): LeafSummarizer {
      return async (messages, opts): Promise<string> => {
        const breaker = breakerFor(tenantId);
        const spend = spendFor(tenantId);
        const est = estimateInputTokens(messages, opts);

        if (breaker.isOpen()) {
          // DEGRADE (breaker open): throw → leaf/condense ladder catches →
          // deterministic L3 floor → truncation-only. No retry of inner
          // (a retry would defeat the breaker); inner is NOT called. The breaker is checked FIRST so an
          // open breaker is reported as breaker_open even when also over-cap.
          throw new SummarizerDegradeError("breaker_open");
        }
        if (!spend.canSpend(est)) {
          // DEGRADE (over per-tenant token cap): same bypass → floor.
          throw new SummarizerDegradeError("spend_cap");
        }

        try {
          const out = await inner(messages, opts);
          breaker.recordSuccess();
          spend.record(est + estimateOutputTokens(out));
          return out;
        } catch (e) {
          breaker.recordFailure();
          throw e; // ladder catches → floor
        }
      };
    },
  };
}

/**
 * Per-tenant rolling-window token tracker. Replicates the budget-guard windowing
 * (prune-on-read, sum-over-window) but keyed on the injected `clock` so tests are
 * deterministic, and scoped to ONE tenant. A cap of `0` disables that window.
 */
function createTenantSpend(config: SummarizerSpendConfig, clock: ClockPort): TenantSpend {
  const entries: SpendEntry[] = [];

  function prune(): void {
    // Drop entries older than the longest tracked window (1 day ⊇ 1 hour).
    const dayAgo = clock.now() - ONE_DAY_MS;
    let i = 0;
    while (i < entries.length && entries[i].timestamp < dayAgo) {
      i++;
    }
    if (i > 0) {
      entries.splice(0, i);
    }
  }

  function sumWindow(windowMs: number): number {
    const cutoff = clock.now() - windowMs;
    let total = 0;
    for (const entry of entries) {
      if (entry.timestamp >= cutoff) {
        total += entry.tokens;
      }
    }
    return total;
  }

  return {
    canSpend(estTokens: number): boolean {
      prune();
      if (config.maxTokensPerTenantPerHour > 0) {
        if (sumWindow(ONE_HOUR_MS) + estTokens > config.maxTokensPerTenantPerHour) {
          return false;
        }
      }
      if (config.maxTokensPerTenantPerDay > 0) {
        if (sumWindow(ONE_DAY_MS) + estTokens > config.maxTokensPerTenantPerDay) {
          return false;
        }
      }
      return true;
    },

    record(actualTokens: number): void {
      entries.push({ timestamp: clock.now(), tokens: actualTokens });
    },
  };
}
