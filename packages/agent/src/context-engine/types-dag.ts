/**
 * DAG compaction, assembly, and reconciliation types for the context store.
 *
 * @module
 */

import type { ComisLogger } from "@comis/infra";
import type { ContextStore } from "@comis/memory";
import type { ContextEngineDeps } from "./types-core.js";

// ---------------------------------------------------------------------------
// DAG Compaction
// ---------------------------------------------------------------------------

/**
 * Dependency injection interface for all DAG compaction functions.
 *
 * All compaction algorithms receive this as a parameter -- no global state,
 * fully testable with `:memory:` SQLite databases.
 */
export interface CompactionDeps {
  /** Context store for all DAG read/write operations. */
  store: ContextStore;
  /** Structured logger for the compaction module. */
  logger: ComisLogger;
  /**
   * LLM summarization function matching the SDK `generateSummary` signature.
   * Handles message formatting, provider differences, and token limits.
   */
  generateSummary: (
    messages: unknown[],
    model: unknown,
    maxTokens: number,
    apiKey: string,
    systemPrompt?: string,
    customInstructions?: string,
  ) => Promise<string>;
  /**
   * Pre-resolved model getter returning the model object and API key accessor.
   *
   * **Wiring note:** The caller ( assembler) must resolve this
   * from config via `summaryModel ?? compactionModel` (see `schema-context-engine.ts`).
   * This function is a pre-resolved closure -- the compaction algorithms do not
   * read config directly.
   */
  getModel: () => { model: unknown; getApiKey: () => Promise<string> };
  /** Token estimation function (typically `Math.ceil(text.length / CHARS_PER_TOKEN_RATIO)`). */
  estimateTokens: (text: string) => number;
}

/**
 * Configuration for the leaf pass (depth-0 summarization of raw messages).
 */
export interface LeafPassConfig {
  /** Minimum number of eligible messages required to trigger leaf summarization. */
  leafMinFanout: number;
  /** Maximum token budget per message chunk before splitting. */
  leafChunkTokens: number;
  /** Target token count for each leaf summary output. */
  leafTargetTokens: number;
  /** Number of recent user-assistant turn cycles to protect from compaction. */
  freshTailTurns: number;
}

/**
 * Configuration for the condensed pass (depth+1 summarization of same-depth summaries).
 */
export interface CondensedPassConfig {
  /** Minimum number of eligible summaries required to trigger condensed summarization. */
  condensedMinFanout: number;
  /** Target token count for each condensed summary output. */
  condensedTargetTokens: number;
}

/**
 * Configuration for the three-tier escalation strategy.
 */
export interface EscalationConfig {
  /** Target token count for the summary output. */
  targetTokens: number;
  /** Multiplier beyond target tokens that triggers escalation to next tier (default 1.5). */
  overrunTolerance?: number;
}

/**
 * Result from a single three-tier escalation summarization attempt.
 */
export interface EscalationResult {
  /** The generated summary content. */
  content: string;
  /** Which escalation tier produced this result. */
  tier: "normal" | "aggressive" | "truncation";
  /** Estimated token count of the produced summary. */
  tokenCount: number;
}

/**
 * Result from a leaf pass execution.
 */
export interface LeafPassResult {
  /** Number of depth-0 summaries created. */
  created: number;
  /** IDs of the created summaries. */
  summaryIds: string[];
  /** Reason the pass was skipped, if applicable. */
  reason?: "insufficient-messages";
}

/**
 * Result from a condensed pass execution.
 */
export interface CondensedPassResult {
  /** Number of summaries created (0 or 1 per pass). */
  created: number;
  /** IDs of the created summaries. */
  summaryIds: string[];
  /** Reason the pass was skipped, if applicable. */
  reason?: "insufficient-summaries";
}

/**
 * Aggregate result from a full compaction cycle (leaf + condensed passes).
 */
export interface CompactionResult {
  /** Result from the leaf (depth-0) pass. */
  leafResult: LeafPassResult;
  /** Results from each condensed pass at increasing depths. */
  condensedResults: CondensedPassResult[];
  /** Total number of summaries created across all passes. */
  totalCreated: number;
  /** Maximum summary depth reached during this compaction. */
  maxDepthReached: number;
}

/**
 * Full configuration for orchestrated DAG compaction (trigger + leaf + condensed).
 */
export interface DagCompactionConfig {
  /** Minimum number of eligible messages required to trigger leaf summarization. */
  leafMinFanout: number;
  /** Maximum token budget per message chunk before splitting. */
  leafChunkTokens: number;
  /** Target token count for each leaf summary output. */
  leafTargetTokens: number;
  /** Minimum number of eligible summaries required to trigger condensed summarization. */
  condensedMinFanout: number;
  /** Target token count for each condensed summary output. */
  condensedTargetTokens: number;
  /** Number of recent user-assistant turn cycles to protect from compaction. */
  freshTailTurns: number;
  /** Multiplier of budget.availableHistoryTokens that triggers compaction. */
  contextThreshold: number;
  /** Maximum condensed pass depth (-1 = unlimited up to 10, 0 = skip condensed). */
  incrementalMaxDepth: number;
}

/**
 * Dependencies for orchestrated DAG compaction (extends CompactionDeps).
 *
 * The eventBus uses a typed emit signature narrowed to the specific
 * `context:dag_compacted` event name. The real TypedEventBus satisfies this
 * narrower type via structural subtyping.
 */
export type DagCompactionDeps = CompactionDeps & {
  /** Optional typed event bus for emitting DAG compaction lifecycle events. */
  eventBus?: {
    emit(event: "context:dag_compacted", data: DagCompactionEvent): void;
  };
  /** Agent ID for event attribution (required for event correlation). */
  agentId: string;
  /** Session key for event correlation (required for event correlation). */
  sessionKey: string;
};

/**
 * Payload for the `context:dag_compacted` event.
 */
export interface DagCompactionEvent {
  /** Conversation that was compacted. */
  conversationId: string;
  /** Agent that triggered compaction. */
  agentId: string;
  /** Session key for event correlation. */
  sessionKey: string;
  /** Number of depth-0 summaries created from raw messages. */
  leafSummariesCreated: number;
  /** Number of condensed summaries created from lower-depth summaries. */
  condensedSummariesCreated: number;
  /** Highest summary depth reached during this compaction cycle. */
  maxDepthReached: number;
  /** Total summaries created (leaf + condensed). */
  totalSummariesCreated: number;
  /** Total compaction duration in milliseconds. */
  durationMs: number;
  /** Unix timestamp when compaction completed. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// DAG Assembly
// ---------------------------------------------------------------------------

/**
 * Dependency injection interface for the DAG assembler layer.
 *
 * Injected via closure in `createDagAssemblerLayer()`. The assembler
 * reads from the context store to fetch context items and resolve
 * their backing message/summary rows.
 */
export interface DagAssemblerDeps {
  /** Context store for all DAG read operations. */
  store: ContextStore;
  /** Structured logger for the assembler module. */
  logger: ComisLogger;
  /** Active conversation ID for context item lookup. */
  conversationId: string;
  /** Token estimation function (typically `Math.ceil(text.length / CHARS_PER_TOKEN_RATIO)`). */
  estimateTokens: (text: string) => number;
}

/**
 * Configuration for the DAG assembler layer.
 *
 * Controls fresh tail protection and the token budget available
 * for assembled history content.
 */
export interface DagAssemblerConfig {
  /** Number of recent user-assistant turn cycles to protect from eviction. */
  freshTailTurns: number;
  /** Token budget for history content (from TokenBudget.availableHistoryTokens). */
  availableHistoryTokens: number;
}

// ---------------------------------------------------------------------------
// DAG Reconciliation
// ---------------------------------------------------------------------------

/**
 * Result from a JSONL-to-DAG reconciliation run.
 */
export interface ReconciliationResult {
  /** Conversation that was reconciled. */
  conversationId: string;
  /** Number of messages imported from JSONL into the DAG. */
  imported: number;
  /** True when DAG was empty (mode switch case -- full import). */
  fullImport: boolean;
  /** Duration of the reconciliation in milliseconds. */
  durationMs: number;
}

/**
 * Extended dependencies for the DAG context engine factory.
 *
 * Adds DAG-specific dependencies on top of the base ContextEngineDeps.
 * These are conditionally provided when config.version === "dag".
 */
export interface DagContextEngineDeps extends ContextEngineDeps {
  /** Context store for DAG read/write operations. */
  contextStore: ContextStore;
  /** Raw better-sqlite3 Database handle for transactions and raw SQL. */
  db: unknown;
  /** Active conversation ID for this session. */
  conversationId: string;
  /** Token estimation function. */
  estimateTokens: (text: string) => number;
  /** Optional DAG compaction configuration. */
  dagCompactionConfig?: DagCompactionConfig;
  /** Optional partial compaction deps (store/logger provided internally). */
  dagCompactionDeps?: Omit<DagCompactionDeps, "store" | "logger">;
}
