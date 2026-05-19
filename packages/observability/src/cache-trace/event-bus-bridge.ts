// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace EventBus bridge.
 *
 * Subscribes to the single `observability:token_usage` event (already
 * emitted live by `pi-event-bridge.ts:993-1021`) and stashes the
 * `cacheReadTokens` + `cacheWriteTokens` values on the cache-trace
 * recorder. The next `recordStage("session:after", {...})` consumes
 * the stash and attaches the values to the emitted event.
 *
 * Why a single-event bridge: physical sequencing — the token counts
 * do not exist before the model responds. Mirrors trajectory's
 * `event-bus-bridge.ts:48-80` pattern but with one event instead of 18.
 *
 * @module
 */

import type { TypedEventBus } from "@comis/core";

import type { CacheTrace } from "./runtime.js";

/**
 * Subscribe a cache-trace recorder to the EventBus. Returns a single
 * `unsubscribe()` function that removes the registered handler.
 *
 * Per-session lifecycle: pi-executor calls this once after the
 * recorder is constructed; the returned `unsubscribe` runs in the
 * `try/finally` covering the runner block (mirrors trajectory's
 * teardown at pi-executor.ts:1314-1318).
 */
export function attachCacheTraceToEventBus(
  trace: CacheTrace,
  bus: TypedEventBus,
): () => void {
  const handler = (payload: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void => {
    const next: { cacheReadTokens?: number; cacheWriteTokens?: number } = {};
    if (typeof payload.cacheReadTokens === "number") {
      next.cacheReadTokens = payload.cacheReadTokens;
    }
    if (typeof payload.cacheWriteTokens === "number") {
      next.cacheWriteTokens = payload.cacheWriteTokens;
    }
    trace.setLatestTokenUsage(next);
  };

  bus.on(
    "observability:token_usage",
    handler as (
      payload: import("@comis/core").EventMap["observability:token_usage"],
    ) => void,
  );

  return function unsubscribe(): void {
    bus.off(
      "observability:token_usage",
      handler as (
        payload: import("@comis/core").EventMap["observability:token_usage"],
      ) => void,
    );
  };
}
