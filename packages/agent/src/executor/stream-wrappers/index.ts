// SPDX-License-Identifier: Apache-2.0
/**
 * Stream wrapper chain infrastructure for intercepting LLM calls.
 *
 * Barrel re-export of all stream wrappers, types, compose utility,
 * and cache helpers. Preserves the complete public API surface from
 * the original monolith stream-wrappers.ts.
 *
 * @module
 */

// Types
export type { StreamFnWrapper } from "./types.js";

// Compose utility
export { composeStreamWrappers } from "./compose.js";

// Individual wrappers
export { createToolResultSizeBouncer } from "./tool-result-size-bouncer.js";
export type { TruncationSummary, ToolResultSizeBouncerResult } from "./tool-result-size-bouncer.js";

export { createTurnResultBudgetWrapper } from "./turn-result-budget-wrapper.js";
export type { TurnBudgetSummary, TurnResultBudgetWrapperResult } from "./turn-result-budget-wrapper.js";

export { createValidationErrorFormatter } from "./validation-error-formatter.js";

export { createConfigResolver, resolveBreakpointStrategy, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./config-resolver.js";
export type { ConfigResolverConfig } from "./config-resolver.js";

export { createCacheTraceWriter, parseSize, rotateIfNeeded } from "./cache-trace-writer.js";
export type { CacheTraceConfig } from "./cache-trace-writer.js";

export { createApiPayloadTraceWriter } from "./api-payload-trace-writer.js";
export type { ApiPayloadTraceConfig } from "./api-payload-trace-writer.js";

export {
  createRequestBodyInjector,
  addCacheControlToLastBlock,
  CACHEABLE_BLOCK_TYPES,
  getMinCacheableTokens,
  resolveCacheRetention,
  clearSessionBetaHeaderLatches,
} from "./request-body-injector.js";
export type { RequestBodyInjectorConfig } from "./request-body-injector.js";

// Tool schema cache extracted to leaf module
export {
  sessionRenderedToolCache,
  getOrCacheRenderedTool,
  clearSessionRenderedToolCache,
  clearSessionPerToolCache,
} from "./tool-schema-cache.js";
export type { RenderedToolCacheEntry, PerToolCacheEntry } from "./tool-schema-cache.js";
