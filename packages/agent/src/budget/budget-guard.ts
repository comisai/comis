import type { BudgetConfig } from "@comis/core";
import { type Result, ok, err } from "@comis/shared";
import { estimateTokens } from "@mariozechner/pi-coding-agent";

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

export interface BudgetGuard {
  /** Estimate total tokens from context size and max output. Delegates to SDK's estimateTokens() ratio for chars-to-token conversion. */
  estimateCost(contextChars: number, maxOutputTokens: number): number;
  /** Check if estimated tokens would exceed any budget cap. */
  checkBudget(estimatedTokens: number): Result<void, BudgetError>;
  /** Record actual token usage after an LLM call completes. */
  recordUsage(tokens: number): void;
  /** Reset per-execution counter (called at start of new execution). */
  resetExecution(): void;
  /** Return current usage across all three budget windows. */
  getSnapshot(): BudgetSnapshot;
}

/**
 * Derive the SDK's chars-per-token ratio by probing estimateTokens() once.
 * This ensures the budget guard always uses the same heuristic as compaction,
 * without maintaining a local constant that could diverge.
 *
 * The `as any` is needed because the budget-guard module does not import
 * `UserMessage` from `@mariozechner/pi-ai` and the object literal satisfies
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
  let executionTotal = 0;
  let lastEstimate = 0;
  const entries: WindowEntry[] = [];

  function prune(): void {
    const now = Date.now();
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
    const cutoff = Date.now() - windowMs;
    let total = 0;
    for (const entry of entries) {
      if (entry.timestamp >= cutoff) {
        total += entry.tokens;
      }
    }
    return total;
  }

  return {
    estimateCost(contextChars: number, maxOutputTokens: number): number {
      const inputTokens = Math.ceil(contextChars / SDK_CHARS_PER_TOKEN);
      const totalEstimate = inputTokens + maxOutputTokens;
      lastEstimate = totalEstimate;
      logger?.debug({ contextChars, inputTokens, maxOutputTokens, totalEstimate }, "Pre-execution cost estimate");
      return totalEstimate;
    },

    checkBudget(estimatedTokens: number): Result<void, BudgetError> {
      prune();

      // Check per-execution first
      if (executionTotal + estimatedTokens > config.perExecution) {
        return err(
          new BudgetError("per-execution", executionTotal, config.perExecution, estimatedTokens),
        );
      }

      // Check per-hour
      const hourlyUsage = sumWindow(ONE_HOUR_MS);
      if (hourlyUsage + estimatedTokens > config.perHour) {
        return err(new BudgetError("per-hour", hourlyUsage, config.perHour, estimatedTokens));
      }

      // Check per-day
      const dailyUsage = sumWindow(ONE_DAY_MS);
      if (dailyUsage + estimatedTokens > config.perDay) {
        return err(new BudgetError("per-day", dailyUsage, config.perDay, estimatedTokens));
      }

      return ok(undefined);
    },

    recordUsage(tokens: number): void {
      executionTotal += tokens;
      entries.push({ timestamp: Date.now(), tokens });

      // Detect large discrepancy between estimated and actual token usage
      if (lastEstimate > 0 && Math.abs(tokens - lastEstimate) / lastEstimate > 0.5) {
        logger?.warn(
          {
            estimated: lastEstimate,
            actual: tokens,
            ratio: (tokens / lastEstimate).toFixed(2),
            hint: "Token estimate diverged significantly from actual API usage; budget may over/under-protect",
            errorKind: "validation",
          },
          "Token estimate vs actual discrepancy",
        );
      }
      lastEstimate = 0;
    },

    resetExecution(): void {
      executionTotal = 0;
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
