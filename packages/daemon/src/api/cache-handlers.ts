// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — admin-gate throw is caught by rpc-dispatch.ts.
/**
 * Durable cache-stats RPC handler.
 *
 * Binds the `obs.cacheStats.window` method to the
 * `buildCacheStatsRpcHandler` factory from `@comis/observability`,
 * supplying:
 *   - the observability store (`deps.obsStore`) as the cache-stats
 *     port (the store interface extends the four `queryCacheStats*`
 *     methods),
 *   - `IS_DEV` to gate the dev-mode response-parse defense in depth,
 *   - the canonical `ObsCacheStatsWindowContract` from `@comis/core`.
 *
 * Empty-store fallback: when `obsStore` is undefined (rare —
 * test seams without a SQLite backing), the handler returns a
 * zero-totals window with no breakdowns. This mirrors the
 * `obs.systemPromptReport.latest` "obsStore absent → null" pattern at
 * `obs-system-prompt-report.ts:56`.
 *
 * @module
 */
import { ObsCacheStatsWindowContract, systemNowMs } from "@comis/core";
import { buildCacheStatsRpcHandler } from "@comis/observability";
import type { RpcHandler } from "./types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-handlers/obs-helpers.js";
import { AuthorizationError } from "./errors.js";

/**
 * Empty window shape (CacheStatsWindow with all-zero totals + empty
 * breakdowns). Used as the fallback when `obsStore` is undefined.
 */
function emptyWindow(sinceMs: number, untilMs: number): Record<string, unknown> {
  return {
    sinceMs,
    untilMs,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    nonCachedInputTokens: 0,
    outputTokens: 0,
    turns: 0,
    cacheHitRate: 0,
    cacheWriteRate: 0,
    byProvider: [],
    byModel: [],
    byAgent: [],
  };
}

/**
 * Bind the cache-stats RPC handler. Object-spread compatible with
 * `Record<string, RpcHandler>` (the dispatch's standard handler-map
 * shape).
 */
export function createCacheHandlers(
  deps: ObsHandlerDeps,
): Record<string, RpcHandler> {
  const { obsStore } = deps;

  // When obsStore is absent, return a degraded handler that emits a
  // zero-totals window. Mirrors the SystemPromptReport.latest
  // pattern. Otherwise, delegate to the @comis/observability factory.
  if (!obsStore) {
    return {
      [ObsCacheStatsWindowContract.method]: async (
        rawParams: Record<string, unknown>,
      ): Promise<unknown> => {
        const trustLevel = rawParams._trustLevel as string | undefined;
        if (trustLevel !== "admin") {
          throw new AuthorizationError("Admin trust level required");
        }
        const sinceMs = (rawParams.sinceMs as number | undefined) ?? 0;
        const untilMs = (rawParams.untilMs as number | undefined) ?? systemNowMs();
        const result = { window: emptyWindow(sinceMs, untilMs) };
        if (IS_DEV) {
          ObsCacheStatsWindowContract.response.parse(result);
        }
        return result;
      },
    };
  }

  return buildCacheStatsRpcHandler({
    store: obsStore,
    isDev: IS_DEV,
    contract: ObsCacheStatsWindowContract,
  });
}
