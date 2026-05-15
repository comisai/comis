// SPDX-License-Identifier: Apache-2.0
/**
 * Per-model cache-retention kill switch (Phase 42 split per EXEC-SPLIT-02).
 *
 * When `resolvedRetention === "none"`, strips ALL cache_control markers
 * from system + tools + messages. Must run AFTER all breakpoint/marker
 * placement so nothing gets re-added after the strip pass.
 *
 * Implements the per-model kill switch path of `getCacheRetentionOverrides`:
 * passing `{ "claude-haiku": "none" }` disables caching entirely for any
 * model whose ID starts with `claude-haiku`.
 *
 * Lifted verbatim from request-body-injector.ts:2013-2040.
 *
 * @module
 */

import type { CacheRetention } from "@mariozechner/pi-ai";
import type { ComisLogger } from "@comis/core";

/**
 * Strip ALL `cache_control` markers from `result.system`, `result.tools`,
 * and every message in `result.messages`. No-op when
 * `resolvedRetention !== "none"` or `!needsCacheBreakpoints`.
 */
export function applyKillSwitch(
  result: Record<string, unknown>,
  modelId: string,
  sessionKey: string | undefined,
  resolvedRetention: CacheRetention | undefined,
  needsCacheBreakpoints: boolean,
  logger: ComisLogger,
): void {
  if (!needsCacheBreakpoints || resolvedRetention !== "none") return;

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
    { modelId, sessionKey },
    "Kill switch active -- stripped all cache_control markers",
  );
}
