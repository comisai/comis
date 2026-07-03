// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break detection — public type surface.
 *
 * Type-only module: all public interfaces and the `CacheBreakReason`
 * tagged-union literal. Imported by the factory in cache-state.ts and
 * the provider adapters in anthropic-extractor.ts / gemini-extractor.ts.
 *
 * @module
 */

export interface PromptStateSnapshot {
  systemHash: number;
  toolsHash: number;
  cacheMetadataHash: number | null;
  toolNames: string[];
  perToolHashes: Record<string, number>;
  model: string;
  provider: string;
  retention: string | undefined;
  callCount: number;
  /** Hash of tracked headers (anthropic-beta, anthropic-version). null for non-Anthropic. */
  headersHash: number | null;
  /** Hash of extra body params outside standard API fields. null when no extras. */
  extraBodyHash: number | null;
  /** JSON-stringified params.thinking object for effort value change detection. */
  effortValue?: string;
  /** Hash of system blocks WITH cache_control markers intact. Catches TTL/scope marker flips. */
  cacheControlHash?: number;
  /** Lazy getter -- serialization only runs when called (zero cost on cache hits). */
  buildDiffableContent?: () => { system: string; tools: string };
  /** Breakpoint budget snapshot for cache break enrichment. */
  breakpointBudget?: {
    total: number;
    system: number;
    tool: number;
    message: number;
    sdkAuto: number;
  };
}

export interface PendingChanges {
  systemChanged: boolean;
  toolsChanged: boolean;
  metadataChanged: boolean;
  modelChanged: boolean;
  retentionChanged: boolean;
  addedTools: string[];
  removedTools: string[];
  changedSchemaTools: string[];
  /** HTTP headers changed between turns. */
  headersChanged: boolean;
  /** Extra body params changed between turns. */
  extraBodyChanged: boolean;
  /** Effort value (params.thinking) changed between turns. */
  effortChanged: boolean;
  /** cache_control markers changed on system blocks (TTL/scope flips). */
  cacheControlChanged: boolean;
}

export type CacheBreakReason =
  | "model_changed"
  | "system_changed"
  | "tools_changed"
  | "retention_changed"
  | "cache_metadata_changed"
  | "headers_changed"
  | "extra_body_changed"
  | "effort_changed"
  | "cache_control_changed"
  | "lookback_window_exceeded"
  | "ttl_expiry"
  | "ttl_expiry_long"
  | "ttl_expiry_short"
  | "likely_server_eviction"
  | "server_eviction";

export interface CacheBreakEvent {
  provider: string;
  reason: CacheBreakReason;
  tokenDrop: number;
  tokenDropRelative: number;
  previousCacheRead: number;
  currentCacheRead: number;
  callCount: number;
  changes: PendingChanges;
  /** Sanitized tool names that changed (MCP names collapsed). For observability events. */
  toolsChanged: string[];
  ttlCategory: "short" | "long" | "none" | undefined;
  agentId: string;
  sessionKey: string;
  timestamp: number;
  /** Serialized previous system prompt content for diff generation. */
  previousSystem?: string;
  /** Serialized current system prompt content for diff generation. */
  currentSystem?: string;
  /** Serialized previous tools JSON for diff generation. */
  previousTools?: string;
  /** Serialized current tools JSON for diff generation. */
  currentTools?: string;
  /** Effort value from detection pipeline for downstream consumers (diff writer, analytics). */
  effortValue?: string;
  /** Number of message blocks in the conversation. Set for lookback window detection. */
  conversationBlockCount?: number;
  /** Breakpoint budget context at time of cache break. */
  breakpointBudget?: {
    total: number;
    system: number;
    tool: number;
    message: number;
    sdkAuto: number;
  };
}

export interface RecordPromptStateInput {
  sessionKey: string;
  agentId: string;
  provider: string;
  model: string;
  systemHash: number;
  toolsHash: number;
  cacheMetadataHash: number | null;
  toolNames: string[];
  perToolHashes: Record<string, number>;
  retention: string | undefined;
  /** Hash of tracked headers. null for non-Anthropic or when headers not provided. */
  headersHash: number | null;
  /** Hash of extra body params. null when no extras present. */
  extraBodyHash: number | null;
  /** JSON-stringified params.thinking object for effort value change detection. */
  effortValue?: string;
  /** Hash of system blocks WITH cache_control markers intact. */
  cacheControlHash?: number;
  /** Lazy getter -- deferred serialization for diff content (zero cost on cache hits). */
  buildDiffableContent?: () => { system: string; tools: string };
  /** Breakpoint budget for cache break enrichment. */
  breakpointBudget?: {
    total: number;
    system: number;
    tool: number;
    message: number;
    sdkAuto: number;
  };
}

export interface CheckCacheBreakInput {
  sessionKey: string;
  provider: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalInputTokens: number;
  /** Elapsed ms since last assistant response. Used for tiered server-side attribution. */
  lastResponseElapsedMs?: number;
  /** When true, API returned an error (400/429/500). Do not treat zero usage as cache break. */
  apiError?: boolean;
  /** Number of message blocks in the conversation. Used for lookback window detection. */
  messageBlockCount?: number;
}

export interface CacheBreakDetector {
  recordPromptState(input: RecordPromptStateInput): void;
  checkResponseForCacheBreak(input: CheckCacheBreakInput): CacheBreakEvent | null;
  notifyCompaction(sessionKey: string): void;
  notifyTtlExpiry(sessionKey: string): void;
  /** Notify that content was intentionally modified (observation masking or microcompaction).
   *  Must be called BEFORE the next checkResponseForCacheBreak(). */
  notifyContentModification(sessionKey: string): void;
  /** Alias a compaction session key to its parent session's DetectorState.
   *  After aliasing, operations on compactionKey update the parent's state, preventing
   *  false cache break alerts during compaction transitions. No-op if parentKey has no state. */
  aliasSession(compactionKey: string, parentKey: string): void;
  cleanupSession(sessionKey: string): void;
  reset(): void;
  /**
   * Read the current call count for a session (1-indexed turn number
   * within the current agent session — turn 1 = first model call after
   * session start). Returns undefined when the session has no detector
   * state yet (cold start before the first recordPromptState).
   *
   * Used by the request-body factory to gate first-turn-only optimizations
   * (e.g., 5m → 1h marker promotion) on real evidence the session will
   * see a follow-up turn.
   */
  getCallCount(sessionKey: string): number | undefined;
}

/** Options for createCacheBreakDetector. */
export interface CacheBreakDetectorOptions {
  /** Override max tracked sessions (default: MAX_TRACKING_ENTRIES = 15). */
  maxTrackingEntries?: number;
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
}
