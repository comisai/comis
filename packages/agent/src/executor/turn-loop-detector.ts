// SPDX-License-Identifier: Apache-2.0
/**
 * Per-execution turn-loop detector (FIX #2 — the durable platform guard).
 *
 * Root-cause incident: a model issued ~150 identical reads of the same four
 * already-inlined workspace files in one turn, hit maxSteps, and aborted. This
 * detector bounds that programmatically, at the source:
 *
 *   - An identical IDEMPOTENT read within the turn is short-circuited to its
 *     cached result + a one-line steer (the model sees "you already ran this;
 *     answer or take a new action") — it never re-executes the read.
 *   - Six consecutive no-progress steps break the turn early (loop_detected),
 *     well before maxSteps, so a runaway loop cannot burn the whole budget.
 *   - Consecutive content-less ("empty") turns are capped.
 *
 * Safety: caching is an explicit ALLOWLIST of idempotent read-only tools. Any
 * tool NOT in the allowlist is treated as a side-effecting mutation — it is
 * never cached or short-circuited (T-hbe-03: a stale "success" for a write
 * would be a tampering bug), and it INVALIDATES the read cache so a read after
 * a write of the same path really re-executes.
 *
 * State is closure-local (one instance per execution run) — NO module-level
 * mutable state. Pure: no I/O, no logger, no clock.
 */

/** Consecutive no-progress steps that break the turn early (well under maxSteps). */
export const NO_PROGRESS_LOOP_THRESHOLD = 6;

/** Consecutive content-less turns that break the empty-turn loop. */
export const EMPTY_TURN_CAP = 2;

/**
 * Idempotent, read-only tools that may be cached / short-circuited. Explicit
 * ALLOWLIST — anything NOT listed is treated as a side-effecting mutation
 * (never cached, invalidates the read cache). Confirmed emitted names:
 * read-tool, ls-tool, find-tool, grep-tool (+ glob, memory_search).
 */
export const IDEMPOTENT_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "find",
  "grep",
  "glob",
  "memory_search",
]);

/** One-line steer appended to a short-circuited cached read result. */
function buildSteer(toolName: string): string {
  return (
    `You already ran ${toolName}(...) this turn; result unchanged and in ` +
    `context -- don't repeat it; answer or take a new action.`
  );
}

export type BeforeCallVerdict =
  | { kind: "allow" }
  | { kind: "short_circuit"; cachedResult: unknown; steer: string };

export interface TurnLoopDetector {
  /**
   * Consult the cache before a tool runs. A cached idempotent read returns a
   * short_circuit verdict (cached result + steer) and counts as a no-progress
   * step; everything else returns allow.
   */
  beforeCall(toolName: string, args: unknown): BeforeCallVerdict;
  /**
   * Record an executed tool result. A read populates the cache (a NEW distinct
   * read signature counts as progress; a repeat does not). A mutation clears
   * the read cache and counts as progress.
   */
  recordCall(toolName: string, args: unknown, result: unknown): void;
  /** Mark a content-less turn (no assistant text, no new signature). */
  recordEmptyTurn(): void;
  /** Mark genuine progress (assistant text / a new distinct signature). Resets counters. */
  recordProgress(): void;
  /** True once consecutive no-progress steps reach the threshold. */
  shouldBreakLoop(): boolean;
  /** True once consecutive empty turns reach the cap. */
  shouldBreakEmptyTurns(): boolean;
}

/**
 * Stable, recursive canonicalization of tool args so semantically-equal calls
 * with different key order / whitespace hash to the same cache key. Sorts
 * object keys at every depth; arrays preserve order (order is significant).
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortValue(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function cacheKey(toolName: string, args: unknown): string {
  return `${toolName}::${canonicalize(args)}`;
}

/**
 * Construct a per-execution loop detector. One instance per run; closure-local
 * state only.
 */
export function createTurnLoopDetector(): TurnLoopDetector {
  const readCache = new Map<string, unknown>();
  let noProgressCount = 0;
  let emptyTurnCount = 0;

  function isIdempotentRead(toolName: string): boolean {
    return IDEMPOTENT_READONLY_TOOLS.has(toolName);
  }

  return {
    beforeCall(toolName, args): BeforeCallVerdict {
      if (!isIdempotentRead(toolName)) return { kind: "allow" };
      const key = cacheKey(toolName, args);
      if (!readCache.has(key)) return { kind: "allow" };
      // A repeat of an already-cached read is a no-progress step.
      noProgressCount++;
      return {
        kind: "short_circuit",
        cachedResult: readCache.get(key),
        steer: buildSteer(toolName),
      };
    },

    recordCall(toolName, args, result): void {
      if (!isIdempotentRead(toolName)) {
        // Mutation: invalidate the read cache (write-between-reads forces a
        // real re-execution of the next read) and count as genuine progress.
        readCache.clear();
        noProgressCount = 0;
        emptyTurnCount = 0;
        return;
      }
      const key = cacheKey(toolName, args);
      const isNewSignature = !readCache.has(key);
      readCache.set(key, result);
      if (isNewSignature) {
        // A new distinct read is progress.
        noProgressCount = 0;
        emptyTurnCount = 0;
      } else {
        noProgressCount++;
      }
    },

    recordEmptyTurn(): void {
      emptyTurnCount++;
    },

    recordProgress(): void {
      noProgressCount = 0;
      emptyTurnCount = 0;
    },

    shouldBreakLoop(): boolean {
      return noProgressCount >= NO_PROGRESS_LOOP_THRESHOLD;
    },

    shouldBreakEmptyTurns(): boolean {
      return emptyTurnCount >= EMPTY_TURN_CAP;
    },
  };
}
