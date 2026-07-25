// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical context-engine factory.
 *
 * Enabled turns always assemble through the lossless context store. Deployments
 * that do not persist context must inject an explicit in-memory
 * `ContextStorePort`; absence is a construction error enforced by this type
 * boundary rather than a runtime implementation fallback.
 */

import type { ContextEngineConfig } from "@comis/core";
import type { ContextEngine } from "./types.js";
import type { CanonicalContextEngineDeps } from "./canonical-context-engine-types.js";
import { createLcdContextEngine } from "./lcd-assembler.js";
export type { CanonicalContextEngineDeps } from "./canonical-context-engine-types.js";

export function createContextEngine(
  config: ContextEngineConfig,
  deps: CanonicalContextEngineDeps,
): ContextEngine {
  if (!config.enabled) {
    return {
      transformContext: async (messages) => messages,
      lastBreakpointIndex: undefined,
      lastTrimOffset: 0,
    };
  }
  return createLcdContextEngine(config, deps);
}
