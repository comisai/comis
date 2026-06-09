// SPDX-License-Identifier: Apache-2.0
/**
 * Request-body injector public types.
 *
 * Lifted out of request-body-injector.ts to break the factory's import
 * cycle with the leaf modules. The barrel (index.ts) re-exports
 * RequestBodyInjectorConfig under the canonical name.
 *
 * @module
 */

import type { CacheRetention } from "@earendil-works/pi-ai";
import type { SessionLatch } from "../../session-latch.js";
import type { BlockStabilityTracker } from "../../block-stability-tracker.js";
import type { ModelProfile } from "../../model-profile.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the request body injector wrapper.
 * Controls cache breakpoints, 1M beta header, service_tier, and store injection.
 */
export interface RequestBodyInjectorConfig {
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
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
   *  placement. Used by the cache break detector to extract prompt state for
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
  /** Timestamp (ms since epoch) of the parent's last confirmed cache write.
   *  Used by the TTL expiry guard to disable skipCacheWrite when the shared prefix
   *  cache has likely expired (>80% of TTL elapsed). */
  cacheWriteTimestamp?: number;
  /** Parent's cache retention tier ("short" or "long"). Used alongside
   *  cacheWriteTimestamp to determine the TTL boundary for the expiry guard. */
  parentCacheRetention?: string;
  /** Session key for rendered tool cache. When provided, tools rendered by
   *  the SDK are cached and replayed byte-identically on subsequent turns. */
  sessionKey?: string;
  /** Getter for deferred tool names from tool deferral pipeline.
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
  /** Callback invoked after cache breakpoint placement with per-TTL token estimates.
   *  Counts tokens under 5m vs 1h cache_control markers for accurate cost attribution.
   *  The bridge normalizes these estimates against the actual SDK-reported cacheWriteTokens. */
  onTtlSplitEstimate?: (estimate: { cacheWrite5mTokens: number; cacheWrite1hTokens: number }) => void;
  /**
   * Getter for the per-session call counter (1-indexed turn number within
   * the current agent session — turn 1 = first model call after session
   * start). Returns undefined when the session has no detector state yet
   * (cold start).
   *
   * The factory threads this into `upgradeSdkMarkers` so the 5m → 1h
   * marker promotion only fires from turn 2 onward; first-turn writes
   * that get evicted server-side would otherwise pay the 1h premium for
   * nothing. Wired from the CacheBreakDetector's `getCallCount` getter
   * in executor-stream-setup.ts.
   */
  getCallCount?: () => number | undefined;
  /**
   * ModelProfile resolved for this execution. Carries supportsPromptCache,
   * supportsServerToolSearch, and other capability flags resolved once
   * per execution in pi-executor.ts (L1/L2 routing — Phase 155-01).
   *
   * When present: supportsPromptCache drives cache-breakpoint placement
   * (factory.ts needsCacheBreakpoints); supportsServerToolSearch drives
   * tool_search injection (tool-deferral-injection.ts).
   *
   * When absent: existing provider-string predicates (isAnthropicFamily /
   * supportsToolSearch) serve as the fallback — behavior is unchanged for
   * callers that do not yet thread modelProfile.
   */
  modelProfile?: ModelProfile;
}
