// SPDX-License-Identifier: Apache-2.0
/**
 * Memory domain types.
 *
 * Interfaces for memory entries, statistics, creation params,
 * and context DAG nodes used in the memory inspector and
 * context engine views.
 */

/** Memory entry for browse/search results */
export interface MemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly memoryType: string;
  readonly trustLevel: string;
  readonly agentId: string;
  readonly tenantId: string;
  readonly source?: string;
  readonly tags?: string[];
  readonly score?: number;
  readonly hasEmbedding: boolean;
  readonly embeddingDims?: number;
  readonly createdAt: number;
  readonly updatedAt?: number;
}

/** Memory stats from memory.stats RPC */
export interface MemoryStats {
  readonly totalEntries: number;
  readonly totalSessions: number;
  readonly embeddedEntries: number;
  readonly dbSizeBytes: number;
  readonly byType?: Readonly<Record<string, number>>;
  readonly byTrustLevel?: Readonly<Record<string, number>>;
  readonly byAgent?: Readonly<Record<string, number>>;
  readonly oldestCreatedAt?: number | null;
}

/** Parameters for creating a new memory entry */
export interface MemoryCreateParams {
  readonly content: string;
  readonly tags?: string[];
  readonly trustLevel?: string;
  readonly provenance?: string;
  readonly agentId?: string;
}

/** Result from memory.flush RPC */
export interface MemoryFlushResult {
  readonly flushed: boolean;
  readonly entriesRemoved: number;
  readonly scope: {
    readonly tenantId: string;
    readonly agentId: string | null;
  };
}

/** Context DAG node for the context engine visualization */
export interface ContextDagNode {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly children: string[];
  readonly depth: number;
  readonly createdAt: number;
}

/** DAG conversation entry from context.conversations RPC */
export interface DagConversation {
  readonly conversation_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly session_key: string;
  readonly title: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Embedding cache stats from memory.embeddingCache RPC */
export interface EmbeddingCacheStats {
  readonly enabled: boolean;
  readonly l1?: {
    readonly entries: number;
    readonly maxEntries: number;
    readonly hitRate: number;
    readonly hits: number;
    readonly misses: number;
  };
  readonly l2: null;
  readonly provider?: string;
  readonly vecAvailable: boolean;
  readonly circuitBreaker: {
    readonly state: "closed" | "open" | "halfOpen" | "unknown";
  };
}

/** DAG tree node from context.tree RPC */
export interface DagTreeNode {
  readonly summaryId: string;
  readonly kind: "leaf" | "condensed";
  readonly depth: number;
  readonly tokenCount: number;
  readonly contentPreview: string;
  readonly childIds: string[];
  readonly parentIds: string[];
  readonly createdAt: string;
}
