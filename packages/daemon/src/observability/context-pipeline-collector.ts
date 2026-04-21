// SPDX-License-Identifier: Apache-2.0
/**
 * Context pipeline collector: subscribes to context:pipeline and context:dag_compacted
 * events and maintains queryable ring buffers for downstream RPC handlers.
 * Follows the DiagnosticCollector pattern (ring buffer, HandlerRef cleanup, factory function).
 * Context Engine observability data pipeline.
 * @module
 */

import type { TypedEventBus, EventMap, EventHandler } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { HandlerRef } from "./index.js";

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

/** Snapshot of a single context:pipeline event, stored in the ring buffer. */
export interface PipelineSnapshot {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly tokensLoaded: number;
  readonly tokensEvicted: number;
  readonly tokensMasked: number;
  readonly tokensCompacted: number;
  readonly thinkingBlocksRemoved: number;
  readonly budgetUtilization: number;
  readonly evictionCategories: Record<string, number>;
  readonly cacheHitTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheMissTokens: number;
  readonly durationMs: number;
  readonly layerCount: number;
  readonly layers: Array<{
    name: string;
    durationMs: number;
    messagesIn: number;
    messagesOut: number;
  }>;
  readonly timestamp: number;
}

/** Snapshot of a single context:dag_compacted event, stored in the ring buffer. */
export interface DagCompactionSnapshot {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly leafSummariesCreated: number;
  readonly condensedSummariesCreated: number;
  readonly maxDepthReached: number;
  readonly totalSummariesCreated: number;
  readonly durationMs: number;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

/** Filter options for querying recent pipeline/DAG snapshots. */
export interface PipelineQueryOpts {
  agentId?: string;
  limit?: number;
}

/**
 * ContextPipelineCollector: subscribes to context:pipeline and context:dag_compacted
 * events and stores them in bounded ring buffers for RPC queries.
 */
export interface ContextPipelineCollector {
  /** Get recent pipeline snapshots, optionally filtered by agentId and limited. */
  getRecentPipelines(opts?: PipelineQueryOpts): PipelineSnapshot[];
  /** Get recent DAG compaction snapshots, optionally filtered by agentId and limited. */
  getRecentDagCompactions(opts?: PipelineQueryOpts): DagCompactionSnapshot[];
  /** Clear both ring buffers. */
  reset(): void;
  /** Unsubscribe all EventBus handlers. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ContextPipelineCollector that subscribes to EventBus context events
 * and stores snapshots in bounded ring buffers.
 */
export function createContextPipelineCollector(deps: {
  eventBus: TypedEventBus;
  maxPipelineEvents?: number;
  maxDagEvents?: number;
  logger?: ComisLogger;
}): ContextPipelineCollector {
  const { eventBus, maxPipelineEvents = 200, maxDagEvents = 100, logger } = deps;
  const pipelines: PipelineSnapshot[] = [];
  const dagCompactions: DagCompactionSnapshot[] = [];
  const handlers: HandlerRef[] = [];

  // Subscribe to context:pipeline
  const pipelineHandler = ((payload: EventMap["context:pipeline"]) => {
    const snapshot: PipelineSnapshot = {
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      tokensLoaded: payload.tokensLoaded,
      tokensEvicted: payload.tokensEvicted,
      tokensMasked: payload.tokensMasked,
      tokensCompacted: payload.tokensCompacted,
      thinkingBlocksRemoved: payload.thinkingBlocksRemoved,
      budgetUtilization: payload.budgetUtilization,
      evictionCategories: payload.evictionCategories,
      cacheHitTokens: payload.cacheHitTokens,
      cacheWriteTokens: payload.cacheWriteTokens,
      cacheMissTokens: payload.cacheMissTokens,
      durationMs: payload.durationMs,
      layerCount: payload.layerCount,
      layers: payload.layers,
      timestamp: payload.timestamp,
    };
    pipelines.push(snapshot);
    if (pipelines.length > maxPipelineEvents) {
      pipelines.splice(0, pipelines.length - maxPipelineEvents);
    }
  }) as EventHandler<"context:pipeline">;

  eventBus.on("context:pipeline", pipelineHandler);
  handlers.push({
    event: "context:pipeline",
    handler: pipelineHandler as EventHandler<keyof EventMap>,
  });

  // Subscribe to context:pipeline:cache -- merge actual cache data into most recent snapshot
  // Timing fix: pre-LLM event has zeros; this patches real data from the post-LLM event
  const cacheHandler = ((payload: EventMap["context:pipeline:cache"]) => {
    // Find the most recent pipeline snapshot for this agent+session to merge into.
    // Walk backward since the pre-LLM event was just pushed.
    for (let i = pipelines.length - 1; i >= 0; i--) {
      const snap = pipelines[i]!;
      if (snap.agentId === payload.agentId && snap.sessionKey === payload.sessionKey) {
        // Merge cache data into the existing snapshot.
        // PipelineSnapshot fields are readonly, so we cast for mutation.
        const mutable = snap as {
          -readonly [K in keyof PipelineSnapshot]: PipelineSnapshot[K];
        };
        mutable.cacheHitTokens = payload.cacheHitTokens;
        mutable.cacheWriteTokens = payload.cacheWriteTokens;
        mutable.cacheMissTokens = payload.cacheMissTokens;
        logger?.debug({
          agentId: payload.agentId,
          sessionKey: payload.sessionKey,
          cacheHitTokens: payload.cacheHitTokens,
          cacheWriteTokens: payload.cacheWriteTokens,
          cacheMissTokens: payload.cacheMissTokens,
        }, "Context pipeline cache merged");
        break;
      }
    }
  }) as EventHandler<"context:pipeline:cache">;

  eventBus.on("context:pipeline:cache", cacheHandler);
  handlers.push({
    event: "context:pipeline:cache",
    handler: cacheHandler as EventHandler<keyof EventMap>,
  });

  // Subscribe to context:dag_compacted
  const dagHandler = ((payload: EventMap["context:dag_compacted"]) => {
    const snapshot: DagCompactionSnapshot = {
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      leafSummariesCreated: payload.leafSummariesCreated,
      condensedSummariesCreated: payload.condensedSummariesCreated,
      maxDepthReached: payload.maxDepthReached,
      totalSummariesCreated: payload.totalSummariesCreated,
      durationMs: payload.durationMs,
      timestamp: payload.timestamp,
    };
    dagCompactions.push(snapshot);
    if (dagCompactions.length > maxDagEvents) {
      dagCompactions.splice(0, dagCompactions.length - maxDagEvents);
    }
  }) as EventHandler<"context:dag_compacted">;

  eventBus.on("context:dag_compacted", dagHandler);
  handlers.push({
    event: "context:dag_compacted",
    handler: dagHandler as EventHandler<keyof EventMap>,
  });

  return {
    getRecentPipelines(opts = {}): PipelineSnapshot[] {
      const { agentId, limit = 50 } = opts;
      let filtered: PipelineSnapshot[] = pipelines;
      if (agentId !== undefined) {
        filtered = filtered.filter((s) => s.agentId === agentId);
      }
      // Return last N entries, newest first
      return filtered.slice(-limit).reverse();
    },

    getRecentDagCompactions(opts = {}): DagCompactionSnapshot[] {
      const { agentId, limit = 50 } = opts;
      let filtered: DagCompactionSnapshot[] = dagCompactions;
      if (agentId !== undefined) {
        filtered = filtered.filter((s) => s.agentId === agentId);
      }
      return filtered.slice(-limit).reverse();
    },

    reset(): void {
      pipelines.length = 0;
      dagCompactions.length = 0;
    },

    dispose(): void {
      for (const ref of handlers) {
        eventBus.off(ref.event, ref.handler);
      }
      handlers.length = 0;
    },
  };
}
