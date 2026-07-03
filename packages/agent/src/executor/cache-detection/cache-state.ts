// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break detection — LruMap, module-level session state, and the
 * `createCacheBreakDetector` factory.
 *
 * Hosts the closure that captures the LRU-bounded per-session map.
 * Public types live in cache-state-types.ts; provider adapters live in
 * anthropic-extractor.ts / gemini-extractor.ts.
 *
 * @module
 */

import {
  CACHE_BREAK_RELATIVE_THRESHOLD,
  CACHE_BREAK_ABSOLUTE_THRESHOLD,
} from "../../context-engine/constants.js";
import type {
  CacheBreakDetector,
  CacheBreakDetectorOptions,
  CacheBreakEvent,
  CheckCacheBreakInput,
  PendingChanges,
  PromptStateSnapshot,
  RecordPromptStateInput,
} from "./cache-state-types.js";
import { createLruMap } from "./lru-map.js";
import {
  NO_CHANGES,
  attributeReason,
  buildPendingChanges,
  collectChangedTools,
  deriveTtlCategory,
} from "./prompt-state-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum chars per category (system, tools) for serialized snapshot content. */
export const MAX_SNAPSHOT_CHARS = 50_000;

/** Maximum number of tracked sessions before LRU eviction. */
export const MAX_TRACKING_ENTRIES = 15;

/** Pattern matching model names excluded from cache break detection. */
const EXCLUDED_MODEL_PATTERN = /haiku/i;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DetectorState {
  currentSnapshot: PromptStateSnapshot | null;
  /** Previous snapshot retained for serialized content diffing. */
  previousSnapshot: PromptStateSnapshot | null;
  previousCacheReadTokens: number | null;
  pendingChanges: PendingChanges | null;
  ttlExpired: boolean;
  compacted: boolean;
  /** Most recent agentId from recordPromptState, used for CacheBreakEvent. */
  agentId: string;
  /** Set by notifyContentModification() when observation masking or microcompaction modifies content. */
  contentModified: boolean;
}

/** Check whether a model should be excluded from cache break detection. */
function isExcludedModel(model: string): boolean {
  return EXCLUDED_MODEL_PATTERN.test(model);
}

// ---------------------------------------------------------------------------
// Module-level session state (default instance for singleton usage)
// ---------------------------------------------------------------------------

let sessionDetectorState = createLruMap<string, DetectorState>(MAX_TRACKING_ENTRIES);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface DetectorLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * Create a cache break detector instance.
 *
 * Uses per-instance LRU Map for per-session state. When the map exceeds
 * maxTrackingEntries, the oldest session is evicted with a WARN log.
 */
export function createCacheBreakDetector(
  logger: DetectorLogger,
  options: CacheBreakDetectorOptions,
): CacheBreakDetector {
  const maxEntries = options.maxTrackingEntries ?? MAX_TRACKING_ENTRIES;
  const clock = options.clock;

  // Create LRU map with WARN on eviction.
  sessionDetectorState = createLruMap<string, DetectorState>(maxEntries, (evictedKey) => {
    if (logger.warn) {
      logger.warn(
        { evictedSession: evictedKey, mapSize: maxEntries, hint: "Increase cache break detector maxTrackingEntries for deployments with many concurrent agents", errorKind: "resource" as const },
        "Cache break detector: LRU eviction -- oldest session loses tracking",
      );
    }
  });

  function getOrCreateState(sessionKey: string): DetectorState {
    let state = sessionDetectorState.get(sessionKey);
    if (!state) {
      state = {
        currentSnapshot: null,
        previousSnapshot: null,
        previousCacheReadTokens: null,
        pendingChanges: null,
        ttlExpired: false,
        compacted: false,
        agentId: "",
        contentModified: false,
      };
      sessionDetectorState.set(sessionKey, state);
    }
    return state;
  }

  return {
    recordPromptState(input: RecordPromptStateInput): void {
      const state = getOrCreateState(input.sessionKey);

      // Build new snapshot
      const newSnapshot: PromptStateSnapshot = {
        systemHash: input.systemHash,
        toolsHash: input.toolsHash,
        cacheMetadataHash: input.cacheMetadataHash,
        toolNames: input.toolNames,
        perToolHashes: input.perToolHashes,
        model: input.model,
        provider: input.provider,
        retention: input.retention,
        callCount: (state.currentSnapshot?.callCount ?? 0) + 1,
        headersHash: input.headersHash,
        extraBodyHash: input.extraBodyHash,
        effortValue: input.effortValue,
        cacheControlHash: input.cacheControlHash,
        buildDiffableContent: input.buildDiffableContent,
        breakpointBudget: input.breakpointBudget,
      };

      // Compare with previous snapshot if exists
      if (state.currentSnapshot) {
        state.pendingChanges = buildPendingChanges(state.currentSnapshot, newSnapshot);
        // Retain previous snapshot for serialized content diffing
        state.previousSnapshot = state.currentSnapshot;
      }

      state.currentSnapshot = newSnapshot;
      state.agentId = input.agentId;

      logger.debug(
        { sessionKey: input.sessionKey, callCount: newSnapshot.callCount, provider: input.provider },
        "Cache break detector: state recorded",
      );
    },

    checkResponseForCacheBreak(input: CheckCacheBreakInput): CacheBreakEvent | null {
      const state = sessionDetectorState.get(input.sessionKey);

      // No state at all for this session
      if (!state || !state.currentSnapshot) {
        return null;
      }

      // API errors produce zero usage but are not cache breaks.
      // Do NOT update previousCacheReadTokens -- preserve the last known-good baseline.
      if (input.apiError) {
        return null;
      }

      // First call: record baseline, return null
      if (state.previousCacheReadTokens === null) {
        state.previousCacheReadTokens = input.cacheReadTokens;
        return null;
      }

      // Compaction: reset baseline, return null
      if (state.compacted) {
        state.previousCacheReadTokens = input.cacheReadTokens;
        state.compacted = false;
        return null;
      }

      // Skip detection for models with different caching behavior
      if (state.currentSnapshot && isExcludedModel(state.currentSnapshot.model)) {
        state.previousCacheReadTokens = input.cacheReadTokens;
        return null;
      }

      // Content modification (observation masking or microcompaction) -- dual-check suppression.
      // Evaluate pendingChanges to determine if a genuine prompt state change co-occurred.
      // If no real changes: suppress the event and reset baseline.
      // If real changes: emit the event with correct attribution (using original baseline).
      if (state.contentModified) {
        state.contentModified = false;

        const changes = state.pendingChanges ?? NO_CHANGES;
        const hasRealChanges = changes.systemChanged || changes.toolsChanged
          || changes.modelChanged || changes.retentionChanged || changes.metadataChanged
          || changes.headersChanged || changes.extraBodyChanged
          || changes.effortChanged || changes.cacheControlChanged;

        if (!hasRealChanges) {
          state.previousCacheReadTokens = input.cacheReadTokens;
          logger.debug({ sessionKey: input.sessionKey },
            "Cache break detector: content modification expected, baseline reset -- suppressed");
          return null;
        }
        // Fall through to attribution -- real change happened alongside content modification
      }

      const prevCacheRead = state.previousCacheReadTokens;
      const tokenDrop = prevCacheRead - input.cacheReadTokens;
      const relDrop = prevCacheRead > 0 ? tokenDrop / prevCacheRead : 0;

      // Update baseline
      state.previousCacheReadTokens = input.cacheReadTokens;

      // No drop
      if (tokenDrop <= 0) {
        return null;
      }

      // AND threshold -- both relative AND absolute must exceed to trigger detection.
      // Reduces false positives: small absolute drops on large contexts (3K on 200K = 1.5%)
      // and small relative drops on small contexts (6% on 10K = 600 tokens) are suppressed.
      if (relDrop <= CACHE_BREAK_RELATIVE_THRESHOLD || tokenDrop <= CACHE_BREAK_ABSOLUTE_THRESHOLD) {
        return null;
      }

      // Attribute reason
      const changes = state.pendingChanges ?? NO_CHANGES;
      // Thread messageBlockCount for lookback window detection (default 0 when the caller does not report it)
      const conversationBlockCount = input.messageBlockCount ?? 0;
      const reason = attributeReason(changes, state.ttlExpired, input.lastResponseElapsedMs, conversationBlockCount);

      // Clear TTL flag after attribution
      state.ttlExpired = false;

      // Materialize lazy content only on detected break
      const prevContent = state.previousSnapshot?.buildDiffableContent?.();
      const currContent = state.currentSnapshot.buildDiffableContent?.();

      const event: CacheBreakEvent = {
        provider: input.provider,
        reason,
        tokenDrop,
        tokenDropRelative: relDrop,
        previousCacheRead: prevCacheRead,
        currentCacheRead: input.cacheReadTokens,
        callCount: state.currentSnapshot.callCount,
        changes,
        toolsChanged: collectChangedTools(changes),
        ttlCategory: deriveTtlCategory(state.currentSnapshot.retention),
        agentId: state.agentId,
        sessionKey: input.sessionKey,
        timestamp: clock.now(),
        // Thread lazy-materialized content for diff writer
        previousSystem: prevContent?.system,
        currentSystem: currContent?.system,
        previousTools: prevContent?.tools,
        currentTools: currContent?.tools,
        // Thread effort value for downstream consumers
        effortValue: state.currentSnapshot.effortValue,
        // Thread conversation block count for lookback observability
        conversationBlockCount: conversationBlockCount > 0 ? conversationBlockCount : undefined,
        // Thread breakpoint budget context for cache break enrichment
        breakpointBudget: state.currentSnapshot.breakpointBudget,
      };

      logger.info(
        { agentId: event.agentId, provider: event.provider, reason: event.reason, tokenDrop: event.tokenDrop, toolsChanged: event.toolsChanged },
        "Cache break detected",
      );

      return event;
    },

    notifyCompaction(sessionKey: string): void {
      const state = sessionDetectorState.get(sessionKey);
      if (state) {
        state.compacted = true;
        logger.debug({ sessionKey }, "Cache break detector: compaction notified, baseline will reset");
      }
    },

    notifyTtlExpiry(sessionKey: string): void {
      const state = sessionDetectorState.get(sessionKey);
      if (state) {
        state.ttlExpired = true;
        logger.debug({ sessionKey }, "Cache break detector: TTL expiry notified");
      }
    },

    notifyContentModification(sessionKey: string): void {
      const state = sessionDetectorState.get(sessionKey);
      if (state) {
        state.contentModified = true;
        logger.debug({ sessionKey }, "Cache break detector: content modification notified");
      }
    },

    aliasSession(compactionKey: string, parentKey: string): void {
      const parentState = sessionDetectorState.get(parentKey);
      if (parentState) {
        sessionDetectorState.set(compactionKey, parentState);
        logger.debug({ compactionKey, parentKey }, "Cache break detector: session aliased for compaction");
      }
    },

    cleanupSession(sessionKey: string): void {
      sessionDetectorState.delete(sessionKey);
    },

    reset(): void {
      sessionDetectorState.clear();
    },

    getCallCount(sessionKey: string): number | undefined {
      // Direct map read — no upsert. Returns undefined when no state exists
      // (cold start before the first recordPromptState call).
      return sessionDetectorState.get(sessionKey)?.currentSnapshot?.callCount;
    },
  };
}

// ---------------------------------------------------------------------------
// Session cleanup export
// ---------------------------------------------------------------------------

/**
 * Clear cache break detector state for a specific session.
 * Called from session-snapshot-cleanup.ts.
 */
export function clearCacheBreakDetectorSession(formattedKey: string): void {
  sessionDetectorState.delete(formattedKey);
}
