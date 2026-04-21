// SPDX-License-Identifier: Apache-2.0
/**
 * DAG compaction trigger detection, lazy ancestor dirty marking, descendant
 * recomputation, and orchestrated compaction runner with typed event emission.
 *
 * - {@link shouldCompact}: Determines WHEN compaction runs (token threshold).
 * - {@link markAncestorsDirty}: Marks ancestor summaries for lazy recomputation.
 * - {@link recomputeDescendantCounts}: Walks DAG to aggregate message/summary counts.
 * - {@link runDagCompaction}: Orchestrates leaf + condensed passes with event emission.
 *
 * All functions are pure -- they receive dependencies via parameters and do not
 * hold state between calls. The assembler wires these into the context engine.
 *
 * DAG Compaction Engine.
 *
 * @module
 */

import type { ContextStore } from "@comis/memory";
import type {
  TokenBudget,
  DagCompactionConfig,
  DagCompactionDeps,
  CompactionResult,
  DagCompactionEvent,
} from "./types.js";
import { runLeafPass, runCondensedPass } from "./dag-compaction.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum recursion depth for ancestor/descendant traversal to prevent stack overflow. */
const MAX_TRAVERSAL_DEPTH = 10;

// ---------------------------------------------------------------------------
// Section 1: Trigger Detection
// ---------------------------------------------------------------------------

/**
 * Determine whether the DAG should be compacted based on total token count.
 *
 * Sums token counts from all messages and summaries in the conversation.
 * Returns `true` when the total exceeds `contextThreshold * budget.availableHistoryTokens`.
 *
 * @param store - Context store for reading messages and summaries
 * @param conversationId - The conversation to check
 * @param config - Contains `contextThreshold` multiplier (e.g. 0.85)
 * @param budget - Token budget with `availableHistoryTokens`
 * @returns Whether the conversation should be compacted
 */
export function shouldCompact(
  store: ContextStore,
  conversationId: string,
  config: { contextThreshold: number },
  budget: TokenBudget,
): boolean {
  const messages = store.getMessagesByConversation(conversationId);
  const messageTokens = messages.reduce((sum, m) => sum + m.token_count, 0);

  const summaries = store.getSummariesByConversation(conversationId);
  const summaryTokens = summaries.reduce((sum, s) => sum + s.token_count, 0);

  const totalTokens = messageTokens + summaryTokens;
  const threshold = config.contextThreshold * budget.availableHistoryTokens;

  return totalTokens > threshold;
}

// ---------------------------------------------------------------------------
// Section 2: Lazy Ancestor Dirty Marking
// ---------------------------------------------------------------------------

/**
 * Mark all ancestor summaries of the given summary as counts-dirty.
 *
 * Walks up the DAG tree via `store.getParentSummaryIds()`, marking each
 * ancestor's `counts_dirty` flag to `true`. Uses a depth guard at
 * {@link MAX_TRAVERSAL_DEPTH} to prevent stack overflow on deep DAGs.
 *
 * @param store - Context store for reading/updating summary dirty flags
 * @param summaryId - The summary whose ancestors should be marked dirty
 * @param depth - Current recursion depth (default 0, internal use)
 */
export function markAncestorsDirty(
  store: ContextStore,
  summaryId: string,
  depth = 0,
): void {
  if (depth >= MAX_TRAVERSAL_DEPTH) return;

  const parentIds = store.getParentSummaryIds(summaryId);
  if (parentIds.length === 0) return;

  store.updateSummaryCountsDirty(parentIds, true);

  for (const parentId of parentIds) {
    markAncestorsDirty(store, parentId, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Section 3: Descendant Recomputation
// ---------------------------------------------------------------------------

/**
 * Recompute descendant counts for a summary, clearing the dirty flag.
 *
 * If the summary is not marked dirty, returns cached counts from the row.
 * Otherwise walks down the DAG:
 * - **Leaf summaries** (no children): `messageCount` = source message count.
 * - **Condensed summaries** (has children): recursively recomputes each child,
 *   aggregating message and summary counts.
 *
 * After recomputation, marks the summary as clean via `updateSummaryCountsDirty`.
 *
 * @param store - Context store for reading DAG structure
 * @param summaryId - The summary to recompute counts for
 * @param depth - Current recursion depth (default 0, internal use)
 * @returns Aggregated message and summary counts for this subtree
 */
export function recomputeDescendantCounts(
  store: ContextStore,
  summaryId: string,
  depth = 0,
): { messageCount: number; summaryCount: number } {
  if (depth >= MAX_TRAVERSAL_DEPTH) {
    return { messageCount: 0, summaryCount: 0 };
  }

  const summary = store.getSummary(summaryId);
  if (!summary) {
    return { messageCount: 0, summaryCount: 0 };
  }

  // If not dirty, return cached counts from the row
  if (summary.counts_dirty !== 1) {
    return {
      messageCount: summary.descendant_count,
      summaryCount: 0, // descendant_count tracks messages; summaryCount is structural
    };
  }

  // Walk down the DAG
  const childSummaryIds = store.getChildSummaryIds(summaryId);
  const sourceMessageIds = store.getSourceMessageIds(summaryId);

  if (childSummaryIds.length === 0) {
    // Leaf summary: count source messages directly
    const result = { messageCount: sourceMessageIds.length, summaryCount: 0 };
    store.updateSummaryCountsDirty([summaryId], false);
    return result;
  }

  // Condensed summary: recursively recompute children
  let totalMessages = 0;
  let totalSummaries = 0;
  for (const childId of childSummaryIds) {
    const childCounts = recomputeDescendantCounts(store, childId, depth + 1);
    totalMessages += childCounts.messageCount;
    totalSummaries += childCounts.summaryCount + 1; // +1 for the child itself
  }

  store.updateSummaryCountsDirty([summaryId], false);
  return { messageCount: totalMessages, summaryCount: totalSummaries };
}

// ---------------------------------------------------------------------------
// Section 4: Orchestrated Compaction Runner
// ---------------------------------------------------------------------------

/**
 * Run a full DAG compaction cycle: leaf pass + condensed passes + event emission.
 *
 * **Steps:**
 * 1. Run the leaf pass (depth-0 summarization of raw messages).
 * 2. Mark ancestors dirty for each new leaf summary.
 * 3. Run condensed passes from depth 1 up to `incrementalMaxDepth`.
 * 4. Mark ancestors dirty for each new condensed summary.
 * 5. Emit `context:dag_compacted` event if `deps.eventBus` is provided.
 * 6. Log INFO with overall compaction stats.
 *
 * **Model resolution note:** `deps.getModel` is expected to be
 * pre-resolved by the assembler from config
 * `summaryModel ?? compactionModel`. The compaction algorithms call
 * `deps.getModel()` to get the model and API key -- they do not read
 * config directly.
 *
 * @param conversationId - The conversation to compact
 * @param config - Full compaction configuration
 * @param deps - Compaction dependencies with optional eventBus
 * @returns Aggregate compaction result
 */
export async function runDagCompaction(
  conversationId: string,
  config: DagCompactionConfig,
  deps: DagCompactionDeps,
): Promise<CompactionResult> {
  // Step 1: Record start time
  const startTime = Date.now();

  // Step 2: Run leaf pass
  const leafResult = await runLeafPass(conversationId, {
    leafMinFanout: config.leafMinFanout,
    leafChunkTokens: config.leafChunkTokens,
    leafTargetTokens: config.leafTargetTokens,
    freshTailTurns: config.freshTailTurns,
  }, deps);

  // Step 3: Mark ancestors dirty for new leaf summaries
  for (const sid of leafResult.summaryIds) {
    markAncestorsDirty(deps.store, sid);
  }

  // Step 4: Run condensed passes in a loop
  const condensedResults = [];
  if (config.incrementalMaxDepth !== 0) {
    let currentDepth = 1;
    const maxDepth = config.incrementalMaxDepth === -1 ? MAX_TRAVERSAL_DEPTH : config.incrementalMaxDepth;

    while (currentDepth <= maxDepth) {
      const result = await runCondensedPass(conversationId, currentDepth, {
        condensedMinFanout: config.condensedMinFanout,
        condensedTargetTokens: config.condensedTargetTokens,
      }, deps);
      condensedResults.push(result);

      if (result.created === 0) break; // No more eligible summaries at this depth

      // Mark ancestors dirty for new condensed summaries
      for (const sid of result.summaryIds) {
        markAncestorsDirty(deps.store, sid);
      }

      currentDepth++;
    }
  }

  // Step 5: Compute duration
  const durationMs = Date.now() - startTime;

  // Step 6: Build CompactionResult
  const totalCondensedCreated = condensedResults.reduce((sum, r) => sum + r.created, 0);
  const totalCreated = leafResult.created + totalCondensedCreated;

  // Find highest depth with created > 0
  let maxDepthReached = 0;
  if (leafResult.created > 0) maxDepthReached = 0;
  for (let i = 0; i < condensedResults.length; i++) {
    if (condensedResults[i].created > 0) { // eslint-disable-line security/detect-object-injection
      maxDepthReached = i + 1; // condensed passes start at depth 1
    }
  }

  const result: CompactionResult = {
    leafResult,
    condensedResults,
    totalCreated,
    maxDepthReached,
  };

  // Step 7: Emit context:dag_compacted event
  deps.eventBus?.emit("context:dag_compacted", {
    conversationId,
    agentId: deps.agentId,
    sessionKey: deps.sessionKey,
    leafSummariesCreated: leafResult.created,
    condensedSummariesCreated: totalCondensedCreated,
    maxDepthReached,
    totalSummariesCreated: totalCreated,
    durationMs,
    timestamp: Date.now(),
  } satisfies DagCompactionEvent);

  // Step 8: Log INFO with overall compaction stats
  deps.logger.info(
    {
      conversationId,
      leafCreated: leafResult.created,
      condensedCreated: totalCondensedCreated,
      totalCreated,
      maxDepthReached,
      durationMs,
    },
    "DAG compaction complete",
  );

  // Step 9: Return result
  return result;
}
