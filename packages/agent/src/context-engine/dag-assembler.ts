/**
 * DAG assembler context engine layer.
 *
 * Fetches context items from the store, applies turn-aware fresh tail boundary,
 * scores evictable items by recency x density, selects within token budget,
 * wraps summaries in XML with metadata, and injects recall tool guidance.
 *
 * The assembler is the output side of the DAG context engine -- it takes the
 * raw DAG data (messages + summaries) and produces a budget-aware,
 * relevance-ranked AgentMessage[] for the LLM. It replaces the pipeline's
 * history window + dead content evictor with DAG-aware assembly.
 *
 * DAG Assembly & Annotation.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CtxContextItemRow, CtxMessageRow, CtxSummaryRow } from "@comis/memory";
import type { ContextStore } from "@comis/memory";
import type { ContextLayer, TokenBudget, DagAssemblerDeps, DagAssemblerConfig } from "./types.js";
import { XML_WRAPPER_OVERHEAD_TOKENS, RECALL_GUIDANCE } from "./constants.js";
import { resolveFreshTailBoundary } from "./dag-compaction.js";

// ---------------------------------------------------------------------------
// Internal types (not exported)
// ---------------------------------------------------------------------------

/** A context item resolved with its backing message or summary row. */
interface ResolvedItem {
  contextItem: CtxContextItemRow;
  content: string;
  tokenCount: number;
  role: string;
  depth?: number;
  summaryRow?: CtxSummaryRow;
  messageRow?: CtxMessageRow;
}

/** A resolved item enriched with a relevance score for budget selection. */
interface ScoredItem extends ResolvedItem {
  score: number;
}

// ---------------------------------------------------------------------------
// Section 1: Resolve Context Items
// ---------------------------------------------------------------------------

/**
 * Fetch context items and resolve their backing message/summary rows.
 *
 * Messages are batch-fetched via `getMessagesByIds()` to avoid N+1.
 * Summaries are fetched individually (typically few per conversation).
 * Items with missing backing data are filtered out.
 */
function resolveContextItems(
  store: ContextStore,
  conversationId: string,
): ResolvedItem[] {
  const items = store.getContextItems(conversationId);
  if (items.length === 0) return [];

  // Partition items by type for batch lookup
  const messageIds: number[] = [];
  const summaryIds: string[] = [];
  for (const item of items) {
    if (item.item_type === "message" && item.message_id !== null) {
      messageIds.push(item.message_id);
    } else if (item.item_type === "summary" && item.summary_id !== null) {
      summaryIds.push(item.summary_id);
    }
  }

  // Batch-fetch messages (single WHERE IN query, chunked at 500)
  const messagesMap = new Map<number, CtxMessageRow>(
    store.getMessagesByIds(messageIds).map(m => [m.message_id, m]),
  );

  // Fetch summaries individually (typically few per conversation)
  const summariesMap = new Map<string, CtxSummaryRow>();
  for (const sid of summaryIds) {
    const sum = store.getSummary(sid);
    if (sum) summariesMap.set(sid, sum);
  }

  // Map each context item to a ResolvedItem, filtering missing backing data
  const resolved: ResolvedItem[] = [];
  for (const item of items) {
    if (item.item_type === "message" && item.message_id !== null) {
      const msg = messagesMap.get(item.message_id);
      if (!msg) continue; // skip orphaned context items
      resolved.push({
        contextItem: item,
        content: msg.content,
        tokenCount: msg.token_count,
        role: msg.role,
        messageRow: msg,
      });
    } else if (item.item_type === "summary" && item.summary_id !== null) {
      const sum = summariesMap.get(item.summary_id);
      if (!sum) continue; // skip orphaned context items
      resolved.push({
        contextItem: item,
        content: sum.content,
        tokenCount: sum.token_count,
        role: "user", // summaries presented as synthetic user messages
        depth: sum.depth,
        summaryRow: sum,
      });
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Section 2: XML Summary Wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap a summary row in XML with depth, descendants, and time range metadata.
 *
 * Produces:
 * ```xml
 * <context_summary id="sum_xxx" depth="0" descendants="5" from="2026-03-15T..." to="2026-03-15T...">
 * {content}
 * </context_summary>
 * ```
 */
function wrapSummaryXml(summary: CtxSummaryRow): string {
  const attrs: string[] = [
    `id="${summary.summary_id}"`,
    `depth="${summary.depth}"`,
    `descendants="${summary.descendant_count}"`,
  ];
  if (summary.earliest_at) attrs.push(`from="${summary.earliest_at}"`);
  if (summary.latest_at) attrs.push(`to="${summary.latest_at}"`);

  return `<context_summary ${attrs.join(" ")}>\n${summary.content}\n</context_summary>`;
}

// ---------------------------------------------------------------------------
// Section 3: Relevance Scoring
// ---------------------------------------------------------------------------

/**
 * Score evictable items by recency x density.
 *
 * Items are already in ordinal order (oldest first):
 * - `recency = (index + 1) / totalEvictable` -- linear decay, newest = 1.0
 * - `density` for summaries: `Math.min(2.0, (source_token_count || 1000) / Math.max(1, tokenCount))`
 *   Higher density = more compressed = more valuable per token.
 * - `density` for messages: `1.0`
 * - `score = recency * density`
 *
 * Returns items sorted by score descending (highest = most relevant).
 */
function scoreEvictableItems(
  items: ResolvedItem[],
  totalEvictable: number,
): ScoredItem[] {
  if (totalEvictable === 0) return [];

  const scored: ScoredItem[] = items.map((item, index) => {
    const recency = (index + 1) / totalEvictable;
    const density = item.summaryRow
      ? Math.min(2.0, (item.summaryRow.source_token_count || 1000) / Math.max(1, item.tokenCount))
      : 1.0;
    return { ...item, score: recency * density };
  });

  // Sort descending by score (highest = most relevant)
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---------------------------------------------------------------------------
// Section 4: Budget Selection
// ---------------------------------------------------------------------------

/**
 * Greedy fill: iterate scored items (highest score first), add if fits budget.
 *
 * For summaries: item tokens include XML_WRAPPER_OVERHEAD_TOKENS.
 * For messages: item tokens are the raw token count.
 *
 * Re-sorts selected by original ordinal for correct conversation order.
 */
function selectWithinBudget(
  scored: ScoredItem[],
  budgetTokens: number,
  xmlOverhead: number,
): ResolvedItem[] {
  const selected: ResolvedItem[] = [];
  let usedTokens = 0;

  for (const item of scored) {
    const itemTokens = item.tokenCount + (item.summaryRow ? xmlOverhead : 0);
    if (usedTokens + itemTokens <= budgetTokens) {
      selected.push(item);
      usedTokens += itemTokens;
    }
  }

  // Re-sort by original ordinal for correct conversation order
  selected.sort((a, b) => a.contextItem.ordinal - b.contextItem.ordinal);
  return selected;
}

// ---------------------------------------------------------------------------
// Section 5: Build Assembled Messages
// ---------------------------------------------------------------------------

/**
 * Build the final AgentMessage[] from selected + fresh tail items.
 *
 * Order: recall guidance, then selected evictable items (ordinal order),
 * then fresh tail items (ordinal order).
 *
 * Summaries are wrapped in XML. Messages are reconstructed from CtxMessageRow,
 * preserving toolName and toolCallId for tool results.
 */
function buildAssembledMessages(
  freshTail: ResolvedItem[],
  selected: ResolvedItem[],
): AgentMessage[] {
   
  const assembled: AgentMessage[] = [];

  // First message: recall guidance
  assembled.push({
    role: "user",
    content: [{ type: "text", text: RECALL_GUIDANCE }],
  } as unknown as AgentMessage);

  // Selected evictable items (already in ordinal order)
  for (const item of selected) {
    assembled.push(buildAgentMessage(item));
  }

  // Fresh tail items (already in ordinal order)
  for (const item of freshTail) {
    assembled.push(buildAgentMessage(item));
  }

  return assembled;
   
}

/**
 * Build a single AgentMessage from a ResolvedItem.
 *
 * Summaries: wrap in XML, present as user message.
 * Messages: reconstruct from CtxMessageRow, preserving tool fields.
 */
function buildAgentMessage(item: ResolvedItem): AgentMessage {
   
  if (item.summaryRow) {
    const wrappedXml = wrapSummaryXml(item.summaryRow);
    return {
      role: "user",
      content: [{ type: "text", text: wrappedXml }],
    } as unknown as AgentMessage;
  }

  // Reconstruct from CtxMessageRow
  const msg = item.messageRow!;
  const result: Record<string, unknown> = {
    role: msg.role,
    content: [{ type: "text", text: msg.content }],
  };

  // Preserve tool fields for toolResult messages
  if (msg.tool_name) result.toolName = msg.tool_name;
  if (msg.tool_call_id) result.toolCallId = msg.tool_call_id;

  return result as unknown as AgentMessage;
   
}

// ---------------------------------------------------------------------------
// Section 6: Factory (public API)
// ---------------------------------------------------------------------------

/**
 * Create a DAG assembler context layer.
 *
 * The assembler reads context items from the store, resolves their backing
 * data, applies fresh tail protection, scores and selects within budget,
 * wraps summaries in XML, and injects recall tool guidance.
 *
 * When no context items exist (first turn, pre-reconciliation), the input
 * messages are returned unchanged (pass-through).
 *
 * @param config - Assembler configuration (fresh tail turns, token budget)
 * @param deps - Dependencies (context store, logger, conversation ID, token estimator)
 * @returns ContextLayer implementing DAG-aware assembly
 */
export function createDagAssemblerLayer(
  config: DagAssemblerConfig,
  deps: DagAssemblerDeps,
): ContextLayer {
  return {
    name: "dag-assembler",

    async apply(messages: AgentMessage[], _budget: TokenBudget): Promise<AgentMessage[]> {
      // Step 1: Resolve context items via batch store operations
      const resolved = resolveContextItems(deps.store, deps.conversationId);

      // Step 2: Pass-through when no context items exist (first turn / pre-reconciliation)
      if (resolved.length === 0) {
        deps.logger.debug(
          { conversationId: deps.conversationId },
          "DAG assembly pass-through: no context items",
        );
        return messages;
      }

      // Step 3: Fetch all messages for fresh tail boundary resolution
      const allMessages = deps.store.getMessagesByConversation(deps.conversationId);

      // Step 4: Resolve fresh tail boundary
      const boundarySeq = resolveFreshTailBoundary(allMessages, config.freshTailTurns);

      // Step 5: Partition resolved items into fresh tail and evictable
      const freshTail: ResolvedItem[] = [];
      const evictable: ResolvedItem[] = [];

      for (const item of resolved) {
        // Messages with seq >= boundary are in the fresh tail
        // Summaries are always evictable (they represent compressed older content)
        const isInFreshTail = item.messageRow
          ? item.messageRow.seq >= boundarySeq
          : false;

        if (isInFreshTail) {
          freshTail.push(item);
        } else {
          evictable.push(item);
        }
      }

      // Step 6: Calculate fresh tail tokens
      let freshTailTokens = 0;
      for (const item of freshTail) {
        freshTailTokens += item.tokenCount + (item.summaryRow ? XML_WRAPPER_OVERHEAD_TOKENS : 0);
      }

      // Step 7: Remaining budget for evictable items
      const remainingBudget = Math.max(0, config.availableHistoryTokens - freshTailTokens);

      // Step 8: Score evictable items and select within remaining budget
      const scored = scoreEvictableItems(evictable, evictable.length);
      const selected = selectWithinBudget(scored, remainingBudget, XML_WRAPPER_OVERHEAD_TOKENS);

      // Step 9: Build assembled messages array
      const assembled = buildAssembledMessages(freshTail, selected);

      // Step 10: Compute used tokens for logging
      let usedTokens = 0;
      for (const item of selected) {
        usedTokens += item.tokenCount + (item.summaryRow ? XML_WRAPPER_OVERHEAD_TOKENS : 0);
      }

      deps.logger.debug(
        {
          conversationId: deps.conversationId,
          totalItems: resolved.length,
          freshTailCount: freshTail.length,
          evictableCount: evictable.length,
          selectedCount: selected.length,
          budgetTokens: config.availableHistoryTokens,
          usedTokens: freshTailTokens + usedTokens,
        },
        "DAG assembly complete",
      );

      // Step 11: Return assembled messages
      return assembled;
    },
  };
}
