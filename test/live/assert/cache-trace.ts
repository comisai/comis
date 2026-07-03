// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace asserter — typed helpers for the CACHE test suite.
 *
 * Reads cache-trace NDJSON lines, computes cacheCreation/cacheRead token
 * deltas, detects digest changes (miss), and exposes typed helpers to
 * scenario tests.
 *
 * Key invariant — model:after-only accumulation:
 *   Token counts are accumulated from `stage === "model:after"` lines ONLY.
 *   The `session:after` stage is a session-aggregate emitted once at session
 *   end via the EventBus bridge; summing it with per-call `model:after` lines
 *   would double-count tokens. Lines with any other stage are NOT summed.
 *
 * Zod guard:
 *   Every candidate line (traceSchema === "comis-cache-trace") is validated
 *   against CacheTraceEventSchema via safe-parse. Lines that fail schema
 *   validation are silently skipped — same treatment as malformed JSON.
 *
 * Mirrors the JSONL parse loop from test/live/assert/observe.ts (expectCacheHit,
 * lines 131–158) and the error-message style from that same file.
 *
 * @module
 */

import { CacheTraceEventSchema } from "@comis/observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Aggregated per-turn cache-trace statistics.
 *
 * Computed by readCacheTraceForTurn across all qualifying model:after lines
 * in a NDJSON block, optionally filtered by traceId or sessionId.
 */
export interface CacheTraceSummary {
  /** Sum of cacheCreationInputTokens from model:after lines. > 0 → write happened. */
  totalCreationTokens: number;
  /** Sum of cacheReadInputTokens from model:after lines. > 0 → cache hit happened. */
  totalReadTokens: number;
  /** Count of qualifying cache-trace lines (model:after, passing Zod guard, passing filter). */
  traceCount: number;
  /** messagesDigest from the last qualifying line (undefined if none present). */
  lastMessagesDigest: string | undefined;
  /** systemDigest from the last qualifying line (undefined if none present). */
  lastSystemDigest: string | undefined;
}

// ---------------------------------------------------------------------------
// Core: readCacheTraceForTurn
// ---------------------------------------------------------------------------

/**
 * Parse a block of cache-trace NDJSON lines and compute per-turn token deltas.
 *
 * Only `stage === "model:after"` lines are counted — `session:after` is a
 * session-aggregate and MUST NOT be summed (double-count guard).
 *
 * Lines that fail JSON.parse or CacheTraceEventSchema safe-parse are silently
 * skipped (malformed-input tolerance).
 *
 * @param cacheTraceLines - Newline-delimited NDJSON block (raw file contents or
 *                          a subset of lines for a single turn).
 * @param filter          - Optional traceId and/or sessionId to restrict the
 *                          counted lines.  When provided, only lines where the
 *                          corresponding field matches the supplied value are
 *                          included in the summary.
 * @returns CacheTraceSummary with accumulated token counts and last digests.
 */
export function readCacheTraceForTurn(
  cacheTraceLines: string,
  filter?: { traceId?: string; sessionId?: string },
): CacheTraceSummary {
  const summary: CacheTraceSummary = {
    totalCreationTokens: 0,
    totalReadTokens: 0,
    traceCount: 0,
    lastMessagesDigest: undefined,
    lastSystemDigest: undefined,
  };

  const rawLines = cacheTraceLines
    .split("\n")
    .filter((l) => l.trim().length > 0);

  for (const line of rawLines) {
    // Step 1: JSON.parse — skip malformed lines
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // skip malformed JSON lines
      continue;
    }

    // Step 2: traceSchema sentinel check
    if (obj["traceSchema"] !== "comis-cache-trace") {
      continue;
    }

    // Step 3: Zod safe-parse — skip lines that fail schema validation
    const parsed = CacheTraceEventSchema.safeParse(obj);
    if (!parsed.success) {
      continue;
    }

    const event = parsed.data;

    // Step 4: model:after-only guard — session:after aggregates MUST NOT be summed
    if (event.stage !== "model:after") {
      continue;
    }

    // Step 5: optional filter by traceId / sessionId
    if (filter?.traceId !== undefined && event.traceId !== filter.traceId) {
      continue;
    }
    if (filter?.sessionId !== undefined && event.sessionId !== filter.sessionId) {
      continue;
    }

    // Step 6: accumulate
    summary.traceCount++;

    if (typeof event.cacheCreationInputTokens === "number") {
      summary.totalCreationTokens += event.cacheCreationInputTokens;
    }
    if (typeof event.cacheReadInputTokens === "number") {
      summary.totalReadTokens += event.cacheReadInputTokens;
    }

    // Step 7: track last qualifying digests
    if (event.messagesDigest !== undefined) {
      summary.lastMessagesDigest = event.messagesDigest;
    }
    if (event.systemDigest !== undefined) {
      summary.lastSystemDigest = event.systemDigest;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Asserter: expectCacheWrite
// ---------------------------------------------------------------------------

/**
 * Assert that a cache-write event (cacheCreationInputTokens > 0) occurred.
 *
 * Reads the NDJSON block, sums cacheCreationInputTokens from model:after lines,
 * and throws if the total falls below the minimum.
 *
 * @param opts.minCreationTokens - Minimum total required (defaults to 1).
 * @param cacheTraceLines        - NDJSON lines from the cache-trace stream.
 * @throws Error with actual counts + traceCount when the assertion fails.
 */
export async function expectCacheWrite(
  opts: { minCreationTokens?: number },
  cacheTraceLines: string,
): Promise<void> {
  const minCreationTokens = opts.minCreationTokens ?? 1;
  const summary = readCacheTraceForTurn(cacheTraceLines);

  if (summary.totalCreationTokens < minCreationTokens) {
    throw new Error(
      `expectCacheWrite: expected at least ${minCreationTokens} cacheCreationInputTokens ` +
        `but found ${summary.totalCreationTokens} across ${summary.traceCount} cache-trace entries.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Asserter: expectNoCacheWrite
// ---------------------------------------------------------------------------

/**
 * Assert that NO cache-write event occurred (cacheCreationInputTokens === 0).
 *
 * Used for the kill-switch path (cacheRetention:"none") where the provider
 * strips all cache_control markers so the model never receives cache annotations
 * and must return cacheCreationInputTokens=0.
 *
 * @param cacheTraceLines - NDJSON lines from the cache-trace stream.
 * @throws Error with actual counts when a write unexpectedly occurred.
 */
export async function expectNoCacheWrite(cacheTraceLines: string): Promise<void> {
  const summary = readCacheTraceForTurn(cacheTraceLines);

  if (summary.totalCreationTokens !== 0) {
    throw new Error(
      `expectNoCacheWrite: expected cacheCreationInputTokens=0 (kill-switch active) ` +
        `but found ${summary.totalCreationTokens} across ${summary.traceCount} cache-trace entries.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Asserter: expectCacheRead
// ---------------------------------------------------------------------------

/**
 * Assert that a cache-read (hit) event (cacheReadInputTokens > 0) occurred.
 *
 * Reads the NDJSON block, sums cacheReadInputTokens from model:after lines,
 * and throws if the total falls below the minimum.
 *
 * @param opts.minReadTokens - Minimum total required.
 * @param cacheTraceLines    - NDJSON lines from the cache-trace stream.
 * @throws Error with actual counts + traceCount when the assertion fails.
 */
export async function expectCacheRead(
  opts: { minReadTokens: number },
  cacheTraceLines: string,
): Promise<void> {
  const summary = readCacheTraceForTurn(cacheTraceLines);

  if (summary.totalReadTokens < opts.minReadTokens) {
    throw new Error(
      `expectCacheRead: expected at least ${opts.minReadTokens} cacheReadInputTokens ` +
        `but found ${summary.totalReadTokens} across ${summary.traceCount} cache-trace entries.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Asserter: expectDigestChange
// ---------------------------------------------------------------------------

/**
 * Assert that at least one digest changed between two CacheTraceSummary snapshots.
 *
 * A digest change indicates a cache miss on the next turn — the assembled
 * messages or system prompt changed, so the previously created cache block
 * no longer applies.
 *
 * Comparison: `before.lastMessagesDigest !== after.lastMessagesDigest` OR
 *             `before.lastSystemDigest !== after.lastSystemDigest`.
 *
 * Throws when both digests are identical (or both undefined), meaning no miss
 * was detected between the two snapshots.
 *
 * @param before - CacheTraceSummary from the earlier turn.
 * @param after  - CacheTraceSummary from the later turn.
 * @throws Error with digest values when no change is detected.
 */
export function expectDigestChange(
  before: CacheTraceSummary,
  after: CacheTraceSummary,
): void {
  // Guard: a zero-trace 'after' snapshot means the turn failed before emitting any
  // cache-trace event. undefined vs. a real digest would compare as "changed",
  // masking a broken turn as a successful cache miss. Throw explicitly instead.
  if (after.traceCount === 0) {
    throw new Error(
      `expectDigestChange: 'after' snapshot has no qualifying trace lines (traceCount=0). ` +
        `Cannot determine digest change — the turn may have failed before emitting a cache-trace event.`,
    );
  }

  const messagesChanged = before.lastMessagesDigest !== after.lastMessagesDigest;
  const systemChanged = before.lastSystemDigest !== after.lastSystemDigest;

  if (!messagesChanged && !systemChanged) {
    throw new Error(
      `expectDigestChange: no digest change detected — ` +
        `messagesDigest before="${before.lastMessagesDigest}" after="${after.lastMessagesDigest}", ` +
        `systemDigest before="${before.lastSystemDigest}" after="${after.lastSystemDigest}". ` +
        `Expected at least one digest to differ between the two turns (cache miss not detected).`,
    );
  }
}
