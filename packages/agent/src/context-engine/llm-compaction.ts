// SPDX-License-Identifier: Apache-2.0
/**
 * LLM compaction context engine layer.
 *
 * "Last resort" layer that triggers when context exceeds 85% of the model
 * context window (after observation masking has run in the pipeline). Delegates
 * to the SDK's `generateSummary()` with Comis-specific structured output
 * instructions requiring 9 named sections, validates the summary quality with
 * retry, and falls back through three levels:
 *
 * 1. Full summarization with structured output validation (up to 3 attempts)
 * 2. Exclude oversized messages and summarize (best-effort, no validation)
 * 3. Count-only note (guaranteed success, no LLM call)
 *
 * Cooldown prevents re-triggering within N turns of the last compaction.
 * Optional model override allows using a cheaper model for summarization.
 *
 * - Trigger at 85% of model window after observation masking
 * - SDK generateSummary with customInstructions for structured output
 * - Three-level fallback (full -> filtered -> count-only)
 * - Configurable cooldown (default 5 turns)
 * - Quality validation with retry (max 2 retries)
 * - Optional cheaper model override with fallback to session model
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { generateSummary } from "@mariozechner/pi-coding-agent";
import type { ContextLayer, TokenBudget, CompactionLayerDeps } from "./types.js";
import {
  COMPACTION_TRIGGER_PERCENT,
  COMPACTION_MAX_RETRIES,
  OVERSIZED_MESSAGE_CHARS_THRESHOLD,
  COMPACTION_REQUIRED_SECTIONS,
  CHARS_PER_TOKEN_RATIO,
  MIN_MIDDLE_MESSAGES_FOR_COMPACTION,
  CACHE_AWARE_COMPACTION_BLOCK_THRESHOLD,
} from "./constants.js";
import {
  estimateContextCharsWithDualRatio,
  estimateMessageChars,
  estimateWithAnchor,
} from "../safety/token-estimator.js";

// ---------------------------------------------------------------------------
// Compaction config subset
// ---------------------------------------------------------------------------

/** Compaction layer config (subset of ContextEngineConfig relevant to compaction). */
export interface CompactionLayerConfig {
  /** Turns to wait before re-triggering compaction. */
  compactionCooldownTurns: number;
  /** Number of user-turn cycles at conversation head to preserve during compaction.
   *  0 = old behavior (tail-only). */
  compactionPrefixAnchorTurns: number;
}

// ---------------------------------------------------------------------------
// Structured output instructions
// ---------------------------------------------------------------------------

/**
 * Build the Comis-specific structured output instructions for generateSummary.
 *
 * Appended to the SDK's base summarization prompt via the `customInstructions`
 * parameter. Requires 9 named sections with fallback "(none)" for empty sections.
 */
function buildComisCompactionInstructions(): string {
  return `Your summary MUST include ALL of the following sections. If a section has no content, write "(none)".

## Identifiers
- Session participants, agent ID, channel context, platform-specific thread IDs

## Primary Request and Intent
- The user's core request that started the conversation — what they actually want accomplished. Preserve the original phrasing.

## Decisions
- Key decisions made during this conversation, with rationale for each

## Files and Code
- File paths, function names, code snippets, URLs, and configuration values mentioned. Preserve actual code snippets verbatim when short (<10 lines). Include file paths with line numbers when referenced.

## Errors and Resolutions
- Error messages encountered AND their resolutions or workarounds. For unresolved errors, note what was tried.

## User Messages
- Verbatim user messages that contain instructions, preferences, or corrections. Preserve exact wording — do not paraphrase.

## Constraints
- User-stated constraints, preferences, requirements, and boundaries

## Active Work
- Currently in-progress work items and what is actively being worked on right now

## Next Steps
- Ordered list of what should happen next`;
}

// ---------------------------------------------------------------------------
// Quality validation
// ---------------------------------------------------------------------------

/**
 * Validate that a compaction summary contains all required sections.
 *
 * Checks for `## SectionName` headings (case-insensitive) for each entry
 * in COMPACTION_REQUIRED_SECTIONS.
 */
export function validateCompactionSummary(summary: string): {
  valid: boolean;
  missingSections: string[];
} {
  const lowerSummary = summary.toLowerCase();
  const missing: string[] = [];
  for (const section of COMPACTION_REQUIRED_SECTIONS) {
    if (!lowerSummary.includes(`## ${section.toLowerCase()}`)) {
      missing.push(section);
    }
  }
  return {
    valid: missing.length === 0,
    missingSections: missing,
  };
}

// ---------------------------------------------------------------------------
// Session persistence helpers
// ---------------------------------------------------------------------------

/**
 * Persist a compaction entry to the SessionManager's fileEntries.
 *
 * Creates a compaction summary message at the beginning of the session,
 * removes old entries before the cut point, and calls `_rewriteFile()` once.
 *
 * This is safe because `transformContext` runs within the `withSession()` write lock.
 */
function persistCompaction(
  sm: unknown,
  summaryText: string,
  keptTailCount: number,
  headCount: number,
  discoveredTools: string[],
): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sessionManager = sm as any;
  const fileEntries = sessionManager.fileEntries;
  if (!Array.isArray(fileEntries)) return;

  // Build compaction summary entry matching SDK format (detected by isCompactionSummary)
  const compactionEntry = {
    type: "message",
    message: {
      role: "user",
      compactionSummary: true,
      content: [{ type: "text", text: `<summary>\n${summaryText}\n</summary>` }],
      discoveredTools,
    },
  };

  // Calculate which message entries to remove: only the MIDDLE zone.
  // Preserve: first `headCount` message entries + last `keptTailCount` message entries.
  const messageEntries = fileEntries.filter((e: any) => e.type === "message");
  const entriesToRemove = messageEntries.length - headCount - keptTailCount;

  if (entriesToRemove > 0) {
    // Find indices of middle message entries to remove (skip first headCount, remove next entriesToRemove)
    let messagesSeen = 0;
    let removedCount = 0;
    const indicesToRemove = new Set<number>();
    for (let i = 0; i < fileEntries.length && removedCount < entriesToRemove; i++) {
      if (fileEntries[i].type === "message") { // eslint-disable-line security/detect-object-injection
        messagesSeen++;
        // Skip head entries (first headCount message entries)
        if (messagesSeen > headCount) {
          indicesToRemove.add(i);
          removedCount++;
        }
      }
    }

    // Build new fileEntries: preserved head + compaction entry + non-removed tail
    // Insert the compaction entry after the last preserved head message entry
    let lastHeadMsgIdx = -1;
    let headMsgsSeen = 0;
    for (let i = 0; i < fileEntries.length; i++) {
      if (fileEntries[i].type === "message") { // eslint-disable-line security/detect-object-injection
        headMsgsSeen++;
        if (headMsgsSeen <= headCount) lastHeadMsgIdx = i;
        else break;
      }
    }

    const newEntries: unknown[] = [];
    for (let i = 0; i < fileEntries.length; i++) {
      if (!indicesToRemove.has(i)) {
        newEntries.push(fileEntries[i]); // eslint-disable-line security/detect-object-injection
      }
      // Insert compaction entry after the last head message entry
      if (i === lastHeadMsgIdx) {
        newEntries.push(compactionEntry);
      }
    }

    // If no head messages (headCount=0), prepend compaction entry
    if (headCount === 0 && !newEntries.includes(compactionEntry)) {
      newEntries.unshift(compactionEntry);
    }

    // Replace fileEntries in-place
    fileEntries.length = 0;
    fileEntries.push(...newEntries);
  } else {
    // No entries to remove -- insert compaction entry after head
    if (headCount > 0) {
      let headMsgsSeen = 0;
      let insertIdx = 0;
      for (let i = 0; i < fileEntries.length; i++) {
        if (fileEntries[i].type === "message") { // eslint-disable-line security/detect-object-injection
          headMsgsSeen++;
          if (headMsgsSeen === headCount) {
            insertIdx = i + 1;
            break;
          }
        }
      }
      fileEntries.splice(insertIdx, 0, compactionEntry);
    } else {
      fileEntries.unshift(compactionEntry);
    }
  }

  if (typeof sessionManager._rewriteFile === "function") {
    sessionManager._rewriteFile();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ---------------------------------------------------------------------------
// Three-zone partitioning helpers
// ---------------------------------------------------------------------------

/**
 * Extend head boundary forward to include trailing tool_use/tool_result exchanges.
 * If the last message in the head zone is a user message followed by an assistant
 * with tool_use calls, extend to include the assistant + all matching tool_results.
 * This prevents orphaned tool results in the middle zone.
 */
function extendHeadForPairSafety(
  messages: AgentMessage[],
  headEndIndex: number,
): number {
  let extended = headEndIndex;
  while (extended < messages.length) {
    const msg = messages[extended]!;
    // If next message is an assistant with tool_use, include it
    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const hasToolUse = content.some(
        (block: any) => block.type === "tool_use" || block.type === "toolCall",
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (hasToolUse) {
        extended++;
        // Include all subsequent tool_result messages
        while (
          extended < messages.length &&
          messages[extended]!.role === "toolResult"
        ) {
          extended++;
        }
        continue;
      }
    }
    break;
  }
  return extended;
}

/**
 * Estimate total chars for a range of messages [startIdx, endIdx).
 */
function estimateRangeChars(
  messages: AgentMessage[],
  startIdx: number,
  endIdx: number,
): number {
  let total = 0;
  for (let i = startIdx; i < endIdx; i++) {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    total += estimateMessageChars(messages[i] as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  return total;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an LLM compaction context layer.
 *
 * @param config - Compaction configuration (cooldown turns)
 * @param deps - Compaction layer dependencies (logger, model, apiKey, sessionManager)
 * @returns ContextLayer that compacts context when above 85% threshold
 */
export function createLlmCompactionLayer(
  config: CompactionLayerConfig,
  deps: CompactionLayerDeps,
): ContextLayer {
  // Closure state for cooldown tracking
  let turnsSinceLastCompaction = Infinity; // Start at Infinity so first trigger is immediate

  return {
    name: "llm-compaction",

    async apply(messages: AgentMessage[], budget: TokenBudget): Promise<AgentMessage[]> {
      try {
        // Step 1: Increment turn counter
        turnsSinceLastCompaction++;

        // Step 2: Cooldown check
        if (turnsSinceLastCompaction < config.compactionCooldownTurns) {
          return messages;
        }

        // Step 2b: Cache-aware block count trigger.
        // Fires BEFORE the token-based threshold because lookback overflow
        // causes cache breaks regardless of how few tokens the messages contain.
        const messageCount = messages.length;
        const blockThreshold = CACHE_AWARE_COMPACTION_BLOCK_THRESHOLD;
        const blockCountExceeded = messageCount > blockThreshold;

        // Step 3: Token threshold check (only when block-count trigger didn't fire)
        let contextTokens: number | undefined;
        let thresholdTokens: number | undefined;
        if (!blockCountExceeded) {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const contextChars = estimateContextCharsWithDualRatio(messages as any);
          /* eslint-enable @typescript-eslint/no-explicit-any */
          const charBasedTokens = Math.ceil(contextChars / CHARS_PER_TOKEN_RATIO);
          const anchor = deps.getTokenAnchor?.() ?? null;
          contextTokens = estimateWithAnchor(anchor, messages as unknown as Message[], charBasedTokens);
          thresholdTokens = Math.floor(budget.windowTokens * COMPACTION_TRIGGER_PERCENT / 100);

          if (contextTokens <= thresholdTokens) {
            return messages;
          }
        }

        // Step 4: Unified log (conditional spread keeps JSON shape clean).
        deps.logger.warn(
          {
            messageCount,
            ...(blockCountExceeded
              ? { blockThreshold, trigger: "block_count" as const }
              : { contextTokens, thresholdTokens, trigger: "token_threshold" as const }),
            windowTokens: budget.windowTokens,
            errorKind: "resource" as const,
            hint: blockCountExceeded
              ? "Message count approaching breakpoint lookback limit; compacting to prevent cache fragmentation"
              : "Context approaching capacity; LLM compaction will summarize older messages to free space",
          },
          blockCountExceeded
            ? "LLM compaction triggered: message count exceeds cache lookback threshold"
            : "LLM compaction triggered: context exceeds 85% threshold",
        );

        // Step 5: Resolve model
        /* eslint-disable @typescript-eslint/no-explicit-any */
        let model: any;
        let apiKey: string;
        if (deps.overrideModel) {
          try {
            model = deps.overrideModel.model;
            apiKey = await deps.overrideModel.getApiKey();
          } catch (overrideErr) {
            deps.logger.warn(
              {
                err: overrideErr,
                hint: "Compaction model override failed; falling back to session model",
                errorKind: "dependency" as const,
              },
              "Compaction model override resolution failed",
            );
            model = deps.getModel();
            apiKey = await deps.getApiKey();
          }
        } else {
          model = deps.getModel();
          apiKey = await deps.getApiKey();
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */

        // Step 6: Three-zone partitioning for cache-preserving compaction
        const budgetChars = budget.availableHistoryTokens * CHARS_PER_TOKEN_RATIO;
        const prefixAnchorTurns = config.compactionPrefixAnchorTurns;

        // Zone 1: Preserved head (first N user-turn cycles)
        let headEndIndex = 0;
        if (prefixAnchorTurns > 0) {
          let userTurnsSeen = 0;
          /* eslint-disable security/detect-object-injection -- array index access */
          for (let i = 0; i < messages.length; i++) {
            if (messages[i]!.role === "user") userTurnsSeen++;
            if (userTurnsSeen > prefixAnchorTurns) break;
            headEndIndex = i + 1;
          }
          /* eslint-enable security/detect-object-injection */
          // Extend head to include trailing tool exchanges (pair safety)
          headEndIndex = extendHeadForPairSafety(messages, headEndIndex);
        }

        // Head budget check: if head alone exceeds budget, fall back to tail-only
        const headChars = headEndIndex > 0 ? estimateRangeChars(messages, 0, headEndIndex) : 0;
        if (headChars >= budgetChars && prefixAnchorTurns > 0) {
          deps.logger.warn(
            {
              headChars,
              budgetChars,
              prefixAnchorTurns,
              hint: "Head exceeds budget; falling back to tail-only compaction",
              errorKind: "resource" as const,
            },
            "Cache-preserving compaction fallback to tail-only",
          );
          headEndIndex = 0;
        }

        // Zone 3: Preserved tail (recent messages fitting remaining budget)
        const tailBudgetChars = budgetChars - (headEndIndex > 0 ? headChars : 0);
        let tailStartIndex = messages.length;
        let tailChars = 0;
        /* eslint-disable security/detect-object-injection -- array index access */
        for (let i = messages.length - 1; i >= headEndIndex; i--) {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const msgChars = estimateMessageChars(messages[i] as any);
          /* eslint-enable @typescript-eslint/no-explicit-any */
          if (tailChars + msgChars > tailBudgetChars) break;
          tailChars += msgChars;
          tailStartIndex = i;
        }
        /* eslint-enable security/detect-object-injection */

        // Zone 2: Middle (to be summarized)
        const middleMessages = messages.slice(headEndIndex, tailStartIndex);

        // Skip if middle is empty or too small to warrant summarization
        if (middleMessages.length < MIN_MIDDLE_MESSAGES_FOR_COMPACTION) {
          return messages;
        }

        // Step 7: Summarize ONLY the middle zone (do NOT pass head or tail to generateSummary)
        const compactionResult = await compactWithFallback(
          middleMessages,
          model,
          apiKey,
          budget.outputReserveTokens,
          deps.logger,
        );

        // Build compaction summary message matching SDK format
        const discoveredTools = deps.getDiscoveredTools?.() ?? [];
        const summaryMessage: AgentMessage = {
          role: "user",
          content: [{ type: "text", text: `<summary>\n${compactionResult.summary}\n</summary>` }],
          compactionSummary: true,
          discoveredTools,
        } as unknown as AgentMessage;

        // Assemble: head + summary + tail (head stays at original positions for cache prefix)
        const headMessages = messages.slice(0, headEndIndex);
        const tailMessages = messages.slice(tailStartIndex);
        const result = [...headMessages, summaryMessage, ...tailMessages];

        // Step 8: Persist compaction to SessionManager
        try {
          const sm = deps.getSessionManager();
          if (sm) {
            persistCompaction(sm, compactionResult.summary, tailMessages.length, headMessages.length, discoveredTools);
          }
        } catch {
          // Persistent write-back is best-effort
        }

        // Step 9: Reset cooldown
        turnsSinceLastCompaction = 0;

        deps.logger.info(
          {
            fallbackLevel: compactionResult.level,
            attempts: compactionResult.attempts,
            originalMessages: messages.length,
            keptHeadMessages: headMessages.length,
            keptTailMessages: tailMessages.length,
            middleSummarized: middleMessages.length,
          },
          "LLM compaction complete",
        );

        // Report compaction stats via callback
        deps.onCompacted?.({
          fallbackLevel: compactionResult.level,
          attempts: compactionResult.attempts,
          originalMessages: messages.length,
          keptMessages: headMessages.length + tailMessages.length,
        });

        return result;
      } catch (err) {
        // Safety net: compaction must never crash the pipeline
        deps.logger.warn(
          {
            err,
            hint: "LLM compaction failed; returning unmodified context",
            errorKind: "dependency" as const,
          },
          "LLM compaction layer error",
        );
        return messages;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Three-level fallback
// ---------------------------------------------------------------------------

/**
 * Attempt compaction through three fallback levels.
 *
 * Level 1: Full summarization with quality validation (up to 3 attempts)
 * Level 2: Filter oversized messages, then summarize (best-effort)
 * Level 3: Count-only note (guaranteed, no LLM call)
 */
async function compactWithFallback(
  messages: AgentMessage[],
  model: unknown,
  apiKey: string,
  reserveTokens: number,
  logger: CompactionLayerDeps["logger"],
): Promise<{ summary: string; level: 1 | 2 | 3; attempts: number }> {
  const instructions = buildComisCompactionInstructions();
  let totalAttempts = 0;

  // Level 1: Full summarization with structured output
  const maxAttempts = 1 + COMPACTION_MAX_RETRIES; // 1 initial + 2 retries = 3
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    totalAttempts++;
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const summary = await generateSummary(
        messages, model as any, reserveTokens, apiKey,
        undefined, undefined, instructions,
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */
      const validation = validateCompactionSummary(summary);
      if (validation.valid) {
        return { summary, level: 1, attempts: totalAttempts };
      }
      logger.warn(
        { missingSections: validation.missingSections, attempt },
        "Compaction summary missing sections, retrying",
      );
    } catch (err) {
      logger.warn({ err, attempt }, "Compaction summarization failed");
    }
  }

  // Level 2: Exclude oversized messages
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const filteredMessages = messages.filter(
    (m) => estimateMessageChars(m as any) < OVERSIZED_MESSAGE_CHARS_THRESHOLD,
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (filteredMessages.length > 0) {
    totalAttempts++;
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const summary = await generateSummary(
        filteredMessages, model as any, reserveTokens, apiKey,
        undefined, undefined, instructions,
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */
      // Skip validation on Level 2 (best-effort)
      return { summary, level: 2, attempts: totalAttempts };
    } catch {
      // Fall through to Level 3
    }
  }

  // Level 3: Count-only note (guaranteed success)
  totalAttempts++;
  const summary =
    `[Context compacted: ${messages.length} messages summarized. ` +
    `No LLM summary available. Recent messages retained.]`;
  return { summary, level: 3, attempts: totalAttempts };
}
