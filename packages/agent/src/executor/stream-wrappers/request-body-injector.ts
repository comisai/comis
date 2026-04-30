// SPDX-License-Identifier: Apache-2.0
/**
 * Request body injector stream wrapper.
 *
 * Mutates the outgoing request body via the onPayload hook. Consolidates:
 * 1. Cache breakpoints (Anthropic-family): cache_control markers
 * 2. 1M beta header (direct Anthropic only)
 * 3. service_tier (Responses API + fastMode)
 * 4. store (Responses API + storeCompletions)
 *
 * Cache breakpoints:
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { CacheRetention, Message } from "@mariozechner/pi-ai";
import type { ComisLogger } from "@comis/infra";

import type { StreamFnWrapper } from "./types.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, resolveBreakpointStrategy } from "./config-resolver.js";
import type { SessionLatch, AccumulativeLatch } from "../session-latch.js";
import { createAccumulativeLatch } from "../session-latch.js";
import { MIN_CACHEABLE_TOKENS, DEFAULT_MIN_CACHEABLE_TOKENS, CHARS_PER_TOKEN_RATIO, CHARS_PER_TOKEN_RATIO_STRUCTURED, CACHE_LOOKBACK_WINDOW } from "../../context-engine/index.js";
import { isAnthropicFamily } from "../../provider/capabilities.js";
import { estimateContextChars } from "../../safety/token-estimator.js";
import { computeHash, djb2 } from "../cache-break-detection.js";
import type { BlockStabilityTracker } from "../block-stability-tracker.js";
import { supportsToolSearch } from "../tool-deferral.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the request body injector wrapper.
 * Controls cache breakpoints, 1M beta header, service_tier, and store injection.
 */
export interface RequestBodyInjectorConfig {
  /** Getter for per-execution cache retention override. */
  getCacheRetention: () => CacheRetention | undefined;
  /** Getter for conversation message retention. When provided, conversation
   *  breakpoints use this retention instead of getCacheRetention().
   *  Returns "short" for adaptive retention -- conversation content shifts every turn. */
  getMessageRetention?: () => CacheRetention | undefined;
  /** When true, inject service_tier: "auto" for Responses API providers. */
  fastMode?: boolean;
  /** When true, inject store: true for Responses API providers. */
  storeCompletions?: boolean;
  /** Callback invoked after cache breakpoints are placed.
   *  Receives the highest message index that has a cache_control marker.
   *  Used to set the cache fence for the next context engine run. */
  onBreakpointsPlaced?: (highestBreakpointIndex: number) => void;
  /** Optional getter overriding the per-model minTokens threshold.
   *  Used to lower the threshold for sub-agent executions where sessions are short
   *  but system prompt + tools are still worth caching. */
  getMinTokensOverride?: () => number | undefined;
  /** Callback invoked with the API-ready payload after cache breakpoint
   *  placement. Used by cache break detector Phase 1 to extract prompt state for
   *  change detection. Receives the mutated params, the model, and (for Anthropic) the HTTP headers. */
  onPayloadForCacheDetection?: (
    params: Record<string, unknown>,
    model: { id: string; provider: string },
    headers?: Record<string, string>,
  ) => void;
  /** Getter for structured system prompt blocks. Returns the blocks
   *  produced by assembleRichSystemPromptBlocks() when available, or undefined
   *  if blocks are not yet assembled (first call before prompt assembly completes). */
  getSystemPromptBlocks?: () => { staticPrefix: string; attribution: string; semiStableBody: string } | undefined;
  /** Breakpoint strategy -- "auto" (default), "multi-zone", or "single". */
  cacheBreakpointStrategy?: "auto" | "multi-zone" | "single";
  /** Skip cache_control on final messages for sub-agent spawns. */
  skipCacheWrite?: boolean;
  /** 2.1: Timestamp (ms since epoch) of the parent's last confirmed cache write.
   *  Used by the TTL expiry guard to disable skipCacheWrite when the shared prefix
   *  cache has likely expired (>80% of TTL elapsed). */
  cacheWriteTimestamp?: number;
  /** 2.1: Parent's cache retention tier ("short" or "long"). Used alongside
   *  cacheWriteTimestamp to determine the TTL boundary for the expiry guard. */
  parentCacheRetention?: string;
  /** Session key for rendered tool cache. When provided, tools rendered by
   *  the SDK are cached and replayed byte-identically on subsequent turns. */
  sessionKey?: string;
  /** DEFER-TOOL: Getter for deferred tool names from tool deferral pipeline.
   *  When provided and non-empty (for Anthropic non-Haiku models), tools matching
   *  these names get defer_loading: true injected in onPayload, and a
   *  tool_search_tool_regex server tool is appended. */
  getDeferredToolNames?: () => Set<string>;
  /** Getter for total MCP tool count. Used to detect all-deferred condition
   *  where per-tool hash recomputation can be skipped. */
  getTotalMcpToolCount?: () => number;
  /** Feature flag hash string for tool cache key invalidation.
   *  When provided, included in the rendered tool cache key so that
   *  config changes affecting tool rendering invalidate stale cached schemas. */
  featureFlagHash?: string;
  /** Beta header latch -- once the anthropic-beta header is resolved,
   *  subsequent calls return the latched value. Prevents mid-session header changes
   *  that bust the cache prefix. */
  getBetaHeaderLatch?: () => SessionLatch<string> | null;
  /** Cache retention latch -- once retention escalates to "long",
   *  subsequent calls return "long". Prevents retention downgrade mid-session. */
  getRetentionLatch?: () => SessionLatch<CacheRetention> | null;
  /** Getter for current model ID. Used by resolveCacheRetention()
   *  to apply per-model cache retention overrides. */
  getModelId?: () => string | undefined;
  /** Getter for per-model cache retention overrides.
   *  Keys are model ID prefixes (e.g., "claude-haiku", "claude-sonnet-4-6").
   *  Longest-prefix-first matching. Overrides agent-level cacheRetention. */
  getCacheRetentionOverrides?: () => Record<string, CacheRetention> | undefined;
  /** Defer loading activation latch -- once defer_loading is activated
   *  for a session, it stays active. Prevents toggling between client-side and
   *  server-side discovery mid-session. */
  getDeferLoadingLatch?: () => SessionLatch<boolean> | null;
  /** Getter for the previous turn's cache fence index.
   *  Used by microcompaction to skip clearing messages within the cached prefix.
   *  Returns -1 when no fence exists (cold start). */
  getCacheFenceIndex?: () => number;
  /** Getter for elapsed ms since last assistant response.
   *  Used for time-based microcompact to detect cold-start scenarios. */
  getElapsedSinceLastResponse?: () => number | undefined;
  /** When true, the recent-zone message breakpoint may be promoted from
   *  "short" to "long" TTL based on observed inter-turn timing.
   *  Requires sessionKey, getElapsedSinceLastResponse, AND getLastResponseTs. */
  promoteRecentZoneOnSlowCadence?: boolean;
  /** Getter for the raw `sessionLastResponseTs.ts` value (ms since epoch)
   *  for this session, or undefined on cold-start. Used by the cadence
   *  tracker to detect turn boundaries within a single execute(). */
  getLastResponseTs?: () => number | undefined;
  /** Number of recent tool results to preserve during microcompact.
   *  Defaults to 25 (matches observation masker keep window). */
  observationKeepWindow?: number;
  /** Callback to suppress false cache break detection after microcompact. */
  onContentModification?: () => void;
  /** Callback to reset adaptive retention to cold-start after microcompact. */
  onAdaptiveRetentionReset?: () => void;
  /** Token ceiling for microcompaction trigger. When estimated input tokens
   *  exceed this value, stale tool results and thinking blocks are cleared regardless
   *  of TTL. Default: undefined (disabled). Set to 180000 for Anthropic models. */
  microcompactTokenCeiling?: number;
  /** Getter for eviction cooldown state. When defined and turnsRemaining > 0,
   *  breakpoint budget is limited to 1 and retention forced to "short". */
  getEvictionCooldown?: () => { turnsRemaining: number; evictedAt: number } | undefined;
  /** Block stability tracker for adaptive TTL promotion.
   *  When provided, message breakpoints whose zone content has been stable
   *  for stabilityThreshold consecutive calls are promoted from 5m to 1h TTL. */
  blockStabilityTracker?: BlockStabilityTracker;
  /** Number of consecutive unchanged calls before promoting a
   *  message breakpoint to 1h TTL. Default: 3. Only used when blockStabilityTracker is set. */
  stabilityThreshold?: number;
  /** / 49-01: Callback invoked after cache breakpoint placement with per-TTL token estimates.
   *  Counts tokens under 5m vs 1h cache_control markers for accurate cost attribution.
   *  The bridge normalizes these estimates against the actual SDK-reported cacheWriteTokens. */
  onTtlSplitEstimate?: (estimate: { cacheWrite5mTokens: number; cacheWrite1hTokens: number }) => void;
}

// ---------------------------------------------------------------------------
// Tool schema caches extracted to tool-schema-cache.ts (leaf module).
// Re-exported here for backward compatibility with existing consumers.
// ---------------------------------------------------------------------------
import { sessionRenderedToolCache, getOrCacheRenderedTool } from "./tool-schema-cache.js";

export { clearSessionRenderedToolCache, getOrCacheRenderedTool, clearSessionPerToolCache } from "./tool-schema-cache.js";
export type { RenderedToolCacheEntry } from "./tool-schema-cache.js";

// ---------------------------------------------------------------------------
// Sticky-on beta header latches.
// Tracks individual beta header values seen per session. Once a beta value
// appears in any API call, it is latched and included in all subsequent calls.
// Prevents mid-session beta header toggling from busting the cache prefix.
// ---------------------------------------------------------------------------
const sessionBetaHeaderLatches = new Map<string, AccumulativeLatch<string>>();

// ---------------------------------------------------------------------------
// Prefix stability tracking.
// Hashes the first N messages before microcompaction to detect prefix instability.
// When the prefix hash changes on consecutive turns, the cache prefix is unstable
// and every turn will miss cache reads beyond the system prompt.
// ---------------------------------------------------------------------------
const sessionPrefixStability = new Map<string, { hash: number; fenceIdx: number; consecutiveChanges: number }>();

export function clearSessionPrefixStability(sessionKey: string): void {
  sessionPrefixStability.delete(sessionKey);
}

export function clearSessionBetaHeaderLatches(sessionKey: string): void {
  sessionBetaHeaderLatches.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Cadence tracker for recent-zone TTL promotion.
// Tracks consecutive turns of same-side cadence to decide promotion.
// ---------------------------------------------------------------------------
interface CadenceTrackerEntry {
  consecutiveSlowTurns: number;
  consecutiveFastTurns: number;
  promoted: boolean;
  lastObservedResponseTs: number | undefined;
}
const sessionCadenceTracker = new Map<string, CadenceTrackerEntry>();

export function clearSessionCadenceTracker(sessionKey: string): void {
  sessionCadenceTracker.delete(sessionKey);
}

const SLOW_CADENCE_PROMOTION_THRESHOLD = 3;
const FAST_CADENCE_DEMOTION_THRESHOLD = 5;
const SLOW_CADENCE_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Per-model cache retention override resolution.
// Enables selectively disabling or changing prompt caching for specific model
// families. Longest-prefix-first matching ensures specific model variants
// (e.g., "claude-sonnet-4-6") take priority over broad families ("claude-sonnet").
// ---------------------------------------------------------------------------

/**
 * Resolve effective cache retention for a model, considering per-model overrides.
 * Uses longest-prefix-first matching: "claude-sonnet-4-6" wins over "claude-sonnet".
 *
 * @param modelId - Full model identifier (e.g., "claude-sonnet-4-6-20260301")
 * @param agentRetention - Agent-level default cache retention
 * @param overrides - Optional per-model family overrides (prefix -> retention)
 * @returns Resolved cache retention value
 */
export function resolveCacheRetention(
  modelId: string,
  agentRetention: CacheRetention,
  overrides?: Record<string, CacheRetention>,
): CacheRetention {
  if (!overrides || Object.keys(overrides).length === 0) {
    return agentRetention;
  }
  // Sort by key length descending (longest-prefix-first)
  const sorted = Object.entries(overrides).sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, retention] of sorted) {
    if (modelId.startsWith(prefix)) return retention;
  }
  return agentRetention;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Anthropic beta header for 1M context window. */
const CONTEXT_1M_BETA = "context-1m-2025-08-07";

/** Check if a model uses the OpenAI Responses API. */
function isResponsesApiProvider(model: { api?: string }): boolean {
  return model.api === "openai-responses" || model.api === "azure-openai-responses";
}

/** Parse a comma-separated header list, returning individual values. */
function parseHeaderList(header: string | undefined): string[] {
  if (!header) return [];
  return header.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Compute a hash of rendered tools excluding cache_control.
 * Uses computeHash (djb2 over JSON.stringify) from cache-break-detection.
 */
function computeRenderedToolsHash(tools: Array<Record<string, unknown>>): number {
  const forHash = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  return computeHash(forHash);
}

/**
 * Pre-sorted MIN_CACHEABLE_TOKENS entries by key length descending.
 * Ensures longest-prefix-first matching: "claude-opus-4-6" (len 15)
 * always matches before "claude-opus-4-" (len 14).
 * Computed once at module load time.
 */
const SORTED_MIN_CACHEABLE_ENTRIES: Array<[string, number]> =
  Object.entries(MIN_CACHEABLE_TOKENS).sort((a, b) => b[0].length - a[0].length);

/**
 * Resolve minimum cacheable tokens for a model ID.
 * Matches by prefix: "claude-opus-4-6-20260301" -> "claude-opus-4-6".
 * Uses pre-sorted entries to guarantee longest prefix wins.
 * Falls back to DEFAULT_MIN_CACHEABLE_TOKENS (1024).
 */
export function getMinCacheableTokens(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_MIN_CACHEABLE_TOKENS;
  for (const [prefix, threshold] of SORTED_MIN_CACHEABLE_ENTRIES) {
    if (modelId.startsWith(prefix)) return threshold;
  }
  return DEFAULT_MIN_CACHEABLE_TOKENS;
}

/**
 * Count existing cache_control breakpoints in an Anthropic API payload.
 * Counts across tools, system blocks, and message content blocks.
 * Tools are counted first because their breakpoints consume slots from
 * the same 4-breakpoint budget.
 */
function countCacheBreakpoints(params: Record<string, unknown>): number {
  let count = 0;
  // Count in tools array
  const tools = params.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool.cache_control) count++;
    }
  }
  // Count in system array
  const system = params.system as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(system)) {
    for (const block of system) {
      if (block.cache_control) count++;
    }
  }
  // Count in messages
  const messages = params.messages as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.cache_control) count++;
        }
      }
    }
  }
  return count;
}

/**
 * Block types eligible for cache_control markers.
 * Thinking and redacted_thinking blocks must never receive cache_control
 * because they waste breakpoint slots.
 */
export const CACHEABLE_BLOCK_TYPES = new Set(["text", "tool_use", "tool_result", "image"]);

/**
 * Add cache_control marker to the last cacheable content block of a message.
 *
 * Walks backwards through the content array to find the last block whose
 * type is in CACHEABLE_BLOCK_TYPES. Thinking and redacted_thinking blocks
 * are skipped because they waste breakpoint slots.
 *
 * When retention is "long", uses ttl="1h" to match the pi-ai SDK's
 * Anthropic provider which sets `{ type: "ephemeral", ttl: "1h" }` on
 * the last user message. The Anthropic API requires TTLs to be
 * monotonically non-increasing across the request (tools -> system ->
 * messages). Since Comis places breakpoints earlier in the message array
 * than the SDK, using the same "1h" TTL ensures ordering compliance.
 *
 * When retention is "short" or undefined, uses the 5m default (no
 * explicit TTL) which is the Anthropic API baseline.
 */
export function addCacheControlToLastBlock(
  message: Record<string, unknown>,
  retention?: CacheRetention,
): void {
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return;

  const cacheControl = retention === "long"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };

  // Walk backwards to find the last cacheable block (skip thinking, redacted_thinking, etc.)
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as Record<string, unknown>;
    if (CACHEABLE_BLOCK_TYPES.has(block.type as string)) {
      block.cache_control = cacheControl;
      return;
    }
  }

  // Edge case: no cacheable block found -- place on last block as fallback
  (content[content.length - 1] as Record<string, unknown>).cache_control = cacheControl;
}

/** Options for cache breakpoint placement. */
interface BreakpointOptions {
  minTokens: number;
  maxBreakpoints: number;
  retention?: CacheRetention;
  /** Retention for semi-stable/mid zones when escalated to "long".
   *  Falls back to retention when undefined. Recent zone always uses retention. */
  resolvedRetention?: CacheRetention;
  /** "multi-zone" (default) or "single" breakpoint strategy. */
  strategy?: "multi-zone" | "single";
  /** Skip cache_control on final messages for sub-agent spawns.
   *  Shifts the recent-zone breakpoint back by one user message position. */
  skipCacheWrite?: boolean;
  /** When true, promote recent-zone from "short" to "long" on slow cadence. */
  promoteRecentZoneOnSlowCadence?: boolean;
  /** Session key for cadence tracker lookup. */
  sessionKey?: string;
}

/**
 * Place exactly 1 cache_control marker on the second-to-last user message.
 * The SDK already places one on the last user message, so we target second-to-last
 * to avoid duplication while still getting one Comis-controlled breakpoint.
 *
 * When skipCacheWrite is true, target the third-to-last user message instead,
 * falling back to second-to-last if insufficient user messages exist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK message types lack public type exports */
function placeSingleBreakpoint(
  messages: Array<Record<string, unknown>>,
  retention?: CacheRetention,
  skipCacheWrite?: boolean,
): number {
  if (messages.length < 2) return 0;
  // When skipCacheWrite, find third-to-last instead of second-to-last
  const targetOrdinal = skipCacheWrite ? 3 : 2; // 1st=last, 2nd=second-to-last, 3rd=third-to-last
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any).role === "user") {
      userCount++;
      if (userCount === targetOrdinal) {
        addCacheControlToLastBlock(messages[i] as Record<string, unknown>, retention);
        return 1;
      }
    }
  }
  // Fallback: if not enough user messages for the target ordinal,
  // try second-to-last (skipCacheWrite fallback)
  if (skipCacheWrite && userCount >= 2) {
    let fallbackCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as any).role === "user") {
        fallbackCount++;
        if (fallbackCount === 2) {
          addCacheControlToLastBlock(messages[i] as Record<string, unknown>, retention);
          return 1;
        }
      }
    }
  }
  return 0;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Place cache breakpoints at strategic positions within the messages array.
 *
 * Zone strategy (up to 3 custom breakpoints):
 * - Breakpoint #2 (semi-stable zone): After the compaction summary or the
 *   boundary between old and recent messages.
 * - Breakpoint #3 (recent zone): On the second-to-last user message (the
 *   SDK places #4 on the last user message).
 * - Breakpoint #3.5 (mid zone): At the midpoint between semi-stable and
 *   second-to-last user -- covers the gap in longer conversations.
 *
 * @param messages - The messages array from the Anthropic API payload
 * @param options - Breakpoint placement options
 * @returns Number of breakpoints actually placed
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK message types lack public type exports */
function placeCacheBreakpoints(
  messages: Array<Record<string, unknown>>,
  options: BreakpointOptions,
): number {
  const { minTokens, maxBreakpoints, retention, resolvedRetention, strategy, skipCacheWrite } = options;
  if (messages.length < 4 || maxBreakpoints <= 0) return 0;

  // Single-breakpoint strategy dispatch
  if (strategy === "single") {
    return placeSingleBreakpoint(messages, retention, skipCacheWrite);
  }

  let placed = 0;
  const remaining = Math.min(maxBreakpoints, 3); // Use full budget (4 total - SDK's 1 = 3 available)

  // Find the second-to-last user message for breakpoint #3
  let secondToLastUserIdx = -1;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any).role === "user") {
      if (lastUserIdx === -1) {
        lastUserIdx = i;
      } else if (secondToLastUserIdx === -1) {
        secondToLastUserIdx = i;
        break;
      }
    }
  }

  // For sub-agent spawns, shift recent-zone breakpoint back by one
  // user message to avoid cache_creation on the final message pair.
  if (skipCacheWrite && secondToLastUserIdx >= 0) {
    let thirdToLastUserIdx = -1;
    for (let i = secondToLastUserIdx - 1; i >= 0; i--) {
      if ((messages[i] as any).role === "user") {
        thirdToLastUserIdx = i;
        break;
      }
    }
    if (thirdToLastUserIdx >= 0) {
      secondToLastUserIdx = thirdToLastUserIdx;
    }
    // If no third-to-last user found, fall through to original secondToLastUserIdx
  }

  // Estimate cumulative tokens for threshold checking.
  // Uses content-aware char/token ratio: structured content (tool results,
  // tool use JSON) tokenizes at ~3 chars/token; natural language at ~4.
  function estimateTokensInRange(start: number, end: number): number {
    let tokens = 0;
    for (let i = start; i <= end && i < messages.length; i++) {
      const msg = messages[i] as any;
      const content = msg.content;
      const isStructured = msg.role === "user"
        ? Array.isArray(content) && content.some((b: any) => b.type === "tool_result")
        : msg.role === "assistant"
          ? Array.isArray(content) && content.some((b: any) => b.type === "tool_use")
          : false;
      const ratio = isStructured ? CHARS_PER_TOKEN_RATIO_STRUCTURED : CHARS_PER_TOKEN_RATIO;

      if (typeof content === "string") {
        tokens += Math.ceil(content.length / ratio);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block.text === "string") {
            tokens += Math.ceil(block.text.length / ratio);
          }
          // tool_result blocks nest text inside block.content[]
          if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              if (typeof inner.text === "string") {
                tokens += Math.ceil(inner.text.length / ratio);
              }
            }
          }
        }
      }
    }
    return tokens;
  }

  // Find compaction summary position (breakpoint #2 candidate)
  let semiStableIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as any;
    if (msg.role === "user") {
      const content = msg.content;
      const text = typeof content === "string" ? content :
        (Array.isArray(content) ? content.find((b: any) => b.type === "text")?.text ?? "" : "");
      if (text.startsWith("<summary>") || text.includes("[Compaction summary]")) {
        semiStableIdx = i;
        break;
      }
    }
  }

  // Place at 50% cumulative token threshold (not 50% message index).
  // Token-density placement ensures sessions with tool-heavy early messages
  // place the breakpoint at the actual token midpoint.
  if (semiStableIdx === -1 && secondToLastUserIdx > 2) {
    const totalTokens = estimateTokensInRange(0, secondToLastUserIdx);
    const halfTokens = totalTokens / 2;
    let cumulative = 0;
    let crossingIdx = -1;

    for (let i = 0; i <= secondToLastUserIdx; i++) {
      cumulative += estimateTokensInRange(i, i);
      if (cumulative >= halfTokens) {
        crossingIdx = i;
        break;
      }
    }

    // Find nearest user message at or before the crossing point
    if (crossingIdx >= 0) {
      for (let i = crossingIdx; i >= 0; i--) {
        if ((messages[i] as any).role === "user") {
          semiStableIdx = i;
          break;
        }
      }
      // Fallback: if no user message at/before crossing, scan forward
      if (semiStableIdx === -1) {
        for (let i = crossingIdx + 1; i <= secondToLastUserIdx; i++) {
          if ((messages[i] as any).role === "user") {
            semiStableIdx = i;
            break;
          }
        }
      }
    }
  }

  // Place breakpoint #2 if above threshold
  if (semiStableIdx >= 0 && placed < remaining) {
    const tokensToPoint = estimateTokensInRange(0, semiStableIdx);
    if (tokensToPoint >= minTokens) {
      addCacheControlToLastBlock(messages[semiStableIdx] as any, resolvedRetention ?? retention);
      placed++;
    }
  }

  // Place breakpoint #3 on second-to-last user message if above threshold
  if (secondToLastUserIdx >= 0 && placed < remaining) {
    const startFrom = semiStableIdx >= 0 ? semiStableIdx + 1 : 0;
    const tokensInRange = estimateTokensInRange(startFrom, secondToLastUserIdx);
    if (tokensInRange >= minTokens) {
      // Promote recent-zone to "long" when cadence indicates user pauses exceed 5m.
      // Monotonicity guard: recent zone can only be promoted when
      // resolvedRetention (tool/system) is already "long".
      let recentRetention = retention;
      if (options.promoteRecentZoneOnSlowCadence && options.sessionKey) {
        const cadence = sessionCadenceTracker.get(options.sessionKey);
        if (cadence?.promoted && resolvedRetention === "long") {
          recentRetention = "long";
        }
      }
      addCacheControlToLastBlock(messages[secondToLastUserIdx] as any, recentRetention);
      placed++;
    }
  }

  // Place breakpoint at mid-point between semi-stable and second-to-last user.
  // Covers the gap in longer conversations where the semi-stable zone (compaction summary)
  // is far from the recent zone (second-to-last user message).
  if (semiStableIdx >= 0 && secondToLastUserIdx >= 0 && placed < remaining) {
    const midIdx = Math.floor((semiStableIdx + secondToLastUserIdx) / 2);
    if (midIdx > semiStableIdx && midIdx < secondToLastUserIdx) {
      // Find nearest user message at or before the midpoint
      let midUserIdx = -1;
      for (let i = midIdx; i > semiStableIdx; i--) {
        if ((messages[i] as any).role === "user") {
          midUserIdx = i;
          break;
        }
      }
      if (midUserIdx >= 0) {
        const startFrom = semiStableIdx + 1;
        const tokensInRange = estimateTokensInRange(startFrom, midUserIdx);
        if (tokensInRange >= minTokens) {
          addCacheControlToLastBlock(messages[midUserIdx] as any, resolvedRetention ?? retention);
          placed++;
        }
      }
    }
  }

  // Lookback window enforcement: check gaps between consecutive breakpoints.
  // The Anthropic API uses a 20-block lookback window for cache prefix matching.
  // If any gap exceeds the window and slots remain, place a bridging breakpoint
  // at the midpoint of the gap to prevent silent cache misses.
  if (placed > 0 && placed < maxBreakpoints) {
    const breakpointPositions: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const content = (messages[i] as any).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.cache_control) {
            breakpointPositions.push(i);
            break;
          }
        }
      }
    }

    // Check gaps between consecutive breakpoints
    for (let g = 1; g < breakpointPositions.length && placed < maxBreakpoints; g++) {
      const gap = breakpointPositions[g]! - breakpointPositions[g - 1]!;
      if (gap > CACHE_LOOKBACK_WINDOW) {
        // Find a user message near the midpoint of the gap
        const midTarget = Math.floor(
          (breakpointPositions[g - 1]! + breakpointPositions[g]!) / 2,
        );
        for (let j = midTarget; j > breakpointPositions[g - 1]!; j--) {
          if ((messages[j] as any).role === "user") {
            const startFrom = breakpointPositions[g - 1]! + 1;
            const tokensInRange = estimateTokensInRange(startFrom, j);
            if (tokensInRange >= minTokens) {
              addCacheControlToLastBlock(messages[j] as any, resolvedRetention ?? retention);
              placed++;
            }
            break;
          }
        }
      }
    }
  }

  return placed;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Time-based microcompact helper
// ---------------------------------------------------------------------------

/** Minimum content length (chars) for a tool result to be considered clearable. */
const MICROCOMPACT_MIN_CONTENT_LENGTH = 1000;

/**
 * Read-only tool names whose results are safely clearable during microcompact.
 * Edit/write tool results are preserved because they carry the LLM's understanding
 * of what was changed -- clearing them loses context.
 */
const COMPACTABLE_TOOL_NAMES = new Set<string>([
  "grep", "glob", "file_read", "web_search", "web_fetch",
  "exec_tool",    // Shell equivalent -- output is ephemeral
  "list_dir",     // Directory listing -- ephemeral
  "search_files", // File search -- ephemeral
]);

/**
 * Edit/write tool names whose tool_use INPUT blocks are clearable during microcompact.
 * Unlike COMPACTABLE_TOOL_NAMES (which clears tool_result output), this clears the
 * tool_use input (the request the LLM sent). The tool_result (what the tool returned)
 * is preserved because edit/write results carry confirmation of what changed.
 */
const CLEARABLE_USES_TOOL_NAMES = new Set<string>([
  "file_edit",
  "file_write",
  "notebook_edit",
]);

/**
 * Clear stale tool results from messages, preserving the most recent ones.
 * Replaces long tool_result content with a placeholder to reduce cache-write
 * token cost when the cache has expired after an idle gap.
 *
 * Only clears read-only (compactable) tool types. Edit/write tool
 * results and orphaned results (no matching tool_use) are preserved.
 *
 * @param messages - The messages array (mutated in place)
 * @param keepWindow - Number of most recent tool_result messages to preserve
 * @returns Number of tool results cleared
 */
function clearStaleToolResults(
  messages: Array<Record<string, unknown>>,
  keepWindow: number,
  fenceIndex: number = -1,
): number {
  // Build tool_use_id -> tool_name map for type filtering
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          toolNameById.set(block.id as string, block.name as string);
        }
      }
    }
  }

  // Find all tool_result indices (role === "tool" in Anthropic API format)
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "tool") {
      toolResultIndices.push(i);
    }
  }

  // Protect the last `keepWindow` tool results
  const clearableIndices = toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - keepWindow));

  let cleared = 0;
  for (const idx of clearableIndices) {
    // Protect messages within the cached prefix (at or below the fence).
    if (idx <= fenceIndex) continue;

    const msg = messages[idx]!;

    // Only clear compactable (read-only) tool types
    const toolUseId = msg.tool_use_id as string | undefined;
    if (toolUseId) {
      const toolName = toolNameById.get(toolUseId);
      if (toolName && !COMPACTABLE_TOOL_NAMES.has(toolName)) {
        continue; // Preserve edit/write tool results
      }
      // If tool name not found (orphaned result), skip clearing (conservative)
      if (!toolName) {
        continue;
      }
    }

    const content = msg.content;
    if (Array.isArray(content)) {
      // Check if any content block exceeds the threshold
      let totalLen = 0;
      for (const block of content as Array<Record<string, unknown>>) {
        if (typeof block.text === "string") {
          totalLen += (block.text as string).length;
        }
      }
      if (totalLen >= MICROCOMPACT_MIN_CONTENT_LENGTH) {
        // Replace content with lightweight placeholder
        msg.content = [{ type: "text", text: "[Stale tool result cleared: idle > TTL]" }];
        cleared++;
      }
    } else if (typeof content === "string" && content.length >= MICROCOMPACT_MIN_CONTENT_LENGTH) {
      msg.content = [{ type: "text", text: "[Stale tool result cleared: idle > TTL]" }];
      cleared++;
    }
  }

  // Second pass -- clear tool_use input blocks for edit/write tools.
  // These tool_use blocks contain the full file content the LLM wanted to write/edit.
  // After the result is confirmed, the input is no longer needed and just wastes cache space.
  const assistantWithToolUseIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const content = msg.content as Array<Record<string, unknown>>;
      if (content.some(b => b.type === "tool_use")) {
        assistantWithToolUseIndices.push(i);
      }
    }
  }
  const clearableAssistantIndices = assistantWithToolUseIndices.slice(
    0, Math.max(0, assistantWithToolUseIndices.length - keepWindow),
  );
  for (const idx of clearableAssistantIndices) {
    // Protect messages within the cached prefix.
    if (idx <= fenceIndex) continue;

    const msg = messages[idx]!;
    const content = msg.content as Array<Record<string, unknown>>;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const toolName = block.name as string;
      if (!CLEARABLE_USES_TOOL_NAMES.has(toolName)) continue;
      const inputStr = JSON.stringify(block.input);
      if (inputStr.length >= MICROCOMPACT_MIN_CONTENT_LENGTH) {
        block.input = { _cleared: true, reason: "stale edit/write input" };
        cleared++;
      }
    }
  }

  return cleared;
}

/**
 * Clear non-redacted thinking blocks from old assistant messages.
 * Thinking blocks (5-20K tokens each) waste cache_creation budget when the cache
 * is cold. This function strips them from assistant messages beyond the keepWindow,
 * preserving redacted thinking blocks (which carry encrypted signatures for API continuity).
 *
 * Mutates messages in place (same pattern as clearStaleToolResults).
 *
 * @param messages - The messages array (mutated in place)
 * @param keepWindow - Number of most recent assistant messages to preserve thinking blocks in
 * @returns Number of thinking blocks cleared
 */
export function clearStaleThinkingBlocks(
  messages: Array<Record<string, unknown>>,
  keepWindow: number,
  fenceIndex: number = -1,
): number {
  // Collect assistant message indices
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "assistant") {
      assistantIndices.push(i);
    }
  }

  // Calculate how many are clearable (beyond keepWindow)
  const clearableCount = Math.max(0, assistantIndices.length - keepWindow);
  if (clearableCount === 0) return 0;

  const clearableIndices = new Set(assistantIndices.slice(0, clearableCount));

  let cleared = 0;
  for (const idx of clearableIndices) {
    // Protect messages within the cached prefix.
    if (idx <= fenceIndex) continue;

    const msg = messages[idx]!;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    // Filter: keep everything EXCEPT non-redacted thinking blocks
    const filtered = (content as Array<Record<string, unknown>>).filter(block => {
      if (block.type !== "thinking") return true;
      // Preserve redacted thinking blocks (encrypted signatures for API continuity)
      return (block as { redacted?: boolean }).redacted === true;
    });

    if (filtered.length < (content as unknown[]).length) {
      cleared += (content as unknown[]).length - filtered.length;
      msg.content = filtered;
    }
  }

  return cleared;
}

/**
 * Reorder content blocks within user messages for deterministic cache prefix.
 * Moves non-text blocks (images, media) before text blocks within each user message.
 * This ensures attachments always appear at the start of a message, preventing
 * cache prefix invalidation when the user sends text+image in varying orders.
 *
 * Only reorders within user messages. Assistant and tool messages are unchanged.
 * Must run AFTER structuredClone and BEFORE any cache_control marker placement.
 */
function reorderContentForStablePrefix(messages: Array<Record<string, unknown>>): void {
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    const content = msg.content as Array<Record<string, unknown>>;
    if (content.length <= 1) continue;

    // Partition: non-text blocks first, then text blocks (stable sort within groups)
    const nonText: Array<Record<string, unknown>> = [];
    const text: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (block.type === "text") {
        text.push(block);
      } else {
        nonText.push(block);
      }
    }

    // Only reorder if there are both types (avoid unnecessary mutations)
    if (nonText.length > 0 && text.length > 0) {
      msg.content = [...nonText, ...text];
    }
  }
}

// ---------------------------------------------------------------------------
// Tool suffix ordering for cache-stable Anthropic payloads
// ---------------------------------------------------------------------------

/**
 * Sort tools for Anthropic cache prefix stability: built-in tools first
 * (preserving original order), then MCP tools sorted alphabetically.
 *
 * This ensures dynamic MCP tool late-joins always append AFTER the cached
 * built-in tool prefix, preventing mid-array insertions from busting
 * Anthropic's prefix cache matching.
 *
 * Server-side tools (type: "tool_search_tool_*") are excluded from sorting
 * and placed at the end since they are appended by the deferral pipeline.
 */
export function sortToolsForCacheStability(
  tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const builtins: Array<Record<string, unknown>> = [];
  const mcpTools: Array<Record<string, unknown>> = [];
  const serverTools: Array<Record<string, unknown>> = [];

  for (const tool of tools) {
    const name = (tool.name as string) ?? "";
    const type = (tool.type as string) ?? "";
    if (type.startsWith("tool_search_tool_")) {
      serverTools.push(tool);
    } else if (name.startsWith("mcp:") || name.startsWith("mcp__")) {
      mcpTools.push(tool);
    } else {
      builtins.push(tool);
    }
  }

  mcpTools.sort((a, b) =>
    ((a.name as string) ?? "").localeCompare((b.name as string) ?? ""),
  );

  return [...builtins, ...mcpTools, ...serverTools];
}

// ---------------------------------------------------------------------------
// Adaptive TTL promotion helpers
// ---------------------------------------------------------------------------

/**
 * Identify the logical zone for a message breakpoint position.
 * Three zones based on placeCacheBreakpoints() placement logic:
 * - "semi-stable": Near compaction summary or first-third boundary (breakpoint #2)
 * - "mid": Midpoint between semi-stable and recent (breakpoint #3.5)
 * - "recent": Second-to-last user message (breakpoint #3)
 *
 * Uses relative position within the message array since absolute indices drift.
 * Zone boundaries: first 40% = semi-stable, last 30% = recent, middle = mid.
 */
export function identifyBreakpointZone(
  breakpointIdx: number,
  messageCount: number,
): "semi-stable" | "mid" | "recent" {
  if (messageCount <= 0) return "recent";
  const ratio = breakpointIdx / messageCount;
  if (ratio <= 0.4) return "semi-stable";
  if (ratio >= 0.7) return "recent";
  return "mid";
}

/**
 * Hash message content at and around a breakpoint position for stability tracking.
 * Hashes the message at the breakpoint index plus 1 message before it (context window).
 * Strips cache_control from content blocks to avoid circular dependency where
 * the hash changes when TTL changes.
 */
export function hashBreakpointContent(
  messages: Array<Record<string, unknown>>,
  breakpointIdx: number,
): number {
  let combined = "";
  const start = Math.max(0, breakpointIdx - 1);
  for (let i = start; i <= breakpointIdx && i < messages.length; i++) {
    const content = messages[i]!.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        // Strip cache_control to avoid circular hash dependency
        const { cache_control: _cc, ...rest } = block;
        combined += JSON.stringify(rest);
      }
    } else if (typeof content === "string") {
      combined += content;
    }
  }
  return computeHash(combined);
}

/**
 * Walk placed message breakpoints, record zone hashes, and promote
 * stable zones from 5m to 1h TTL. Only promotes when resolvedRetention is "long"
 * (monotonicity constraint: tools >= system >= messages).
 *
 * Must be called AFTER placeCacheBreakpoints() and BEFORE onPayloadForCacheDetection().
 *
 * @param messages - The messages array with placed breakpoints
 * @param tracker - BlockStabilityTracker for per-session zone tracking
 * @param sessionKey - The session key for per-session state
 * @param threshold - Number of consecutive unchanged calls before promotion
 * @param resolvedRetention - Current cache retention level (must be "long" for promotion)
 * @returns Number of breakpoints promoted from 5m to 1h TTL
 */
export function maybePromoteBreakpoints(
  messages: Array<Record<string, unknown>>,
  tracker: BlockStabilityTracker,
  sessionKey: string,
  threshold: number,
  resolvedRetention: CacheRetention | undefined,
): number {
  // Monotonicity guard: cannot promote to 1h if tools/system use 5m
  if (resolvedRetention !== "long") return 0;

  let promoted = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      // Find message-level breakpoints (placed by placeCacheBreakpoints)
      const cc = block.cache_control as Record<string, unknown> | undefined;
      if (!cc || cc.type !== "ephemeral") continue;
      // Skip breakpoints that already have 1h TTL (tool/system breakpoints)
      if (cc.ttl === "1h") continue;

      // This is a message breakpoint with 5m TTL -- check stability
      const zone = identifyBreakpointZone(i, messages.length);
      const contentHash = hashBreakpointContent(messages, i);
      tracker.recordZoneHash(sessionKey, zone, contentHash);

      if (tracker.isStable(sessionKey, zone, threshold)) {
        // Promote to 1h TTL
        block.cache_control = { type: "ephemeral", ttl: "1h" };
        promoted++;
      }
    }
  }
  return promoted;
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 49-01: Per-block token estimator for TTL split estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the token count for a single content block.
 *
 * Extracts the `text` field when present (text blocks) and divides by
 * CHARS_PER_TOKEN_RATIO. For non-text blocks (images, tool_use JSON) falls
 * back to JSON.stringify length / CHARS_PER_TOKEN_RATIO. The 3.5 ratio
 * better matches Anthropic's tokenizer than the previously used 4.0 ratio.
 *
 * @param block - A content block from the API payload
 * @returns Estimated token count (always >= 1)
 */
export function estimateBlockTokens(block: Record<string, unknown>): number {
  const text = typeof block.text === "string" ? block.text : JSON.stringify(block);
  return Math.ceil(text.length / CHARS_PER_TOKEN_RATIO);
}

/**
 * Create a stream wrapper that mutates the outgoing request body via the
 * onPayload hook. Consolidates four concerns:
 *
 * 1. **Cache breakpoints** (Anthropic-family): injects cache_control markers
 *    at strategic positions in the message array.
 * 2. **1M beta header** (direct Anthropic only): appends the context-1m beta
 *    header for 1M context window models.
 * 3. **service_tier** (Responses API + fastMode): injects service_tier: "auto".
 * 4. **store** (Responses API + storeCompletions): injects store: true.
 *
 * The wrapper only activates when the model matches at least one concern;
 * for non-Anthropic non-Responses providers, it passes through unchanged.
 *
 * @param config - Request body injector configuration
 * @param logger - Logger for debug output
 * @returns A named StreamFnWrapper ("requestBodyInjector")
 */
export function createRequestBodyInjector(
  config: RequestBodyInjectorConfig,
  logger: ComisLogger,
): StreamFnWrapper {
  return function requestBodyInjector(next: StreamFn): StreamFn {
    return (model, context, options) => {
      const needsCacheBreakpoints = isAnthropicFamily(model.provider);
      const needsResponsesApiInjection = isResponsesApiProvider(model as { api?: string });

      if (!needsCacheBreakpoints && !needsResponsesApiInjection) {
        return next(model, context, options);
      }

      const minTokens = config.getMinTokensOverride?.() ?? getMinCacheableTokens(model.id);

      // Concern 2: 1M beta header (direct Anthropic only -- NOT Bedrock/Vertex)
      // Must be injected as HTTP headers via options.headers, NOT in the request body.
      // The pi-ai SDK passes options.headers to createClient() for HTTP transport,
      // while onPayload mutates the JSON body -- putting headers there causes
      // Anthropic API to reject with "headers: Extra inputs are not permitted".
      let mergedHeaders: Record<string, string> | undefined;
      if (model.provider === "anthropic") {
        const existingHeaders = (options as Record<string, unknown>)?.headers as Record<string, string> | undefined;
        const headers = { ...(existingHeaders ?? {}) };
        const existingBetas = parseHeaderList(headers["anthropic-beta"]);
        if (!existingBetas.includes(CONTEXT_1M_BETA)) {
          existingBetas.push(CONTEXT_1M_BETA);
          headers["anthropic-beta"] = existingBetas.join(", ");
          mergedHeaders = headers;
        }
        // SESS-LATCH: Latch beta header on first use
        const betaLatch = config.getBetaHeaderLatch?.();
        if (betaLatch) {
          if (mergedHeaders) {
            const betaValue = mergedHeaders["anthropic-beta"];
            if (betaValue) {
              mergedHeaders["anthropic-beta"] = betaLatch.setOnce(betaValue);
            }
          } else {
            // No new headers to merge but latch has a value -- use latched value
            const latched = betaLatch.get();
            if (latched) {
              mergedHeaders = { ...(existingHeaders ?? {}), "anthropic-beta": latched };
            }
          }
        }

        // Sticky-on beta header latches -- accumulate individual beta
        // values across calls. Unlike SESS-LATCH (set-once for entire string), this
        // tracks individual values and ensures once-seen-always-included semantics.
        if (config.sessionKey) {
          // Ensure mergedHeaders exists (even if CONTEXT_1M_BETA was already present)
          if (!mergedHeaders) {
            mergedHeaders = { ...(existingHeaders ?? {}) };
          }
          const currentBetas = parseHeaderList(mergedHeaders["anthropic-beta"]);

          let latched = sessionBetaHeaderLatches.get(config.sessionKey);
          if (!latched) {
            latched = createAccumulativeLatch<string>();
            sessionBetaHeaderLatches.set(config.sessionKey, latched);
          }

          // Latch all current beta values (sticky-on: once seen, always included)
          for (const beta of currentBetas) {
            latched.add(beta);
          }

          // Merge any previously-latched values not in current set
          let changed = false;
          for (const beta of latched.getAll()) {
            if (!currentBetas.includes(beta)) {
              currentBetas.push(beta);
              changed = true;
            }
          }

          if (changed) {
            mergedHeaders["anthropic-beta"] = currentBetas.join(", ");
          }
        }
      }

      // Chain onPayload: preserve any existing onPayload callback
      const existingOnPayload = (options as Record<string, unknown>)?.onPayload as
        ((payload: unknown, model: unknown) => Promise<unknown> | unknown) | undefined;

      const enhancedOptions = {
        ...options,
        ...(mergedHeaders ? { headers: mergedHeaders } : {}),
        onPayload: async (payload: unknown, payloadModel: unknown) => {
          // Let existing onPayload run first
          const transformed = existingOnPayload
            ? await existingOnPayload(payload, payloadModel)
            : undefined;
          const params = (transformed ?? payload) as Record<string, unknown>;

          // Clone mutable sub-structures before any mutation.
          // Prevents contaminating reused content in secondary queries (title generation, compaction)
          // that may share the original params reference. The SDK builds params fresh each call
          // via buildParams(), but we must not mutate SDK-owned objects to prevent stale marker
          // accumulation if the SDK ever caches or reuses params across calls.
          const result: Record<string, unknown> = { ...params };
          if (needsCacheBreakpoints) {
            if (Array.isArray(params.system)) {
              result.system = structuredClone(params.system);
            }
            if (Array.isArray(params.tools)) {
              result.tools = structuredClone(params.tools);
            }
            if (Array.isArray(params.messages)) {
              result.messages = structuredClone(params.messages);
            }
          }

          // Reorder content blocks for stable prefix (before any cache marker placement)
          if (needsCacheBreakpoints && Array.isArray(result.messages)) {
            reorderContentForStablePrefix(result.messages as Array<Record<string, unknown>>);
          }

          // 2.1: TTL expiry guard for skipCacheWrite -- when the parent's cache write
          // timestamp indicates the shared prefix cache has likely expired (>80% of TTL
          // elapsed), disable skipCacheWrite so the sub-agent creates its own cache entry
          // instead of referencing a stale one. Prevents 100% cache misses on round-2
          // sub-agents where the 5-minute TTL expired between rounds.
          // Computed early so the W2 guard below can defer to the sub-agent bypass
          // path (line ~1854) for SDK-placed tool markers.
          let effectiveSkipCacheWrite = config.skipCacheWrite ?? false;
          if (effectiveSkipCacheWrite && config.cacheWriteTimestamp != null) {
            const TTL_MAP: Record<string, number> = { short: 300_000, long: 3_600_000 };
            const ttlMs = TTL_MAP[config.parentCacheRetention ?? "short"] ?? 300_000;
            const SAFETY_MARGIN = 0.8;
            const elapsed = Date.now() - config.cacheWriteTimestamp;
            if (elapsed > ttlMs * SAFETY_MARGIN) {
              effectiveSkipCacheWrite = false;
              logger.debug(
                { elapsed, ttlMs, safetyMargin: SAFETY_MARGIN, sessionKey: config.sessionKey },
                "TTL likely expired, disabling skipCacheWrite",
              );
            }
          }

          // pi-ai 0.67.4+ auto-places cache_control on the last tool in
          // convertTools(). W2 keeps tools at zero breakpoints (cached
          // implicitly via the cumulative hash at the system breakpoint), so
          // strip the auto-placed marker before our budget + zone strategy runs.
          //
          // Skipped for effectiveSkipCacheWrite=true (sub-agent path): single-turn
          // sub-agents need SDK-placed markers intact to match the parent's cached
          // prefix; multi-turn sub-agents strip+re-place at line ~1874 anyway.
          if (needsCacheBreakpoints && !effectiveSkipCacheWrite && Array.isArray(result.tools)) {
            for (const tool of result.tools as Array<Record<string, unknown>>) {
              if (tool.cache_control) delete tool.cache_control;
            }
          }

          // Sort tools for cache-stable prefix: builtins first, MCP alphabetically
          if (needsCacheBreakpoints && Array.isArray(result.tools) && result.tools.length > 0) {
            result.tools = sortToolsForCacheStability(result.tools as Array<Record<string, unknown>>);
          }

          // Rendered tool cache -- ensures byte-identical
          // tool JSON across turns when composition is unchanged. On aggregate cache miss,
          // per-tool content-addressed memoization preserves unchanged individual tools.
          if (config.sessionKey && needsCacheBreakpoints && Array.isArray(result.tools)) {
            // When ALL MCP tools use defer_loading, tool composition is guaranteed stable.
            // Skip per-tool hash recomputation since no MCP tool connect/disconnect can change schemas.
            // Only activate after defer_loading latch is set AND tool cache exists (not first turn).
            const allDeferredToolHashSkip = (() => {
              if (!config.getDeferredToolNames || !config.getTotalMcpToolCount) return false;
              const deferredNames = config.getDeferredToolNames();
              const totalMcpTools = config.getTotalMcpToolCount();
              if (totalMcpTools === 0 || deferredNames.size === 0) return false;
              // All MCP tools deferred AND we have a cached entry from a prior turn
              return deferredNames.size >= totalMcpTools && sessionRenderedToolCache.has(config.sessionKey!);
            })();

            if (allDeferredToolHashSkip) {
              logger.debug({ sessionKey: config.sessionKey }, "All tools deferred, skipping per-tool hash recomputation");
              // Use cached tools from prior turn (already in sessionRenderedToolCache)
              const cached = sessionRenderedToolCache.get(config.sessionKey);
              if (cached) {
                result.tools = structuredClone(cached.tools);
              }
            } else {
              const tools = result.tools as Array<Record<string, unknown>>;
              const renderedHash = computeRenderedToolsHash(tools);
              // Include feature flag hash so config changes that affect tool rendering
              // invalidate the cached tool array.
              const featureFlagHash = config.featureFlagHash ?? "default";
              const cached = sessionRenderedToolCache.get(config.sessionKey);
              if (cached && cached.hash === renderedHash && cached.featureFlagHash === featureFlagHash) {
                // Aggregate cache hit -- replace with cached copy for byte-identical output
                result.tools = structuredClone(cached.tools);
              } else {
                // Aggregate hash changed -- iterate per-tool cache.
                // Unchanged individual tools keep byte-identical references while
                // changed ones get new snapshots via getOrCacheRenderedTool().
                const perToolCached = tools.map(t => getOrCacheRenderedTool(config.sessionKey!, t));
                // Store rebuilt array as new aggregate snapshot
                result.tools = perToolCached;
                sessionRenderedToolCache.set(config.sessionKey, {
                  hash: renderedHash,
                  featureFlagHash,
                  tools: structuredClone(perToolCached), // Snapshot before cache_control
                });
              }
            }
          }

          // Time-based microcompact -- clear stale tool results when cache is cold.
          // Runs BEFORE breakpoint placement because clearing results changes message sizes.
          // Fence-aware — skip clearing messages at/below the previous turn's
          // cache fence to preserve prefix stability after cache breaks.
          if (needsCacheBreakpoints && config.getElapsedSinceLastResponse && config.sessionKey) {
            const elapsed = config.getElapsedSinceLastResponse();
            if (elapsed !== undefined) {
              // Determine TTL from current retention (pre-latch, since we're checking if cache is cold)
              const baseRetentionForTtl = config.getCacheRetention() ?? "long";
              const ttlMs = baseRetentionForTtl === "long" ? 3_600_000 : 300_000;
              if (elapsed > ttlMs && Array.isArray(result.messages)) {
                const keepWindow = config.observationKeepWindow ?? 25;
                const microcompactFence = config.getCacheFenceIndex?.() ?? -1;
                const cleared = clearStaleToolResults(
                  result.messages as Array<Record<string, unknown>>,
                  keepWindow,
                  microcompactFence,
                );
                // Also clear thinking blocks from old assistant messages
                const thinkingCleared = clearStaleThinkingBlocks(
                  result.messages as Array<Record<string, unknown>>,
                  keepWindow,
                  microcompactFence,
                );
                if (cleared > 0 || thinkingCleared > 0) {
                  config.onContentModification?.();
                  if (cleared > 0) config.onAdaptiveRetentionReset?.();
                  logger.debug(
                    { cleared, thinkingCleared, elapsedMs: elapsed, ttlMs, keepWindow, sessionKey: config.sessionKey },
                    "Time-based microcompact cleared stale content",
                  );
                }
              }
            }
          }

          // Token-ceiling microcompact -- clear stale content when context grows too large.
          // Runs independently of TTL: a session with rapid back-and-forth can accumulate massive
          // context within a single TTL window. Unlike TTL trigger, does NOT reset adaptive retention
          // because the cache may still be warm.
          // Fence-aware — respects cache fence.
          if (needsCacheBreakpoints && config.microcompactTokenCeiling && config.sessionKey) {
            const msgs = result.messages as Array<Record<string, unknown>>;
            if (Array.isArray(msgs)) {
              const estimatedTokens = estimateContextChars(msgs as unknown as Message[]) / CHARS_PER_TOKEN_RATIO;
              if (estimatedTokens > config.microcompactTokenCeiling) {
                const keepWindow = config.observationKeepWindow ?? 25;
                const ceilingFence = config.getCacheFenceIndex?.() ?? -1;
                const cleared = clearStaleToolResults(msgs, keepWindow, ceilingFence);
                const thinkingCleared = clearStaleThinkingBlocks(msgs, keepWindow, ceilingFence);
                if (cleared > 0 || thinkingCleared > 0) {
                  config.onContentModification?.();
                  // NOTE: Do NOT call onAdaptiveRetentionReset -- cache may still be warm
                  logger.debug(
                    { cleared, thinkingCleared, estimatedTokens: Math.round(estimatedTokens), ceiling: config.microcompactTokenCeiling, sessionKey: config.sessionKey },
                    "Token-ceiling microcompact cleared stale content",
                  );
                }
              }
            }
          }

          // Prefix stability diagnostic — detect when microcompaction
          // changes the cache-fenced prefix between turns (indicating permanent cache collapse).
          // Fence-index-aware: growing fence (normal conversation growth) is benign unless
          // the old prefix content was mutated. Fence shrink (compaction) resets the counter.
          // Uses getCacheFenceIndex() to hash only the cached region; skips detection
          // when no fence is set yet (early bootstrap / non-Anthropic provider).
          if (needsCacheBreakpoints && config.sessionKey && Array.isArray(result.messages)) {
            const diagFenceIdx = config.getCacheFenceIndex?.() ?? -1;
            if (diagFenceIdx >= 0) {
              const msgs = result.messages as Array<Record<string, unknown>>;

              /** Hash role + first 200 chars of content for messages up to endIdx (inclusive). */
              const hashMessageSlice = (messages: Array<Record<string, unknown>>, endIdx: number): number => {
                const slice = messages.slice(0, endIdx + 1);
                return computeHash(slice.map(m => {
                  const c = m.content;
                  const text = typeof c === "string" ? c.slice(0, 200) :
                    Array.isArray(c) ? (c as Array<Record<string, unknown>>).map(b => String(b.text ?? b.type ?? "")).join("").slice(0, 200) : "";
                  return `${m.role}:${text}`;
                }));
              };

              const prefixHash = hashMessageSlice(msgs, diagFenceIdx);
              const prev = sessionPrefixStability.get(config.sessionKey);

              if (!prev) {
                // First observation — store baseline, no comparison needed
                sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0 });
              } else if (diagFenceIdx < prev.fenceIdx) {
                // Case C: Fence shrank (compaction reset) — reset counter entirely
                sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0 });
              } else if (diagFenceIdx > prev.fenceIdx) {
                // Case A: Fence grew (normal conversation growth).
                // Re-hash using the old fence boundary to check if old prefix content is intact.
                const oldRangeHash = hashMessageSlice(msgs, prev.fenceIdx);
                if (oldRangeHash === prev.hash) {
                  // Old prefix content unchanged — benign growth, reset counter
                  sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0 });
                } else {
                  // Old prefix content was mutated — genuine instability
                  const changes = prev.consecutiveChanges + 1;
                  sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: changes });
                  if (changes >= 3) {
                    logger.warn(
                      {
                        sessionKey: config.sessionKey,
                        consecutiveChanges: changes,
                        hint: "Cache prefix changing every turn — microcompaction or content modification destabilizing the prefix. Cache writes are wasted.",
                        errorKind: "performance" as const,
                      },
                      "Unstable prefix detected",
                    );
                  }
                }
              } else {
                // Case B: Same fence position — direct hash comparison
                if (prev.hash !== prefixHash) {
                  const changes = prev.consecutiveChanges + 1;
                  sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: changes });
                  if (changes >= 3) {
                    logger.warn(
                      {
                        sessionKey: config.sessionKey,
                        consecutiveChanges: changes,
                        hint: "Cache prefix changing every turn — microcompaction or content modification destabilizing the prefix. Cache writes are wasted.",
                        errorKind: "performance" as const,
                      },
                      "Unstable prefix detected",
                    );
                  }
                } else {
                  // Prefix stable — reset counter
                  sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0 });
                }
              }
            }
          }

          // Hoist resolvedRetention for kill switch access after needsCacheBreakpoints block
          let resolvedRetention: CacheRetention | undefined;

          // Concern 1: Cache breakpoints (Anthropic-family)
          if (needsCacheBreakpoints) {
            // Resolve per-model cache retention override before latching
            const baseRetention = config.getCacheRetention() ?? "long";
            const modelId = config.getModelId?.() ?? model.id;
            const effectiveRetention = resolveCacheRetention(
              modelId,
              baseRetention,
              config.getCacheRetentionOverrides?.(),
            );

            // Latch retention on first resolution
            const rawRetention = effectiveRetention;
            const retentionLatch = config.getRetentionLatch?.();
            resolvedRetention = retentionLatch
              ? retentionLatch.setOnce(rawRetention)
              : rawRetention;

            // Replace single system block with multi-block for independent caching.
            // Must run AFTER structuredClone (operates on cloned system) and BEFORE the
            // TTL upgrade (so all new blocks get upgraded). The SDK-placed single-block
            // cache_control is discarded -- we inject cache_control on all blocks explicitly.
            const promptBlocks = config.getSystemPromptBlocks?.();
            if (promptBlocks && Array.isArray(result.system)) {
              const blocks: Array<Record<string, unknown>> = [
                { type: "text" as const, text: promptBlocks.staticPrefix + SYSTEM_PROMPT_DYNAMIC_BOUNDARY },
              ];
              // Attribution block only when non-empty (empty in "none" mode)
              if (promptBlocks.attribution) {
                blocks.push({ type: "text" as const, text: promptBlocks.attribution });
              }
              blocks.push({ type: "text" as const, text: promptBlocks.semiStableBody });
              result.system = blocks;
              // Only last system block gets cache_control -- cumulative hash covers
              // all prior blocks. Frees 2 breakpoint slots for message breakpoints.
              const sysBlocks = result.system as Array<Record<string, unknown>>;
              for (const block of sysBlocks) {
                delete block.cache_control;
              }
              sysBlocks[sysBlocks.length - 1]!.cache_control = resolvedRetention === "long"
                ? { type: "ephemeral", ttl: "1h" }
                : { type: "ephemeral" };
              logger.debug(
                { blockCount: blocks.length, retention: resolvedRetention, modelId: model.id },
                "Multi-block system prompt injected",
              );
            }

            // Log first system prompt block hash for prefix-matching debug.
            // Runs after multi-block injection so the hash reflects the final static prefix.
            if (Array.isArray(result.system)) {
              const sysBlocks = result.system as Array<Record<string, unknown>>;
              if (sysBlocks.length > 0 && typeof sysBlocks[0]?.text === "string") {
                const text = sysBlocks[0].text as string;
                logger.debug(
                  {
                    firstBlockHash: djb2(text),
                    firstBlockSnippet: text.slice(0, 80).replace(/\n/g, "\\n"),
                    blockCount: sysBlocks.length,
                    modelId: model.id,
                  },
                  "System prompt first-block hash",
                );
              }
            }

            // Upgrade system prompt TTL to satisfy monotonicity constraint.
            // The SDK always sets system blocks to { type: "ephemeral" } (5m) because
            // configResolver passes getMessageRetention() = "short" for the SDK's
            // cacheRetention option (we can't give the SDK different values for system
            // vs last-user-message). But after adaptive escalation, the tool breakpoint
            // uses ttl: "1h". Without this upgrade, system(5m) -> tools(1h) violates
            // Anthropic's non-increasing TTL requirement, causing the API to silently
            // downgrade tools to 5m.
            if (resolvedRetention === "long" && Array.isArray(result.system)) {
              for (const block of result.system as Array<Record<string, unknown>>) {
                if (block.cache_control) {
                  block.cache_control = { type: "ephemeral", ttl: "1h" };
                }
              }
            }

            // Count breakpoints on `result` (post-clone, post-multi-block-injection)
            // not `params` (pre-clone). Multi-block injection may have added cache_control to
            // 2 system blocks that didn't exist in the original params.
            const existingCount = countCacheBreakpoints(result);
            let slotsAvailable = 4 - existingCount;

            // Breakpoint budget audit -- 1 per API call.
            {
              let systemBpCount = 0;
              let toolBpCount = 0;
              if (Array.isArray(result.system)) {
                for (const block of result.system as Array<Record<string, unknown>>) {
                  if (block.cache_control) systemBpCount++;
                }
              }
              if (Array.isArray(result.tools)) {
                for (const tool of result.tools as Array<Record<string, unknown>>) {
                  if (tool.cache_control) toolBpCount++;
                }
              }
              logger.info(
                {
                  existingCount,
                  slotsAvailable,
                  systemBreakpoints: systemBpCount,
                  toolBreakpoints: toolBpCount,
                  modelId: model.id,
                },
                "Breakpoint budget audit (pre-message-placement)",
              );
            }

            // W2: Tool breakpoint removed -- tools cached implicitly via cumulative hash
            // at system breakpoint position (zero tool breakpoints).

            // DEFER-TOOL: Inject defer_loading on deferred tools for Anthropic non-Haiku models.
            // Runs after tool cache breakpoints so deferred marking doesn't pollute breakpoint logic.
            if (config.getDeferredToolNames && supportsToolSearch(model.id)) {
              const deferredNames = config.getDeferredToolNames();
              // SESS-LATCH: Latch defer_loading activation
              const deferLatch = config.getDeferLoadingLatch?.();
              const shouldDeferLoad = deferLatch
                ? deferLatch.setOnce(deferredNames.size > 0)
                : deferredNames.size > 0;
              if (shouldDeferLoad && Array.isArray(result.tools)) {
                const tools = result.tools as Array<Record<string, unknown>>;
                let deferCount = 0;
                for (const tool of tools) {
                  if (deferredNames.has(tool.name as string)) {
                    tool.defer_loading = true;
                    deferCount++;
                  }
                }
                // Only switch to server-side tool_search when tools were actually
                // marked defer_loading in the payload. When deferred tools are
                // excluded upstream (tool-deferral.ts client-side exclusion),
                // deferCount is 0 and the payload lacks deferred definitions —
                // injecting tool_search_tool without any deferred tools crashes
                // the Anthropic API/SDK.
                if (deferCount > 0) {
                  // Remove client-side discover_tools (replaced by server-side tool_search)
                  const discoverIdx = tools.findIndex(t => (t.name as string) === "discover_tools");
                  if (discoverIdx !== -1) {
                    tools.splice(discoverIdx, 1);
                  }
                  // Append server-side search tool (only if not already present)
                  const hasSearchTool = tools.some(t =>
                    typeof t.type === "string" && (t.type as string).startsWith("tool_search_tool_"),
                  );
                  if (!hasSearchTool) {
                    tools.push({
                      type: "tool_search_tool_regex_20251119",
                      name: "tool_search_tool_regex",
                    });
                  }
                }
                logger.debug(
                  { deferCount, modelId: model.id, searchToolAppended: deferCount > 0 },
                  "DEFER-TOOL: Injected defer_loading on deferred tools",
                );
              }
            }

            // GRAPH-BREAKPOINT: Place a cache breakpoint on graph context envelope.
            // Wave 2+ subagents and graph-enabled sessions receive injected research
            // results as the first user message. This dynamic content (~100K+ tokens)
            // falls between the standard cache breakpoints, paying full uncached input
            // rate. Placing a breakpoint captures it under the cache prefix.
            // Must run INSIDE the budget-aware block to consume a slot from slotsAvailable.
            if (slotsAvailable > 0 && !effectiveSkipCacheWrite && Array.isArray(result.messages)) {
              const msgs = result.messages as Array<Record<string, unknown>>;
              for (let i = 0; i < Math.min(msgs.length, 3); i++) {
                const msg = msgs[i]!;
                if (msg.role !== "user") continue;
                const content = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
                const hasGraphContext = content.some((block: Record<string, unknown>) =>
                  typeof block.text === "string" && (block.text as string).includes("## Graph Context"),
                );
                if (hasGraphContext) {
                  addCacheControlToLastBlock(msg, resolvedRetention ?? "long");
                  slotsAvailable--;
                  logger.debug(
                    { modelId: model.id, messageIndex: i, sessionKey: config.sessionKey },
                    "GRAPH-BREAKPOINT: Placed cache breakpoint on graph context envelope message",
                  );
                  break;
                }
              }
            }

            // During eviction cooldown, limit to 1 breakpoint (recent zone) at "short" retention.
            const evictionCooldown = config.getEvictionCooldown?.();
            const inCooldown = evictionCooldown != null && evictionCooldown.turnsRemaining > 0;

            if (slotsAvailable > 0 && Array.isArray(result.messages)) {
              // Conversation breakpoints use zone-aware retention.
              // Recent zone always uses "short" (5m); semi-stable/mid zones get escalated retention.
              const messageRetention = config.getMessageRetention?.() ?? resolvedRetention;
              const placed = placeCacheBreakpoints(
                result.messages as Array<Record<string, unknown>>,
                {
                  minTokens,
                  maxBreakpoints: inCooldown ? 1 : slotsAvailable,
                  retention: "short", // Recent zone always "short" (5m)
                  resolvedRetention: inCooldown ? "short" : messageRetention, // Force "short" during cooldown
                  strategy: resolveBreakpointStrategy(config.cacheBreakpointStrategy, model.provider),
                  skipCacheWrite: effectiveSkipCacheWrite,
                  promoteRecentZoneOnSlowCadence: config.promoteRecentZoneOnSlowCadence,
                  sessionKey: config.sessionKey,
                },
              );
              if (placed > 0) {
                logger.debug(
                  {
                    placed,
                    existingCount,
                    totalBreakpoints: existingCount + placed,
                    minTokens,
                    modelId: model.id,
                    strategy: resolveBreakpointStrategy(config.cacheBreakpointStrategy, model.provider),
                  },
                  "Message breakpoints placed",
                );
              } else if (Array.isArray(result.messages) && (result.messages as unknown[]).length >= 4) {
                logger.debug(
                  { messageCount: (result.messages as unknown[]).length, minTokens, modelId: model.id, existingCount },
                  "Cache breakpoints skipped: token gaps below minTokens threshold",
                );
              }

              // W12: Unconditional scan for ANY message breakpoint (including SDK auto-marker).
              // Ensures cacheFenceIndex is set for all sessions, not just those with explicit placements.
              if (config.onBreakpointsPlaced && Array.isArray(result.messages)) {
                let highestBreakpointIdx = -1;
                const scanMsgs = result.messages as Array<Record<string, unknown>>;
                for (let i = scanMsgs.length - 1; i >= 0; i--) {
                  const content = scanMsgs[i]!.content;
                  if (Array.isArray(content)) {
                    for (const block of content as Record<string, unknown>[]) {
                      if (block.cache_control) {
                        highestBreakpointIdx = i;
                        break;
                      }
                    }
                  }
                  if (highestBreakpointIdx >= 0) break;
                }
                if (highestBreakpointIdx >= 0) {
                  config.onBreakpointsPlaced(highestBreakpointIdx);
                  logger.debug(
                    { highestBreakpointIdx, modelId: model.id },
                    "Cache fence callback fired",
                  );
                }
              }
            }

            // W12-FALLBACK: When all breakpoint slots are consumed, still scan for SDK auto-marker
            // to set cache fence. The SDK always places a marker on the last user message.
            if (slotsAvailable <= 0 && config.onBreakpointsPlaced && Array.isArray(result.messages)) {
              let highestBreakpointIdx = -1;
              const fallbackMsgs = result.messages as Array<Record<string, unknown>>;
              for (let i = fallbackMsgs.length - 1; i >= 0; i--) {
                const content = fallbackMsgs[i]!.content;
                if (Array.isArray(content)) {
                  for (const block of content as Record<string, unknown>[]) {
                    if (block.cache_control) {
                      highestBreakpointIdx = i;
                      break;
                    }
                  }
                }
                if (highestBreakpointIdx >= 0) break;
              }
              if (highestBreakpointIdx >= 0) {
                config.onBreakpointsPlaced(highestBreakpointIdx);
                logger.debug(
                  { highestBreakpointIdx, modelId: model.id, source: "sdk-auto-marker" },
                  "W12-FALLBACK: Cache fence set from SDK auto-marker (no explicit slots available)",
                );
              }
            }

            // Warn when cache fence remains unset in mature conversation.
            // This indicates no cache_control markers exist on any message -- neither explicit nor SDK auto.
            if (config.onBreakpointsPlaced && Array.isArray(result.messages) && (result.messages as unknown[]).length >= 10) {
              const scanForFence = result.messages as Array<Record<string, unknown>>;
              let fenceFound = false;
              for (let i = scanForFence.length - 1; i >= 0; i--) {
                const content = scanForFence[i]!.content;
                if (Array.isArray(content)) {
                  for (const block of content as Record<string, unknown>[]) {
                    if (block.cache_control) { fenceFound = true; break; }
                  }
                }
                if (fenceFound) break;
              }
              if (!fenceFound) {
                logger.warn(
                  {
                    messageCount: (result.messages as unknown[]).length,
                    modelId: model.id,
                    hint: "No cache breakpoint found on any message in mature conversation. Cache fence is unset -- thinking block cleaner has no protection boundary.",
                    errorKind: "performance" as const,
                  },
                  "Cache fence unset in mature session",
                );
              }
            }

            // W7: Diagnostic WARN when breakpoint budget exhausted on mature conversation.
            if (slotsAvailable <= 0 && Array.isArray(result.messages) && (result.messages as unknown[]).length >= 20) {
              logger.warn(
                {
                  existingCount,
                  messageCount: (result.messages as unknown[]).length,
                  modelId: model.id,
                  hint: "Breakpoint budget exhausted before message breakpoints. System prompt may need consolidation or tool breakpoint reduction.",
                  errorKind: "performance" as const,
                },
                "W7: Cache breakpoint budget exhausted -- no message breakpoints placed on mature conversation",
              );
            }
          }

          // Promote stable message breakpoints from 5m to 1h TTL
          // Skip breakpoint TTL promotion during eviction cooldown (conservative caching).
          {
          const cooldownForPromotion = config.getEvictionCooldown?.();
          const promotionBlocked = cooldownForPromotion != null && cooldownForPromotion.turnsRemaining > 0;
          if (config.blockStabilityTracker && config.sessionKey && !effectiveSkipCacheWrite && !promotionBlocked) {
            const promotionThreshold = config.stabilityThreshold ?? 3;
            const promotedCount = maybePromoteBreakpoints(
              result.messages as Array<Record<string, unknown>>,
              config.blockStabilityTracker,
              config.sessionKey,
              promotionThreshold,
              resolvedRetention,
            );
            if (promotedCount > 0) {
              logger.debug(
                { promoted: promotedCount, threshold: promotionThreshold, modelId: model.id },
                "Message breakpoints promoted to 1h TTL",
              );
            }
          }
          } // end eviction cooldown promotion scope


          // Sticky-on sweep -- capture any beta headers modified inside onPayload
          // and merge previously-latched values. Ensures consistency regardless of where
          // beta headers are added (outer scope or inside onPayload callbacks).
          if (config.sessionKey && mergedHeaders) {
            const allBetas = parseHeaderList(mergedHeaders["anthropic-beta"]);
            let latched = sessionBetaHeaderLatches.get(config.sessionKey);
            if (!latched) {
              latched = createAccumulativeLatch<string>();
              sessionBetaHeaderLatches.set(config.sessionKey, latched);
            }
            for (const beta of allBetas) latched.add(beta);
            // Inject any previously latched values not yet in current headers
            let changed = false;
            for (const beta of latched.getAll()) {
              if (!allBetas.includes(beta)) {
                allBetas.push(beta);
                changed = true;
              }
            }
            if (changed) {
              mergedHeaders["anthropic-beta"] = allBetas.join(", ");
            }
          }

          // Feed payload to cache break detector Phase 1 (after breakpoint placement)
          if (config.onPayloadForCacheDetection) {
            config.onPayloadForCacheDetection(result, model, mergedHeaders);
          }

          // Track cadence for recent-zone promotion (symmetric: promote slow, demote on fast).
          // Runs after onPayloadForCacheDetection so the detection snapshot reflects the
          // pre-mutation state. Mutation takes effect on the next turn's placeCacheBreakpoints().
          if (config.promoteRecentZoneOnSlowCadence && config.sessionKey
              && config.getElapsedSinceLastResponse && config.getLastResponseTs) {
            const lastResponseTs = config.getLastResponseTs();
            if (lastResponseTs !== undefined) {
              let tracker = sessionCadenceTracker.get(config.sessionKey);
              if (!tracker) {
                tracker = {
                  consecutiveSlowTurns: 0,
                  consecutiveFastTurns: 0,
                  promoted: false,
                  lastObservedResponseTs: undefined,
                };
                sessionCadenceTracker.set(config.sessionKey, tracker);
              }

              // Same-turn guard: successive onPayload calls inside one execute() all
              // observe the same lastResponseTs. Only count once per turn boundary.
              if (lastResponseTs !== tracker.lastObservedResponseTs) {
                tracker.lastObservedResponseTs = lastResponseTs;
                const elapsed = config.getElapsedSinceLastResponse();
                if (elapsed !== undefined) {
                  if (elapsed > SLOW_CADENCE_MS) {
                    tracker.consecutiveSlowTurns++;
                    tracker.consecutiveFastTurns = 0;
                    if (!tracker.promoted && tracker.consecutiveSlowTurns >= SLOW_CADENCE_PROMOTION_THRESHOLD) {
                      tracker.promoted = true;
                      logger.info(
                        { sessionKey: config.sessionKey, consecutiveSlowTurns: tracker.consecutiveSlowTurns },
                        "Recent-zone TTL promoted to long: slow cadence detected",
                      );
                    }
                  } else {
                    tracker.consecutiveFastTurns++;
                    tracker.consecutiveSlowTurns = 0;
                    if (tracker.promoted && tracker.consecutiveFastTurns >= FAST_CADENCE_DEMOTION_THRESHOLD) {
                      tracker.promoted = false;
                      logger.info(
                        { sessionKey: config.sessionKey, consecutiveFastTurns: tracker.consecutiveFastTurns },
                        "Recent-zone TTL demoted to short: fast cadence resumed",
                      );
                    }
                  }
                }
              }
            }
          }

          // SDK-UPGRADE: Upgrade SDK auto-placed 5m markers to 1h when retention is long.
          // The pi-ai SDK places cache_control: { type: "ephemeral" } (5m TTL) on the last
          // user message. When the session uses "long" retention, these 5m writes waste money
          // because they expire before the conversation can reuse them. Upgrading to 1h aligns
          // SDK markers with our retention strategy.
          // Runs BEFORE (skipCacheWrite overrides these anyway for subagents) and
          // BEFORE TTL split estimation (so estimates see the upgraded TTLs).
          // Note: message markers respect getMessageRetention (may be "short" even when
          // resolvedRetention is "long" -- e.g., adaptive retention splits tool/system from
          // conversation). System and tool markers always use resolvedRetention.
          if (needsCacheBreakpoints && resolvedRetention === "long" && !effectiveSkipCacheWrite) {
            const upgradeMarkers = (blocks: Array<Record<string, unknown>>) => {
              for (const block of blocks) {
                const cc = block.cache_control as Record<string, unknown> | undefined;
                if (cc && cc.type === "ephemeral" && !cc.ttl) {
                  cc.ttl = "1h";
                }
              }
            };

            // Upgrade system blocks (always follow resolvedRetention)
            if (Array.isArray(result.system)) {
              upgradeMarkers(result.system as Array<Record<string, unknown>>);
            }
            // Upgrade tool blocks (always follow resolvedRetention)
            if (Array.isArray(result.tools)) {
              upgradeMarkers(result.tools as Array<Record<string, unknown>>);
            }
            // Do NOT upgrade message markers here. placeCacheBreakpoints
            // already assigns zone-aware TTLs: semi-stable/mid get 1h, recent stays 5m.
            // Upgrading all message markers would override the intentionally "short"
            // recent-zone markers. System and tool markers above still get upgraded.
            // The SDK's auto-placed marker on the last user message is in the recent
            // zone and should remain at 5m.

            logger.debug(
              { modelId: model.id, sessionKey: config.sessionKey },
              "SDK-UPGRADE: Upgraded SDK 5m auto-markers to 1h for long retention",
            );
          }

          // skipCacheWrite places marker at shared-prefix point instead of stripping all.
          // The second-to-last user message is the shared-prefix boundary -- the parent's cache
          // already covers everything up to that point. Placing a marker there (instead of stripping)
          // lets the server merge with the existing cache entry without creating new writes.
          if (needsCacheBreakpoints && effectiveSkipCacheWrite && Array.isArray(result.messages)) {
            const msgs = result.messages as Array<Record<string, unknown>>;

            // Count user messages FIRST. Single-turn sub-agents (userCount < 2) have
            // no second-to-last-user anchor, so the shared-prefix strip+replace logic
            // cannot do anything useful. If we stripped markers unconditionally, the
            // request would reach Anthropic with ZERO cache_control anywhere -> 100%
            // cache miss, full-price input tokens. Bypass here so the SDK's earlier
            // auto-placed markers (system/tools, and last-user at 5m) remain intact
            // and the sub-agent can still match the parent's cached prefix.
            let userCount = 0;
            for (const msg of msgs) {
              if ((msg as Record<string, unknown>).role === "user") userCount++;
            }

            if (userCount < 2) {
              logger.debug(
                { modelId: model.id, sessionKey: config.sessionKey, userCount },
                "skipCacheWrite bypassed -- single-turn sub-agent keeps standard cache markers",
              );
            } else {
              // Strip system block cache_control markers (shared prefix)
              if (Array.isArray(result.system)) {
                for (const block of result.system as Array<Record<string, unknown>>) {
                  delete block.cache_control;
                }
              }
              // Strip tool definition cache_control markers (shared prefix)
              if (Array.isArray(result.tools)) {
                for (const tool of result.tools as Array<Record<string, unknown>>) {
                  delete tool.cache_control;
                }
              }
              // Strip all existing message-level cache_control markers
              for (const msg of msgs) {
                if (Array.isArray(msg.content)) {
                  for (const block of msg.content as Array<Record<string, unknown>>) {
                    delete block.cache_control;
                  }
                }
              }
              // Then: place marker on second-to-last user message (shared-prefix point)
              let seen = 0;
              for (let i = msgs.length - 1; i >= 0; i--) {
                if ((msgs[i] as Record<string, unknown>).role === "user") {
                  seen++;
                  if (seen === 2) {
                    addCacheControlToLastBlock(msgs[i] as Record<string, unknown>, resolvedRetention ?? "long");
                    break;
                  }
                }
              }
              // Re-place marker on last user message (volatile per-turn content).
              // The SDK's auto-placed last-user-message marker was stripped above. Re-placing
              // with "short" (5m) TTL ensures the last user message (with tool results) gets
              // cache reads ($0.30/MTok) instead of full-price uncached input ($3/MTok).
              for (let i = msgs.length - 1; i >= 0; i--) {
                if ((msgs[i] as Record<string, unknown>).role === "user") {
                  addCacheControlToLastBlock(msgs[i] as Record<string, unknown>, "short");
                  break;
                }
              }
              logger.debug(
                { modelId: model.id, sessionKey: config.sessionKey, markerPlaced: true, lastUserMarkerPlaced: true },
                "skipCacheWrite shared-prefix marker placement",
              );
            }
          }

          // Kill switch -- strip ALL cache_control when resolved retention is "none".
          // Must run AFTER all breakpoint/marker placement (system, tools, messages) so
          // nothing gets re-added after the strip pass.
          if (needsCacheBreakpoints && resolvedRetention === "none") {
            if (Array.isArray(result.system)) {
              for (const block of result.system as Array<Record<string, unknown>>) {
                delete block.cache_control;
              }
            }
            if (Array.isArray(result.tools)) {
              for (const tool of result.tools as Array<Record<string, unknown>>) {
                delete tool.cache_control;
              }
            }
            if (Array.isArray(result.messages)) {
              for (const msg of result.messages as Array<Record<string, unknown>>) {
                if (Array.isArray(msg.content)) {
                  for (const block of msg.content as Array<Record<string, unknown>>) {
                    delete block.cache_control;
                  }
                }
              }
            }
            logger.debug(
              { modelId: model.id, sessionKey: config.sessionKey },
              "Kill switch active -- stripped all cache_control markers",
            );
          }

          // Count per-TTL token distribution from final cache_control markers.
          // Runs AFTER all breakpoint placement and kill-switch stripping so counts
          // reflect the exact markers sent to the API.
          if (config.onTtlSplitEstimate && needsCacheBreakpoints) {
            let cacheWrite5mTokens = 0;
            let cacheWrite1hTokens = 0;

            // Uses module-level estimateBlockTokens (text extraction + CHARS_PER_TOKEN_RATIO)
            // Count system blocks with cache_control
            if (Array.isArray(result.system)) {
              for (const block of result.system as Array<Record<string, unknown>>) {
                if (block.cache_control) {
                  const tokens = estimateBlockTokens(block);
                  const cc = block.cache_control as Record<string, unknown>;
                  if (cc.ttl === "1h") {
                    cacheWrite1hTokens += tokens;
                  } else {
                    cacheWrite5mTokens += tokens;
                  }
                }
              }
            }

            // Count tool definitions with cache_control
            if (Array.isArray(result.tools)) {
              for (const tool of result.tools as Array<Record<string, unknown>>) {
                if (tool.cache_control) {
                  const tokens = estimateBlockTokens(tool);
                  const cc = tool.cache_control as Record<string, unknown>;
                  if (cc.ttl === "1h") {
                    cacheWrite1hTokens += tokens;
                  } else {
                    cacheWrite5mTokens += tokens;
                  }
                }
              }
            }

            // Count message blocks with cache_control
            if (Array.isArray(result.messages)) {
              for (const msg of result.messages as Array<Record<string, unknown>>) {
                if (Array.isArray(msg.content)) {
                  for (const block of msg.content as Array<Record<string, unknown>>) {
                    if (block.cache_control) {
                      const tokens = estimateBlockTokens(block);
                      const cc = block.cache_control as Record<string, unknown>;
                      if (cc.ttl === "1h") {
                        cacheWrite1hTokens += tokens;
                      } else {
                        cacheWrite5mTokens += tokens;
                      }
                    }
                  }
                }
              }
            }

            config.onTtlSplitEstimate({ cacheWrite5mTokens, cacheWrite1hTokens });
          }

          // Concern 3: service_tier (Responses API + fastMode)
          if (needsResponsesApiInjection && config.fastMode) {
            result.service_tier = "auto";
          }

          // Concern 4: store (Responses API + storeCompletions)
          if (needsResponsesApiInjection && config.storeCompletions) {
            result.store = true;
          }

          return result;
        },
      };

      return next(model, context, enhancedOptions as typeof options);
    };
  };
}
