// SPDX-License-Identifier: Apache-2.0
/**
 * Cache breakpoint helpers + adaptive TTL promotion.
 *
 * Hosts (directly):
 *  - `resolveCacheRetention` (public): per-model cache-retention override resolution.
 *  - `getMinCacheableTokens` (public): per-model minTokens threshold lookup.
 *  - `clearSessionPrefixStability` (public) + `sessionPrefixStability`
 *    (module-level state mutated by the factory).
 *  - `sortToolsForCacheStability` (public): tool ordering.
 *  - `identifyBreakpointZone`, `hashBreakpointContent`, `maybePromoteBreakpoints`
 *    (public): adaptive TTL promotion helpers.
 *  - `computeRenderedToolsHash`, `countCacheBreakpoints` (internal helpers
 *    consumed by the factory).
 *
 * Re-exports (canonical names) from sibling modules:
 *  - `addCacheControlToLastBlock`, `CACHEABLE_BLOCK_TYPES` from
 *    `./cache-control-block.js`
 *  - `placeCacheBreakpoints`, `placeSingleBreakpoint`, `BreakpointOptions`
 *    from `./breakpoint-placement.js`
 *  - `clearSessionCadenceTracker`, cadence threshold constants from
 *    `./cadence-tracker.js`
 *
 * @module
 */

import type { CacheRetention } from "@earendil-works/pi-ai";
import {
  MIN_CACHEABLE_TOKENS,
  DEFAULT_MIN_CACHEABLE_TOKENS,
} from "../../../context-engine/index.js";
import { computeHash } from "../../cache-detection/index.js";
import type { BlockStabilityTracker } from "../../block-stability-tracker.js";

// Re-exports — the new sub-modules host the canonical implementations.
export {
  addCacheControlToLastBlock,
  CACHEABLE_BLOCK_TYPES,
} from "./cache-control-block.js";
export {
  placeCacheBreakpoints,
  placeSingleBreakpoint,
} from "./breakpoint-placement.js";
export type { BreakpointOptions } from "./breakpoint-placement.js";
export {
  clearSessionCadenceTracker,
  sessionCadenceTracker,
  SLOW_CADENCE_MS,
  SLOW_CADENCE_PROMOTION_THRESHOLD,
  FAST_CADENCE_DEMOTION_THRESHOLD,
} from "./cadence-tracker.js";
export type { CadenceTrackerEntry } from "./cadence-tracker.js";

// ---------------------------------------------------------------------------
// Prefix stability tracking.
// Hashes the first N messages before microcompaction to detect prefix instability.
// When the prefix hash changes on consecutive turns, the cache prefix is unstable
// and every turn will miss cache reads beyond the system prompt.
// ---------------------------------------------------------------------------
export const sessionPrefixStability = new Map<string, { hash: number; fenceIdx: number; consecutiveChanges: number; msgHashes?: number[] }>();

export function clearSessionPrefixStability(sessionKey: string): void {
  sessionPrefixStability.delete(sessionKey);
}

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

/**
 * Compute a hash of rendered tools excluding cache_control.
 * Uses computeHash (djb2 over JSON.stringify) from cache-detection/.
 */
export function computeRenderedToolsHash(tools: Array<Record<string, unknown>>): number {
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
export function countCacheBreakpoints(params: Record<string, unknown>): number {
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

  // Non-Anthropic body guard (codex turn-abort regression 2026-06-14): the
  // OpenAI responses / openai-codex request body has `input`, not a `messages`
  // array, so `messages` is undefined here. cache_control breakpoint promotion
  // is Anthropic-only — no-op rather than throw `reading 'length'`, which the
  // provider's onPayload hook would surface as a silent whole-turn failure.
  if (!Array.isArray(messages)) return 0;

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

// Need to import addCacheControlToLastBlock for maybePromoteBreakpoints' usage path?
// No — maybePromoteBreakpoints mutates cache_control inline; it does not call addCacheControlToLastBlock.
// The import in breakpoint-placement.ts handles the helper consumption.

