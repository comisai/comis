// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/agent - Agent execution with safety controls
 */

// Executor types
export type { AgentExecutor, ExecutionResult, ExecutionOverrides } from "./executor/types.js";

// Step counter
export { createStepCounter } from "./executor/step-counter.js";
export type { StepCounter } from "./executor/step-counter.js";

// Safety
export { createCircuitBreaker } from "./safety/circuit-breaker.js";
export type { CircuitBreaker, CircuitState } from "./safety/circuit-breaker.js";
export { createProviderHealthMonitor } from "./safety/provider-health-monitor.js";
export type { ProviderHealthMonitor } from "./safety/provider-health-monitor.js";
export { createToolRetryBreaker } from "./safety/tool-retry-breaker.js";
export type { ToolRetryBreaker, ToolRetryVerdict, ToolRetryBreakerConfig } from "./safety/tool-retry-breaker.js";
export { sanitizeToolOutput, INSTRUCTION_PATTERNS } from "./safety/tool-output-safety.js";
export { createToolDisplayNames } from "./safety/tool-display-names.js";
export type { ToolDisplayNames } from "./safety/tool-display-names.js";
export { createToolImageSanitizer } from "./safety/tool-output-safety.js";
export type { ToolImageSanitizer, ImageSanitizeOptions, SanitizeResult } from "./safety/tool-output-safety.js";
export { createContextWindowGuard } from "./safety/context-window-guard.js";
export type { ContextWindowGuard, ContextWindowStatus, ContextWindowGuardOptions } from "./safety/context-window-guard.js";
export { createToolResultSizeGuard } from "./safety/tool-result-size-guard.js";
export type { ToolResultSizeGuard, TruncationMetadata, ToolResultSizeGuardOptions } from "./safety/tool-result-size-guard.js";

// Token estimator
export { estimateMessageChars, estimateContextChars, estimateMessageTokens, estimateContextTokens, CHARS_PER_TOKEN, IMAGE_TOKEN_ESTIMATE } from "./safety/token-estimator.js";

// Overflow recovery ()
export type { OverflowRecoveryConfig, OverflowRecoveryResult } from "./executor/overflow-recovery.js";
export { createOverflowRecovery, createOverflowRecoveryWrapper } from "./executor/overflow-recovery.js";

// Budget
export { createBudgetGuard, BudgetError } from "./budget/budget-guard.js";
export type { BudgetGuard, BudgetSnapshot } from "./budget/budget-guard.js";
export { createCostTracker } from "./budget/cost-tracker.js";
export type { CostTracker, CostRecord, UsageInput } from "./budget/cost-tracker.js";
export { createTurnBudgetTracker } from "./budget/turn-budget-tracker.js";
export type { TurnBudgetTracker, TurnBudgetDecision, TurnBudgetStopReason } from "./budget/turn-budget-tracker.js";

// Auth provider facade (unified auth wiring)
export { createAuthProvider } from "./model/auth-provider.js";
export type { AuthProvider, AuthProviderConfig } from "./model/auth-provider.js";

// Auth profile rotation
export { createAuthProfileManager } from "./model/auth-profile.js";
export type { AuthProfileManager, AuthProfile, OrderingStrategy } from "./model/auth-profile.js";

// Auth rotation adapter (key rotation with cooldown)
export { createAuthRotationAdapter } from "./model/auth-rotation-adapter.js";
export type { AuthRotationAdapter, AuthRotationAdapterOptions } from "./model/auth-rotation-adapter.js";

// Image-aware model routing (existing + image fallback chain from 62-05)
export { resolveModelForMessage, isVisionCapable, createImageFallbackChain } from "./model/image-router.js";
export type { ImageRouterParams, ImageRouterResult, ImageFallbackChain, ImageFallbackChainConfig } from "./model/image-router.js";

// Model allowlist
export { createModelAllowlist } from "./model/model-allowlist.js";
export type { ModelAllowlist } from "./model/model-allowlist.js";

// Model alias resolver
export { createModelAliasResolver } from "./model/model-alias-resolver.js";
export type { ModelAliasResolver, ModelAliasResolverDeps } from "./model/model-alias-resolver.js";

// Context window resolver
export { createContextWindowResolver } from "./model/context-window-resolver.js";
export type { ContextWindowResolver, ContextWindowResolverDeps } from "./model/context-window-resolver.js";

// Model catalog
export { createModelCatalog, resolveModelPricing, ZERO_COST } from "./model/model-catalog.js";
export type { CatalogEntry, ModelCatalog, PerTokenCostRates } from "./model/model-catalog.js";

// Cache eligibility helpers
export { getCacheProviderInfo } from "./executor/cache-usage-helpers.js";
export type { CacheProviderInfo } from "./executor/cache-usage-helpers.js";

// Model scanner
export { createModelScanner } from "./model/model-scanner.js";
export type { ScanResult, ModelScanner, ModelScannerDeps } from "./model/model-scanner.js";

// OAuth token manager (from 62-03)
export { createOAuthTokenManager } from "./model/oauth-token-manager.js";
export type { OAuthTokenManager, OAuthTokenManagerDeps, OAuthError } from "./model/oauth-token-manager.js";

// Auth usage tracker (from 62-05)
export { createAuthUsageTracker } from "./model/auth-usage-tracker.js";
export type { AuthUsageTracker, ProfileStats, ProfileUsageInput } from "./model/auth-usage-tracker.js";

// Last-known-working model tracker (auth-failure fallback)
export { createLastKnownModelTracker } from "./model/last-known-model.js";
export type { LastKnownModelTracker, LastKnownModelEntry } from "./model/last-known-model.js";

// Routing
export { createMessageRouter, resolveAgent } from "./routing/message-router.js";
export type { MessageRouter } from "./routing/message-router.js";

// Session lifecycle (renamed from session-manager.ts)
export { createSessionLifecycle } from "./session/session-lifecycle.js";
export type { SessionLifecycle, SessionLifecycleOptions } from "./session/session-lifecycle.js";
// Backward compat aliases
export { createSessionLifecycle as createSessionManager } from "./session/session-lifecycle.js";
export type { SessionLifecycle as SessionManager } from "./session/session-lifecycle.js";

// Session label store (human-readable session names via metadata.label)
export { createSessionLabelStore } from "./session/session-label-store.js";
export type { SessionLabelStore } from "./session/session-label-store.js";

// Session key builder (DM scope modes, agent prefix, thread isolation)
export { buildScopedSessionKey, extractThreadId } from "./session/session-key-builder.js";
export type { DmScopeMode, ScopedSessionKeyParams } from "./session/session-key-builder.js";

// Session write lock (per-session filesystem locking)
export { withSessionLock, cleanupStaleLocks } from "./session/session-write-lock.js";
export type { LockedSessionStoreOptions } from "./session/session-write-lock.js";

// Session reset policy
export {
  createSessionResetScheduler,
  classifySession,
  resolvePolicy,
  isDailyResetDue,
  isIdleResetDue,
  checkReset,
  type SessionResetScheduler,
  type SessionResetSchedulerDeps,
  type SessionKind,
  type EffectiveResetPolicy,
} from "./session/session-reset-policy.js";

// Identity
export { loadIdentityFiles } from "./identity/identity-loader.js";
export type { IdentityFiles } from "./identity/identity-loader.js";
export { createIdentityUpdater } from "./identity/identity-updater.js";
export type { IdentityUpdater, PendingUpdate } from "./identity/identity-updater.js";
export { createIdentityLinkResolver } from "./identity/identity-link-resolver.js";
export type { IdentityLinkResolver, IdentityLinkResolverDeps } from "./identity/identity-link-resolver.js";

// Greeting (LLM-powered session greeting for /new and /reset)
export { createGreetingGenerator } from "./greeting/session-greeting.js";
export type { GreetingGenerator, GreetingGeneratorDeps } from "./greeting/session-greeting.js";

// Memory review (periodic session history extraction)
export { runMemoryReview } from "./memory/memory-review-job.js";
export type { MemoryReviewDeps } from "./memory/memory-review-job.js";

// RAG (Retrieval-Augmented Generation)
export { createRagRetriever, formatMemorySection } from "./rag/rag-retriever.js";
export type { RagRetriever, RagRetrieverDeps } from "./rag/rag-retriever.js";

// Queue
export { createCommandQueue } from "./queue/index.js";
export type { CommandQueue, CommandQueueDeps, QueueStats } from "./queue/index.js";
export type { SessionLane } from "./queue/index.js";
export { applyOverflowPolicy } from "./queue/index.js";
export type { OverflowResult } from "./queue/index.js";
export { coalesceMessages } from "./queue/index.js";
export { createDebounceBuffer } from "./queue/index.js";
export type { DebounceBuffer, DebounceBufferDeps } from "./queue/index.js";
export { createFollowupTrigger } from "./queue/index.js";
export type { FollowupTrigger, FollowupTriggerDeps } from "./queue/index.js";
export { createPriorityScheduler } from "./queue/index.js";
export type { PriorityScheduler, PrioritySchedulerDeps, LaneStats } from "./queue/index.js";

// Bootstrap (workspace loading & system prompt assembly)
export {
  loadWorkspaceBootstrapFiles,
  truncateFileContent,
  filterBootstrapFilesForSubAgent,
  filterBootstrapFilesForLightContext,
  filterBootstrapFilesForGroupChat,
  buildBootstrapContextFiles,
  assembleRichSystemPrompt,
  LEAN_TOOL_DESCRIPTIONS,
  TOOL_SUMMARIES,
  TOOL_ORDER,
  resolveDescription,
} from "./bootstrap/index.js";
export type {
  BootstrapFile,
  TruncationResult,
  PromptMode,
  RuntimeInfo,
  BootstrapContextFile,
  AssemblerParams,
  SystemPromptBlocks,
  ToolDescriptionContext,
} from "./bootstrap/index.js";

// Commands (slash command parser & handler)
export { parseSlashCommand, createCommandHandler } from "./commands/index.js";
export type {
  CommandType,
  ParsedCommand,
  CommandDirectives,
  CommandResult,
  CommandHandlerDeps,
  CommandHandler,
} from "./commands/index.js";

// Commands — Prompt skill matcher
export { matchPromptSkillCommand, detectSkillCollisions, RESERVED_COMMAND_NAMES } from "./commands/index.js";
export type { PromptSkillMatch, CollisionWarning, PromptSkillDirective } from "./commands/index.js";

// Workspace
export {
  ensureWorkspace,
  getWorkspaceStatus,
  registerWorkspaceFilesInTracker,
  resolveWorkspaceDir,
  WORKSPACE_FILE_NAMES,
  WORKSPACE_SUBDIRS,
  DEFAULT_TEMPLATES,
  isHeartbeatContentEffectivelyEmpty,
} from "./workspace/index.js";
export type {
  WorkspaceFiles,
  EnsureWorkspaceOptions,
  WorkspaceStatus,
  WorkspaceFileName,
  WorkspaceSeedTracker,
  RegisterWorkspaceResult,
} from "./workspace/index.js";

// File-state tracker registry (per-session lifetime)
export { createSessionTrackerRegistry } from "./file-state/session-tracker-registry.js";
export type {
  SessionTrackerRegistry,
  FileStateTrackerLike,
  CreateFileStateTrackerFn,
} from "./file-state/session-tracker-registry.js";

// Envelope (message wrapping for LLM context)
export { wrapInEnvelope, formatElapsed } from "./envelope/index.js";

// ---------------------------------------------------------------------------
// PiExecutor
// ---------------------------------------------------------------------------

// PiExecutor core
export { createPiExecutor } from "./executor/pi-executor.js";
export type { PiExecutorDeps } from "./executor/pi-executor.js";

// Wire session:expired to clearSession functions
export { clearSessionState, wireSessionStateCleanup } from "./executor/session-snapshot-cleanup.js";

// Sub-agent cache prefix sharing -- parent CacheSafeParams reader for setup-cross-session
export { getCacheSafeParams } from "./executor/prompt-assembly.js";
export type { CacheSafeParams } from "./executor/prompt-assembly.js";

// MCP disconnect cleanup (clean discovery state on server disconnect/tools_changed)
export { wireMcpDisconnectCleanup } from "./executor/mcp-disconnect-cleanup.js";

// Discovery tracker bulk cleanup (server disconnect + tools_changed)
export { cleanupServerFromAllTrackers, cleanupToolsFromAllTrackers } from "./executor/discovery-tracker.js";

// Prompt timeout guard
export { withPromptTimeout, withResettablePromptTimeout, PromptTimeoutError } from "./executor/prompt-timeout.js";
export type { ResettableTimeout } from "./executor/prompt-timeout.js";

// Error classification (user-safe error messages)
export { classifyError, classifyPromptTimeout } from "./executor/error-classifier.js";
export type { ErrorCategory, ClassifiedError } from "./executor/error-classifier.js";

// Stream function wrapper chain
// JSONL trace wrappers
// Cache breakpoint injector
export type { StreamFnWrapper, ConfigResolverConfig, RequestBodyInjectorConfig, CacheTraceConfig, ApiPayloadTraceConfig, TruncationSummary, ToolResultSizeBouncerResult } from "./executor/stream-wrappers/index.js";
export { composeStreamWrappers, createConfigResolver, createRequestBodyInjector, createCacheTraceWriter, createApiPayloadTraceWriter, createToolResultSizeBouncer, clearSessionRenderedToolCache } from "./executor/stream-wrappers/index.js";

// Active run registry (-- tracks running sessions for mid-stream steering)
export { createActiveRunRegistry } from "./executor/active-run-registry.js";
export type { ActiveRunRegistry, RunHandle } from "./executor/active-run-registry.js";

// Cache break detection
export { clearCacheBreakDetectorSession, extractGeminiPromptState } from "./executor/cache-break-detection.js";
export type { CacheBreakDetector, CacheBreakEvent, CacheBreakReason, RecordPromptStateInput, CheckCacheBreakInput, PendingChanges, PromptStateSnapshot } from "./executor/cache-break-detection.js";

// Cache break diff writer ()
export { createCacheBreakDiffWriter } from "./executor/cache-break-diff-writer.js";
export type { CacheBreakDiffWriterConfig, CacheBreakDiffPayload } from "./executor/cache-break-diff-writer.js";

// Gemini cache injector
export { createGeminiCacheInjector } from "./executor/gemini-cache-injector.js";
export type { GeminiCacheInjectorConfig } from "./executor/gemini-cache-injector.js";

// Gemini cache manager ()
export { createGeminiCacheManager, computeCacheContentHash } from "./executor/gemini-cache-manager.js";
export type { GeminiCacheManager, GeminiCacheManagerConfig, CacheEntry, CacheRequest } from "./executor/gemini-cache-manager.js";

// Gemini cache lifecycle
export { wireGeminiCacheCleanup } from "./executor/gemini-cache-lifecycle.js";

// Comis session manager (unified session wrapper)
export { createComisSessionManager } from "./session/comis-session-manager.js";
export type { ComisSessionManager, ComisSessionManagerDeps, SessionStats, SessionMetadata } from "./session/comis-session-manager.js";
// Session secret sanitizer (post-execution JSONL redaction)
export { sanitizeSessionSecrets } from "./session/sanitize-session-secrets.js";

// Orphaned message repair (trailing user message detection)
export { repairOrphanedMessages, scrubPoisonedThinkingBlocks } from "./session/orphaned-message-repair.js";
export type { ScrubResult } from "./session/orphaned-message-repair.js";

// Redacted-tool-call scrub (neutralizes env_set tool_use/tool_result pairs
// whose args were redacted by sanitizeSessionSecrets, preventing the model
// from replaying "[REDACTED]" as a future env_value)
export { scrubRedactedToolCalls } from "./session/scrub-redacted-tool-calls.js";
export type { RedactedScrubResult } from "./session/scrub-redacted-tool-calls.js";

// Pi event bridge (AgentSessionEvent to TypedEventBus translation)
export { createPiEventBridge } from "./bridge/pi-event-bridge.js";
export type { PiEventBridgeDeps, PiEventBridgeResult } from "./bridge/pi-event-bridge.js";

// ---------------------------------------------------------------------------
// Adapters (re-export for daemon wiring convenience)
// ---------------------------------------------------------------------------

// Auth storage adapter (SecretManager to pi-coding-agent AuthStorage)
export { createAuthStorageAdapter, DEFAULT_PROVIDER_KEYS } from "./model/auth-storage-adapter.js";
export type { AuthStorageAdapterOptions } from "./model/auth-storage-adapter.js";

// Model registry adapter (ModelRegistry creation + initial model resolution)
export { createModelRegistryAdapter, registerCustomProviders, resolveInitialModel } from "./model/model-registry-adapter.js";
export type { CustomProviderRegistration, CustomProviderLogger } from "./model/model-registry-adapter.js";

// Session key mapper (SessionKey to/from filesystem path)
export { sessionKeyToPath, pathToSessionKey } from "./session/session-key-mapper.js";

// ---------------------------------------------------------------------------
// LLM prompting improvements
// ---------------------------------------------------------------------------

// Follow-through detector (detect broken tool-use promises)
export { detectBrokenFollowThrough, FOLLOW_THROUGH_PATTERNS } from "./safety/response-safety-checks.js";
export type { FollowThroughResult } from "./safety/response-safety-checks.js";

// Post-compaction safety (re-inject safety rules after SDK compaction)
export { buildPostCompactionSafetyMessage, POST_COMPACTION_SAFETY_RULES } from "./safety/response-safety-checks.js";

// Context truncation recovery (emergency overflow handling)
export { isContextOverflowError, truncateContextForRecovery } from "./safety/context-truncation-recovery.js";
export type { ContextTruncationResult } from "./safety/context-truncation-recovery.js";

// Hybrid memory injector (split RAG results: inline + system prompt)
export { createHybridMemoryInjector } from "./rag/hybrid-memory-injector.js";
export type { HybridMemoryInjector, HybridMemoryInjection } from "./rag/hybrid-memory-injector.js";

// Schema normalizer (strip unsupported JSON Schema keywords per provider)
export { normalizeToolSchema, normalizeToolSchemas, PROVIDER_UNSUPPORTED_KEYWORDS } from "./safety/tool-schema-safety.js";
export type { NormalizedSchema, ProviderName } from "./safety/tool-schema-safety.js";

// Tool schema normalization pipeline (4-layer per-provider normalization)
export { normalizeToolSchemasForProvider, setToolNormalizationLogger } from "./provider/tool-schema/normalize.js";
export type { ToolNormalizationContext } from "./provider/tool-schema/normalize.js";
export { cleanSchemaForGemini } from "./provider/tool-schema/clean-for-gemini.js";
export { stripXaiUnsupportedKeywords } from "./provider/tool-schema/clean-for-xai.js";

// Schema pruning (strip optional param descriptions for small models)
export { pruneSchemaDescriptions, pruneToolSchemas } from "./safety/tool-schema-safety.js";
export type { PruneResult, PruneToolsResult } from "./safety/tool-schema-safety.js";

// Spawn (SpawnPacketBuilder + parent summary + result condensation)
export { createSpawnPacketBuilder } from "./spawn/index.js";
export type { SpawnPacketBuilderDeps, SpawnPacketBuildParams } from "./spawn/index.js";
export { generateParentSummary } from "./spawn/index.js";
export type { GenerateParentSummaryDeps } from "./spawn/index.js";
export { createResultCondenser } from "./spawn/index.js";
export type { ResultCondenserDeps, CondenseParams } from "./spawn/index.js";
export { createNarrativeCaster } from "./spawn/index.js";
export type { NarrativeCasterConfig, CastParams } from "./spawn/index.js";
export { createLifecycleHooks, deriveSubagentContextEngineConfig } from "./spawn/index.js";
export type { LifecycleHooksDeps } from "./spawn/index.js";
export { createEphemeralComisSessionManager } from "./spawn/index.js";

// Context engine (, )
export { createContextEngine } from "./context-engine/index.js";
export { createThinkingBlockCleaner } from "./context-engine/index.js";
export { computeTokenBudget } from "./context-engine/index.js";
export type {
  ContextEngine,
  ContextEngineDeps,
  ContextLayer,
  TokenBudget,
  ContextEngineMetrics,
  AssembledContext,
  LayerCircuitBreaker,
} from "./context-engine/index.js";

// DAG reconciliation, compaction, integrity, and assembler (Phases 411-414)
export {
  reconcileJsonlToDag,
  installDagIngestionHook,
  createDagContextEngine,
  runLeafPass,
  runCondensedPass,
  resolveFreshTailBoundary,
  shouldCompact,
  markAncestorsDirty,
  recomputeDescendantCounts,
  runDagCompaction,
  checkIntegrity,
  CHARS_PER_TOKEN_RATIO,
} from "./context-engine/index.js";
export type {
  ReconciliationResult,
  DagContextEngineDeps,
  CompactionDeps,
  DagCompactionConfig,
  DagCompactionDeps,
  IntegrityCheckDeps,
  IntegrityReport,
  IntegrityIssue,
} from "./context-engine/index.js";

// Provider capabilities
export {
  DEFAULTS as PROVIDER_CAPABILITY_DEFAULTS,
  resolveProviderCapabilities,
  normalizeProviderId,
  isAnthropicFamily,
  isOpenAiFamily,
  shouldDropThinkingBlocks,
  resolveToolCallIdMode,
} from "./provider/capabilities.js";

// Model compatibility auto-detection (xAI compat flags)
export { normalizeModelCompat } from "./provider/model-compat.js";

// Model ID normalization ()
export { normalizeModelId } from "./provider/model-id-normalize.js";
export type { ModelIdNormalizationResult } from "./provider/model-id-normalize.js";

// Response sanitization pipeline
export { sanitizeAssistantResponse, setSanitizeLogger, extractFinalTagContent } from "./provider/response/sanitize-pipeline.js";
export type { SanitizeOptions } from "./provider/response/sanitize-pipeline.js";

// Response filter utilities ( -- used by ThinkingTagFilter)
export { stripReasoningTagsFromText } from "./response-filter/reasoning-tags.js";
export { findCodeRegions, isInsideCode } from "./response-filter/code-regions.js";
export type { CodeRegion } from "./response-filter/code-regions.js";

// Thinking tag filter ( -- moved from @comis/channels)
export { createThinkingTagFilter } from "./response-filter/thinking-tag-filter.js";
export type { ThinkingTagFilter, ThinkingTagFilterOptions } from "./response-filter/thinking-tag-filter.js";

// Operation model resolver
export { resolveOperationModel, resolveProviderFamily } from "./model/operation-model-resolver.js";
export type { OperationModelResolution } from "./model/operation-model-resolver.js";
export { OPERATION_MODEL_DEFAULTS, OPERATION_TIER_MAP, OPERATION_TIMEOUT_DEFAULTS, OPERATION_CACHE_DEFAULTS } from "./model/operation-model-defaults.js";

// SessionLatch utility
export { createSessionLatch } from "./executor/session-latch.js";
export type { SessionLatch } from "./executor/session-latch.js";

// Background task infrastructure
export * from "./background/index.js";
