// SPDX-License-Identifier: Apache-2.0
/**
 * Per-TTL token estimation from final cache_control markers.
 *
 * Counts tokens under 5m vs 1h `cache_control` markers across the final
 * `result.system`, `result.tools`, and `result.messages` blocks. Used by
 * the bridge to attribute `cacheWriteTokens` cost between the two TTL
 * tiers. Runs AFTER all breakpoint placement and kill-switch stripping so
 * counts reflect the exact markers sent to the API.
 *
 * @module
 */

import { estimateBlockTokens } from "./token-estimation.js";
import type { RequestBodyInjectorConfig } from "./types.js";

/**
 * Run the per-TTL token estimation pass and dispatch via
 * `config.onTtlSplitEstimate`. No-op when the callback is undefined or
 * `needsCacheBreakpoints` is false.
 */
export function estimateTtlSplit(
  result: Record<string, unknown>,
  config: RequestBodyInjectorConfig,
  needsCacheBreakpoints: boolean,
): void {
  if (!config.onTtlSplitEstimate || !needsCacheBreakpoints) return;

  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;

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
