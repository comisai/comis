// SPDX-License-Identifier: Apache-2.0
/**
 * Request-body injector public surface.
 *
 * Composition root: re-exports the leaf modules' canonical public symbols
 * and hosts the `createRequestBodyInjector` factory. Factory lives in a
 * sibling module (`./factory.js`) because its body is ~1,000L of
 * composition logic that cannot fit in an ~80L barrel.
 *
 * Public surface (15 symbols + 1 type) uses canonical names — no aliases.
 *
 * @module
 */

// Type re-export
export type { RequestBodyInjectorConfig } from "./types.js";

// Main factory
export { createRequestBodyInjector } from "./factory.js";

// Cache-breakpoints leaf
export {
  placeCacheBreakpoints,
  placeSingleBreakpoint,
  addCacheControlToLastBlock,
  sortToolsForCacheStability,
  identifyBreakpointZone,
  hashBreakpointContent,
  maybePromoteBreakpoints,
  resolveCacheRetention,
  getMinCacheableTokens,
  CACHEABLE_BLOCK_TYPES,
  clearSessionPrefixStability,
  clearSessionCadenceTracker,
} from "./cache-breakpoints.js";

// Context-window leaf
export { clearSessionBetaHeaderLatches } from "./context-window.js";

// Token-estimation leaf
export { estimateBlockTokens } from "./token-estimation.js";

// Tool-result-clearing leaf
export { clearStaleThinkingBlocks, stripTransientRecallFromHistory, stripReplayThinking, deferRecallToUncachedTail } from "./tool-result-clearing.js";
