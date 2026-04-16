/**
 * @comis/agent context engine - Token budget management and context optimization.
 *
 * Provides the context engine pipeline that manages thinking block retention,
 * observation masking, microcompaction, and token budget allocation.
 *
 * @module
 */

// Types
export type {
  TokenBudget,
  TokenAnchor,
  ContextLayer,
  ContextEngine,
  ContextEngineDeps,
  ContextEngineMetrics,
  AssembledContext,
  LayerCircuitBreaker,
  MicrocompactionGuard,
  ObservationMasker,
  CacheOptimizationMetrics,
  CacheSessionStats,
  EvictionStats,
} from "./types.js";
export type { ToolMaskingTier } from "./constants.js";

// Constants
export {
  SAFETY_MARGIN_PERCENT,
  MIN_SAFETY_MARGIN_TOKENS,
  OUTPUT_RESERVE_TOKENS,
  CONTEXT_ROT_BUFFER_PERCENT,
  LAYER_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_KEEP_WINDOW_TURNS,
  MAX_INLINE_TOOL_RESULT_CHARS,
  MAX_INLINE_MCP_TOOL_RESULT_CHARS,
  MAX_INLINE_FILE_READ_RESULT_CHARS,
  TOOL_RESULT_HARD_CAP_CHARS,
  DEFAULT_OBSERVATION_KEEP_WINDOW,
  OBSERVATION_MASKING_CHAR_THRESHOLD,
  TOOL_MASKING_TIERS,
  resolveToolMaskingTier,
  EPHEMERAL_TOOL_KEEP_WINDOW,
  CHARS_PER_TOKEN_RATIO,
  CHARS_PER_TOKEN_RATIO_STRUCTURED,
  SYSTEM_PROMPT_HASH_LENGTH,
  BOOTSTRAP_BUDGET_WARN_PERCENT,
  MIN_CACHEABLE_TOKENS,
  DEFAULT_MIN_CACHEABLE_TOKENS,
  MCP_DEFERRAL_THRESHOLD,
  CACHE_LOOKBACK_WINDOW,
  COMPACTION_TRIGGER_PERCENT,
  COMPACTION_COOLDOWN_TURNS,
  COMPACTION_MAX_RETRIES,
  OVERSIZED_MESSAGE_CHARS_THRESHOLD,
  COMPACTION_REQUIRED_SECTIONS,
} from "./constants.js";

// Token budget algebra
export { computeTokenBudget } from "./token-budget.js";

// Context engine factory
export { createContextEngine } from "./context-engine.js";

// Thinking block cleaner layer
export { createThinkingBlockCleaner } from "./thinking-block-cleaner.js";

// Reasoning tag stripper layer
export { createReasoningTagStripper, validateRoleAttribution } from "./reasoning-tag-stripper.js";

// Microcompaction guard
export { installMicrocompactionGuard } from "./microcompaction-guard.js";

// History window layer
export { createHistoryWindowLayer } from "./history-window.js";
export type { HistoryWindowConfig } from "./history-window.js";

// Observation masker layer
export { createObservationMaskerLayer } from "./observation-masker.js";
export type { ObservationMaskerConfig } from "./observation-masker.js";

// LLM compaction layer
export { createLlmCompactionLayer } from "./llm-compaction.js";
export type { CompactionLayerDeps, CompactionLayerMetrics } from "./types.js";

// Post-compaction rehydration layer
export { createRehydrationLayer } from "./rehydration.js";
export type { RehydrationLayerDeps, RehydrationLayerMetrics } from "./types.js";
export {
  MAX_REHYDRATION_FILES,
  MAX_REHYDRATION_FILE_CHARS,
  MAX_REHYDRATION_TOTAL_CHARS,
} from "./constants.js";

// Dead content evictor layer
export { createDeadContentEvictorLayer } from "./dead-content-evictor.js";
export type { DeadContentEvictorConfig } from "./dead-content-evictor.js";
export { DEAD_CONTENT_EVICTION_MIN_AGE } from "./constants.js";

// Objective reinforcement layer
export { createObjectiveReinforcementLayer } from "./objective-reinforcement.js";

// Re-read detector
export { detectRereads } from "./reread-detector.js";
export type { RereadDetectorResult } from "./reread-detector.js";

// DAG compaction
export {
  runLeafPass,
  runCondensedPass,
  resolveFreshTailBoundary,
  summarizeWithEscalation,
  truncateAtSentenceBoundary,
  getDepthPrompt,
} from "./dag-compaction.js";
export type {
  CompactionDeps,
  LeafPassConfig,
  CondensedPassConfig,
  EscalationConfig,
  EscalationResult,
  LeafPassResult,
  CondensedPassResult,
  CompactionResult,
} from "./types.js";
export {
  DEPTH_PROMPTS,
  DAG_ESCALATION_OVERRUN_TOLERANCE,
  DAG_SUMMARY_ID_PREFIX,
  DAG_SUMMARY_ID_BYTES,
} from "./constants.js";

// DAG triggers
export {
  shouldCompact,
  markAncestorsDirty,
  recomputeDescendantCounts,
  runDagCompaction,
} from "./dag-triggers.js";
export type {
  DagCompactionConfig,
  DagCompactionDeps,
  DagCompactionEvent,
} from "./types.js";

// DAG assembler
export { createDagAssemblerLayer } from "./dag-assembler.js";
export type { DagAssemblerDeps, DagAssemblerConfig } from "./types.js";
export { XML_WRAPPER_OVERHEAD_TOKENS, RECALL_GUIDANCE } from "./constants.js";

// DAG annotator
export { createDagAnnotatorLayer } from "./dag-annotator.js";
export type { DagAnnotatorConfig, DagAnnotatorDeps } from "./dag-annotator.js";

// DAG integrity
export { checkIntegrity } from "./dag-integrity.js";
export type {
  IntegrityIssue,
  IntegrityReport,
  IntegrityCheckDeps,
  IntegrityCheckEvent,
} from "./types.js";

// DAG reconciliation and wiring
export { reconcileJsonlToDag, installDagIngestionHook, createDagContextEngine } from "./dag-reconciliation.js";
export type { ReconciliationResult, DagContextEngineDeps } from "./types.js";
