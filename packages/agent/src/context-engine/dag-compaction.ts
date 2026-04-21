// SPDX-License-Identifier: Apache-2.0
/**
 * DAG compaction algorithms: leaf pass, condensed pass, three-tier escalation,
 * turn-aware fresh tail boundary, depth-aware prompts, sentence-boundary truncation.
 *
 * All functions are pure -- they receive dependencies via {@link CompactionDeps}
 * and do not hold state between calls. The DAG engine ( assembler)
 * orchestrates these functions.
 *
 * DAG Compaction Engine.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import type {
  CompactionDeps,
  LeafPassConfig,
  CondensedPassConfig,
  EscalationConfig,
  EscalationResult,
  LeafPassResult,
  CondensedPassResult,
} from "./types.js";
import {
  DEPTH_PROMPTS,
  CHARS_PER_TOKEN_RATIO,
  DAG_ESCALATION_OVERRUN_TOLERANCE,
  DAG_SUMMARY_ID_PREFIX,
  DAG_SUMMARY_ID_BYTES,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Section 1: ID Generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique summary ID with the `sum_` prefix.
 *
 * Format: `sum_` + 16 hex characters (8 random bytes).
 * Example: `"sum_a1b2c3d4e5f6a7b8"`.
 */
function generateSummaryId(): string {
  return DAG_SUMMARY_ID_PREFIX + randomBytes(DAG_SUMMARY_ID_BYTES).toString("hex");
}

// ---------------------------------------------------------------------------
// Section 2: Fresh Tail Boundary
// ---------------------------------------------------------------------------

/**
 * Resolve the fresh tail boundary by counting user-assistant turn cycles.
 *
 * Walks messages backwards from the end, counting `role === "user"` occurrences
 * as turn boundaries. When `protectedTurns` user messages have been seen,
 * returns that message's `seq` as the boundary -- all messages with
 * `seq >= boundary` are protected from compaction.
 *
 * If fewer turns exist than the threshold, returns 0 (protect everything).
 *
 * @param messages - Messages sorted by seq ascending, each with `seq` and `role`
 * @param protectedTurns - Number of user-assistant turn cycles to protect
 * @returns The seq boundary; messages with seq >= this value are protected
 */
export function resolveFreshTailBoundary(
  messages: Array<{ seq: number; role: string }>,
  protectedTurns: number,
): number {
  if (protectedTurns <= 0) return Infinity;

  let turnCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { // eslint-disable-line security/detect-object-injection
      turnCount++;
      if (turnCount >= protectedTurns) {
        return messages[i].seq; // eslint-disable-line security/detect-object-injection
      }
    }
  }
  return 0; // protect everything if fewer turns than threshold
}

// ---------------------------------------------------------------------------
// Section 3: Token Chunking
// ---------------------------------------------------------------------------

/**
 * Partition messages into chunks bounded by a token budget.
 *
 * Accumulates messages into the current chunk. Starts a new chunk when adding
 * the next message would exceed `chunkTokenBudget`, but only if the current
 * chunk already has at least `minPerChunk` messages. If the final chunk has
 * fewer than `minPerChunk` messages, it is merged into the previous chunk.
 *
 * Returns an empty array if total messages < minPerChunk (caller should skip).
 *
 * @param messages - Messages with at least a `token_count` field
 * @param chunkTokenBudget - Maximum token budget per chunk
 * @param minPerChunk - Minimum messages required per chunk
 * @returns Array of message chunks
 */
function chunkByTokens<T extends { token_count: number }>(
  messages: T[],
  chunkTokenBudget: number,
  minPerChunk: number,
): T[][] {
  if (messages.length < minPerChunk) return [];

  const chunks: T[][] = [];
  let currentChunk: T[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    if (
      currentChunk.length >= minPerChunk &&
      currentTokens + msg.token_count > chunkTokenBudget
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
    currentChunk.push(msg);
    currentTokens += msg.token_count;
  }

  // Handle final chunk
  if (currentChunk.length > 0) {
    if (currentChunk.length < minPerChunk && chunks.length > 0) {
      // Merge thin final chunk into previous
      const prev = chunks[chunks.length - 1];  
      prev.push(...currentChunk);
    } else if (currentChunk.length >= minPerChunk || chunks.length === 0) {
      // Only push if it meets minimum or it's the only chunk
      // (the top-level check already ensures total >= minPerChunk)
      chunks.push(currentChunk);
    } else {
      // Less than minPerChunk and we have other chunks -- merge into last
      const prev = chunks[chunks.length - 1];  
      prev.push(...currentChunk);
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Section 4: Depth-Aware Prompts
// ---------------------------------------------------------------------------

/**
 * Get the summarization prompt for a given depth and escalation tier.
 *
 * Looks up {@link DEPTH_PROMPTS} using `Math.min(depth, 3)` -- depth 3 is the
 * "project memory" prompt used for d3+.
 *
 * @param depth - Summary depth (0 = leaf, 1 = session, 2 = phase, 3+ = project)
 * @param tier - Escalation tier ("normal" or "aggressive")
 * @returns The appropriate summarization prompt text
 */
export function getDepthPrompt(depth: number, tier: "normal" | "aggressive"): string {
  const clampedDepth = Math.min(depth, 3);
  const entry = DEPTH_PROMPTS[clampedDepth] ?? DEPTH_PROMPTS[3]; // eslint-disable-line security/detect-object-injection
  return entry[tier]; // eslint-disable-line security/detect-object-injection
}

// ---------------------------------------------------------------------------
// Section 5: Sentence-Boundary Truncation (Tier 3)
// ---------------------------------------------------------------------------

/**
 * Truncate text at a sentence boundary within the character limit.
 *
 * Scans for `/[.!?]\s/g` regex matches within `maxChars`. If a sentence
 * boundary is found, truncates there. If no boundary is found, hard-cuts
 * at `maxChars`. Appends a `[Truncated from ~N tokens]` marker.
 *
 * @param text - The text to truncate
 * @param maxChars - Maximum character count for the output
 * @returns Truncated text with truncation marker, or original text if within limit
 */
export function truncateAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const sentenceEnd = /[.!?]\s/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = sentenceEnd.exec(text)) !== null) {
    if (match.index + match[0].length > maxChars) break;
    lastEnd = match.index + match[0].length;
  }

  // If no sentence boundary found within maxChars, hard-cut
  if (lastEnd === 0) lastEnd = maxChars;

  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN_RATIO);
  return text.slice(0, lastEnd) + `\n[Truncated from ~${estimatedTokens} tokens]`;
}

// ---------------------------------------------------------------------------
// Section 6: Three-Tier Escalation
// ---------------------------------------------------------------------------

/**
 * Summarize content using three-tier escalation: normal LLM, aggressive LLM,
 * then sentence-boundary truncation.
 *
 * - **Tier 1 (normal):** Uses the normal depth prompt. Checks if the result
 *   fits within `targetTokens * overrunTolerance`. If overrun, falls through.
 * - **Tier 2 (aggressive):** Uses the aggressive depth prompt. Accepts whatever
 *   the LLM returns (no overrun check).
 * - **Tier 3 (truncation):** Sentence-boundary truncation of the source content.
 *   Zero LLM dependency -- guaranteed to succeed.
 *
 * Each tier is wrapped in try/catch -- any error falls through to the next tier.
 *
 * @param sourceContent - The raw text content to summarize
 * @param depth - Summary depth (determines which prompt template to use)
 * @param config - Escalation configuration (target tokens, overrun tolerance)
 * @param deps - Compaction dependencies (LLM function, model, token estimator)
 * @returns The summarization result with tier indicator and token count
 */
export async function summarizeWithEscalation(
  sourceContent: string,
  depth: number,
  config: EscalationConfig,
  deps: CompactionDeps,
): Promise<EscalationResult> {
  const overrunTolerance = config.overrunTolerance ?? DAG_ESCALATION_OVERRUN_TOLERANCE;

  // Tier 1: Normal prompt with overrun check
  try {
    const prompt = getDepthPrompt(depth, "normal");
    const modelInfo = deps.getModel();
    const apiKey = await modelInfo.getApiKey();
    const summary = await deps.generateSummary(
      [{ role: "user", content: sourceContent }],
      modelInfo.model,
      config.targetTokens,
      apiKey,
      undefined,
      prompt,
    );
    const tokenCount = deps.estimateTokens(summary);
    if (tokenCount <= config.targetTokens * overrunTolerance) {
      return { content: summary, tier: "normal", tokenCount };
    }
    deps.logger.debug(
      { tokenCount, target: config.targetTokens, tolerance: overrunTolerance },
      "Tier 1 summary exceeded overrun tolerance, escalating to aggressive",
    );
  } catch (err) {
    deps.logger.debug({ err }, "Tier 1 (normal) summarization failed, escalating");
  }

  // Tier 2: Aggressive prompt (no overrun check)
  try {
    const prompt = getDepthPrompt(depth, "aggressive");
    const modelInfo = deps.getModel();
    const apiKey = await modelInfo.getApiKey();
    const summary = await deps.generateSummary(
      [{ role: "user", content: sourceContent }],
      modelInfo.model,
      config.targetTokens,
      apiKey,
      undefined,
      prompt,
    );
    const tokenCount = deps.estimateTokens(summary);
    return { content: summary, tier: "aggressive", tokenCount };
  } catch (err) {
    deps.logger.debug({ err }, "Tier 2 (aggressive) summarization failed, escalating to truncation");
  }

  // Tier 3: Sentence-boundary truncation (no LLM, guaranteed success)
  const truncated = truncateAtSentenceBoundary(
    sourceContent,
    config.targetTokens * CHARS_PER_TOKEN_RATIO,
  );
  const tokenCount = deps.estimateTokens(truncated);
  return { content: truncated, tier: "truncation", tokenCount };
}

// ---------------------------------------------------------------------------
// Section 7: Leaf Pass
// ---------------------------------------------------------------------------

/**
 * Run the leaf pass: group raw messages into depth-0 summaries.
 *
 * 1. Fetch all messages for the conversation.
 * 2. Resolve the fresh tail boundary (turn-aware).
 * 3. Find already-summarized message IDs from existing depth-0 summaries.
 * 4. Filter eligible messages (before tail, not already summarized).
 * 5. Check minimum fanout threshold.
 * 6. Chunk eligible messages by token budget.
 * 7. Summarize each chunk with depth-0 prompts via three-tier escalation.
 * 8. Write summaries and message links to the store.
 *
 * @param conversationId - The conversation to compact
 * @param config - Leaf pass configuration (fanout, chunk size, target tokens, fresh tail)
 * @param deps - Compaction dependencies
 * @returns Leaf pass result with created summary count and IDs
 */
export async function runLeafPass(
  conversationId: string,
  config: LeafPassConfig,
  deps: CompactionDeps,
): Promise<LeafPassResult> {
  // Step 1: Get all messages
  const messages = deps.store.getMessagesByConversation(conversationId);

  // Step 2: Resolve fresh tail boundary (turn-aware)
  const tailBoundarySeq = resolveFreshTailBoundary(messages, config.freshTailTurns);

  // Step 3: Find already-summarized message IDs
  const existingSummaries = deps.store.getSummariesByConversation(conversationId, { depth: 0 });
  const alreadySummarized = new Set<number>();
  for (const sum of existingSummaries) {
    for (const msgId of deps.store.getSourceMessageIds(sum.summary_id)) {
      alreadySummarized.add(msgId);
    }
  }

  // Step 4: Filter eligible messages
  const eligible = messages.filter(
    m => m.seq < tailBoundarySeq && !alreadySummarized.has(m.message_id),
  );

  // Step 5: Check minimum fanout
  if (eligible.length < config.leafMinFanout) {
    deps.logger.debug(
      { eligible: eligible.length, minFanout: config.leafMinFanout, conversationId },
      "Leaf pass skipped: insufficient eligible messages",
    );
    return { created: 0, summaryIds: [], reason: "insufficient-messages" };
  }

  // Step 6: Chunk by token budget
  const chunks = chunkByTokens(eligible, config.leafChunkTokens, config.leafMinFanout);

  // Step 7-8: Summarize each chunk and write to store
  const summaryIds: string[] = [];
  for (const chunk of chunks) {
    const sourceContent = chunk
      .map(m => `[${m.created_at}] ${m.role}: ${m.content}`)
      .join("\n\n");

    try {
      const { content, tier, tokenCount } = await summarizeWithEscalation(
        sourceContent,
        0, // depth 0 = leaf
        { targetTokens: config.leafTargetTokens },
        deps,
      );

      const summaryId = generateSummaryId();
      deps.store.insertSummary({
        summaryId,
        conversationId,
        kind: "leaf",
        depth: 0,
        content,
        tokenCount,
        earliestAt: chunk[0].created_at,
        latestAt: chunk[chunk.length - 1].created_at,  
        sourceTokenCount: chunk.reduce((sum, m) => sum + m.token_count, 0),
      });
      deps.store.linkSummaryMessages(
        summaryId,
        chunk.map(m => m.message_id),
      );
      summaryIds.push(summaryId);

      deps.logger.debug(
        { summaryId, tier, tokenCount, chunkSize: chunk.length },
        "Leaf chunk summarized",
      );
    } catch (err) {
      deps.logger.warn(
        { err, chunkSize: chunk.length, hint: "Leaf chunk summarization failed; skipping chunk", errorKind: "dependency" as const },
        "Leaf pass chunk error",
      );
    }
  }

  deps.logger.info(
    { created: summaryIds.length, eligible: eligible.length, chunks: chunks.length, conversationId },
    "Leaf pass complete",
  );

  return { created: summaryIds.length, summaryIds };
}

// ---------------------------------------------------------------------------
// Section 8: Condensed Pass
// ---------------------------------------------------------------------------

/**
 * Run the condensed pass: group same-depth summaries into a depth+1 summary.
 *
 * 1. Fetch summaries at `targetDepth - 1`.
 * 2. Find already-condensed summary IDs from existing summaries at `targetDepth`.
 * 3. Filter eligible summaries (not already condensed).
 * 4. Check minimum fanout threshold.
 * 5. Build source content from eligible summaries.
 * 6. Summarize with three-tier escalation at `targetDepth`.
 * 7. Write summary and parent links to the store.
 *
 * @param conversationId - The conversation to compact
 * @param targetDepth - The depth of the new condensed summary (must be >= 1)
 * @param config - Condensed pass configuration (fanout, target tokens)
 * @param deps - Compaction dependencies
 * @returns Condensed pass result with created summary count and IDs
 */
export async function runCondensedPass(
  conversationId: string,
  targetDepth: number,
  config: CondensedPassConfig,
  deps: CompactionDeps,
): Promise<CondensedPassResult> {
  // Step 1: Get summaries at source depth
  const sourceSummaries = deps.store.getSummariesByConversation(
    conversationId,
    { depth: targetDepth - 1 },
  );

  // Step 2: Find already-condensed parent IDs
  const higherSummaries = deps.store.getSummariesByConversation(
    conversationId,
    { depth: targetDepth },
  );
  const alreadyCondensed = new Set<string>();
  for (const hs of higherSummaries) {
    for (const pid of deps.store.getParentSummaryIds(hs.summary_id)) {
      alreadyCondensed.add(pid);
    }
  }

  // Step 3: Filter eligible summaries
  const eligible = sourceSummaries.filter(s => !alreadyCondensed.has(s.summary_id));

  // Step 4: Check minimum fanout
  if (eligible.length < config.condensedMinFanout) {
    deps.logger.debug(
      { eligible: eligible.length, minFanout: config.condensedMinFanout, targetDepth, conversationId },
      "Condensed pass skipped: insufficient eligible summaries",
    );
    return { created: 0, summaryIds: [], reason: "insufficient-summaries" };
  }

  // Step 5: Build source content
  const sourceContent = eligible
    .map(s => `[${s.earliest_at} - ${s.latest_at}] (depth ${s.depth}):\n${s.content}`)
    .join("\n\n---\n\n");

  // Step 6: Summarize with escalation
  try {
    const { content, tier, tokenCount } = await summarizeWithEscalation(
      sourceContent,
      targetDepth,
      { targetTokens: config.condensedTargetTokens },
      deps,
    );

    // Step 7: Write to store
    const summaryId = generateSummaryId();
    deps.store.insertSummary({
      summaryId,
      conversationId,
      kind: "condensed",
      depth: targetDepth,
      content,
      tokenCount,
      earliestAt: eligible[0].earliest_at ?? undefined,
      latestAt: eligible[eligible.length - 1].latest_at ?? undefined,  
      sourceTokenCount: eligible.reduce((sum, s) => sum + s.token_count, 0),
    });
    deps.store.linkSummaryParents(
      summaryId,
      eligible.map(s => s.summary_id),
    );

    deps.logger.info(
      { summaryId, tier, tokenCount, sourceCount: eligible.length, targetDepth, conversationId },
      "Condensed pass complete",
    );

    return { created: 1, summaryIds: [summaryId] };
  } catch (err) {
    deps.logger.warn(
      { err, targetDepth, sourceCount: eligible.length, hint: "Condensed pass summarization failed", errorKind: "dependency" as const },
      "Condensed pass error",
    );
    return { created: 0, summaryIds: [] };
  }
}
