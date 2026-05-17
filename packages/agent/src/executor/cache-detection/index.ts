// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break detection module.
 *
 * Barrel re-export of the canonical public API of the former
 * cache-break-detection.ts monolith. No aliases — every export keeps
 * its canonical name.
 *
 * @module
 */

export type {
  PromptStateSnapshot,
  PendingChanges,
  CacheBreakReason,
  CacheBreakEvent,
  RecordPromptStateInput,
  CheckCacheBreakInput,
  CacheBreakDetector,
  CacheBreakDetectorOptions,
} from "./cache-state-types.js";
export {
  createCacheBreakDetector,
  clearCacheBreakDetectorSession,
  MAX_SNAPSHOT_CHARS,
  MAX_TRACKING_ENTRIES,
} from "./cache-state.js";
export { extractAnthropicPromptState } from "./anthropic-extractor.js";
export { extractGeminiPromptState } from "./gemini-extractor.js";
export {
  djb2,
  computeHash,
  sanitizeMcpToolName,
  sanitizeMcpToolNameForAnalytics,
} from "./prompt-state-utils.js";
