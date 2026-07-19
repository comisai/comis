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
export { createSummarizerSpendBreaker } from "./safety/summarizer-spend-breaker.js";
// SummarizerSpendBreakerDeps + SummarizerSpendConfig are NOT re-exported: they are
// consumed only intra-package (the factory's own signature in
// summarizer-spend-breaker.ts). The daemon composition root imports
// createSummarizerSpendBreaker + the SummarizerSpendBreaker instance type only.
export type { SummarizerSpendBreaker } from "./safety/summarizer-spend-breaker.js";

// Token estimator
export { estimateMessageChars, estimateContextChars, estimateMessageTokens, estimateContextTokens, CHARS_PER_TOKEN, IMAGE_TOKEN_ESTIMATE } from "./safety/token-estimator.js";

// Overflow recovery
export type { OverflowRecoveryConfig, OverflowRecoveryResult } from "./executor/overflow-recovery.js";
export { createOverflowRecovery, createOverflowRecoveryWrapper } from "./executor/overflow-recovery.js";

// Budget
export { createBudgetGuard, BudgetError } from "./budget/budget-guard.js";
export type { BudgetGuard, BudgetSnapshot } from "./budget/budget-guard.js";
export { createCostTracker } from "./budget/cost-tracker.js";
export type { CostTracker, CostRecord, UsageInput } from "./budget/cost-tracker.js";
// Spend kill-switch: the surface the daemon composition root consumes
// cross-package — the daemon-wide accumulator factory + the instance type + the
// scope type (setup-observability wiring + the PiExecutorDeps thread).
// The 3-state spend GATE (`checkSpendCeiling` + its outcome/error/ceilings/config
// types) is consumed cross-package by the per-`rootRunId` budget meter
// (`@comis/daemon` `autonomy/per-root-budget.ts`): the meter REUSES the 3-state
// gate VERBATIM for its $-limb (same fail-closed semantics — never
// re-implemented). Exported here because the daemon meter consumes them
// cross-package (public-export-consumers gate: a barrel export needs a
// cross-package consumer).
export { createSpendAccumulator, SpendError } from "./budget/spend-accumulator.js";
export type { SpendAccumulator, SpendScope, SpendLimb, SpendUnit } from "./budget/spend-accumulator.js";
export { checkSpendCeiling } from "./budget/budget-guard.js";
export type { SpendGateOutcome, SpendGateConfig } from "./budget/budget-guard.js";
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

// Image-aware model routing (existing + image fallback chain)
export { resolveModelForMessage, isVisionCapable, createImageFallbackChain } from "./model/image-router.js";
export type { ImageRouterParams, ImageRouterResult, ImageFallbackChain, ImageFallbackChainConfig } from "./model/image-router.js";

// Model allowlist
export { createModelAllowlist } from "./model/model-allowlist.js";
export type { ModelAllowlist } from "./model/model-allowlist.js";

// Context window resolver
export { createContextWindowResolver } from "./model/context-window-resolver.js";
export type { ContextWindowResolver, ContextWindowResolverDeps } from "./model/context-window-resolver.js";

// The following re-exports live in @comis/core; CLI + daemon consumers
// retarget to @comis/core via the barrel:
//   - createFileLock
//   - createConsoleLogger / isDocker
//   - isRemoteEnvironment
//   - selectOAuthCredentialStore
//   - loginOpenAICodexOAuth + types
//   - OAuthError
//   - createOAuthCredentialStoreFile + types
//   - loginOpenAICodexDeviceCode + types
//   - runOAuthTlsPreflight + types
//   - createModelCatalog + types
//   - ensureWorkspace / resolveWorkspaceDir
// OAuth token manager runtime stays here because chokidar + pi-ai/oauth deps
// are out of scope for core. The types (OAuthTokenManager, OAuthTokenManagerDeps,
// OAuthError) are duplicated in @comis/core/oauth/oauth-token-manager.ts as
// structurally-equivalent type aliases — production composition (daemon
// setup-agents) constructs the manager from agent's runtime and assigns the
// instance to the core-typed slot.

// Cache eligibility helpers
export { getCacheProviderInfo } from "./executor/cache-usage-helpers.js";
export type { CacheProviderInfo } from "./executor/cache-usage-helpers.js";

// Model scanner
export { createModelScanner } from "./model/model-scanner.js";
export type { ScanResult, ModelScanner, ModelScannerDeps } from "./model/model-scanner.js";

// Ollama capacity probe (boot-time served num_ctx discovery)
// Only probeAllOllamaProviders is consumed cross-package (daemon boot);
// the remaining probe symbols (prewarmOllamaModel et al.) are intra-package
// only — invoked internally by probeAllOllamaProviders, never re-exported.
export { probeAllOllamaProviders } from "./model/ollama-capacity-probe.js";

// Served-window comparator (boot-time served<configured WARN).
// Only compareServedWindowForProvider + the comparison type are consumed
// cross-package (daemon setup-agents wiring); the latch reset is test-only.
export { compareServedWindowForProvider, resetServedWindowWarnForTest, type ServedWindowComparison, type ServedWindowComparisonInput } from "./model/served-window-comparator.js";

// Viable floor (boot-time minViable WARN). collectAgentBootWindowInfo +
// evaluateViableFloorForAgent are consumed cross-package (daemon boot wiring);
// computeMinViableEquation + the drift-pin surface are intra-package/test only.
export { collectAgentBootWindowInfo, evaluateViableFloorForAgent, type AgentBootWindowInfo, type MinViableEquation } from "./context-engine/viable-floor.js";

// OAuth token manager (runtime stays in agent due to chokidar + pi-ai/oauth deps)
export {
  createOAuthTokenManager,
  isValidOAuthEnvSeed,
  oauthEnvSecretKey,
} from "./model/oauth-token-manager.js";

// Per-LLM-call OAuth dispatch helper — shared helper used by PiExecutor.execute()
// pre-hook and the two compaction getApiKey callbacks. Re-exported so the
// integration test can drive the same resolver hook the executor uses.
export { resolveProviderApiKey } from "./model/resolve-provider-api-key.js";
export type { ResolveProviderApiKeyDeps } from "./model/resolve-provider-api-key.js";

// Auth usage tracker
export { createAuthUsageTracker } from "./model/auth-usage-tracker.js";
export type { AuthUsageTracker, ProfileStats, ProfileUsageInput } from "./model/auth-usage-tracker.js";

// Last-known-working model tracker (auth-failure fallback)
export { createLastKnownModelTracker } from "./model/last-known-model.js";
export type { LastKnownModelTracker, LastKnownModelEntry } from "./model/last-known-model.js";

// Routing symbols (router factory, resolver, router type) live in
// @comis/orchestrator. Consumers import from @comis/orchestrator.

// Session lifecycle
export { createSessionLifecycle } from "./session/session-lifecycle.js";
export type { SessionLifecycle, SessionLifecycleOptions } from "./session/session-lifecycle.js";

// Session label store (human-readable session names via metadata.label)
export { createSessionLabelStore } from "./session/session-label-store.js";
export type { SessionLabelStore } from "./session/session-label-store.js";

// Session key builder lives in @comis/orchestrator. The builder + its
// co-located test + dm-scope-integration.test.ts live at
// packages/orchestrator/src/session-key/. Other files in
// packages/agent/src/session/ (lifecycle, write-lock, reset-policy, label-store)
// stay in agent. Consumers (orchestrator/src/inbound/inbound-resolve.ts) use
// the relative orchestrator-internal import path; external consumers import
// from @comis/orchestrator.

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

// Greeting (LLM-powered session greeting for /new and /reset)
export { createGreetingGenerator } from "./greeting/session-greeting.js";
export type { GreetingGenerator, GreetingGeneratorDeps, GreetingTrigger } from "./greeting/session-greeting.js";

// Memory review (periodic session history extraction)
export { runMemoryReview } from "./memory/memory-review-job.js";
export type { MemoryReviewDeps } from "./memory/memory-review-job.js";

// (There is no offline triple-extraction job: the TripleStorePort + its sqlite
// adapter + the graphSpread recall lane (recall-graph-spread-lane.ts) exist
// without a batch extraction writer.)

// (There is no offline usefulness-judge seam: the keyless citation-marker
// attribution is the usefulness signal; the recordUsage reward write lives in
// the daemon's setup-learning.ts, a separate seam.)

// Query-time dialectic synthesis seam (the ONE allowed query-time LLM
// surface). The factory the daemon `memory.ask` handler calls to BUILD the
// synthesize() seam from a cheap resolved model (the daemon injects it), keeping DIALECTIC_PROMPT
// + its lenient/total parser agent-internal (mirrors createUserRepresentationSeam). The seam
// is the only LLM; the pure trust-first/abstain/citation helpers + the prompt/parser have no
// model call. Consumed by the daemon memory.ask handler — a temporary orphan until
// that lands (tracked in public-api-policy.ts).
export { createDialecticSeam } from "./memory/memory-dialectic-seam.js";
export type { DialecticSeamDeps } from "./memory/memory-dialectic-seam.js";
export type { DialecticParsed } from "./memory/memory-dialectic-prompt.js";

// The PURE dialectic synthesis helpers. Consumed by the
// daemon memory.ask handler: orderByTrust (HARD trust-first ordering of the recall
// grounding), assembleSynthesis (abstain-in-code + citations⊆recalled-ids → the response), and
// citationChains (the citation→recalled-id→sourceId reasoning-tree for the recall-trace).
// No model — the seam above is the only LLM. Only the VALUE helpers are exported; their return
// shapes (AssembledSynthesis/CitationChain/ParsedSynthesis) are inferred at the consumer and
// kept module-internal (no unconsumed type surface on the public barrel).
export { orderByTrust, assembleSynthesis, citationChains } from "./memory/memory-dialectic-synthesis.js";

// RAG (Retrieval-Augmented Generation)
export { formatMemorySection } from "./rag/rag-retriever.js";

// Queue symbols live in @comis/orchestrator:
// createCommandQueue, CommandQueue, DebounceBuffer, FollowupTrigger,
// coalesceMessages, applyOverflowPolicy, SessionLane, and all related *Deps / *Stats types
// live at packages/orchestrator/src/queue/ and re-export from @comis/orchestrator.

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
  BootstrapContextFile,
  AssemblerParams,
  SystemPromptBlocks,
  ToolDescriptionContext,
} from "./bootstrap/index.js";

// Commands (slash command parser & handler) live in @comis/orchestrator.
// Consumers import from @comis/orchestrator.

// Workspace public API lives in @comis/core. The agent-internal workspace/
// subdir is retained because agent internals (bootstrap-loader, executor, etc.)
// consume it via relative paths; only the public barrel re-exports are deleted
// here. One holdover: isHeartbeatContentEffectivelyEmpty is consumed by daemon
// heartbeat code via the agent barrel (it sits next to the workspace helpers
// as a workspace-state probe).
export { isHeartbeatContentEffectivelyEmpty } from "./workspace/index.js";
export { createFilesystemWorkspacePolicyAdapter } from "./workspace/index.js";

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
export { createPiExecutor } from "./executor/pi-executor/index.js";
export type { PiExecutorDeps } from "./executor/pi-executor/index.js";

// ExecutionPlanPort holder — the composition root builds the holder,
// threads it into bootstrapSession's ctx so SEP publishes the live per-turn
// plan ref, and hands the SAME holder to the gateway as
// AcpServerDeps.executionPlanPort (it IS a @comis/core ExecutionPlanPort).
// The gateway never imports @comis/agent — it receives the bound port typed
// from @comis/core (mirrors the activityStreamPort injection seam).
export { createExecutionPlanHolder } from "./executor/pi-executor/execution-plan-holder.js";
export type { ExecutionPlanHolder } from "./executor/pi-executor/execution-plan-holder.js";

// Wire session:expired to clearSession functions
export { clearSessionState, wireSessionStateCleanup } from "./executor/session-snapshot-cleanup.js";

// Sub-agent cache prefix sharing -- parent CacheSafeParams reader for setup-cross-session
export { getCacheSafeParams } from "./executor/prompt-assembly.js";
export type { CacheSafeParams } from "./executor/prompt-assembly.js";

// Recall-trace recorder wiring. Exported so the
// recall-diagnostics capstone can drive the REAL production recorder path
// (envelope + dataDir-derived confinedBaseDir) rather than a hand-written
// fixture, closing the read-path gap end-to-end.
export { buildRecallTrace } from "./executor/prompt-assembly.js";

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
export type { StreamFnWrapper, ConfigResolverConfig, RequestBodyInjectorConfig, ApiPayloadTraceConfig, TruncationSummary, ToolResultSizeBouncerResult } from "./executor/stream-wrappers/index.js";
export { composeStreamWrappers, createConfigResolver, createRequestBodyInjector, createApiPayloadTraceWriter, createToolResultSizeBouncer, clearSessionRenderedToolCache } from "./executor/stream-wrappers/index.js";

// Active run registry (tracks running sessions for mid-stream steering)
export { createActiveRunRegistry } from "./executor/active-run-registry.js";
export type { ActiveRunRegistry, RunHandle } from "./executor/active-run-registry.js";

// Cache break detection
export { clearCacheBreakDetectorSession, extractGeminiPromptState } from "./executor/cache-detection/index.js";
export type { CacheBreakDetector, CacheBreakEvent, CacheBreakReason, RecordPromptStateInput, CheckCacheBreakInput, PendingChanges, PromptStateSnapshot } from "./executor/cache-detection/index.js";

// Cache break diff writer
export { createCacheBreakDiffWriter } from "./executor/cache-break-diff-writer.js";
export type { CacheBreakDiffWriterConfig, CacheBreakDiffPayload } from "./executor/cache-break-diff-writer.js";

// Gemini cache injector
export { createGeminiCacheInjector } from "./executor/gemini-cache-injector.js";
export type { GeminiCacheInjectorConfig } from "./executor/gemini-cache-injector.js";

// Gemini cache manager
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
// BoundedAutonomyBudgetPort is intentionally NOT exported — it is the internal shape
// of BoundedAutonomyBudgetHolder.current (the only cross-package consumer is the holder).
export type { PiEventBridgeDeps, PiEventBridgeResult, BoundedAutonomyBudgetHolder } from "./bridge/pi-event-bridge.js";

// ---------------------------------------------------------------------------
// Adapters (re-export for daemon wiring convenience)
// ---------------------------------------------------------------------------

// Credential store adapter (SecretManager to pi-ai CredentialStore)
export {
  ComisCredentialStore,
  createAuthStorageAdapter,
  getMissingProviderCredentialNames,
  getProviderSecretNames,
  PROVIDER_SECRET_KEYS,
  syncCredentialsForSecretChange,
} from "./model/auth-storage-adapter.js";
export type { AuthStorage, AuthStorageAdapterOptions } from "./model/auth-storage-adapter.js";

// Model registry adapter (ModelRegistry creation + initial model resolution)
export { createModelRegistryAdapter, registerCustomProviders, resolveInitialModel, normalizeOpenAICompatBaseUrl } from "./model/model-registry-adapter.js";
export type { CustomProviderRegistration, CustomProviderLogger, RegisterCustomProvidersResult, ModelRegistryAdapter } from "./model/model-registry-adapter.js";

// Session key mapper (SessionKey to/from filesystem path)
export {
  INBOUND_MESSAGE_LEDGER_SUFFIX,
  inboundMessageLedgerPathToSessionKey,
  pathToSessionKey,
  sessionKeyToPath,
} from "./session/session-key-mapper.js";
export type {
  InboundMessageProvenancePlan,
} from "./session/inbound-message-provenance.js";
export { isSyntheticSessionUserMessage } from "./session/synthetic-user-messages.js";

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
export {
  createHybridMemoryInjector,
  stripInlineRecalledMemory,
} from "./rag/hybrid-memory-injector.js";
export type { HybridMemoryInjector, HybridMemoryInjection } from "./rag/hybrid-memory-injector.js";
export { createMemoryRecall } from "./rag/memory-recall.js";
export type { MemoryRecall, MemoryRecallDeps, MemoryRecallConfig } from "./rag/memory-recall.js";

// Schema normalizer (strip unsupported JSON Schema keywords per provider)
export { normalizeToolSchema, PROVIDER_UNSUPPORTED_KEYWORDS } from "./safety/tool-schema-safety.js";
export type { NormalizedSchema, ProviderName } from "./safety/tool-schema-safety.js";

// Tool schema normalization pipeline (4-layer per-provider normalization)
export { normalizeToolSchemasForProvider, setToolNormalizationLogger } from "./provider/tool-schema/normalize.js";
export type { ToolNormalizationContext } from "./provider/tool-schema/normalize.js";
export { cleanSchemaForGemini } from "./provider/tool-schema/clean-for-gemini.js";
export { stripXaiUnsupportedKeywords } from "./provider/tool-schema/clean-for-xai.js";

// Schema pruning (strip optional param descriptions for small models)
export { pruneSchemaDescriptions, pruneToolSchemas } from "./safety/tool-schema-safety.js";
export type { PruneResult, PruneToolsResult } from "./safety/tool-schema-safety.js";

// Spawn (SpawnPacketBuilder + parent summary + result condensation + sub-agent lifecycle)
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
export { createSubAgentRunner } from "./spawn/index.js";
export type { SubAgentRunnerDeps, SubAgentRun, SpawnParams, SubAgentRunnerLogger } from "./spawn/index.js";
export { sweepResultFiles, buildAnnouncementMessage, deliverFailureNotification } from "./spawn/index.js";
export { createDeliveryDedup } from "./spawn/index.js";
export type { DeliveryDedup } from "./spawn/index.js";
export { comparePosture, resolvePostureFromSkills } from "./spawn/index.js";
export type {
  SandboxPosture,
  PostureDimension,
  PostureComparison,
  SkillsPostureSlice,
} from "./spawn/index.js";

// Context engine
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

// Shared token-estimation ratio (non-DAG; consumed by tool-schema-safety.ts,
// executor-tool-assembly.ts, et al.)
export { CHARS_PER_TOKEN_RATIO } from "./context-engine/index.js";

// Provider capabilities
export {
  DEFAULTS as PROVIDER_CAPABILITY_DEFAULTS,
  resolveProviderCapabilities,
  normalizeProviderId,
  isAnthropicFamily,
  isOpenAiFamily,
  shouldDropThinkingBlocks,
  resolveToolCallIdMode,
  validateProviderOverrides,
} from "./provider/capabilities.js";
export type { ProviderOverridesValidatorLogger } from "./provider/capabilities.js";

// Model compatibility auto-detection (xAI compat flags)
export { normalizeModelCompat } from "./provider/model-compat.js";

// Model ID normalization
export { normalizeModelId } from "./provider/model-id-normalize.js";
export type { ModelIdNormalizationResult } from "./provider/model-id-normalize.js";

// Response sanitization pipeline
export { sanitizeAssistantResponse, setSanitizeLogger, extractFinalTagContent } from "./provider/response/sanitize-pipeline.js";
export type { SanitizeOptions } from "./provider/response/sanitize-pipeline.js";

// Response filter utilities (used by ThinkingTagFilter)
export { stripReasoningTagsFromText } from "./response-filter/reasoning-tags.js";
export { findCodeRegions, isInsideCode } from "./response-filter/code-regions.js";
export type { CodeRegion } from "./response-filter/code-regions.js";

// Thinking tag filter
export { createThinkingTagFilter } from "./response-filter/thinking-tag-filter.js";
export type { ThinkingTagFilter, ThinkingTagFilterOptions } from "./response-filter/thinking-tag-filter.js";

// Operation model resolver
export { resolveOperationModel, resolveProviderFamily } from "./model/operation-model-resolver.js";
export type { OperationModelResolution } from "./model/operation-model-resolver.js";

// ModelProfile resolver — the immutable capability/capacity profile. Exported so
// the daemon wiring derives the memory-job capabilityClass the SAME way
// pi-executor does per-execution (any parallel derivation silently drifts from
// what actually runs). Only
// the resolver + CapabilityClass type cross the package boundary; the memory jobs
// (also in @comis/agent) own the resolveMemoryOpsStrategy call internally.
export { resolveModelProfile, capabilityClassFromProvider, resolveEffectiveCapabilityClass, autoRepairForClass } from "./executor/model-profile.js";
export type { CapabilityClass } from "./executor/model-profile.js";
// Canonical DAG template seeding. seedDefaultDagTemplates is wired
// into daemon bootstrap (idempotent INSERT-OR-IGNORE) so the four canonical
// small-model templates exist in the named-graph store at startup.
export { seedDefaultDagTemplates } from "./executor/dag-templates.js";
// The deterministic, conservative repair matcher. INJECTED into the daemon's buildGraphInput via
// deps.repairMatch (rpc-dispatch composition site) — the daemon never imports
// dag-templates directly. fillDagTemplate / CANONICAL_DAG_TEMPLATES stay
// package-internal (the matcher is the only weak-model repair consumer; it fills
// internally), so only the matcher fn + its result types cross the boundary.
export { matchRawGraphToTemplate } from "./executor/dag-template-match.js";
export type { TemplateMatch, CanonicalTemplatePattern } from "./executor/dag-template-match.js";
// The deterministic intent → ExecutionGraph
// synthesizer. Imported by the pipeline tool's from_intent action (@comis/skills)
// — it RETURNS a validated graph, never executes one; the tool dispatches it
// through the existing graph.execute path so governance applies automatically.
export { synthesizeFromIntent } from "./executor/dag-synthesizer.js";
// SynthesisPattern is consumed by the from_intent tool action (@comis/skills);
// SynthesisIntent stays module-local (the tool builds the intent inline) — no
// cross-package consumer, so it is NOT re-exported from the barrel.
export type { SynthesisPattern } from "./executor/dag-synthesizer.js";
export { resolveOperationDefaults, OPERATION_TIER_MAP, OPERATION_TIMEOUT_DEFAULTS, OPERATION_CACHE_DEFAULTS } from "./model/operation-model-defaults.js";
export { resolveCompactionModel } from "./model/compaction-model-resolver.js";

// SessionLatch utility
export { createSessionLatch } from "./executor/session-latch.js";
export type { SessionLatch } from "./executor/session-latch.js";

// Background task infrastructure
export * from "./background/index.js";

// Correction-detector seam. The cost-gated
// `fast`-tier detector the daemon constructs (setup-learning-reactions
// buildReactionWiringDeps) ONLY when `learningOutcome.correction.enabled` is opted
// in, then runs over a follow-up user turn → a `corrected`/`correction` soft-
// failure verdict. Re-exported from the memory sub-barrel beside its
// daemon consumer so the public-export-consumers gate never sees an
// orphan. The prompt + triple-bound (wrap + reward-cap + strip-parse) stay
// agent-internal.
export { createCorrectionDetectorSeam } from "./memory/index.js";
export type { CorrectionVerdict } from "./memory/index.js";

// The cost-gated LLM outcome-judge
// seam the daemon constructs on the `outcomeJudge` fast tier as the FALLBACK source
// for a CONVERSATIONAL turn (an `unknown` deterministic resolve). Re-exported beside
// its daemon consumer (setup-learning-reactions wiring) so the public-export-consumers
// gate never sees an orphan. The prompt + triple-bound + the reward cap stay
// agent-internal (the daemon `observe()`s the seam's already-capped `cappedConfidence`).
export { createOutcomeJudgeSeam } from "./memory/index.js";
export type { OutcomeVerdict } from "./memory/index.js";
// CustomCompletionsModelSpec is consumed by the daemon's judge resolvers;
// resolveJudgeModel stays package-internal (the seams import it relatively).
export type { CustomCompletionsModelSpec } from "./memory/index.js";

// The one-shot orchestrate repair seam the daemon mints (in buildAutonomyToolWiring)
// on a repair-eligible capability class and injects into the orchestrate runner:
// ONE bounded utility-model re-prompt regenerates a failed script for exactly one
// re-run. Built on the SAME resolveJudgeModel+completeSimple machinery as the
// outcome-judge seam so @comis/skills consumes only the injected closure and never
// imports the model layer — resolveJudgeModel stays package-internal; the FACTORY
// (+ its closure/deps types) is the export.
export { createOrchestrateRepairSeam } from "./memory/index.js";
export type { OrchestrateRepairSeam, OrchestrateRepairSeamDeps } from "./memory/index.js";

// Reflection engine. The
// reflection JOB (runReflection) + the cheap-model reflect adapter + the
// prompt/parser the daemon invokes from the __REFLECT__ cron: SELECT
// trusted-origin success → group-by-topicKey → ≥2-distinct corroboration gate →
// delta-ops reflect → validateLearnedDocBody guard → admit at candidate/learned.
// Consumes @comis/core PORT TYPES + the static guard + the pure delta-ops only
// (the agent↛memory / agent↛skills cut); the daemon injects the store + adapter.
// Re-exported from the memory sub-barrel beside its daemon consumer so
// the public-export-consumers gate never sees an orphan.
export { createLlmReflectionAdapter, runReflection, classifyReflectOutcome } from "./memory/index.js";
// The per-kind reflect prompts the daemon `__REFLECT__` cron injects as the adapter
// `systemPrompt`: REFLECT_PROMPT (skill default), PROFILE_REFLECT_PROMPT,
// TOPIC_REFLECT_PROMPT, PROCEDURE_REFLECT_PROMPT. One engine, varied per-kind prompt.
export { REFLECT_PROMPT, PROFILE_REFLECT_PROMPT, TOPIC_REFLECT_PROMPT, PROCEDURE_REFLECT_PROMPT } from "./memory/index.js";
export type {
  LlmReflectionAdapterDeps,
  ReflectionAdapter,
  ReflectInput,
  ReflectionResult,
  RunReflectionDeps,
  RunReflectionResult,
  RunReflectionConfig,
  ReflectionSourceTrajectory,
  ReflectAdmissionOutcome,
} from "./memory/index.js";
