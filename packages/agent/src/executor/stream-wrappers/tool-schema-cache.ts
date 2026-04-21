// SPDX-License-Identifier: Apache-2.0
/**
 * Extracted tool schema cache module.
 *
 * Pure data structures for session-scoped rendered tool caching.
 * Leaf module: imports only from cache-break-detection.ts (computeHash).
 * Zero imports from request-body-injector.ts.
 *
 * @module
 */
import { computeHash } from "../cache-break-detection.js";

// ---------------------------------------------------------------------------
// Session-scoped rendered tool cache.
// Stores the last rendered params.tools array (pre-cache_control) keyed by session.
// Guarantees byte-identical JSON.stringify across turns when tool composition is unchanged.
// ---------------------------------------------------------------------------
export interface RenderedToolCacheEntry {
  hash: number;
  featureFlagHash: string; // included in cache key for config-aware invalidation
  tools: Array<Record<string, unknown>>;
}
export const sessionRenderedToolCache = new Map<string, RenderedToolCacheEntry>();

export function clearSessionRenderedToolCache(sessionKey: string): void {
  sessionRenderedToolCache.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Per-tool content-addressed memoization cache.
// Stores individual rendered tool objects keyed by tool name within a session.
// Each entry has a content-addressed key `${name}:${hash}` so that schema or
// description changes for one tool do not invalidate the cache for others.
// ---------------------------------------------------------------------------
export type PerToolCacheEntry = {
  key: string; // content-addressed: `${name}:${schemaHash}`
  tool: Record<string, unknown>;
};
export const sessionPerToolCache = new Map<string, Map<string, PerToolCacheEntry>>();

/**
 * Get or cache a single rendered tool object by content-addressed key.
 * Returns byte-identical reference when name+description+input_schema is unchanged.
 * When any field changes, a new structuredClone snapshot replaces the old entry.
 *
 * @param sessionKey - Session key for cache scoping
 * @param tool - Rendered tool object with name, description, input_schema
 * @returns Cached or freshly cloned tool object
 */
export function getOrCacheRenderedTool(
  sessionKey: string,
  tool: Record<string, unknown>,
): Record<string, unknown> {
  const name = tool.name as string;
  const cacheKey = `${name}:${computeHash({ name: tool.name, description: tool.description, input_schema: tool.input_schema })}`;

  let sessionTools = sessionPerToolCache.get(sessionKey);
  if (!sessionTools) {
    sessionTools = new Map();
    sessionPerToolCache.set(sessionKey, sessionTools);
  }

  const cached = sessionTools.get(name);
  if (cached && cached.key === cacheKey) {
    return cached.tool; // byte-identical reference
  }

  // Create a new snapshot
  const snapshot = structuredClone({ name: tool.name, description: tool.description, input_schema: tool.input_schema });
  sessionTools.set(name, { key: cacheKey, tool: snapshot });
  return snapshot;
}

/**
 * Clear the per-tool content-addressed cache for a session.
 *
 * @param sessionKey - Session key to clear
 */
export function clearSessionPerToolCache(sessionKey: string): void {
  sessionPerToolCache.delete(sessionKey);
}
