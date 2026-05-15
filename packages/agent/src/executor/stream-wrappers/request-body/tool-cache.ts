// SPDX-License-Identifier: Apache-2.0
/**
 * Rendered tool cache + per-tool memoization (Phase 42 split per EXEC-SPLIT-02).
 *
 * Ensures byte-identical tool JSON across turns when composition is
 * unchanged. On aggregate cache miss, per-tool content-addressed
 * memoization preserves unchanged individual tools.
 *
 * Special-case: when ALL MCP tools are deferred AND a cached entry exists
 * from a prior turn, skip per-tool hash recomputation — tool composition
 * is guaranteed stable because no MCP tool connect/disconnect can change
 * schemas.
 *
 * Lifted verbatim from request-body-injector.ts:1277-1324.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";

import { getOrCacheRenderedTool, sessionRenderedToolCache } from "../tool-schema-cache.js";
import { computeRenderedToolsHash } from "./cache-breakpoints.js";
import type { RequestBodyInjectorConfig } from "./types.js";

/**
 * Apply the rendered-tool cache. Mutates `result.tools` in place when a
 * cache hit occurs or after per-tool memoization rebuilds the array.
 *
 * Preconditions: `config.sessionKey` AND `needsCacheBreakpoints` AND
 * `Array.isArray(result.tools)`.
 */
export function applyRenderedToolCache(
  result: Record<string, unknown>,
  config: RequestBodyInjectorConfig,
  needsCacheBreakpoints: boolean,
  logger: ComisLogger,
): void {
  if (!config.sessionKey || !needsCacheBreakpoints || !Array.isArray(result.tools)) return;

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
    return;
  }

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
