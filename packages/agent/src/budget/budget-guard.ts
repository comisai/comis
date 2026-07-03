// SPDX-License-Identifier: Apache-2.0
import type { BudgetConfig } from "@comis/core";
import { systemNowMs, resolvePricingState } from "@comis/core";
import { type Result, ok, err } from "@comis/shared";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type {
  SpendAccumulator,
  SpendScope,
  SpendReservation,
  SpendError,
  SpendWarn,
} from "./spend-accumulator.js";

/**
 * Budget enforcement error with diagnostic context.
 *
 * Thrown (as Result err) when an estimated LLM call would exceed
 * per-execution, per-hour, or per-day token caps.
 */
export class BudgetError extends Error {
  public readonly name = "BudgetError";

  constructor(
    public readonly scope: "per-execution" | "per-hour" | "per-day",
    public readonly currentUsage: number,
    public readonly cap: number,
    public readonly estimated: number,
  ) {
    super(
      `Budget exceeded (${scope}): current ${currentUsage} + estimated ${estimated} > cap ${cap}`,
    );
  }
}

/** Internal timestamped usage entry for rolling windows. */
interface WindowEntry {
  timestamp: number;
  tokens: number;
}

/**
 * Pre-commit budget guard that estimates cost BEFORE each LLM call
 * and rejects when caps would be exceeded.
 */
/** Snapshot of current budget usage for all three windows. */
export interface BudgetSnapshot {
  perExecution: number;
  perHour: number;
  perDay: number;
}

/**
 * Execution-local view of a budget guard returned by {@link BudgetGuard.resetExecution}.
 *
 * The per-execution dimension (the running `total` and the effective cap)
 * is owned by THIS handle, not by the shared per-agent guard. Two concurrent
 * executions of the same agentId therefore get two independent windows and can
 * never clobber each other's cap or accrued spend. The per-hour/per-day rolling
 * windows are delegated to the shared guard (they are correctly per-agent), so a
 * window's checkBudget still enforces the agent-wide hourly/daily caps.
 */
export interface ExecutionBudgetWindow {
  /** Estimate total tokens from context size and max output (delegates to the guard). */
  estimateCost(contextChars: number, maxOutputTokens: number): number;
  /**
   * Check if estimated tokens would exceed THIS execution's per-execution cap
   * or the SHARED per-hour/per-day caps. Per-execution uses this window's own
   * `total` + cap; the rolling windows read the shared per-agent entries.
   */
  checkBudget(estimatedTokens: number): Result<void, BudgetError>;
  /** Record actual token usage: accrues into THIS window's total AND the shared rolling windows. */
  recordUsage(tokens: number): void;
  /** Return current usage (this window's per-execution total + the shared hour/day windows). */
  getSnapshot(): BudgetSnapshot;
}

export interface BudgetGuard {
  /** Estimate total tokens from context size and max output. Delegates to SDK's estimateTokens() ratio for chars-to-token conversion. */
  estimateCost(contextChars: number, maxOutputTokens: number): number;
  /** Check if estimated tokens would exceed any budget cap. */
  checkBudget(estimatedTokens: number): Result<void, BudgetError>;
  /** Record actual token usage after an LLM call completes. */
  recordUsage(tokens: number): void;
  /**
   * Reset the per-execution window and set an OPTIONAL per-execution effective
   * cap for THIS run (called at the start of every execution). Returns an
   * execution-local {@link ExecutionBudgetWindow} that OWNS this run's running
   * total + effective cap — the caller threads it into checkBudget/recordUsage
   * so concurrent executions of the same agent never share the per-execution
   * dimension. checkBudget enforces min(config.perExecution, cap): a
   * child can only TIGHTEN, never RAISE, its per-execution budget.
   *
   * Calling resetExecution also re-points the guard's OWN checkBudget/recordUsage/
   * getSnapshot at the freshly-created window, preserving the legacy single-execution
   * call shape for callers that have not been threaded the handle.
   */
  resetExecution(cap?: number): ExecutionBudgetWindow;
  /** Return current usage across all three budget windows. */
  getSnapshot(): BudgetSnapshot;
}

/**
 * Derive the SDK's chars-per-token ratio by probing estimateTokens() once.
 * This ensures the budget guard always uses the same heuristic as compaction,
 * without maintaining a local constant that could diverge.
 *
 * The `as any` is needed because the budget-guard module does not import
 * `UserMessage` from `@earendil-works/pi-ai` and the object literal satisfies
 * the runtime shape expected by estimateTokens().
 */
const SDK_PROBE_CHARS = 400;
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK expects UserMessage; literal satisfies runtime shape */
const SDK_PROBE_TOKENS = estimateTokens({
  role: "user",
  content: "a".repeat(SDK_PROBE_CHARS),
  timestamp: 0,
} as any);
/* eslint-enable @typescript-eslint/no-explicit-any */
const SDK_CHARS_PER_TOKEN = SDK_PROBE_CHARS / SDK_PROBE_TOKENS; // Expected: 4

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Create a budget guard bound to the given config caps.
 *
 * Uses rolling windows for per-hour and per-day enforcement.
 * Entries are pruned lazily on each checkBudget call.
 */
export function createBudgetGuard(
  config: BudgetConfig,
  logger?: { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): BudgetGuard {
  // SHARED per-agent state: the rolling per-hour/per-day windows and the
  // last-estimate latch. These legitimately stay shared across every execution
  // of this agent (only the per-EXECUTION dimension must be local).
  let lastEstimate = 0;
  const entries: WindowEntry[] = [];

  function prune(): void {
    const now = systemNowMs();
    const dayAgo = now - ONE_DAY_MS;
    // Remove entries older than 1 day (superset of 1 hour)
    let i = 0;
    while (i < entries.length && entries[i].timestamp < dayAgo) {
      i++;
    }
    if (i > 0) {
      entries.splice(0, i);
    }
  }

  function sumWindow(windowMs: number): number {
    const cutoff = systemNowMs() - windowMs;
    let total = 0;
    for (const entry of entries) {
      if (entry.timestamp >= cutoff) {
        total += entry.tokens;
      }
    }
    return total;
  }

  function estimateCost(contextChars: number, maxOutputTokens: number): number {
    const inputTokens = Math.ceil(contextChars / SDK_CHARS_PER_TOKEN);
    const totalEstimate = inputTokens + maxOutputTokens;
    lastEstimate = totalEstimate;
    logger?.debug({ contextChars, inputTokens, maxOutputTokens, totalEstimate }, "Pre-execution cost estimate");
    return totalEstimate;
  }

  /**
   * Create an execution-local window. `executionTotal` and
   * `effectiveExecutionCap` are closed over by THIS window only — never shared
   * across concurrent executions — while the rolling-window reads/writes
   * (`entries`/`sumWindow`) and the estimate latch stay on the shared guard.
   */
  function createWindow(cap?: number): ExecutionBudgetWindow {
    // Per-execution running total — local to this window (NOT the shared guard).
    let executionTotal = 0;
    // Per-execution effective cap for THIS run; undefined ⇒ enforce
    // config.perExecution (byte-identical to the no-budget path).
    const effectiveExecutionCap = cap;

    return {
      estimateCost,

      checkBudget(estimatedTokens: number): Result<void, BudgetError> {
        prune();

        // Check per-execution first against THIS window's own total + cap. A
        // per-spawn effective cap can only TIGHTEN the budget — min() means a
        // child never raises its ceiling above the agent's config.perExecution.
        const execCap =
          effectiveExecutionCap === undefined
            ? config.perExecution
            : Math.min(config.perExecution, effectiveExecutionCap);
        if (executionTotal + estimatedTokens > execCap) {
          return err(new BudgetError("per-execution", executionTotal, execCap, estimatedTokens));
        }

        // Check per-hour (SHARED per-agent window)
        const hourlyUsage = sumWindow(ONE_HOUR_MS);
        if (hourlyUsage + estimatedTokens > config.perHour) {
          return err(new BudgetError("per-hour", hourlyUsage, config.perHour, estimatedTokens));
        }

        // Check per-day (SHARED per-agent window)
        const dailyUsage = sumWindow(ONE_DAY_MS);
        if (dailyUsage + estimatedTokens > config.perDay) {
          return err(new BudgetError("per-day", dailyUsage, config.perDay, estimatedTokens));
        }

        return ok(undefined);
      },

      recordUsage(tokens: number): void {
        // Accrue into THIS window's per-execution total AND the shared rolling windows.
        executionTotal += tokens;
        entries.push({ timestamp: systemNowMs(), tokens });

        // Detect large discrepancy between estimated and actual token usage
        if (lastEstimate > 0 && Math.abs(tokens - lastEstimate) / lastEstimate > 0.5) {
          logger?.warn(
            {
              estimated: lastEstimate,
              actual: tokens,
              ratio: (tokens / lastEstimate).toFixed(2),
              hint: "Token estimate diverged significantly from actual API usage; budget may over/under-protect",
              errorKind: "validation" as const,
            },
            "Token estimate vs actual discrepancy",
          );
        }
        lastEstimate = 0;
      },

      getSnapshot(): BudgetSnapshot {
        prune();
        return {
          perExecution: executionTotal,
          perHour: sumWindow(ONE_HOUR_MS),
          perDay: sumWindow(ONE_DAY_MS),
        };
      },
    };
  }

  // Legacy single-execution window: backs the guard's OWN checkBudget/
  // recordUsage/getSnapshot for callers that have not been threaded an explicit
  // window handle. resetExecution re-points this at a fresh window.
  let currentWindow: ExecutionBudgetWindow = createWindow();

  return {
    estimateCost,

    checkBudget(estimatedTokens: number): Result<void, BudgetError> {
      return currentWindow.checkBudget(estimatedTokens);
    },

    recordUsage(tokens: number): void {
      currentWindow.recordUsage(tokens);
    },

    resetExecution(cap?: number): ExecutionBudgetWindow {
      // A FRESH execution-local window each reset. The returned handle
      // is what concurrent callers thread through checkBudget/recordUsage so
      // they never share the per-execution total/cap. The guard's own legacy
      // methods follow the most-recent window (sequential-caller compatibility).
      currentWindow = createWindow(cap);
      return currentWindow;
    },

    getSnapshot(): BudgetSnapshot {
      return currentWindow.getSnapshot();
    },
  };
}

// ---------------------------------------------------------------------------
// Spend ceiling gate — the dollars kill-switch enforcement READ
// ---------------------------------------------------------------------------

/**
 * The outcome of the 3-state pricing gate + the atomic accumulator reserve. It is
 * the discriminated result the bridge routes on:
 *  - `ok`          — a reservation was granted (carries the `warn` DIMENSION —
 *                    the breaching scope + its total/cap, or `null` — so the
 *                    bridge emits a scope-correct `observability:spend_warning`).
 *  - `free`        — a local/gateway-`free` model: NEVER trips a ceiling
 *                    (no false-DoS of local-first deployments).
 *  - `unpriceable` — a native-provider `unknown`-priced model that burned tokens
 *                    (real spend with no price to meter it): the bridge ALWAYS emits
 *                    `observability:spend_unpriceable` (fail LOUD); whether it
 *                    aborts is gated on `onUnknownPricing`+`action` at the bridge.
 *  - `exceeded`    — a ceiling breach: the bridge routes it through the single
 *                    `execution:aborted{reason:"spend_exceeded"}` path.
 */
export type SpendGateOutcome =
  | { kind: "ok"; reservation: SpendReservation; warn: SpendWarn | null }
  | { kind: "free" }
  | { kind: "unpriceable"; provider: string; model: string }
  | { kind: "exceeded"; error: SpendError };

/** Spend-gate config slice (a subset of `observability.spend`). */
export interface SpendGateConfig {
  /** Behaviour when a native provider's price is unknown while it burns tokens. */
  onUnknownPricing: "warn" | "abort";
  /** The pricing fallback strategy on a transient resolve failure (snapshot only today). */
  pricingFallback: "snapshot";
}

/**
 * The 3-state pricing gate + the atomic per-(tenant,agent)/tenant/global ceiling
 * reserve — the dollars kill-switch's enforcement READ. It lives in the enforcer
 * module (NOT the pure recorder `cost-tracker.ts` — recorder ≠ enforcer).
 *
 * Discipline (the `budget/` arch gates): returns {@link Result}, never raises
 * (the raw-throw gate); reads no wall clock (the accumulator owns time via its
 * injected ClockPort — the globals gate); consumes the SHIPPED 3-state
 * {@link resolvePricingState} directly, never a catalog-presence boolean (which
 * fails both directions — a local-free model has no entry yet is NOT unknown, and
 * a $0-cost catalog entry IS present yet is not priced).
 *
 * Fail-safe, never fail-open: a transient pricing-resolve throw falls back to the
 * snapshot path (treat as priced) and STILL enforces the ceiling — it neither
 * aborts on the transient itself nor treats it as "no limit".
 *
 * @param resolvePricingStateOverride - optional pricing-state resolver; when
 *   omitted the body consumes the shipped {@link resolvePricingState} directly.
 *   Injectable so the snapshot-fallback fail-safe path is unit-testable with a
 *   throwing resolver (no module mock).
 */
export function checkSpendCeiling(
  accumulator: SpendAccumulator,
  scope: SpendScope,
  provider: string,
  model: string,
  estUsd: number,
  config: SpendGateConfig,
  burnedTokens: boolean,
  resolvePricingStateOverride?: (
    provider: string,
    model: string,
  ) => "priced" | "free" | "unknown",
): Result<SpendGateOutcome, SpendError> {
  // 1. Resolve the 3-state pricing, defensively. A thrown/errored resolve is the
  //    transient case: fall through to the snapshot path (treat as priced) — do
  //    NOT fail open (never "no limit"), do NOT abort on the transient itself.
  //    resolveModelPricing is a pure in-process lookup, so this is a guard; the
  //    fail-safe behaviour is proven by injecting a throwing resolver.
  let state: "priced" | "free" | "unknown";
  try {
    state =
      resolvePricingStateOverride !== undefined
        ? resolvePricingStateOverride(provider, model)
        : resolvePricingState(provider, model);
  } catch {
    // pricingFallback === "snapshot": the dated snapshot rate is treated as
    // priced — proceed to the atomic reserve below (fail-SAFE).
    state = "priced";
  }

  // 2. Local/gateway-free → honest $0, NEVER trips a ceiling. Skip the reserve
  //    entirely so a local-first deployment can never be falsely DoSed.
  if (state === "free") return ok({ kind: "free" });

  // 3. Native-provider unknown + actually burned tokens → real spend that no
  //    ceiling can meter.
  //    Surface the unpriceable signal ALWAYS (fail LOUD — the bridge emits
  //    observability:spend_unpriceable regardless of action); the bridge gates
  //    the abort on onUnknownPricing+action. NOT fail-open: we surface, we do
  //    not silently pass a phantom $0.
  if (state === "unknown" && burnedTokens) {
    return ok({ kind: "unpriceable", provider, model });
  }

  // 4. Priced (or unknown-under-no-burn, or the snapshot fallback) → the atomic
  //    per-(tenant,agent)→tenant→global reserve. The accumulator owns the
  //    headroom check + the synchronous reserve; a breach is surfaced as an
  //    `exceeded` outcome (Result-returning — the bridge decides the abort).
  const r = accumulator.checkAndReserve(scope, estUsd);
  return r.ok
    ? ok({ kind: "ok", reservation: r.value, warn: r.value.warn })
    : ok({ kind: "exceeded", error: r.error });
}
