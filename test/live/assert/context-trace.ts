// SPDX-License-Identifier: Apache-2.0
/**
 * Context-trace asserter — typed helpers for the CTX test suite.
 *
 * Reads cache-trace NDJSON lines to extract the `stream:context` stage shape
 * (AssembledShape) and provides structural asserters for the A1/A2/A3/O1/P1/P2
 * invariants. Also provides event-array asserters for the context:dag_compacted
 * and context:evicted lifecycle events.
 *
 * Key design invariants:
 *
 *   A1 (fresh tail verbatim): the assembled array always has totalCount > 0.
 *     Any assembled context with no messages is a bug in the engine.
 *
 *   A2 (pair intact): pairedToolResultCount === toolResultCount === toolUseCount.
 *     Every tool_use block has a matching tool_result; no orphans.
 *
 *   A3 (no pair split): for every toolUseId in toolUseIds there is a matching
 *     toolResultId in toolResultIds. ONLY reliable when !idsTruncated — when
 *     truncated, the sampled arrays are partial and the integer count invariant
 *     (A2) is the authoritative check.
 *
 *   O1 (metrics non-zero): at least one context:dag_compacted event has
 *     leafSummariesCreated > 0 OR at least one context:evicted event has
 *     evictedCount > 0. Asserts real DAG activity, not hardcoded zeros.
 *
 *   P1 (honest presentation): at least one context:dag_compacted event has
 *     totalSummariesCreated > 0. The [LCD summary — depth=N, …] header is
 *     rendered in assembled messages (lcd-assembler.ts summaryRefToMessage)
 *     and NEVER logged verbatim per AGENTS.md §2.7. The event is the only
 *     daemon-side observable.
 *
 *   P2 (uncertainty clauses): at least one context:dag_compacted event is
 *     present. If dag_compacted fired, dag mode was active and the P2 system
 *     prompt clause (## Compressed context, buildLossinessUncertaintySection)
 *     was injected. The system prompt text is NEVER logged per AGENTS.md §2.7.
 *
 * Mirrors the structure and error-message style of test/live/assert/cache-trace.ts.
 *
 * @module
 */

import { CacheTraceEventSchema } from "@comis/observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Assembled-array shape descriptor from the `stream:context` stage line.
 *
 * Mirrors the REAL AssembledShape interface from
 * packages/observability/src/cache-trace/stream-fn-wrapper.ts.
 *
 * IMPORTANT: the truncation flag is `idsTruncated` (NOT `isSampled` — that
 * field does not exist in the schema). Source: types.ts line 150.
 */
export interface ContextStreamShape {
  /** Number of messages in the assembled provider array. */
  totalCount: number;
  /** Count of content blocks bucketed by block type. */
  blockKindCounts: Record<string, number>;
  /** True when the array carries any tool_result block or top-level toolResult message. */
  hasToolResult: boolean;
  /** Opaque call ids of tool_use blocks, SAMPLED to MAX_SAMPLED_IDS (32). */
  toolUseIds: string[];
  /** Opaque call ids of tool_result blocks, SAMPLED to MAX_SAMPLED_IDS (32). */
  toolResultIds: string[];
  /** True count of tool_use blocks (never sampled away). */
  toolUseCount: number;
  /** True count of tool_result blocks (never sampled away). */
  toolResultCount: number;
  /**
   * Count of tool_result ids paired with a tool_use id (computed over the
   * full id sets before sampling). A2: pairedToolResultCount === toolResultCount ⇒ no orphans.
   */
  pairedToolResultCount: number;
  /**
   * True when either id list exceeded MAX_SAMPLED_IDS and the *Ids arrays are
   * a SAMPLE rather than the complete set. When true, assertA3NoPairSplit skips
   * the id-by-id check and emits a console.warn; use assertA2PairIntact (integer
   * counts) instead.
   *
   * REAL field name: idsTruncated (NOT isSampled — that field does not exist).
   */
  idsTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Core: readContextStreamShape
// ---------------------------------------------------------------------------

/**
 * Parse a block of cache-trace NDJSON lines and return the last `stream:context`
 * stage shape (assembledShape field), or null if no qualifying line is found.
 *
 * Lines are filtered to:
 *   1. Valid JSON
 *   2. traceSchema === "comis-cache-trace"
 *   3. Passes CacheTraceEventSchema Zod safe-parse
 *   4. stage === "stream:context"
 *   5. assembledShape field present
 *
 * Optionally filtered by traceId and/or sessionId when filter is provided.
 * Malformed lines are silently skipped (same treatment as cache-trace.ts).
 *
 * @param cacheTraceLines - Newline-delimited NDJSON block (raw file contents).
 * @param filter          - Optional traceId and/or sessionId filter.
 * @returns Last ContextStreamShape found, or null if none.
 */
export function readContextStreamShape(
  cacheTraceLines: string,
  filter?: { traceId?: string; sessionId?: string },
): ContextStreamShape | null {
  const rawLines = cacheTraceLines
    .split("\n")
    .filter((l) => l.trim().length > 0);

  let lastShape: ContextStreamShape | null = null;

  for (const line of rawLines) {
    // Step 1: JSON.parse — skip malformed lines
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
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

    // Step 4: stream:context stage guard only
    if (event.stage !== "stream:context") {
      continue;
    }

    // Step 5: assembledShape must be present
    if (event.assembledShape === undefined) {
      continue;
    }

    // Step 6: optional filter by traceId / sessionId
    if (filter?.traceId !== undefined && event.traceId !== filter.traceId) {
      continue;
    }
    if (filter?.sessionId !== undefined && event.sessionId !== filter.sessionId) {
      continue;
    }

    // Step 7: cast to ContextStreamShape and update lastShape
    lastShape = event.assembledShape as ContextStreamShape;
  }

  return lastShape;
}

// ---------------------------------------------------------------------------
// Asserter: assertA1TailVerbatim
// ---------------------------------------------------------------------------

/**
 * Assert A1 — fresh tail verbatim: the assembled array is non-empty.
 *
 * The LCD engine guarantees that getMessages() always includes the fresh tail
 * (the most recent messages, never truncated). A zero-count assembled array is
 * a engine bug.
 *
 * @param shape - ContextStreamShape from readContextStreamShape.
 * @throws Error when totalCount === 0.
 */
export function assertA1TailVerbatim(shape: ContextStreamShape): void {
  if (shape.totalCount === 0) {
    throw new Error(
      `assertA1TailVerbatim: assembled array is empty (totalCount=0) — ` +
        `the LCD engine must always include the fresh tail messages; an empty assembly is a bug.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Asserter: assertA2PairIntact
// ---------------------------------------------------------------------------

/**
 * Assert A2 — pair intact: every tool_use has a paired tool_result, no orphans.
 *
 * Uses integer counts (computed over the full id sets before sampling) so the
 * check holds at any turn size, including large tool fan-outs where the sampled
 * id arrays may be truncated (idsTruncated=true).
 *
 * Invariants checked:
 *   - pairedToolResultCount === toolResultCount (no orphaned tool_results)
 *   - toolUseCount === toolResultCount (symmetric: every use has a result)
 *
 * @param shape - ContextStreamShape from readContextStreamShape.
 * @throws Error with actual counts when either invariant fails.
 */
export function assertA2PairIntact(shape: ContextStreamShape): void {
  if (shape.pairedToolResultCount !== shape.toolResultCount) {
    throw new Error(
      `assertA2PairIntact: orphaned tool_result detected — ` +
        `pairedToolResultCount=${shape.pairedToolResultCount} !== toolResultCount=${shape.toolResultCount}. ` +
        `Every tool_result must have a matching tool_use id.`,
    );
  }
  if (shape.toolUseCount !== shape.toolResultCount) {
    throw new Error(
      `assertA2PairIntact: tool_use/tool_result count mismatch — ` +
        `toolUseCount=${shape.toolUseCount} !== toolResultCount=${shape.toolResultCount}. ` +
        `Every tool_use must have a corresponding tool_result.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Asserter: assertA3NoPairSplit
// ---------------------------------------------------------------------------

/**
 * Assert A3 — budget never splits a pair: every toolUseId in toolUseIds has a
 * matching toolResultId in toolResultIds.
 *
 * IMPORTANT: this check is only reliable when idsTruncated === false. When the
 * id arrays are truncated (idsTruncated=true), the sampled arrays are a partial
 * view and the id-by-id check cannot be conclusive. In that case this function
 * emits a console.warn and returns without throwing — use assertA2PairIntact
 * (integer count invariant, never truncated) instead.
 *
 * @param shape - ContextStreamShape from readContextStreamShape.
 * @throws Error when idsTruncated=false and any toolUseId is absent from toolResultIds.
 */
export function assertA3NoPairSplit(shape: ContextStreamShape): void {
  if (shape.idsTruncated) {
    console.warn(
      `assertA3NoPairSplit: id lists truncated (idsTruncated=true) — ` +
        `skipping split check; use toolUseCount/toolResultCount integer counts ` +
        `via assertA2PairIntact instead`,
    );
    return;
  }

  const resultIdSet = new Set(shape.toolResultIds);
  for (const useId of shape.toolUseIds) {
    if (!resultIdSet.has(useId)) {
      throw new Error(
        `assertA3NoPairSplit: tool_use id "${useId}" has no matching tool_result id — ` +
          `the budget splitter must not evict a tool_result without its paired tool_use. ` +
          `toolUseIds=${JSON.stringify(shape.toolUseIds)}, ` +
          `toolResultIds=${JSON.stringify(shape.toolResultIds)}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Asserter: assertO1MetricsNonZero
// ---------------------------------------------------------------------------

/**
 * Assert O1 — non-zero DAG metrics: at least one qualifying event carries a
 * positive count, proving real DAG/eviction activity (not hardcoded zeros).
 *
 * Passes when:
 *   - At least one context:dag_compacted event has leafSummariesCreated > 0, OR
 *   - At least one context:evicted event has evictedCount > 0.
 *
 * Takes an event array (not log lines) — the daemon NEVER logs message content
 * or event payload bodies verbatim per AGENTS.md §2.7.
 *
 * @param events - Array of captured EventBus events ({name, payload}).
 * @throws Error when no qualifying event is found.
 */
export function assertO1MetricsNonZero(
  events: Array<{ name: string; payload: unknown }>,
): void {
  for (const event of events) {
    if (event.name === "context:dag_compacted") {
      const p = event.payload as { leafSummariesCreated?: number };
      if (typeof p.leafSummariesCreated === "number" && p.leafSummariesCreated > 0) {
        return;
      }
    }
    if (event.name === "context:evicted") {
      const p = event.payload as { evictedCount?: number };
      if (typeof p.evictedCount === "number" && p.evictedCount > 0) {
        return;
      }
    }
  }

  throw new Error(
    `assertO1MetricsNonZero: no context:dag_compacted event with leafSummariesCreated > 0 ` +
      `and no context:evicted event with evictedCount > 0 found in ${events.length} events. ` +
      `Ensure the session ran long enough to trigger real DAG compaction or eviction activity.`,
  );
}

// ---------------------------------------------------------------------------
// Asserter: assertP1HonestPresentation
// ---------------------------------------------------------------------------

/**
 * Assert P1 — honest presentation: summaries were created and presented in this
 * session (the [LCD summary — depth=N, …] header was rendered in assembled messages).
 *
 * Asserts that at least one context:dag_compacted event has totalSummariesCreated > 0.
 *
 * NOTE: the [LCD summary — …] header text lives in assembled messages
 * (lcd-assembler.ts summaryRefToMessage), NOT in log lines. Per AGENTS.md §2.7,
 * message bodies are NEVER logged verbatim. Do not grep log lines for this text —
 * the event is the only daemon-side observable for P1.
 *
 * Takes an event array (not log lines).
 *
 * @param events - Array of captured EventBus events ({name, payload}).
 * @throws Error when no dag_compacted event with totalSummariesCreated > 0 is found.
 */
export function assertP1HonestPresentation(
  events: Array<{ name: string; payload: unknown }>,
): void {
  for (const event of events) {
    if (event.name === "context:dag_compacted") {
      const p = event.payload as { totalSummariesCreated?: number };
      if (typeof p.totalSummariesCreated === "number" && p.totalSummariesCreated > 0) {
        return;
      }
    }
  }

  throw new Error(
    `assertP1HonestPresentation: no context:dag_compacted event with totalSummariesCreated > 0 ` +
      `found — summaries were not created in this session, so honest presentation markers ` +
      `(the [LCD summary — …] header) were not rendered; ensure the session ran long enough ` +
      `to trigger compaction. NOTE: summary header text is in assembled messages, never in ` +
      `log lines (AGENTS.md §2.7) — the event is the only observable.`,
  );
}

// ---------------------------------------------------------------------------
// Asserter: assertP2UncertaintyClauses
// ---------------------------------------------------------------------------

/**
 * Assert P2 — uncertainty clauses: the DAG mode was active in this session, so
 * the P2 system prompt clause (## Compressed context) was injected by
 * buildLossinessUncertaintySection.
 *
 * If at least one context:dag_compacted event is present, DAG mode was active
 * and the P2 clause was rendered (mode-gated static inclusion — it is always
 * injected when dag mode is configured, regardless of compaction having occurred).
 *
 * NOTE: the P2 system prompt text (## Compressed context) is NEVER logged
 * verbatim per AGENTS.md §2.7. The context:dag_compacted event is the only
 * daemon-side observable for whether dag mode was active. Do not grep log lines
 * for system prompt text.
 *
 * Takes an event array (not log lines).
 *
 * @param events - Array of captured EventBus events ({name, payload}).
 * @throws Error when no context:dag_compacted event is present.
 */
export function assertP2UncertaintyClauses(
  events: Array<{ name: string; payload: unknown }>,
): void {
  const hasDagCompacted = events.some((e) => e.name === "context:dag_compacted");

  if (!hasDagCompacted) {
    throw new Error(
      `assertP2UncertaintyClauses: no context:dag_compacted event found — dag mode did not ` +
        `run in this session, so the P2 uncertainty clause (## Compressed context) was not ` +
        `included in the system prompt. NOTE: the system prompt text is never logged ` +
        `(AGENTS.md §2.7); the event is the only observable.`,
    );
  }
}
