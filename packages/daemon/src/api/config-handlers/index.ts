// SPDX-License-Identifier: Apache-2.0
/**
 * Config handlers (Phase 43 split per FILE-SPLIT-03).
 *
 * Barrel re-export of the canonical public API of the former
 * `config-handlers.ts` monolith (1,317L). No aliases — every export keeps
 * its canonical name.
 *
 * The 3 pure validation helpers (`unwrapSchema`, `resolveSchemaForPath`,
 * `coerceConfigValue`) live in `config-validate.ts` and are re-exported
 * because they have `@internal — exported only for test-only direct
 * invocation` docstrings; the existing `config-handlers.test.ts` imports
 * `coerceConfigValue` through the public barrel.
 *
 * @module
 */

export type { ConfigHandlerDeps } from "./config-helpers.js";
export { unwrapSchema, resolveSchemaForPath, coerceConfigValue } from "./config-validate.js";

import type { RpcHandler } from "../types.js";
import type { ConfigHandlerDeps } from "./config-helpers.js";
import { createTokenBucket } from "./config-helpers.js";
import { bindConfigReadHandlers } from "./config-read.js";
import { bindConfigWriteHandlers } from "./config-write.js";
import { bindConfigExportHandlers } from "./config-export.js";

/**
 * Create config and gateway RPC handlers.
 *
 * Rate limiter: 5 patches per 60s, SHARED between config.patch and
 * config.apply (matches the merged pre-split limit). Constructed once
 * here and threaded into both write-side bundles.
 *
 * @param deps - Injected dependencies (container, config paths)
 * @returns Record mapping method names to handler functions
 */
export function createConfigHandlers(deps: ConfigHandlerDeps): Record<string, RpcHandler> {
  // Rate limiter: 5 patches per 60s
  const patchBucket = createTokenBucket(5, 60_000);

  return {
    ...bindConfigReadHandlers(deps),
    ...bindConfigWriteHandlers(deps, patchBucket),
    ...bindConfigExportHandlers(deps, patchBucket),
  };
}
