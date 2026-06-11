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

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import { systemNowMs } from "@comis/core";
import type { ContextLayer, TokenBudget, CompactionLayerDeps } from "./types.js";
import type { CapabilityClass } from "../executor/model-profile.js";
import { resolveCompactionStrategy } from "./compaction-capability-router.js";
import { effectiveSummarizerWindow } from "./summarizer-window.js";
import { isSecurityRelevantMessage } from "./security-context-pinner.js";
import type { SecurityPinMarkers } from "./security-context-pinner.js";
import {
  COMPACTION_TRIGGER_PERCENT,
  COMPACTION_MAX_RETRIES,
  OVERSIZED_MESSAGE_CHARS_THRESHOLD,
  COMPACTION_REQUIRED_SECTIONS,
  CHARS_PER_TOKEN_RATIO,
  MIN_MIDDLE_MESSAGES_FOR_COMPACTION,
  CACHE_AWARE_COMPACTION_BLOCK_THRESHOLD,
  SUMMARIZER_PROMPT_OVERHEAD_TOKENS,
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
  // C4: capability-routed compaction
  /** The agent's capability class (from ModelProfile). Defaults to "frontier" (unchanged behavior). */
  capabilityClass?: CapabilityClass;
  /** Route small/nano to eviction instead of LLM summarization. Defaults to true. */
  preferEvictionByCapability?: boolean;
  /** If set, small/nano use this stronger model for summarization instead of eviction. */
  strongerSummarizerModel?: string;
  // S4: security context pinning
  /** Security pin markers for identifying messages that must never be evicted. */
  securityMarkers?: SecurityPinMarkers;
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
 * Inserts a compaction summary message immediately after the preserved head
 * (or at the very front when `headCount === 0`), removes EXACTLY the message
 * entries named by `removeMessageOrdinals`, and calls `_rewriteFile()` once.
 *
 * Review WR-01: removal is by IDENTITY — the caller passes the file-order
 * message ordinals of the SUMMARIZED span — never by count. The previous
 * count-based removal took the first (pinned + span) middle entries
 * positionally, which deleted un-summarized REMAINDER entries from the durable
 * session file whenever an S4-pinned message sat later in the middle: durable
 * history deletion the summary does not cover (Pitfall 3). With identity
 * removal, pinned messages AND the remainder survive in the file regardless of
 * interleaving; only content the summary actually covers is removed.
 *
 * This is safe because `transformContext` runs within the `withSession()` write lock.
 */
function persistCompaction(
  sm: unknown,
  summaryText: string,
  removeMessageOrdinals: ReadonlySet<number>,
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

  // Single walk over fileEntries: drop the named message ordinals, insert the
  // compaction entry immediately after the headCount-th message entry (the
  // pre-existing placement), or prepend when there is no preserved head.
  const newEntries: unknown[] = [];
  let inserted = false;
  if (headCount === 0) {
    newEntries.push(compactionEntry);
    inserted = true;
  }
  let ordinal = 0; // index among MESSAGE entries, file order
  for (const entry of fileEntries) {
    if ((entry as { type?: string }).type === "message") {
      if (!removeMessageOrdinals.has(ordinal)) newEntries.push(entry);
      ordinal++;
      if (ordinal === headCount && !inserted) {
        newEntries.push(compactionEntry);
        inserted = true;
      }
    } else {
      newEntries.push(entry);
    }
  }
  // Defensive: fewer message entries than headCount — append at the end.
  if (!inserted) newEntries.push(compactionEntry);

  // Replace fileEntries in-place
  fileEntries.length = 0;
  fileEntries.push(...newEntries);

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

        // Step 4: Resolve model. INT-W1: the served-window truth rides the SAME
        // branch as the model selection (gated per candidate at the wiring site).
        /* eslint-disable @typescript-eslint/no-explicit-any */
        let model: any;
        let apiKey: string;
        let servedSummarizerWindow: number | undefined;
        if (deps.overrideModel) {
          try {
            model = deps.overrideModel.model;
            apiKey = await deps.overrideModel.getApiKey();
            servedSummarizerWindow = deps.overrideModel.servedWindow;
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
            servedSummarizerWindow = deps.primaryServedWindow;
          }
        } else {
          model = deps.getModel();
          apiKey = await deps.getApiKey();
          servedSummarizerWindow = deps.primaryServedWindow;
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

        // Skip if middle is empty or too small to warrant summarization.
        // Reset the cooldown counter so we don't re-evaluate (and re-warn)
        // on every subsequent turn when the conversation shape stays this way.
        if (middleMessages.length < MIN_MIDDLE_MESSAGES_FOR_COMPACTION) {
          turnsSinceLastCompaction = 0;
          return messages;
        }

        // S4: filter security-pinned messages out of the middle zone.
        // pinned[] is hoisted to outer scope so the output assembly can re-insert them
        // (see result assembly below — S4 invariant: pinned messages MUST appear in output).
        // Must run before the capability gate so pinnedCount is accurate for the event.
        const pinned: AgentMessage[] = [];
        let evictableMiddle = middleMessages;
        let securityPinnedCount = 0;
        if (config.securityMarkers) {
          const evictable: AgentMessage[] = [];
          for (const m of middleMessages) {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            if (isSecurityRelevantMessage(m as any, config.securityMarkers!)) {
              pinned.push(m);
            } else {
              evictable.push(m);
            }
            /* eslint-enable @typescript-eslint/no-explicit-any */
          }
          securityPinnedCount = pinned.length;
          evictableMiddle = evictable;
        }

        // C4: resolve the compaction strategy based on capability class.
        const compactionStrategy = resolveCompactionStrategy(
          config.capabilityClass ?? "frontier",
          config.preferEvictionByCapability ?? true,
          config.strongerSummarizerModel ?? "",
        );

        if (compactionStrategy === "eviction" || compactionStrategy === "deterministic") {
          // Small/nano: skip LLM call — use deterministic Level-3 fallback.
          deps.logger.warn(
            {
              submodule: "llm-compaction",
              hint: `C4: capabilityClass=${config.capabilityClass ?? "frontier"} prefers eviction over LLM summarization — using deterministic fallback. Configure contextEngine.compaction.strongerSummarizerModel for LLM-quality summaries.`,
              errorKind: "config" as const,
              capabilityClass: config.capabilityClass ?? "frontier",
              strategy: compactionStrategy,
            },
            "C4: compaction capability gate — eviction selected",
          );
          // Emit context:compaction_routed event
          if (deps.eventBus && deps.agentId && deps.sessionKey) {
            deps.eventBus.emit("context:compaction_routed", {
              agentId: deps.agentId,
              sessionKey: deps.sessionKey,
              capabilityClass: config.capabilityClass ?? "frontier",
              strategy: compactionStrategy,
              layer: "pipeline",
              securityPinnedCount,
              timestamp: systemNowMs(),
            });
          }
          // Return messages unchanged (eviction: no summarization, no structural change).
          // Reset cooldown so we re-evaluate next turn (the capability gate may change).
          turnsSinceLastCompaction = 0;
          return messages;
        }

        // SUMW-01 (Phase 178): clamp the summarized span to the RESOLVED
        // summarizer's window. Reads the LOCAL `model` resolved at Step 4 — the
        // SAME variable handed to generateSummary (the try/catch override
        // fallback already decided which model summarizes; re-resolving here
        // could disagree — Pitfall 2). With an `operationModels.compaction`
        // override the summarizer's window (e.g. 8K) can be far smaller than
        // the middle zone — feeding the whole span is a provider overflow.
        // INT-W1: the configured window is min()'d with the Phase-176 SERVED
        // window bound to the SAME Step-4 candidate (a served-bound PRIMARY —
        // num_ctx 8_192 under a configured 131_072 — clamps too, not just
        // overrides). Neither valid → clamp OFF (never invent a window). The 85%
        // trigger + cooldown re-fire until the remainder backlog drains (the
        // cut===0 escalation guarantees every evaluation makes progress).
        const summarizerWindow = effectiveSummarizerWindow(
          (model as { contextWindow?: number } | undefined)?.contextWindow, servedSummarizerWindow,
        );
        // Review CR-01: the summary-output reserve must be SUMMARIZER-sized, not
        // session-sized — subtracting the session's outputReserveTokens (8_192 on
        // any frontier session) from an 8K summarizer's window goes permanently
        // negative and silently disables compaction forever (a regression vs the
        // pre-clamp Level-2/3 floor). Reserve at most a QUARTER of the resolved
        // summarizer's own window, and pass the SAME value to compactWithFallback
        // below so the clamp and the generateSummary reserveTokens agree.
        const summaryReserve =
          summarizerWindow === undefined
            ? budget.outputReserveTokens
            : Math.min(budget.outputReserveTokens, Math.max(1, Math.floor(summarizerWindow / 4)));
        let spanToSummarize = evictableMiddle;
        let remainingMiddle: AgentMessage[] = [];
        if (summarizerWindow !== undefined) {
          const maxSpanTokens =
            summarizerWindow - summaryReserve - SUMMARIZER_PROMPT_OVERHEAD_TOKENS;
          // Oldest-first prefix walk over the evictable middle: cut at the
          // first message that would exceed maxSpanTokens. Review WR-04: each
          // message is measured with the SAME dual-ratio estimate the layer's
          // own 85% trigger uses (toolResult chars weighted ×2 before the 3.5
          // divide) — a flat chars/3.5 walk under-counts structured content by
          // ~15-17%, re-opening the provider-overflow class on toolResult-heavy
          // middles. One estimator per layer (single-sourced with the trigger).
          let spanTokens = 0;
          let cut = 0;
          for (const m of evictableMiddle) {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const msgTokens = Math.ceil(
              estimateContextCharsWithDualRatio([m] as any) / CHARS_PER_TOKEN_RATIO,
            );
            /* eslint-enable @typescript-eslint/no-explicit-any */
            if (spanTokens + msgTokens > maxSpanTokens) break;
            spanTokens += msgTokens;
            cut++;
          }
          if (cut === 0) {
            // Review CR-01 (convergence): even the OLDEST evictable message alone
            // exceeds the span budget (or the window is below reserve + overhead).
            // Skipping here would disarm compaction PERMANENTLY — the oldest
            // message never leaves the middle's head, so every later evaluation
            // takes the same exit while context grows unboundedly. Instead feed
            // that ONE message to compactWithFallback and let its pre-existing
            // escalation bound it (Level 2 filters oversized messages; Level 3 is
            // the guaranteed-shrink count-only note) — degraded but ALWAYS
            // shrinking, exactly the pre-clamp floor. DEBUG, counts/window only.
            deps.logger.debug(
              {
                step: "compaction-span-clamp",
                summarizerWindow,
                maxSpanTokens,
                middleMessages: evictableMiddle.length,
              },
              "Compaction span clamp: oldest middle message exceeds the summarizer budget; escalating one message through the fallback ladder",
            );
            cut = 1;
          }
          if (cut < evictableMiddle.length) {
            spanToSummarize = evictableMiddle.slice(0, cut);
            remainingMiddle = evictableMiddle.slice(cut);
            deps.logger.debug(
              {
                step: "compaction-span-clamp",
                spanMessages: spanToSummarize.length,
                remainingMessages: remainingMiddle.length,
                summarizerWindow,
                maxSpanTokens,
              },
              "Compaction span clamped to the resolved summarizer window",
            );
          }
        }

        // Emit compaction_routed for llm/strong-summarizer paths too (for observability)
        if (deps.eventBus && deps.agentId && deps.sessionKey) {
          deps.eventBus.emit("context:compaction_routed", {
            agentId: deps.agentId,
            sessionKey: deps.sessionKey,
            capabilityClass: config.capabilityClass ?? "frontier",
            strategy: compactionStrategy,
            layer: "pipeline",
            securityPinnedCount,
            timestamp: systemNowMs(),
          });
        }

        // Trigger log fires only when compaction will actually run, so log
        // volume reflects real compaction work (not infeasibility re-checks).
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

        // Step 7: Summarize ONLY the clamped middle span (do NOT pass head or tail
        // to generateSummary). spanToSummarize is the SUMW-01 oldest-first prefix of
        // evictableMiddle that fits the resolved summarizer's window (security-pinned
        // messages already excluded via S4 filtering above); when the clamp does not
        // bind it IS evictableMiddle. summaryReserve is the SAME summarizer-sized
        // reserve the clamp budgeted (review CR-01) — clamp and call always agree.
        const compactionResult = await compactWithFallback(
          spanToSummarize,
          model,
          apiKey,
          summaryReserve,
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

        // Assemble: head + pinned + summary + remainingMiddle + tail
        // S4: pinned messages from the middle zone are excluded from summarization
        // but MUST be preserved in the output so they are never evicted from context.
        // They are placed before the summary (surviving context, not part of the summary).
        // SUMW-01: the un-summarized remainder of the middle zone is NEVER dropped
        // (Pitfall 3 — a dropped remainder is silent, unrecoverable history deletion);
        // it sits between the summary and the tail in original order. When the clamp
        // does not bind, remainingMiddle is [] → output identical to before SUMW-01.
        // head stays at original positions for cache prefix stability.
        const headMessages = messages.slice(0, headEndIndex);
        const tailMessages = messages.slice(tailStartIndex);
        const result = [
          ...headMessages,
          ...pinned,
          summaryMessage,
          ...remainingMiddle,
          ...tailMessages,
        ];

        // Step 8: Persist compaction to SessionManager
        // SUMW-01 / review WR-01: durable-side conservation is by IDENTITY —
        // messages[i] corresponds 1:1 to the i-th message entry in fileEntries
        // (the positional model the head/tail counts already relied on), so we
        // remove EXACTLY the summarized span's entries. Pinned messages and the
        // un-summarized remainder survive in the durable file regardless of how
        // they interleave; removing anything else would be durable history
        // deletion the summary does not cover (the Pitfall-3 data loss).
        try {
          const sm = deps.getSessionManager();
          if (sm) {
            const spanSet = new Set(spanToSummarize);
            const removeMessageOrdinals = new Set<number>();
            /* eslint-disable security/detect-object-injection -- array index access */
            for (let i = headEndIndex; i < tailStartIndex; i++) {
              if (spanSet.has(messages[i]!)) removeMessageOrdinals.add(i);
            }
            /* eslint-enable security/detect-object-injection */
            persistCompaction(
              sm,
              compactionResult.summary,
              removeMessageOrdinals,
              headMessages.length,
              discoveredTools,
            );
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
            // SUMW-01: counts reflect the CLAMPED span actually summarized, plus
            // the preserved un-summarized remainder (counts only — never content).
            middleSummarized: spanToSummarize.length,
            middleRemainder: remainingMiddle.length,
            securityPinnedCount,
          },
          "LLM compaction complete",
        );

        // Report compaction stats via callback
        deps.onCompacted?.({
          fallbackLevel: compactionResult.level,
          attempts: compactionResult.attempts,
          originalMessages: messages.length,
          keptMessages: headMessages.length + remainingMiddle.length + tailMessages.length,
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
