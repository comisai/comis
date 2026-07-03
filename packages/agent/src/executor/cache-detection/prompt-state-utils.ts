// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break detection — pure utilities for prompt-state fingerprinting
 * and change detection.
 *
 * Functions in this module are pure (no closure captures, no module-level
 * state). Used by the factory in cache-state.ts and the provider adapters
 * in anthropic-extractor.ts / gemini-extractor.ts.
 *
 * @module
 */

import type { PendingChanges, PromptStateSnapshot, CacheBreakReason } from "./cache-state-types.js";

// ---------------------------------------------------------------------------
// Public helpers (exported)
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
// Internal helpers (consumed by cache-state.ts; not re-exported from index.ts)
// ---------------------------------------------------------------------------

/** Elapsed time threshold for "long TTL expiry" attribution (60 minutes). */
const TTL_LONG_MS = 60 * 60 * 1000;   // 3,600,000 ms

/** Elapsed time threshold for "short TTL expiry" attribution (5 minutes). */
const TTL_SHORT_MS = 5 * 60 * 1000;   // 300,000 ms

export const NO_CHANGES: PendingChanges = {
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

/** Compare two snapshots and compute PendingChanges. */
export function buildPendingChanges(prev: PromptStateSnapshot, curr: PromptStateSnapshot): PendingChanges {
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
 * conversationBlockCount enables lookback window detection before TTL fallthrough.
 */
export function attributeReason(
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
  // Header / extra-body reasons after metadata, before TTL
  if (changes.headersChanged) return "headers_changed";
  if (changes.extraBodyChanged) return "extra_body_changed";
  // Effort and cache_control reasons after extra_body, before TTL
  if (changes.effortChanged) return "effort_changed";
  if (changes.cacheControlChanged) return "cache_control_changed";
  if (ttlExpired) return "ttl_expiry";
  // Lookback window exceeded -- conversation grew beyond cache anchoring range.
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
export function deriveTtlCategory(retention: string | undefined): "short" | "long" | "none" | undefined {
  if (retention === "short") return "short";
  if (retention === "long") return "long";
  if (retention === undefined) return undefined;
  return "none";
}

/** Collect sanitized changed tool names for event payload. */
export function collectChangedTools(changes: PendingChanges): string[] {
  const names = new Set<string>();
  for (const n of changes.addedTools) names.add(sanitizeMcpToolName(n));
  for (const n of changes.removedTools) names.add(sanitizeMcpToolName(n));
  for (const n of changes.changedSchemaTools) names.add(sanitizeMcpToolName(n));
  return [...names];
}
