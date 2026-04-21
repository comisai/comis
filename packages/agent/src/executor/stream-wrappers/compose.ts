// SPDX-License-Identifier: Apache-2.0
/**
 * Compose utility for stream wrapper chains.
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ComisLogger } from "@comis/infra";

import type { StreamFnWrapper } from "./types.js";

/**
 * Compose an ordered list of wrappers around a base StreamFn.
 *
 * Wrappers are applied in order: first wrapper is outermost (executes first),
 * last wrapper is innermost (closest to base). Implemented as a right-fold.
 *
 * @param wrappers - Ordered list of wrappers to apply
 * @param base - The original SDK StreamFn to wrap
 * @param logger - Logger for debug output
 * @returns Composed StreamFn with all wrappers applied
 */
export function composeStreamWrappers(
  wrappers: StreamFnWrapper[],
  base: StreamFn,
  logger: ComisLogger,
): StreamFn {
  if (wrappers.length === 0) {
    return base;
  }

  const composed = wrappers.reduceRight<StreamFn>((fn, wrapper) => {
    return wrapper(fn);
  }, base);

  logger.debug(
    { wrapperCount: wrappers.length, wrapperNames: wrappers.map(w => w.name || "anonymous") },
    "Stream wrappers composed",
  );

  return composed;
}
