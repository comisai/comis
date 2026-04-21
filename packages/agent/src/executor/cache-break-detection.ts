// SPDX-License-Identifier: Apache-2.0
/**
 * Cache break detection module: two-phase detection with Anthropic adapter.
 *
 * Phase 1 (pre-call): Records prompt state via provider-specific adapter
 * (system hash, per-tool schema hashes, cache_control metadata hash).
 *
 * Phase 2 (post-call): Compares cacheRead tokens against baseline using
 * AND-based dual threshold (both >5% relative AND >2000 absolute must exceed).
 * Provider-agnostic.
 *
 * Attribution priority: model > system > tools > retention > metadata > headers > extra_body > TTL > server eviction.
 *
 * @module
 */

import {
  CACHE_BREAK_RELATIVE_THRESHOLD,
  CACHE_BREAK_ABSOLUTE_THRESHOLD,
} from "../context-engine/constants.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DIFF-CONTENT: Maximum chars per category (system, tools) for serialized snapshot content. */
export const MAX_SNAPSHOT_CHARS = 50_000;

/** Maximum number of tracked sessions before LRU eviction. */
export const MAX_TRACKING_ENTRIES = 15;

/** Pattern matching model names excluded from cache break detection. */
const EXCLUDED_MODEL_PATTERN = /haiku/i;

/** Elapsed time threshold for "long TTL expiry" attribution (60 minutes). */
const TTL_LONG_MS = 60 * 60 * 1000;   // 3,600,000 ms

/** Elapsed time threshold for "short TTL expiry" attribution (5 minutes). */
const TTL_SHORT_MS = 5 * 60 * 1000;   // 300,000 ms

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptStateSnapshot {
  systemHash: number;
  toolsHash: number;
  cacheMetadataHash: number | null;
  toolNames: string[];
  perToolHashes: Record<string, number>;
  model: string;
  provider: string;
  retention: string | undefined;
  callCount: number;
  /** Hash of tracked headers (anthropic-beta, anthropic-version). null for non-Anthropic. */
  headersHash: number | null;
  /** Hash of extra body params outside standard API fields. null when no extras. */
  extraBodyHash: number | null;
  /** JSON-stringified params.thinking object for effort value change detection. */
  effortValue?: string;
  /** Hash of system blocks WITH cache_control markers intact. Catches TTL/scope marker flips. */
  cacheControlHash?: number;
  /** Lazy getter -- serialization only runs when called (zero cost on cache hits). */
  buildDiffableContent?: () => { system: string; tools: string };
  /** Breakpoint budget snapshot for cache break enrichment. */
  breakpointBudget?: {
    total: number;
    system: number;
    tool: number;
    message: number;
    sdkAuto: number;
  };
}

export interface PendingChanges {
  systemChanged: boolean;
  toolsChanged: boolean;
  metadataChanged: boolean;
  modelChanged: boolean;
  retentionChanged: boolean;
  addedTools: string[];
  removedTools: string[];
  changedSchemaTools: string[];
  /** HTTP headers changed between turns. */
  headersChanged: boolean;
  /** Extra body params changed between turns. */
  extraBodyChanged: boolean;
  /** Effort value (params.thinking) changed between turns. */
  effortChanged: boolean;
  /** cache_control markers changed on system blocks (TTL/scope flips). */
  cacheControlChanged: boolean;
}

export type CacheBreakReason =
  | "model_changed"
  | "system_changed"
  | "tools_changed"
  | "retention_changed"
  | "cache_metadata_changed"
  | "headers_changed"
  | "extra_body_changed"
  | "effort_changed"
  | "cache_control_changed"
  | "lookback_window_exceeded"
  | "ttl_expiry"
  | "ttl_expiry_long"
  | "ttl_expiry_short"
  | "likely_server_eviction"
  | "server_eviction";

export interface CacheBreakEvent {
  provider: string;
  reason: CacheBreakReason;
  tokenDrop: number;
  tokenDropRelative: number;
  previousCacheRead: number;
  currentCacheRead: number;
  callCount: number;
  changes: PendingChanges;
  /** Sanitized tool names that changed (MCP names collapsed). For observability events. */
  toolsChanged: string[];
  ttlCategory: "short" | "long" | "none" | undefined;
  agentId: string;
  sessionKey: string;
  timestamp: number;
  /** DIFF-CONTENT: Serialized previous system prompt content for diff generation. */
  previousSystem?: string;
  /** DIFF-CONTENT: Serialized current system prompt content for diff generation. */
  currentSystem?: string;
  /** DIFF-CONTENT: Serialized previous tools JSON for diff generation. */
  previousTools?: string;
  /** DIFF-CONTENT: Serialized current tools JSON for diff generation. */
  currentTools?: string;
  /** Effort value from detection pipeline for downstream consumers (diff writer, analytics). */
  effortValue?: string;
  /** W4: Number of message blocks in the conversation. Set for lookback window detection. */
  conversationBlockCount?: number;
  /** Breakpoint budget context at time of cache break. */
  breakpointBudget?: {
    total: number;
    system: number;
    tool: number;
    message: number;
    sdkAuto: number;
  };
}

export interface RecordPromptStateInput {
  sessionKey: string;
  agentId: string;
  provider: string;
  model: string;
  systemHash: number;
  toolsHash: number;
  cacheMetadataHash: number | null;
  toolNames: string[];
  perToolHashes: Record<string, number>;
  retention: string | undefined;
  /** Hash of tracked headers. null for non-Anthropic or when headers not provided. */
  headersHash: number | null;
  /** Hash of extra body params. null when no extras present. */
  extraBodyHash: number | null;
  /** JSON-stringified params.thinking object for effort value change detection. */
  effortValue?: string;
  /** Hash of system blocks WITH cache_control markers intact. */
  cacheControlHash?: number;
  /** Lazy getter -- deferred serialization for diff content (zero cost on cache hits). */
  buildDiffableContent?: () => { system: string; tools: string };
  /** Breakpoint budget for cache break enrichment. */
  breakpointBudget?: {
    total: number;
    system: number;
    tool: number;
    message: number;
    sdkAuto: number;
  };
}

export interface CheckCacheBreakInput {
  sessionKey: string;
  provider: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalInputTokens: number;
  /** Elapsed ms since last assistant response. Used for tiered server-side attribution. */
  lastResponseElapsedMs?: number;
  /** When true, API returned an error (400/429/500). Do not treat zero usage as cache break. */
  apiError?: boolean;
  /** W4: Number of message blocks in the conversation. Used for lookback window detection. */
  messageBlockCount?: number;
}

export interface CacheBreakDetector {
  recordPromptState(input: RecordPromptStateInput): void;
  checkResponseForCacheBreak(input: CheckCacheBreakInput): CacheBreakEvent | null;
  notifyCompaction(sessionKey: string): void;
  notifyTtlExpiry(sessionKey: string): void;
  /** G-09: Notify that content was intentionally modified (observation masking or microcompaction).
   *  Must be called BEFORE the next checkResponseForCacheBreak(). */
  notifyContentModification(sessionKey: string): void;
  /** Alias a compaction session key to its parent session's DetectorState.
   *  After aliasing, operations on compactionKey update the parent's state, preventing
   *  false cache break alerts during compaction transitions. No-op if parentKey has no state. */
  aliasSession(compactionKey: string, parentKey: string): void;
  cleanupSession(sessionKey: string): void;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DetectorState {
  currentSnapshot: PromptStateSnapshot | null;
  /** DIFF-CONTENT: Previous snapshot retained for serialized content diffing. */
  previousSnapshot: PromptStateSnapshot | null;
  previousCacheReadTokens: number | null;
  pendingChanges: PendingChanges | null;
  ttlExpired: boolean;
  compacted: boolean;
  /** Most recent agentId from recordPromptState, used for CacheBreakEvent. */
  agentId: string;
  /** G-09: Set by notifyContentModification() when observation masking or microcompaction modifies content. */
  contentModified: boolean;
}

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Classic DJB2 hash. Fast non-crypto hash for prompt state fingerprinting.
 * Returns unsigned 32-bit integer.
 */
export function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0; // hash * 33 + c
  }
  return hash >>> 0; // unsigned 32-bit
}

/**
 * Serialize any value to JSON, then hash via djb2.
 * Strings are hashed directly without JSON serialization.
 * Handles undefined (JSON.stringify(undefined) returns undefined, not a string).
 */
export function computeHash(data: unknown): number {
  if (data === undefined) return djb2("undefined");
  return djb2(typeof data === "string" ? data : JSON.stringify(data));
}

/**
 * Collapse MCP tool names from mcp__server--tool to mcp__server for observability.
 * Non-MCP tool names pass through unchanged.
 */
export function sanitizeMcpToolName(name: string): string {
  if (name.startsWith("mcp__") && name.includes("--")) {
    return name.split("--")[0];
  }
  return name;
}

/** Collapse all MCP tool names to bare 'mcp' for analytics/observability payloads.
 *  Prevents user-controlled server names (which may contain filepaths) from leaking into analytics.
 *  Stricter than sanitizeMcpToolName() which preserves server-level granularity for detection. */
export function sanitizeMcpToolNameForAnalytics(name: string): string {
  return name.startsWith("mcp__") ? "mcp" : name;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const NO_CHANGES: PendingChanges = {
  systemChanged: false,
  toolsChanged: false,
  metadataChanged: false,
  modelChanged: false,
  retentionChanged: false,
  addedTools: [],
  removedTools: [],
  changedSchemaTools: [],
  headersChanged: false,
  extraBodyChanged: false,
  effortChanged: false,
  cacheControlChanged: false,
};

/** Check whether a model should be excluded from cache break detection. */
function isExcludedModel(model: string): boolean {
  return EXCLUDED_MODEL_PATTERN.test(model);
}

/** Compare two snapshots and compute PendingChanges. */
function buildPendingChanges(prev: PromptStateSnapshot, curr: PromptStateSnapshot): PendingChanges {
  const systemChanged = prev.systemHash !== curr.systemHash;
  const metadataChanged = prev.cacheMetadataHash !== curr.cacheMetadataHash;
  const modelChanged = prev.model !== curr.model;
  const retentionChanged = prev.retention !== curr.retention;

  // Lazy per-tool comparison -- skip N JSON.stringify+hash calls
  // when aggregate toolsHash is unchanged (common path: 30-50 tools unchanged).
  const addedTools: string[] = [];
  const removedTools: string[] = [];
  const changedSchemaTools: string[] = [];
  let toolsChanged = false;

  if (prev.toolsHash !== curr.toolsHash) {
    // Aggregate hash changed -- compute per-tool diff
    const prevNames = new Set(prev.toolNames);
    const currNames = new Set(curr.toolNames);

    for (const name of currNames) {
      if (!prevNames.has(name)) {
        addedTools.push(name);
      } else if (prev.perToolHashes[name] !== curr.perToolHashes[name]) {
        changedSchemaTools.push(name);
      }
    }

    for (const name of prevNames) {
      if (!currNames.has(name)) {
        removedTools.push(name);
      }
    }

    toolsChanged = addedTools.length > 0 || removedTools.length > 0 || changedSchemaTools.length > 0;
  }

  const headersChanged = prev.headersHash !== curr.headersHash;
  const extraBodyChanged = prev.extraBodyHash !== curr.extraBodyHash;
  // Effort value (params.thinking) change detection
  const effortChanged = prev.effortValue !== curr.effortValue;
  // cache_control marker change detection (TTL/scope flips invisible to stripped systemHash)
  const cacheControlChanged = (prev.cacheControlHash ?? 0) !== (curr.cacheControlHash ?? 0);

  return {
    systemChanged,
    toolsChanged,
    metadataChanged,
    modelChanged,
    retentionChanged,
    addedTools,
    removedTools,
    changedSchemaTools,
    headersChanged,
    extraBodyChanged,
    effortChanged,
    cacheControlChanged,
  };
}

/**
 * Attribute the primary reason for a cache break using fixed priority ordering.
 * Priority: model > system > tools > retention > metadata > headers > extra_body > effort >
 *           cache_control > lookback_window > TTL > tiered server attribution.
 *
 * W4: conversationBlockCount enables lookback window detection before TTL fallthrough.
 */
function attributeReason(
  changes: PendingChanges,
  ttlExpired: boolean,
  lastResponseElapsedMs: number | undefined,
  conversationBlockCount: number,
): CacheBreakReason {
  if (changes.modelChanged) return "model_changed";
  if (changes.systemChanged) return "system_changed";
  if (changes.toolsChanged) return "tools_changed";
  if (changes.retentionChanged) return "retention_changed";
  if (changes.metadataChanged) return "cache_metadata_changed";
  // New reasons after metadata, before TTL
  if (changes.headersChanged) return "headers_changed";
  if (changes.extraBodyChanged) return "extra_body_changed";
  // Effort and cache_control reasons after extra_body, before TTL
  if (changes.effortChanged) return "effort_changed";
  if (changes.cacheControlChanged) return "cache_control_changed";
  if (ttlExpired) return "ttl_expiry";
  // W4: Lookback window exceeded -- conversation grew beyond cache anchoring range.
  // cacheRead drops to system prefix baseline but no client-side changes explain it.
  // This is expected behavior for long conversations, NOT a server eviction.
  // Threshold: 20 blocks matches Anthropic's documented lookback window.
  if (conversationBlockCount > 20 && lastResponseElapsedMs !== undefined && lastResponseElapsedMs <= TTL_SHORT_MS) {
    return "lookback_window_exceeded";
  }
  // Tiered server-side attribution when no client-side changes explain the break
  if (lastResponseElapsedMs !== undefined) {
    if (lastResponseElapsedMs > TTL_LONG_MS) return "ttl_expiry_long";
    if (lastResponseElapsedMs > TTL_SHORT_MS) return "ttl_expiry_short";
    return "likely_server_eviction";
  }
  return "server_eviction";
}

/** Derive TTL category from retention string. */
function deriveTtlCategory(retention: string | undefined): "short" | "long" | "none" | undefined {
  if (retention === "short") return "short";
  if (retention === "long") return "long";
  if (retention === undefined) return undefined;
  return "none";
}

/** Collect sanitized changed tool names for event payload. */
function collectChangedTools(changes: PendingChanges): string[] {
  const names = new Set<string>();
  for (const n of changes.addedTools) names.add(sanitizeMcpToolName(n));
  for (const n of changes.removedTools) names.add(sanitizeMcpToolName(n));
  for (const n of changes.changedSchemaTools) names.add(sanitizeMcpToolName(n));
  return [...names];
}

// ---------------------------------------------------------------------------
// LRU-bounded Map
// ---------------------------------------------------------------------------

/**
 * Simple LRU-bounded Map using JS Map's insertion-order guarantee.
 * On get()/set(), delete-then-reinsert moves the key to most-recently-used.
 * On set(), if size exceeds capacity, the first key (LRU) is evicted.
 */
interface LruMap<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
  clear(): void;
  has(key: K): boolean;
  readonly size: number;
}

function createLruMap<K, V>(capacity: number, onEvict?: (key: K) => void): LruMap<K, V> {
  const map = new Map<K, V>();
  return {
    get(key: K): V | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        // Move to most-recently-used: delete then re-insert at end
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: K, value: V): void {
      // If key exists, delete first to update insertion order
      if (map.has(key)) {
        map.delete(key);
      }
      map.set(key, value);
      // Evict LRU (first key) if over capacity
      if (map.size > capacity) {
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) {
          onEvict?.(firstKey);
          map.delete(firstKey);
        }
      }
    },
    delete(key: K): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
    has(key: K): boolean {
      return map.has(key);
    },
    get size(): number {
      return map.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level session state (default instance for singleton usage)
// ---------------------------------------------------------------------------

let sessionDetectorState = createLruMap<string, DetectorState>(MAX_TRACKING_ENTRIES);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface DetectorLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/** Options for createCacheBreakDetector. */
export interface CacheBreakDetectorOptions {
  /** Design 3.4: Override max tracked sessions (default: MAX_TRACKING_ENTRIES = 15). */
  maxTrackingEntries?: number;
}

/**
 * Create a cache break detector instance.
 *
 * Uses per-instance LRU Map for per-session state. When the map exceeds
 * maxTrackingEntries, the oldest session is evicted with a WARN log.
 */
export function createCacheBreakDetector(
  logger: DetectorLogger,
  options?: CacheBreakDetectorOptions,
): CacheBreakDetector {
  const maxEntries = options?.maxTrackingEntries ?? MAX_TRACKING_ENTRIES;

  // Design 3.4: Create LRU map with WARN on eviction
  sessionDetectorState = createLruMap<string, DetectorState>(maxEntries, (evictedKey) => {
    if (logger.warn) {
      logger.warn(
        { evictedSession: evictedKey, mapSize: maxEntries, hint: "Increase cache break detector maxTrackingEntries for deployments with many concurrent agents", errorKind: "resource" as const },
        "Cache break detector: LRU eviction -- oldest session loses tracking",
      );
    }
  });

  function getOrCreateState(sessionKey: string): DetectorState {
    let state = sessionDetectorState.get(sessionKey);
    if (!state) {
      state = {
        currentSnapshot: null,
        previousSnapshot: null,
        previousCacheReadTokens: null,
        pendingChanges: null,
        ttlExpired: false,
        compacted: false,
        agentId: "",
        contentModified: false,
      };
      sessionDetectorState.set(sessionKey, state);
    }
    return state;
  }

  return {
    recordPromptState(input: RecordPromptStateInput): void {
      const state = getOrCreateState(input.sessionKey);

      // Build new snapshot
      const newSnapshot: PromptStateSnapshot = {
        systemHash: input.systemHash,
        toolsHash: input.toolsHash,
        cacheMetadataHash: input.cacheMetadataHash,
        toolNames: input.toolNames,
        perToolHashes: input.perToolHashes,
        model: input.model,
        provider: input.provider,
        retention: input.retention,
        callCount: (state.currentSnapshot?.callCount ?? 0) + 1,
        headersHash: input.headersHash,
        extraBodyHash: input.extraBodyHash,
        effortValue: input.effortValue,
        cacheControlHash: input.cacheControlHash,
        buildDiffableContent: input.buildDiffableContent,
        breakpointBudget: input.breakpointBudget,
      };

      // Compare with previous snapshot if exists
      if (state.currentSnapshot) {
        state.pendingChanges = buildPendingChanges(state.currentSnapshot, newSnapshot);
        // DIFF-CONTENT: Retain previous snapshot for serialized content diffing
        state.previousSnapshot = state.currentSnapshot;
      }

      state.currentSnapshot = newSnapshot;
      state.agentId = input.agentId;

      logger.debug(
        { sessionKey: input.sessionKey, callCount: newSnapshot.callCount, provider: input.provider },
        "Cache break detector: state recorded",
      );
    },

    checkResponseForCacheBreak(input: CheckCacheBreakInput): CacheBreakEvent | null {
      const state = sessionDetectorState.get(input.sessionKey);

      // No state at all for this session
      if (!state || !state.currentSnapshot) {
        return null;
      }

      // API errors produce zero usage but are not cache breaks.
      // Do NOT update previousCacheReadTokens -- preserve the last known-good baseline.
      if (input.apiError) {
        return null;
      }

      // First call: record baseline, return null
      if (state.previousCacheReadTokens === null) {
        state.previousCacheReadTokens = input.cacheReadTokens;
        return null;
      }

      // Compaction: reset baseline, return null
      if (state.compacted) {
        state.previousCacheReadTokens = input.cacheReadTokens;
        state.compacted = false;
        return null;
      }

      // Skip detection for models with different caching behavior
      if (state.currentSnapshot && isExcludedModel(state.currentSnapshot.model)) {
        state.previousCacheReadTokens = input.cacheReadTokens;
        return null;
      }

      // G-09: Content modification (observation masking or microcompaction) -- dual-check suppression.
      // Evaluate pendingChanges to determine if a genuine prompt state change co-occurred.
      // If no real changes: suppress the event and reset baseline.
      // If real changes: emit the event with correct attribution (using original baseline).
      if (state.contentModified) {
        state.contentModified = false;

        const changes = state.pendingChanges ?? NO_CHANGES;
        const hasRealChanges = changes.systemChanged || changes.toolsChanged
          || changes.modelChanged || changes.retentionChanged || changes.metadataChanged
          || changes.headersChanged || changes.extraBodyChanged
          || changes.effortChanged || changes.cacheControlChanged;

        if (!hasRealChanges) {
          state.previousCacheReadTokens = input.cacheReadTokens;
          logger.debug({ sessionKey: input.sessionKey },
            "Cache break detector: content modification expected, baseline reset -- suppressed");
          return null;
        }
        // Fall through to attribution -- real change happened alongside content modification
      }

      const prevCacheRead = state.previousCacheReadTokens;
      const tokenDrop = prevCacheRead - input.cacheReadTokens;
      const relDrop = prevCacheRead > 0 ? tokenDrop / prevCacheRead : 0;

      // Update baseline
      state.previousCacheReadTokens = input.cacheReadTokens;

      // No drop
      if (tokenDrop <= 0) {
        return null;
      }

      // AND threshold -- both relative AND absolute must exceed to trigger detection.
      // Reduces false positives: small absolute drops on large contexts (3K on 200K = 1.5%)
      // and small relative drops on small contexts (6% on 10K = 600 tokens) are suppressed.
      if (relDrop <= CACHE_BREAK_RELATIVE_THRESHOLD || tokenDrop <= CACHE_BREAK_ABSOLUTE_THRESHOLD) {
        return null;
      }

      // Attribute reason
      const changes = state.pendingChanges ?? NO_CHANGES;
      // W4: Thread messageBlockCount for lookback window detection (default 0 for backward compat)
      const conversationBlockCount = input.messageBlockCount ?? 0;
      const reason = attributeReason(changes, state.ttlExpired, input.lastResponseElapsedMs, conversationBlockCount);

      // Clear TTL flag after attribution
      state.ttlExpired = false;

      // Materialize lazy content only on detected break
      const prevContent = state.previousSnapshot?.buildDiffableContent?.();
      const currContent = state.currentSnapshot.buildDiffableContent?.();

      const event: CacheBreakEvent = {
        provider: input.provider,
        reason,
        tokenDrop,
        tokenDropRelative: relDrop,
        previousCacheRead: prevCacheRead,
        currentCacheRead: input.cacheReadTokens,
        callCount: state.currentSnapshot.callCount,
        changes,
        toolsChanged: collectChangedTools(changes),
        ttlCategory: deriveTtlCategory(state.currentSnapshot.retention),
        agentId: state.agentId,
        sessionKey: input.sessionKey,
        timestamp: Date.now(),
        // Thread lazy-materialized content for diff writer
        previousSystem: prevContent?.system,
        currentSystem: currContent?.system,
        previousTools: prevContent?.tools,
        currentTools: currContent?.tools,
        // Thread effort value for downstream consumers
        effortValue: state.currentSnapshot.effortValue,
        // W4: Thread conversation block count for lookback observability
        conversationBlockCount: conversationBlockCount > 0 ? conversationBlockCount : undefined,
        // Thread breakpoint budget context for cache break enrichment
        breakpointBudget: state.currentSnapshot.breakpointBudget,
      };

      logger.info(
        { agentId: event.agentId, provider: event.provider, reason: event.reason, tokenDrop: event.tokenDrop, toolsChanged: event.toolsChanged },
        "Cache break detected",
      );

      return event;
    },

    notifyCompaction(sessionKey: string): void {
      const state = sessionDetectorState.get(sessionKey);
      if (state) {
        state.compacted = true;
        logger.debug({ sessionKey }, "Cache break detector: compaction notified, baseline will reset");
      }
    },

    notifyTtlExpiry(sessionKey: string): void {
      const state = sessionDetectorState.get(sessionKey);
      if (state) {
        state.ttlExpired = true;
        logger.debug({ sessionKey }, "Cache break detector: TTL expiry notified");
      }
    },

    notifyContentModification(sessionKey: string): void {
      const state = sessionDetectorState.get(sessionKey);
      if (state) {
        state.contentModified = true;
        logger.debug({ sessionKey }, "Cache break detector: content modification notified");
      }
    },

    aliasSession(compactionKey: string, parentKey: string): void {
      const parentState = sessionDetectorState.get(parentKey);
      if (parentState) {
        sessionDetectorState.set(compactionKey, parentState);
        logger.debug({ compactionKey, parentKey }, "Cache break detector: session aliased for compaction");
      }
    },

    cleanupSession(sessionKey: string): void {
      sessionDetectorState.delete(sessionKey);
    },

    reset(): void {
      sessionDetectorState.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

/**
 * Standard Anthropic Messages API fields.
 * Any key in the params object NOT in this set is an "extra body" parameter.
 * Includes cache/SDK-internal fields to avoid false positives from breakpoint injection.
 */
const STANDARD_ANTHROPIC_FIELDS = new Set([
  "model", "max_tokens", "messages", "system", "stop_sequences",
  "stream", "temperature", "top_p", "top_k", "tools", "tool_choice",
  "thinking", "output_config", "cache_control", "container",
  "inference_geo", "service_tier", "metadata",
  // SDK-internal / breakpoint-injected fields (not user-controlled)
  "betas",
]);

/**
 * Extract prompt state from Anthropic API payload for Phase 1 recording.
 *
 * CRITICAL: Does NOT mutate the original params object. Creates shallow copies
 * for hashing with cache_control stripped (D-08). Per-tool hashing uses
 * input_schema (D-09).
 */
export function extractAnthropicPromptState(
  params: Record<string, unknown>,
  modelId: string,
  retention: string | undefined,
  sessionKey: string,
  agentId: string,
  headers?: Record<string, string>,
): RecordPromptStateInput {
  // Extract tools (do NOT mutate params)
  const tools = Array.isArray(params.tools)
    ? (params.tools as Array<Record<string, unknown>>)
    : [];

  // Per-tool hashing using input_schema (D-09)
  // Skip server-side tools (tool_search_tool_regex etc.) which lack input_schema.
  const perToolHashes: Record<string, number> = {};
  const toolNames: string[] = [];
  for (const tool of tools) {
    const name = tool.name as string;
    // Server-side tools have a `type` field (e.g., "tool_search_tool_regex_20251119")
    // and no input_schema — skip them for per-tool hashing.
    if (typeof tool.type === "string" && (tool.type as string).startsWith("tool_search_tool_")) continue;
    toolNames.push(name);
    perToolHashes[name] = computeHash(tool.input_schema);
  }

  // Hash all tools together (without cache_control -- explicit field pick)
  // Filter out server-side tools for stable hashing.
  const toolsForHash = tools
    .filter((t) => !(typeof t.type === "string" && (t.type as string).startsWith("tool_search_tool_")))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  const toolsHash = computeHash(toolsForHash);

  // System prompt hash (strip cache_control from system blocks)
  const system = Array.isArray(params.system)
    ? (params.system as Array<Record<string, unknown>>)
    : [];
  const systemForHash = system.map((block) => {
     
    const { cache_control: _cc, ...rest } = block;
    return rest;
  });
  const systemHash = computeHash(systemForHash);

  // Hash cache_control metadata separately (D-08)
  const cacheMetadata = [
    ...tools.map((t) => t.cache_control).filter(Boolean),
    ...system.map((b) => b.cache_control).filter(Boolean),
  ];
  const cacheMetadataHash = cacheMetadata.length > 0
    ? computeHash(cacheMetadata)
    : null;

  // Hash tracked Anthropic headers
  const headersHash = headers
    ? computeHash({
        "anthropic-beta": headers["anthropic-beta"] ?? "",
        "anthropic-version": headers["anthropic-version"] ?? "",
      })
    : null;

  // Hash extra body params (keys not in STANDARD_ANTHROPIC_FIELDS)
  const extraKeys = Object.keys(params).filter(k => !STANDARD_ANTHROPIC_FIELDS.has(k));
  const extraBodyHash = extraKeys.length > 0
    ? computeHash(Object.fromEntries(extraKeys.sort().map(k => [k, params[k]])))
    : null;

  // Extract effort value from thinking param
  const thinking = params.thinking as Record<string, unknown> | undefined;
  const effortValue = thinking ? JSON.stringify(thinking) : undefined;

  // Hash system blocks WITH cache_control markers intact (catches TTL/scope flips)
  const cacheControlHash = computeHash(system);

  // Lazy getter -- capture stripped values at creation time (before any cache_control mutation).
  // Serialization only runs when a cache break is detected (zero cost on cache hits).
  const capturedSystem = system.map((block) => (block.text as string) ?? "");
  const capturedToolsForHash = toolsForHash; // already stripped of cache_control
  const buildDiffableContent = (): { system: string; tools: string } => ({
    system: capturedSystem.join("\n").slice(0, MAX_SNAPSHOT_CHARS),
    tools: JSON.stringify(capturedToolsForHash, null, 2).slice(0, MAX_SNAPSHOT_CHARS),
  });

  // Compute breakpoint budget from API params for cache break enrichment.
  // Counts cache_control markers on system blocks, tools, and messages.
  let systemBpCount = 0;
  let toolBpCount = 0;
  let messageBpCount = 0;
  for (const block of system) {
    if (block.cache_control) systemBpCount++;
  }
  for (const tool of tools) {
    if (tool.cache_control) toolBpCount++;
  }
  const messages = Array.isArray(params.messages)
    ? (params.messages as Array<Record<string, unknown>>)
    : [];
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.cache_control) { messageBpCount++; break; }
      }
    }
  }
  const sdkAutoCount = 1; // SDK always places a marker on the last user message

  return {
    sessionKey,
    agentId,
    provider: "anthropic",
    model: modelId,
    systemHash,
    toolsHash,
    cacheMetadataHash,
    toolNames,
    perToolHashes,
    retention,
    headersHash,
    extraBodyHash,
    effortValue,
    cacheControlHash,
    buildDiffableContent,
    breakpointBudget: {
      total: 4,
      system: systemBpCount,
      tool: toolBpCount,
      message: messageBpCount,
      sdkAuto: sdkAutoCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini adapter
// ---------------------------------------------------------------------------

/**
 * Extract Gemini-native prompt state for Phase 1 cache break detection.
 *
 * Gemini payload structure differs from Anthropic:
 * - System prompt: config.systemInstruction (string, not array of blocks)
 * - Tools: config.tools[0].functionDeclarations (nested, not flat)
 * - Per-tool schema: parametersJsonSchema (not input_schema)
 * - No cache_control markers (cacheMetadataHash always null)
 * - No adaptive retention (Gemini reads static config.cacheRetention)
 */
export function extractGeminiPromptState(
  params: Record<string, unknown>,
  modelId: string,
  sessionKey: string,
  agentId: string,
): RecordPromptStateInput {
  const configObj = params.config as Record<string, unknown> | undefined;

  // System instruction is a string (not array of blocks like Anthropic)
  const systemInstruction = configObj?.systemInstruction;
  const systemHash = computeHash(systemInstruction ?? "");

  // Tools are nested: config.tools[0].functionDeclarations
  const toolsArr = configObj?.tools as Array<Record<string, unknown>> | undefined;
  const functionDeclarations: Array<Record<string, unknown>> =
    Array.isArray(toolsArr) && toolsArr.length > 0
      ? (toolsArr[0]?.functionDeclarations as Array<Record<string, unknown>> ?? [])
      : [];

  // Per-tool hashing using parametersJsonSchema (Gemini equivalent of Anthropic input_schema)
  const perToolHashes: Record<string, number> = {};
  const toolNames: string[] = [];
  for (const decl of functionDeclarations) {
    const name = decl.name as string;
    toolNames.push(name);
    perToolHashes[sanitizeMcpToolName(name)] = computeHash(decl.parametersJsonSchema);
  }

  // Hash all function declarations together for aggregate tools hash
  const toolsHash = computeHash(functionDeclarations);

  return {
    sessionKey,
    agentId,
    provider: "google",
    model: modelId,
    systemHash,
    toolsHash,
    cacheMetadataHash: null, // Gemini has no inline cache_control markers
    toolNames,
    perToolHashes,
    retention: undefined,       // Gemini reads static config, not adaptive retention
    headersHash: null, // Gemini does not track headers
    extraBodyHash: null, // Gemini does not track extra body params
  };
}

// ---------------------------------------------------------------------------
// Session cleanup export
// ---------------------------------------------------------------------------

/**
 * Clear cache break detector state for a specific session.
 * Called from session-snapshot-cleanup.ts.
 */
export function clearCacheBreakDetectorSession(formattedKey: string): void {
  sessionDetectorState.delete(formattedKey);
}
