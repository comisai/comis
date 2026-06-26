// SPDX-License-Identifier: Apache-2.0
/**
 * Documented external-API surface + baseline orphan-export tracking.
 *
 * Two categories of entries live here:
 *
 * 1. EXTERNAL-API entries:
 *    `@comis/cli` exposes three entrypoints intended for embedding code:
 *      - `withClient` -- daemon-RPC connection helper for embedding code.
 *      - `credentialsStep` -- wizard step exposed for embed-and-extend.
 *      - `RpcClient` -- direct RPC handle for advanced consumers.
 *
 * 2. BASELINE orphan-export entries:
 *    Symbols re-exported from packages/<pkg>/src/index.ts that have NO
 *    in-repo consumer at the current baseline. These are tracked here
 *    because the public-export-consumers.test.ts gate would otherwise
 *    fire on them on every PR. The baseline is shrink-only by convention
 *    — entries should be removed as the corresponding export is removed
 *    from the package index.ts OR a real in-repo consumer is added.
 *
 *    Note: re-exports flowing through `export * from` chains in core/src/
 *    index.ts are followed transitively, so the core baseline counts every
 *    transitively-re-exported symbol.
 *
 * Format: package-name -> set of exported symbol names.
 *
 * @module
 */

export const PUBLIC_API_POLICY: ReadonlyMap<string, ReadonlySet<string>> =
  new Map<string, ReadonlySet<string>>([
    // @comis/agent: baseline orphans tracked here (SessionLifecycleOptions remains — no in-repo consumer yet).
    ["@comis/agent", new Set<string>([
      "ExecutionResult",
      "ExecutionOverrides",
      "StepCounter",
      "CircuitBreaker",
      "CircuitState",
      "createToolRetryBreaker",
      "ToolRetryBreaker",
      "ToolRetryVerdict",
      "ToolRetryBreakerConfig",
      "INSTRUCTION_PATTERNS",
      "createToolDisplayNames",
      "ToolDisplayNames",
      "createToolImageSanitizer",
      "ToolImageSanitizer",
      "ImageSanitizeOptions",
      "SanitizeResult",
      "createContextWindowGuard",
      "ContextWindowGuard",
      "ContextWindowStatus",
      "ContextWindowGuardOptions",
      "createToolResultSizeGuard",
      "ToolResultSizeGuard",
      "TruncationMetadata",
      "ToolResultSizeGuardOptions",
      "estimateMessageChars",
      "estimateContextChars",
      "estimateMessageTokens",
      "estimateContextTokens",
      "CHARS_PER_TOKEN",
      "IMAGE_TOKEN_ESTIMATE",
      "OverflowRecoveryConfig",
      "OverflowRecoveryResult",
      "createOverflowRecovery",
      "createOverflowRecoveryWrapper",
      "BudgetError",
      "BudgetGuard",
      "BudgetSnapshot",
      "UsageInput",
      "createTurnBudgetTracker",
      "TurnBudgetTracker",
      "TurnBudgetDecision",
      "TurnBudgetStopReason",
      "AuthProvider",
      "AuthProviderConfig",
      "AuthProfileManager",
      "AuthProfile",
      "OrderingStrategy",
      "AuthRotationAdapter",
      "AuthRotationAdapterOptions",
      "resolveModelForMessage",
      "createImageFallbackChain",
      "ImageRouterParams",
      "ImageRouterResult",
      "ImageFallbackChain",
      "ImageFallbackChainConfig",
      "createModelAllowlist",
      "ModelAllowlist",
      "createContextWindowResolver",
      "ContextWindowResolver",
      "ContextWindowResolverDeps",
      "resolveModelPricing",
      "ZERO_COST",
      "PerTokenCostRates",
      "getCacheProviderInfo",
      "CacheProviderInfo",
      "createModelScanner",
      "ScanResult",
      "ModelScanner",
      "ModelScannerDeps",
      "createOAuthTokenManager",
      "OAuthTokenManager",
      "OAuthTokenManagerDeps",
      "resolveProviderApiKey",
      "ResolveProviderApiKeyDeps",
      // decodeCodexJwtPayload, resolveCodexStableSubject,
      // resolveCodexAccessTokenExpiry, OAuthErrorCode, RewrittenOAuthError
      // moved to @comis/core/src/security/oauth-helpers.ts and are tracked
      // under "@comis/core" below.
      "createOAuthCredentialStoreFile",
      "OAuthCredentialStoreFileConfig",
      "SelectOAuthCredentialStoreInput",
      "OAuthStorageMode",
      "IsRemoteEnvironmentInput",
      "LoginError",
      "LoginRunnerSuccess",
      "LoginRunnerParams",
      "RunnerPrompter",
      "loginOpenAICodexDeviceCode",
      "DeviceCodeVerificationPrompt",
      "LoginOpenAICodexDeviceCodeOptions",
      "TlsPreflightResult",
      "TlsPreflightFailureKind",
      "RunOAuthTlsPreflightOptions",
      "createAuthUsageTracker",
      "AuthUsageTracker",
      "ProfileStats",
      "ProfileUsageInput",
      "LastKnownModelEntry",
      // resolveAgent moved from @comis/agent to @comis/orchestrator alongside
      // createMessageRouter and the MessageRouter type. No baseline entry in
      // @comis/orchestrator (createMessageRouter has setup-channels.ts as
      // in-repo consumer, and MessageRouter has channel-manager.ts +
      // inbound-pipeline.ts as in-repo consumers via the orchestrator-internal
      // relative import). resolveAgent is also without an in-repo consumer
      // post-move, but the public-export-consumers gate is the source of
      // truth — if it surfaces an orphan, re-add to the @comis/orchestrator
      // policy entry.
      "SessionLifecycleOptions",
      "createSessionLabelStore",
      // SessionLabelStore type: pair of createSessionLabelStore (already in this
      // baseline). The only in-repo consumer (ChannelManagerDeps.sessionLabelStore
      // field) was deleted alongside 10 other unwired deps fields. Pair the type
      // and factory in the baseline until a future cleanup removes both as a
      // unit (separate dead-module cleanup).
      "SessionLabelStore",
      "ScopedSessionKeyParams",
      "withSessionLock",
      "LockedSessionStoreOptions",
      "classifySession",
      "resolvePolicy",
      "isDailyResetDue",
      "isIdleResetDue",
      "checkReset",
      "SessionResetSchedulerDeps",
      "SessionKind",
      "EffectiveResetPolicy",
      "loadIdentityFiles",
      "IdentityFiles",
      "createIdentityUpdater",
      "IdentityUpdater",
      "PendingUpdate",
      "GreetingGeneratorDeps",
      "MemoryReviewDeps",
      // Consolidation job Deps. runMemoryConsolidation is consumed by the
      // daemon (setup-channels-credentials __MEMORY_CONSOLIDATION__ sentinel),
      // but it is called with an inline object, so the named Deps SHAPE type has no
      // production consumer — baseline orphan (mirror MemoryReviewDeps).
      "MemoryConsolidationDeps",
      // Offline triple-extraction job.
      // runMemoryTripleExtraction is the offline writer; its daemon cron wiring is
      // OPTIONAL (the job is default-OFF and the benchmark calls
      // runMemoryTripleExtraction directly / seeds via tripleStore.upsertTriple).
      // Surfaced here AHEAD of that consumer — the factory-orphan dance (mirror
      // runMemoryConsolidation before its sentinel landed): this entry
      // SHRINKS when a cron-wiring plan lands the consumer.
      // The Deps/Config/Stats SHAPE types + the TripleCandidate extractor-output type
      // are referenced via inline objects only — baseline orphans (mirror MemoryConsolidationDeps).
      "runMemoryTripleExtraction",
      "MemoryTripleExtractionDeps",
      "MemoryTripleExtractionConfig",
      "MemoryTripleExtractionStats",
      "TripleCandidate",
      // Offline reasoning job. runMemoryReasoning
      // is now CONSUMED by the daemon __MEMORY_REASONING__ sentinel dispatch,
      // so it SHRANK out of this baseline (no longer an orphan). createReasoningSeam
      // (the daemon-injected reason() seam factory) is likewise consumed by the
      // dispatch — no entry needed. The Deps/Config/Stats/Result SHAPE types + the
      // ReasoningOutput seam-output type are referenced via inline objects only (the
      // dispatch + the gated bench construct them structurally / import them
      // same-package) — baseline orphans (mirror MemoryTripleExtractionDeps).
      // ReasoningSeamDeps is the createReasoningSeam input shape — the daemon
      // calls it with an inline object, so the TYPE itself has no cross-package importer.
      "MemoryReasoningDeps",
      "MemoryReasoningConfig",
      "MemoryReasoningStats",
      "MemoryReasoningResult",
      "ReasoningOutput",
      "ReasoningSeamDeps",
      // Offline per-user representation builder.
      // runUserRepresentationBuild is now CONSUMED by the daemon __USER_REPRESENTATION__
      // cron-sentinel dispatch, so it SHRANK out of this baseline (no longer an
      // orphan). createUserRepresentationSeam (the daemon-injected build() seam factory) is
      // consumed by the dispatch too. buildUserRepresentationPrompt + parseUserRepresentationOutput
      // are imported by createUserRepresentationSeam via the RELATIVE same-package path (the prompt
      // stays agent-internal), so their @comis/agent index re-exports have no cross-package importer
      // — baseline orphans (mirror DEDUCTIVE_PROMPT/parseDeductiveResult being relative-only). The
      // Deps/Config/Stats/Result SHAPE types + the Candidate/BuildOutput seam-output types + the
      // SourceMemory read-shape are referenced via inline objects only (the dispatch + the gated
      // bench construct them structurally) — baseline orphans (mirror MemoryReasoningDeps).
      // UserRepresentationSeamDeps (the createUserRepresentationSeam input shape) is called with an
      // inline object, so the TYPE itself has no cross-package importer (mirror ReasoningSeamDeps).
      "buildUserRepresentationPrompt",
      "parseUserRepresentationOutput",
      "MemoryUserRepresentationDeps",
      "MemoryUserRepresentationConfig",
      "MemoryUserRepresentationStats",
      "MemoryUserRepresentationResult",
      "UserRepresentationSourceMemory",
      "UserRepresentationCandidate",
      "UserRepresentationBuildOutput",
      "UserRepresentationSeamDeps",
      // Offline directional relationship builder.
      // SHRUNK: the offline-builder run-fn + the cheap-model seam-factory are now CONSUMED
      // by the daemon __SOCIAL_MODELING__ cron dispatch (setup-channels-memory-crons.ts), so they
      // were REMOVED from this list (the shrink — mirror the per-user-representation builder/seam
      // shrink; allowlist-shrink enforces shrink-only). buildRelationshipPrompt +
      // parseRelationshipOutput are imported by the seam via the RELATIVE same-package path (the
      // prompt stays agent-internal), so their @comis/agent index re-exports have no cross-package
      // importer — baseline orphans (mirror buildUserRepresentationPrompt above). The
      // Deps/Config/Stats/Result SHAPE types + the Candidate/BuildOutput seam-output types + the
      // SourceMemory read-shape are referenced via inline objects only — baseline orphans (mirror
      // MemoryUserRepresentationDeps). RelationshipSeamDeps (the seam-factory input shape) is called
      // with an inline object, so the TYPE itself has no cross-package importer.
      "buildRelationshipPrompt",
      "parseRelationshipOutput",
      "MemoryRelationshipDeps",
      "MemoryRelationshipConfig",
      "MemoryRelationshipStats",
      "MemoryRelationshipResult",
      "RelationshipSourceMemory",
      "RelationshipCandidate",
      "RelationshipBuildOutput",
      "RelationshipSeamDeps",
      // Offline tuned-alpha bandit. SHRUNK:
      // runOnlineTuning is now CONSUMED by the daemon __ONLINE_TUNING__ cron-sentinel dispatch
      // (setup-channels-memory-crons.ts), so it was REMOVED from this list (the interface-first
      // cross-task seam shrink — the builder-shrink precedent; allowlist-shrink
      // enforces shrink-only). The Deps/Config/Stats/Result SHAPE types + the Baseline read-shape
      // are referenced via inline objects only (the dispatch constructs them structurally) —
      // baseline orphans (mirror MemoryUserRepresentationDeps). OnlineTuningFeedEntry IS imported
      // by the dispatch (the readUsefulness seam's Map value type) so it is NOT an orphan. The
      // PURE computeTunedAlphas + buildScoringAlphas are agent-INTERNAL (no public barrel export
      // → no orphan churn).
      "MemoryOnlineTuningDeps",
      "MemoryOnlineTuningConfig",
      "MemoryOnlineTuningStats",
      "MemoryOnlineTuningResult",
      "OnlineTuningBaselineAlphas",
      // (The createDialecticSeam / DialecticSeamDeps / DialecticParsed
      //  ahead-of-consumer orphans were REMOVED here — setup-dialectic.ts now
      //  NAME-imports all three in non-test daemon wiring [the seam factory build + the
      //  DialecticSeamDeps annotation + the DialecticParsed return type], so the
      //  public-export-consumers walker sees real consumers. Mirrors createUserRepresentationSeam
      //  once it was consumed.)
      "formatMemorySection",
      "CommandQueueDeps",
      "QueueStats",
      "SessionLane",
      "applyOverflowPolicy",
      "OverflowResult",
      "coalesceMessages",
      "createDebounceBuffer",
      "DebounceBufferDeps",
      "createFollowupTrigger",
      "FollowupTriggerDeps",
      "loadWorkspaceBootstrapFiles",
      "truncateFileContent",
      "filterBootstrapFilesForSubAgent",
      "filterBootstrapFilesForLightContext",
      "filterBootstrapFilesForGroupChat",
      "buildBootstrapContextFiles",
      "assembleRichSystemPrompt",
      "TOOL_SUMMARIES",
      "TOOL_ORDER",
      "BootstrapFile",
      "TruncationResult",
      "PromptMode",
      "RuntimeInfo",
      "BootstrapContextFile",
      "AssemblerParams",
      "SystemPromptBlocks",
      "CommandType",
      "ParsedCommand",
      "CommandResult",
      "CommandHandler",
      "detectSkillCollisions",
      "RESERVED_COMMAND_NAMES",
      "PromptSkillMatch",
      "CollisionWarning",
      "PromptSkillDirective",
      "WorkspaceFiles",
      "EnsureWorkspaceOptions",
      "WorkspaceStatus",
      "WorkspaceSeedTracker",
      "RegisterWorkspaceResult",
      "FileStateTrackerLike",
      "CreateFileStateTrackerFn",
      "wrapInEnvelope",
      "formatElapsed",
      "PiExecutorDeps",
      // createExecutionPlanHolder + ExecutionPlanHolder are NO LONGER
      // orphans: the composition root is now wired. The
      // daemon's setup-acp-wiring.ts now imports createExecutionPlanHolder from
      // @comis/agent (and the ExecutionPlanHolder type) to build the one shared
      // holder threaded into both PiExecutorDeps.executionPlanHolder and the
      // gateway's AcpServerDeps.executionPlanPort. Both entries removed here
      // (the public-export-consumers gate now finds the real in-repo consumer).
      "clearSessionState",
      "CacheSafeParams",
      "cleanupServerFromAllTrackers",
      "cleanupToolsFromAllTrackers",
      "withPromptTimeout",
      "withResettablePromptTimeout",
      "PromptTimeoutError",
      "ResettableTimeout",
      "classifyPromptTimeout",
      "ErrorCategory",
      "ClassifiedError",
      "StreamFnWrapper",
      "ConfigResolverConfig",
      "RequestBodyInjectorConfig",
      "ApiPayloadTraceConfig",
      "TruncationSummary",
      "ToolResultSizeBouncerResult",
      "composeStreamWrappers",
      "createConfigResolver",
      "createRequestBodyInjector",
      "createApiPayloadTraceWriter",
      "createToolResultSizeBouncer",
      "clearSessionRenderedToolCache",
      "RunHandle",
      "clearCacheBreakDetectorSession",
      "extractGeminiPromptState",
      "CacheBreakDetector",
      "CacheBreakEvent",
      "CacheBreakReason",
      "RecordPromptStateInput",
      "CheckCacheBreakInput",
      "PendingChanges",
      "PromptStateSnapshot",
      "CacheBreakDiffWriterConfig",
      "CacheBreakDiffPayload",
      "createGeminiCacheInjector",
      "GeminiCacheInjectorConfig",
      "computeCacheContentHash",
      "GeminiCacheManagerConfig",
      "CacheEntry",
      "CacheRequest",
      "ComisSessionManager",
      "ComisSessionManagerDeps",
      "SessionStats",
      "SessionMetadata",
      "sanitizeSessionSecrets",
      "repairOrphanedMessages",
      "scrubPoisonedThinkingBlocks",
      "ScrubResult",
      "scrubRedactedToolCalls",
      "RedactedScrubResult",
      "createPiEventBridge",
      "PiEventBridgeDeps",
      "PiEventBridgeResult",
      "AuthStorageAdapterOptions",
      "resolveInitialModel",
      "CustomProviderRegistration",
      "CustomProviderLogger",
      "RegisterCustomProvidersResult",
      "pathToSessionKey",
      "detectBrokenFollowThrough",
      "FOLLOW_THROUGH_PATTERNS",
      "FollowThroughResult",
      "buildPostCompactionSafetyMessage",
      "POST_COMPACTION_SAFETY_RULES",
      "isContextOverflowError",
      "truncateContextForRecovery",
      "ContextTruncationResult",
      "createHybridMemoryInjector",
      "HybridMemoryInjector",
      "HybridMemoryInjection",
      // Recall orchestrator. Consumed internally by prompt-assembly via a
      // direct relative import; exported for the eval harness + external
      // recall composition. Baseline orphan until the eval harness lands its consumer.
      "createMemoryRecall",
      "MemoryRecall",
      "MemoryRecallDeps",
      "MemoryRecallConfig",
      "normalizeToolSchema",
      "normalizeToolSchemas",
      "PROVIDER_UNSUPPORTED_KEYWORDS",
      "NormalizedSchema",
      "ProviderName",
      "normalizeToolSchemasForProvider",
      "ToolNormalizationContext",
      "cleanSchemaForGemini",
      "stripXaiUnsupportedKeywords",
      "pruneSchemaDescriptions",
      "pruneToolSchemas",
      "PruneResult",
      "PruneToolsResult",
      "SpawnPacketBuilderDeps",
      "SpawnPacketBuildParams",
      "GenerateParentSummaryDeps",
      "ResultCondenserDeps",
      "CondenseParams",
      "NarrativeCasterConfig",
      "CastParams",
      "deriveSubagentContextEngineConfig",
      "LifecycleHooksDeps",
      "createContextEngine",
      "createThinkingBlockCleaner",
      "computeTokenBudget",
      "ContextEngine",
      "ContextEngineDeps",
      "ContextLayer",
      "TokenBudget",
      "ContextEngineMetrics",
      "AssembledContext",
      "LayerCircuitBreaker",
      "CHARS_PER_TOKEN_RATIO",
      "PROVIDER_CAPABILITY_DEFAULTS",
      "resolveProviderCapabilities",
      "normalizeProviderId",
      "isAnthropicFamily",
      "isOpenAiFamily",
      "shouldDropThinkingBlocks",
      "resolveToolCallIdMode",
      "ProviderOverridesValidatorLogger",
      "normalizeModelCompat",
      "normalizeModelId",
      "ModelIdNormalizationResult",
      "SanitizeOptions",
      "stripReasoningTagsFromText",
      "findCodeRegions",
      "isInsideCode",
      "CodeRegion",
      "ThinkingTagFilter",
      "ThinkingTagFilterOptions",
      "OperationModelResolution",
      "OPERATION_TIMEOUT_DEFAULTS",
      "OPERATION_CACHE_DEFAULTS",
      "createSessionLatch",
      "SessionLatch",
      "BackgroundTask",
      "BackgroundTaskStatus",
      "BackgroundSessionState",
      "PersistedTaskState",
      "BackgroundTaskNotificationPolicyType",
      "BackgroundTaskOrigin",
      "persistTaskSync",
      "loadTask",
      "recoverTasks",
      "removeTaskFile",
      "BackgroundTaskManagerOpts",
      "wrapToolForAutoBackground",
      "ToolDefinition",
      "formatCompletionAnnouncement",
      "TRAILING_INSTRUCTION",
      "BackgroundCompletionRunnerDeps",
      "STATES",
      "BackgroundTaskNotificationPolicy",
      "CompletionDispatcherDeps",
      "DispatcherSessionStore",
      "DispatcherTaskManager",
      "ActiveSessionKey",
      "BackgroundSessionResolverDeps",
      // Sub-agent runtime moved from packages/daemon/src/ to
      // packages/agent/src/spawn/. The 7 entries below are the move's type
      // and helper exports that have no in-repo consumer at the moment
      // (the moved tests/integration coverage import via the local file
      // path, not via @comis/agent). createSubAgentRunner and
      // ANNOUNCE_PARENT_TIMEOUT_MS are NOT listed because they DO have
      // in-repo consumers (wiring/setup-cross-session.ts and
      // graph/graph-completion.ts respectively).
      "SubAgentRunnerDeps",
      "SubAgentRun",
      "SpawnParams",
      "SubAgentRunnerLogger",
      "sweepResultFiles",
      "buildAnnouncementMessage",
      "deliverFailureNotification",
      // buildRecallTrace: consumed by the
      // recall-diagnostics-isolation integration test (the e2e
      // redaction proof + the cross-scope-leak negative drive the real
      // recorder through the @comis/agent barrel — see
      // test/integration/security/recall-diagnostics-isolation.test.ts:61).
      // The public-export-consumers AST walker only scans packages/*/src/**
      // (NOT test/), so that cross-package consumer doesn't satisfy the gate.
      // The production consumer is intra-package (prompt-assembly.ts threads
      // the same envelope), which the walker skips as a self-import. Mirrors
      // the createMemoryHandlers / MEMORY_DIAGNOSTIC_CONTRACTS precedent.
      // Keep the barrel export — the integration test needs it via
      // the bare `@comis/agent` import.
      "buildRecallTrace",
      // Served-window comparator (KNOB-01, phase 176). 176-05 wired the daemon
      // consumers: compareServedWindowForProvider is named-imported by
      // setup-agents-runtime.ts and ServedWindowComparison by daemon.ts, so
      // their transient 176-02 entries are REMOVED. The two that remain:
      //   - resetServedWindowWarnForTest: test-only latch reset, consumed by
      //     setup-agents-served-window-wiring.test.ts via the @comis/agent
      //     barrel — the AST walker scans packages/*/src/** but skips .test.ts,
      //     so that consumer can't satisfy the gate (buildRecallTrace precedent).
      //   - ServedWindowComparisonInput: the daemon builds the comparator input
      //     inline (mirroring MemoryConsolidationDeps' named-shape-without-
      //     consumer posture); the type stays for external/test callers.
      "resetServedWindowWarnForTest",
      "ServedWindowComparisonInput",
      // Viable floor (FLOOR-01, phase 176 plan 176-05). The two value exports +
      // AgentBootWindowInfo have daemon consumers (setup-agents-runtime.ts /
      // daemon.ts named imports). MinViableEquation is the structured equation
      // result type — part of the documented floor API; the production wiring
      // discards the return (WARN-only, I1/D-02) and the intra-package tests
      // consume it via the local module path, which the walker skips as a
      // self-import.
      "MinViableEquation",
      // Verified Learning WS2 (P2 Skills, Phase 201) — DELETED in Phase 223 Plan 06.
      // The synthesis adapter / JOB / prompt / source / approval-gate subset were
      // the dead embedding-clustering pipeline the reflection engine REPLACED
      // (Plan 05 swapped the cron; Plan 06 deleted skill-synthesis-job.ts +
      // llm-skill-synthesis-adapter.ts + skill-synthesis-prompt.ts). Their barrel
      // re-exports are gone, so they need no allowlist entry — removed (the
      // shrink-only ratchet runs BOTH ways).
      // v2.31 Reflection engine (Phase 223 Plan 04, REFLECT-01/03/04/05/06) — the
      // reflection JOB (runReflection) + classifier + the cheap-model reflect
      // adapter (createLlmReflectionAdapter) + prompt/parser, surfaced on the
      // @comis/agent barrel. Plan 05 (the daemon __REFLECT__ wiring) now name-imports
      // `runReflection` + `createLlmReflectionAdapter` (value) in
      // setup-channels-memory-crons-wire.ts and `ReflectionSourceTrajectory` (type) in
      // setup-channels-skill-synthesis-deps.ts / setup-channels-memory-crons-types.ts —
      // so those THREE SHRANK out of this allowlist (the shrink-only ratchet,
      // AGENTS.md §2.8). The rest stay ahead-of-consumer (the LLM-mock A→B harness in
      // Plan 08 consumes ReflectionResult/the deps types). They ship ALONGSIDE the
      // synthesis entries; Plan 06 deletes the synthesis half.
      "classifyReflectOutcome",
      "REFLECT_PROMPT",
      "parseReflectionResult",
      "LlmReflectionAdapterDeps",
      "ReflectionAdapter",
      "ReflectInput",
      "ReflectionResult",
      "RunReflectionDeps",
      "RunReflectionResult",
      "RunReflectionConfig",
      "ReflectAdmissionOutcome",
      // Sandbox-posture primitive (SANDBOX-01/02, phase 172). resolvePostureFromSkills
      // SHRANK out of this baseline — Plan 02's daemon wiring
      // (setup-cross-session-runtime.ts) now name-imports it cross-package to build
      // the injected resolvePosture closure, so the walker finds a real consumer.
      // The comparator + types below stay ahead-of-consumer: the Plan 02 spawn gate
      // consumes comparePosture + SandboxPosture INTRA-package (sub-agent-runner.ts via
      // the relative ./sandbox-posture.js import), which the cross-package walker skips
      // as a self-import (the buildRecallTrace / resetServedWindowWarnForTest precedent).
      // PostureDimension/PostureComparison/SkillsPostureSlice have no cross-package value
      // or type importer by name. Shrink each as a real cross-package consumer lands.
      "comparePosture",
      "SandboxPosture",
      "PostureDimension",
      "PostureComparison",
      "SkillsPostureSlice",
    ])],
    // @comis/channels: baseline orphans tracked here. The 5 delivery
    // helpers + the Markdown IR pipeline (incl. telegram-file-ref-guard)
    // moved from packages/channels/src/shared/ to
    // packages/core/src/delivery/. The 8 channel-baseline entries that
    // came from those moved modules (RetryEngine, chunkForDelivery,
    // ChunkForDeliveryOptions, PERMANENT_ERROR_PATTERNS,
    // guardTelegramFileRefs, isTelegramFileGuardEnabled,
    // ALWAYS_GUARD_EXTENSIONS, AMBIGUOUS_EXTENSIONS) are removed from
    // this set and re-added under @comis/core below (no back-compat shims).
    ["@comis/channels", new Set<string>([
      "createTelegramAdapter",
      "TelegramAdapterDeps",
      "TelegramAdapterHandle",
      "mapGrammyToNormalized",
      "buildAttachments",
      "validateWebhookSecret",
      "BotInfo",
      "createTelegramResolver",
      "TelegramResolverDeps",
      "createDiscordAdapter",
      "DiscordAdapterDeps",
      "mapDiscordToNormalized",
      "buildDiscordAttachments",
      "DiscordBotInfo",
      "chunkDiscordText",
      "ChunkDiscordTextOpts",
      "createSlackAdapter",
      "SlackAdapterDeps",
      "mapSlackToNormalized",
      "SlackMessageEvent",
      "SlackFile",
      "buildSlackAttachments",
      "fetchWithSlackAuth",
      "isSlackHostname",
      "SlackBotInfo",
      "escapeSlackMrkdwn",
      "SlackResolverDeps",
      "createWhatsAppAdapter",
      "WhatsAppAdapterDeps",
      "mapBaileysToNormalized",
      "BaileysMessage",
      "buildWhatsAppAttachments",
      "normalizeWhatsAppJid",
      "isWhatsAppGroupJid",
      "isWhatsAppUserJid",
      "extractJidPhone",
      "WhatsAppResolverDeps",
      "createSignalAdapter",
      "SignalAdapterDeps",
      "mapSignalToNormalized",
      "buildSignalAttachments",
      "SignalBotInfo",
      "convertIrToSignalTextStyles",
      "SignalTextStyle",
      "createLineAdapter",
      "LineAdapterDeps",
      "LineAdapterHandle",
      "mapLineToNormalized",
      "buildLineAttachments",
      "LineBotInfo",
      "buildFlexMessage",
      "buildFlexCarousel",
      "FlexTemplate",
      "FlexAction",
      "createRichMenuManager",
      "RichMenuManager",
      "RichMenuInput",
      "createLineResolver",
      "LineResolverDeps",
      "createIMessageAdapter",
      "IMessageAdapterDeps",
      "mapImsgToNormalized",
      "buildImsgAttachments",
      "ImsgBotInfo",
      "IMessageResolverDeps",
      "createIrcAdapter",
      "IrcAdapterDeps",
      "mapIrcToNormalized",
      "IrcBotInfo",
      "createEmailAdapter",
      "EmailCredentialOpts",
      "EmailCredentialInfo",
      "isAllowedSender",
      "isAutomatedSender",
      "mapEmailToNormalized",
      "createImapLifecycle",
      "ImapLifecycleOpts",
      "ImapLifecycleHandle",
      "buildThreadingHeaders",
      "extractThreadId",
      "EchoChannelAdapter",
      "EchoAdapterOptions",
      "createEchoPlugin",
      "createChannelRegistry",
      "ChannelRegistry",
      "ChannelRegistryOptions",
      "evaluateAutoReply",
      "isGroupMessage",
      "isBotMentioned",
      "AutoReplyDecision",
      "PreflightResult",
      "PreflightDeps",
      "NO_REPLY_TOKEN",
      "HEARTBEAT_OK_TOKEN",
      "FilterResult",
      "mimeToAttachmentType",
      "normalizeTelegramPollResult",
      "normalizeDiscordPollResult",
      "normalizeWhatsAppPollResult",
      "TelegramPollData",
      "DiscordPollData",
      "WhatsAppPollData",
      "ApprovalNotifierDeps",
      "ChannelManagerDeps",
      "TypingControllerConfig",
      "TypingMode",
      "createTypingLifecycleController",
      "TypingLifecycleController",
      "TypingLifecycleOptions",
      // GroupHistoryBuffer: the only in-repo consumer
      // (InboundPipelineDeps.groupHistoryBuffer field, plus its mirror on
      // ChannelManagerDeps) was deleted — the deps slot was never wired by the
      // daemon and the absent-mode (no group history injection) IS the
      // production code path. Type stays exported on the documented public
      // surface until a future cleanup removes the implementation module as a
      // dead-code unit (separate cleanup).
      "GroupHistoryBuffer",
      // deliverToChannel, DeliverToChannelDeps, DeliveryResult,
      // ChunkDeliveryResult, resolveChunkLimit, and QUEUE_BACKOFF_SCHEDULE_MS
      // were removed from @comis/channels exports when
      // packages/channels/src/shared/deliver-to-channel.ts was deleted.
      // Delivery types are now owned by @comis/core; queue-backoff helpers
      // live at packages/core/src/delivery/queue-backoff.ts.
      "executeVoiceResponse",
      "VoiceResponseContext",
      "VoiceResponseResult",
      "deliverOutboundMedia",
      "OutboundMediaDeps",
      "OutboundMediaResult",
      "LifecycleReactorDeps",
      "LifecyclePhase",
      "PhaseCategory",
      "isValidTransition",
      "isTerminal",
      "getPhaseCategory",
      "ALL_PHASES",
      "EmojiTier",
      "EmojiSet",
      "EMOJI_SETS",
      "classifyToolPhase",
      "getEmojiForPhase",
      "toSlackShortname",
      "UNICODE_TO_SLACK",
      "PHASE_MULTIPLIERS",
      "computeStallThresholds",
      "getPhaseMultiplier",
      "StallThresholds",
      "TELEGRAM_SAFE_EMOJI",
      "tokenizeTemplate",
      "resolveTokens",
      "applyPrefix",
      "FORMATTERS",
      "TemplateToken",
      "ChannelHealthMonitorConfig",
      "ChannelHealthState",
      "ChannelHealthEntry",
      // Two channels-side symbols consumed only by orchestrator-side test
      // fixtures (`packages/orchestrator/src/execution/execution-pipeline.test.ts`).
      // The public-export-consumers gate excludes `*.test.ts` files from its
      // in-repo consumer scan, so test-only consumers don't satisfy the gate
      // even though the symbols ARE used. Both go away when channel-manager
      // + the block-pacer / telegram thread-context internals move to
      // orchestrator and these entries are removed.
      "PacerConfig",
      "TELEGRAM_THREAD_META_KEYS",
      // Telegram thread-context builders (the General-Topic id=1 asymmetry).
      // Surfaced on the public barrel for the v2.28 channel-emulation harness's
      // GROUP-03 HARD assertion (it drives the REAL SEND-omits / TYPING-includes
      // routing through the dist-aliased @comis/channels, not a re-implementation).
      // The only consumers are test/live/** scenarios + the channels index.test.ts
      // barrel check — both of which the public-export-consumers AST walker
      // excludes (it scans packages/*/src/** and skips *.test.ts). Mirrors the
      // TELEGRAM_THREAD_META_KEYS precedent directly above. Shrink if a
      // cross-package production consumer lands.
      "buildSendThreadParams",
      "buildTypingThreadParams",
      "resolveTelegramThreadContext",
      "TelegramThreadScope",
      "TelegramThreadContext",
      // Telegram error classifier (the structural GrammyError →
      // ActivityRenderError mapping: 429→rate_limited / 400-edit→
      // not_supported{edit} / 403→permission / default→internal). Surfaced on
      // the public barrel for the v2.28 channel-emulation harness's FAULT-02
      // assertion (it drives the REAL classifier through the dist-aliased
      // @comis/channels, not a re-implementation). The only consumers are
      // test/live/** scenarios + the channels index.test.ts barrel check — both
      // excluded by the public-export-consumers AST walker (it scans
      // packages/*/src/** and skips *.test.ts). Mirrors the thread-context
      // builders precedent directly above. Shrink if a cross-package
      // production consumer lands.
      "classifyTelegramError",
      // Signal wire types (the adapter's OWN signal-cli envelope/attachment
      // interface, defined in signal/signal-client.ts). Surfaced TYPE-ONLY on the
      // public barrel for the v2.28 channel-emulation harness's CHAN2-01 I4
      // discipline — the Signal emulator's payload builders
      // (test/live/emulators/signal/signal-payloads.ts) return-annotate against
      // them so an envelope wire-shape drift is a compile error, and the
      // dist-aliased @comis/channels barrel is the only import path the test/live
      // vitest alias exposes. `export type` is erased at build (no runtime export
      // added → SEC-02-safe). The only consumers are test/live/** scenarios + the
      // channels index.test.ts barrel check — both excluded by the
      // public-export-consumers AST walker (it scans packages/*/src/** and skips
      // *.test.ts). Mirrors the thread-context builders / classifyTelegramError
      // precedents directly above. Shrink if a cross-package production consumer lands.
      "SignalEnvelope",
      "SignalAttachment",
      // Discord channel narrowing surface. Consumed to retarget the 18
      // `as any` casts in `discord-actions.ts` + the 5 thread-iteration
      // sites. The 4 entries are removed once discord-actions.ts is
      // retargeted to consume them.
      "asTextLike",
      "DiscordTextLikeChannel",
      "asThreadInfo",
      "DiscordThreadInfo",
      // Activity-renderer surface re-exported so the daemon's
      // buildActivityRenderers (setup-channels-activity-renderers.ts) can
      // construct the EditPlace renderers from the @comis/channels barrel.
      // The four per-channel factories (createTelegramActivityRenderer,
      // createDiscordActivityRenderer, createSlackActivityRenderer,
      // createWhatsAppActivityRenderer) HAVE that in-repo consumer and are
      // NOT listed. createEchoActivityRenderer is the Echo→TestSink wrapper
      // (the daemon constructs createTestSink() directly, so the Echo factory
      // has no production consumer yet — its consumer arrives with the Echo
      // activity-renderer wiring). createEditPlaceRenderer + EditPlaceDeps are
      // wrapped INTERNALLY by the four per-channel factories, so the daemon
      // never imports them by name; they are public-surface for embedders +
      // the per-channel factory implementations. Shrink each as a real
      // cross-package consumer lands.
      "createEchoActivityRenderer",
      "createEditPlaceRenderer",
      "EditPlaceDeps",
    ])],
    // @comis/cli: 4 documented external-API entries (withClient,
    // credentialsStep, RpcClient, callTyped). All register*Command factories and
    // output utilities (success/error/warn/info/json/renderTable/
    // renderKeyValue/withSpinner) are not re-exported from the package;
    // they remain accessible to the bin only via ./commands/*.js /
    // ./output/*.js direct source paths.
    // callTyped is an intentional embedding entrypoint: used heavily
    // inside @comis/cli itself via relative imports and by the integration
    // test harness via `@comis/cli` bare-package import.
    ["@comis/cli", new Set<string>([
      "withClient",
      "credentialsStep",
      "RpcClient",
      "callTyped",
    ])],
    // @comis/core: baseline orphans tracked here. See inline comments
    // throughout this set for per-entry rationale.
    ["@comis/core", new Set<string>([
      // ── tool.invoke surface + ResultRef (Phase 212, interface-first) ──
      // TOOL_CAPABILITY_MAP/TOOL_ROUTE_MAP are the single source of truth for
      // the tool.invoke surface; ResultRef + its pure threshold/GC math are the
      // minimal result-handle. They land FIRST (Plan 01) so the four downstream
      // consumers draw from one table without drift — the daemon gate + the
      // lease audience (Plan 02) and the comis_tools SDK codegen (Plan 03). Until
      // those plans land, the only callers are the two cap-map arch-tests + the
      // pure unit tests (intra-core / test-scope, excluded from the consumer
      // scan). Shrink each entry as the real cross-package production caller
      // (Plan 02 dispatch / lease-manager, Plan 03 codegen + result-ref-store)
      // lands. Mirrors the validateBindMount (211-03 interface-first) precedent
      // below.
      "TOOL_CAPABILITY_MAP",
      "TOOL_ROUTE_MAP",
      "ToolName",
      "ToolRoute",
      "RESULT_REF_THRESHOLDS",
      "DEFAULT_INLINE_THRESHOLD_BYTES",
      "PER_FILE_CAP_BYTES",
      "PER_RUN_AGGREGATE_CAP_BYTES",
      "getResultRefThreshold",
      "shouldMaterialize",
      "isExpired",
      "selectEvictions",
      "checkPerFileCap",
      "computeExpiresAt",
      "ResultRef",
      // ── JAIL-03 bind-mount validator (Phase 211) ──
      // validateBindMount is the pure denylist backstop the bwrap-provider calls
      // before emitting any bind. It lands in @comis/core (211-03) so the jail
      // wiring (211-05) consumes it; until that plan lands, the only callers are
      // its own deny-branch tests (intra-core, excluded from the consumer scan).
      // Shrink this entry once 211-05 wires it into the bwrap provider.
      "validateBindMount",
      // ── learned-doc static scan (v2.31 Reflection, 223-02, interface-first) ──
      // validateLearnedDocBody is the STATIC poison/secret scan an advisory Mental
      // Model doc receives (SKILL-02 / INV-3) — the renamed `scanFields` extracted to
      // @comis/core (where validateMemoryWrite already lives). It lands FIRST so the
      // agent reflection job (223-04) + the daemon reflect path (223-05) consume it
      // without a @comis/skills dependency. Until those plans land, the only callers
      // are its own static-scan tests (intra-core, excluded from the consumer scan).
      // Mirrors the validateBindMount interface-first precedent above. Shrink each
      // entry once 223-04/05 wire it into the reflection path.
      "validateLearnedDocBody",
      "MAX_DOC_NAME_LENGTH",
      "LearnedDocValidation",
      "LearnedDocFinding",
      // ── orchestration authoring gate (Phase 174 / v2.27 P2) ──
      // The orchestration.authoring.{intentAction,repairProducer,gbnfConstrain}
      // gate ships GATED-OFF (every flag .default(false); the 173 gate returned
      // DEFER). The schema lands FIRST so downstream plans receive the exact
      // gate shape; the production consumers are Plans 02-05 (events / repair
      // producer / from_intent synthesizer / GBNF constrain), which read the
      // flags from @comis/core. Until those land, the only callers are this
      // schema's own tests + the section-registry/serializer derivations
      // (intra-core, excluded from the consumer scan). Shrink each entry as a
      // real cross-package production caller lands.
      "OrchestrationConfigSchema",
      "OrchestrationAuthoringConfigSchema",
      "OrchestrationConfig",
      "OrchestrationAuthoringConfig",
      // ── capability default-activation ──
      // The default-activation framework: a declarative capability registry +
      // empty measured-winner set + pure resolver + frozen-trust invariant.
      // The prove-out measured no winner, so the framework flips NOTHING
      // (byte-identity) and its only consumers today are its own
      // invariant tests (excluded from the consumer scan). The production
      // consumers land later: a future costed-winner phase records an
      // ActivationDecision (the ONLY place a default flips), and an operator
      // surface reads resolveAllCapabilityDefaults() for the activation posture.
      // Shrink each entry as a real in-repo production caller lands.
      "V2_9_CAPABILITIES",
      "ACTIVATED_CAPABILITIES",
      "FROZEN_TRUST_PATHS",
      "resolveCapabilityDefault",
      "resolveAllCapabilityDefaults",
      "CapabilityId",
      "CapabilityDescriptor",
      "ActivationDecision",
      "ResolvedCapabilityDefault",
      // ── Agent Transparency (interactive approvals) ──
      // ParsedCallback is the documented return shape of the public
      // parseCallbackData. The orchestrator router consumes the
      // function, not the type name (it destructures the value), so the type
      // has no production import. It is part of the signing API surface external
      // consumers of parseCallbackData rely on; tracked here.
      "ParsedCallback",
      // ── Agent Transparency (foundation) ──────────────
      // Activity + redaction public surface shipped in the @comis/core
      // barrel as the foundation. Consumers land later:
      // channel renderers wire chatProjection/acpProjection/
      // coalesce/ActivityStrategy; the ACP bridge consumes acpProjection;
      // label specs register via registerActivityLabelSpec; the redaction
      // types/limits feed emit sites. redactValue itself already has
      // cross-package consumers (template-engine + emit sites) so it is
      // NOT listed here. Shrink each entry as it gains a real consumer.
      "ActivityEventSchema",
      "RedactedParamValueSchema",
      "RedactedParamsSchema",
      "ActivityParseError",
      "ActivityVerbosity",
      "isNonEmptyEvents",
      "ApprovalChoice",
      "ApprovalChoiceSchema",
      "ApprovalCorrelation",
      "ApprovalCorrelationSchema",
      "TemplateOutput",
      "TemplateError",
      "SemanticPhase",
      "classifySemanticPhase",
      "LabelSpec",
      "ActionLabelSpec",
      "RegisteredLabelSpec",
      "ResolveLabelOptions",
      "registerActivityLabelSpec",
      // hasRegisteredLabelSpec: the explicit-registration
      // introspection primitive the transparency coverage gate
      // (packages/skills/src/__tests__/transparency-label-coverage.test.ts)
      // calls. resolveLabelSpec is total (always returns a humanized fallback)
      // so it cannot gate; the gate must ask "was a spec explicitly
      // registered?". The sole consumer is that __tests__ gate (excluded from
      // the consumer scan), so the public primitive has no in-repo production
      // import yet — tracked here. Shrink when a production caller lands.
      "hasRegisteredLabelSpec",
      // ThemeName: the activity-theme name union shipped on
      // the @comis/core barrel for the four bundled themes. Channel renderers
      // pass a theme through resolveLabelSpec options; the type name itself has
      // no in-repo value consumer yet — tracked here.
      "ThemeName",
      "chatProjection",
      "acpProjection",
      "coalesce",
      "CoalesceResult",
      "CHAT_COALESCE_RULES",
      "ActivityStrategy",
      "ReadonlyPlanStep",
      "REDACT_LIMITS",
      "RedactLimits",
      "RedactOptions",
      "RedactedValue",
      "RedactionRecord",
      // ───────────────────────────────────────────────────────────────
      "AttachmentSchema",
      "NormalizedMessageSchema",
      "parseMessage",
      // getMessageTraceId: typed accessor for NormalizedMessage.metadata.traceId.
      // Consumers: orchestrator channel-manager.ts will read msg.metadata.traceId via this helper.
      "getMessageTraceId",
      // ── Verified Learning WS1: inbound-reaction contracts (Phase 199, REACT-01) ──
      // The interface-first wave (Plan 01) ships the NormalizedReaction domain
      // shape + parse + the ReactionHandler port type AHEAD of their consumers so
      // later plans receive the contract rather than scavenge for it. Consumers
      // land later: the reaction-capable adapters (Discord/Slack/Telegram, Plan 02)
      // produce a NormalizedReaction via parseReaction and register a
      // ReactionHandler through ChannelPort.onReaction?; the orchestrator
      // channel-manager fans out to it (Plan 04); the daemon resolves trust +
      // observes the outcome. Shrink each entry as its real in-repo consumer lands.
      "NormalizedReactionSchema",
      "parseReaction",
      "NormalizedReaction",
      "ReactionHandler",
      "TrustLevelSchema",
      "MemorySourceSchema",
      "MemoryEntrySchema",
      // Structured-extraction + entity domain
      // types. MemoryEntity is the entity import target; the
      // extraction LLM-output types describe the shape @comis/agent's
      // parseExtractionResult validates. These 6 (3 schemas + 3 inferred
      // types) are consumed intra-core (memory-entry.ts builds the
      // MemoryExtractionResult chain from them) + are downstream-facing public
      // domain API surface, but carry NO cross-package value/type import by
      // name yet — the checker counts cross-package barrel consumers only.
      // (MemoryExtractionResultSchema + MemoryExtractionResult are NOT listed:
      // @comis/agent's parseExtractionResult imports both from @comis/core, so
      // they have a real cross-package consumer.) Mirrors the @comis/memory
      // row-schema / reranker baseline-orphan precedent. Shrink each
      // as a real cross-package consumer lands.
      "ExtractedEntitySchema",
      "StructuredMemorySchema",
      "MemoryEntitySchema",
      "ExtractedEntity",
      "StructuredMemory",
      "MemoryEntity",
      "ToolCallSchema",
      "TokenUsageSchema",
      "AgentResponseSchema",
      "SessionKeySchema",
      "parseSessionKey",
      "PollInputSchema",
      "PollOptionResultSchema",
      "NormalizedPollResultSchema",
      "RichButtonSchema",
      "RichCardFieldSchema",
      "RichCardSchema",
      "RichEffectSchema",
      "ApprovalRequestSchema",
      "ApprovalResolutionSchema",
      "SerializedApprovalRequestSchema",
      "SerializedApprovalCacheEntrySchema",
      "InjectionTypeSchema",
      "CredentialMappingSchema",
      "SecretRefSchema",
      "isSecretRef",
      "SecretRefOrStringSchema",
      "DeliveryOriginSchema",
      // IncidentReportSchema is the Zod schema for the obs.explain response
      // (the §6.3 IncidentReport wire shape, Phase 153). The handler + the
      // contract consume the inferred *type* `IncidentReport` (which has
      // cross-package consumers), and the contract's `response` field
      // references the schema VALUE internally within observability.ts — but no
      // OTHER in-repo module imports the schema value directly. It is part of
      // the documented external-API surface: an external consumer validating an
      // IncidentReport off the wire imports this schema. Tracked here per the
      // baseline orphan-export policy; remove if an in-repo value consumer lands.
      "IncidentReportSchema",
      // FleetHealthReportSchema is the Zod schema VALUE for the obs.fleet.health
      // response (the v2.15 cross-session fleet digest). The Phase-161 handler +
      // the ObsFleetHealthContract consume the inferred TYPE `FleetHealthReport`
      // (now removed from this allowlist — it has a real consumer), and the
      // contract's `response` field references the schema VALUE internally within
      // fleet-health-report.ts — but no OTHER in-repo module imports the schema
      // value directly. It is part of the documented external-API surface (an
      // external consumer validating a FleetHealthReport off the wire imports it).
      // Same rationale + precedent as IncidentReportSchema above; remove if an
      // in-repo value consumer lands.
      "FleetHealthReportSchema",
      // ── Audit schema reshape (AUDIT-03 / E4, Phase 176 Plan 02) ──
      // AUDIT_KINDS (the closed kind value-list) + kindIsSecuritySignal (the
      // exhaustiveness-guarded severity helper) + AuditKind (the inferred union
      // type) are the reshaped audit contract surface. AuditKind has an
      // INTRA-core consumer — events-agent.ts annotates the audit:event
      // payload's `kind?: AuditKind` via the relative ../security/audit.js
      // import, which the cross-package walker skips as a self-import
      // (buildRecallTrace precedent). The cross-package value consumers land in
      // Plan 03 (the daemon audit sink reads payload.kind, derives via
      // kindIsSecuritySignal/AUDIT_KINDS). Surfaced here AHEAD of that consumer
      // (the orchestration-authoring schema-first precedent). Shrink each entry
      // as Plan 03's sink name-imports it.
      "AUDIT_KINDS",
      "kindIsSecuritySignal",
      "AuditKind",
      "NodeStatusSchema",
      "GraphStatusSchema",
      "GraphNodeSchema",
      "NodeExecutionStateSchema",
      "ExecutionGraphSchema",
      "GraphValidationError",
      "topologicalSort",
      "SubagentEndReasonSchema",
      "parseSubagentResult",
      "SubagentContextConfigSchema",
      "NodeTypeIdSchema",
      "ToolSchemaProfileSchema",
      "ToolCallArgumentsEncodingSchema",
      "ModelCompatConfigSchema",
      "ProviderFamilySchema",
      "TranscriptToolCallIdModeSchema",
      "ProviderCapabilitiesSchema",
      "BackgroundTaskOriginSchema",
      "ToolCall",
      "TokenUsage",
      "AgentResponse",
      "PollInput",
      "PollOptionResult",
      "ApprovalRequest",
      "ApprovalResolution",
      "SerializedApprovalRequest",
      "SerializedApprovalCacheEntry",
      "InjectionType",
      "SecretRef",
      "SubagentEndReason",
      "SubAgentSpawnPreparedEvent",
      "SubAgentSpawnRejectedEvent",
      "SubAgentSpawnStartedEvent",
      "SubAgentResultCondensedEvent",
      "SubAgentLifecycleEndedEvent",
      "SubAgentContextCompactedEvent",
      "NodeTypeId",
      "ToolSchemaProfile",
      "ToolCallArgumentsEncoding",
      "ProviderFamily",
      "TranscriptToolCallIdMode",
      "createNoOpCapabilityPort",
      "PROFILE_ID_RE",
      // NOTE (v2.12, Phase 126 Plan 04): the DAG context-store planned-orphan
      // cluster — ContextStorePort / ContextEngineStore / ContextAdminStore, the
      // 5 remaining Context*Contract definitions (ContextRecall/Expand/
      // Conversations/Tree/SearchByConversation), and the 9 Ctx*Row DTOs — was
      // removed here. The core ports + the contract definitions were deleted
      // outright in this plan (the last consumers went in Plans 02/03 + the CLI
      // rewire), so they are no longer orphaned exports to track.
      // SessionStorePort + its 3 row DTOs are declared in
      // core/src/ports/{session-store,session-store-types}.ts but not yet
      // consumed by agent/cli value-import retargets — tracked as
      // planned-orphan policy entries (same pattern as ContextStorePort).
      "SessionStorePort",
      "SessionData",
      "SessionListEntry",
      "SessionDetailedEntry",
      // LCD lossless store (v2.12, Phase 127): the ContextStorePort + DTOs +
      // codec are surfaced on @comis/core but only memory's createLcdStore
      // (port + DTO typed-import) and Phase 128 ingest consume some of them —
      // tracked as planned-orphan policy entries (same pattern as
      // SessionStorePort). The memory adapter (Plan 04) value-consumes the
      // codec + types; listed here so the gate is green at THIS plan's commit
      // before Plan 04 lands (over-listing a soon-consumed symbol is the
      // documented pattern, never under-listing).
      "ContextStorePort",
      "LcdMessage",
      "LcdMessagePart",
      "LcdPartMetadata",
      "LcdPartKind",
      "LcdRole",
      "ContextStoreScope",
      "AppendMessageInput",
      "messageToParts",
      "partsToMessage",
      // Master-key file helpers extracted from CLI's `secrets init` body
      // into core/src/security/master-key.ts. The three names are surfaced
      // on @comis/core's public barrel without a consumer until the CLI
      // rewrite is wired — tracked here as planned-orphan policy entries
      // (same pattern as SessionStorePort above).
      "writeMasterKeyIfAbsent",
      "generateMasterKey",
      "MasterKeyWriteResult",
      // OAuth helpers consolidated in @comis/core/src/security/oauth-helpers.ts.
      // The two verbatim-moved JWT helpers (decodeCodexJwtPayload,
      // resolveCodexStableSubject) carry no in-repo consumer post-move
      // (same baseline orphan posture they had in @comis/agent pre-move),
      // and the RewrittenOAuthError result type is consumed only via the
      // function's return value (no explicit type-import consumer in repo).
      // The other five helpers (resolveCodexAuthIdentity, redactEmailForLog,
      // rewriteOAuthError, resolveCodexAccessTokenExpiry, OAuthErrorCode)
      // have real in-repo consumers in agent + cli + gateway and are NOT
      // listed.
      "decodeCodexJwtPayload",
      "resolveCodexStableSubject",
      "RewrittenOAuthError",
      "FileExtractionErrorKind",
      // Video generation (v2.24 Phase 188) — the greenfield @comis/core video
      // foundation surfaced on the public barrel so the LATER-wave Plan 04
      // (@comis/daemon video handler + boot selector) can import them. These are
      // the REMAINING ahead-of-consumer planned-orphans (the
      // SessionStorePort / ContextStorePort "listed so the gate is green before
      // the consumer lands" precedent — over-listing a soon-consumed symbol is
      // the documented pattern, never under-listing). Each entry SHRINKS out of
      // this baseline when its real in-repo consumer lands.
      //
      // SHRUNK at Plan 03 (this plan): the port + 4 value types
      // (VideoGenerationPort / VideoGenInput / VideoGenJob / VideoJobStatus /
      // VideoGenOutput), VideoErrorKind, and VideoGenError now have real
      // cross-package consumers in @comis/skills/.../video-gen (the FAL adapter
      // implements the port + throws VideoGenError; the classifier name-imports
      // VideoErrorKind) — so they are removed from this list.
      //
      // STILL ORPHAN (kept — Plan 04 / @comis/daemon consumes them):
      //   - resolveVideoProvider / isBlockedObjectKey / VIDEO_ERR_TO_LOG:
      //     Plan 04's boot selector + handler.
      //   - estimateVideoCostUsd / VIDEO_PRICING: Plan 04's pre-submit cost gate.
      //   - VideoGenerateContract (api-contracts/media.ts, Plan 02): the RPC
      //     contract is declared in Wave 1; its `[VideoGenerateContract.method]`
      //     handler lands in Plan 04 (Wave 3) — a documented cross-wave seam.
      // VIDEO_CAPABILITY + VideoProviderSelection + VideoGenSelectionConfig are
      // NOT listed — they stay intra-`@comis/core/media` (the IMAGE_CAPABILITY /
      // ImageProviderSelection policy), so they never reach the public barrel.
      "VIDEO_ERR_TO_LOG",
      "resolveVideoProvider",
      "isBlockedObjectKey",
      "estimateVideoCostUsd",
      "VIDEO_PRICING",
      "VideoGenerateContract",
      // CAP-02 per-model capability-matrix TYPES (v2.24 Phase 191 Plan 01).
      // Surfaced on the @comis/core barrel (exports/media.ts) in Wave 1. The
      // ACCESSORS listVideoModelCaps / supportedModes / snapDuration were tracked
      // here as ahead-of-consumer planned-orphans; REMOVED in Plan 02 (Wave 2):
      // the @comis/daemon video-handlers now name-imports all three from
      // @comis/core for the IN-02 validator (a real cross-package consumer), so
      // they are no longer orphans (Plan 03's video-generate-tool adds a second
      // consumer of listVideoModelCaps for the IN-03 dynamic description). The
      // VideoModelCaps / VideoDurations TYPES STAY listed — they are surfaced on
      // the barrel but have no NAME-import consumer yet (the handler reads them
      // via inference off listVideoModelCaps's return type, not a named import),
      // so they remain ahead-of-consumer planned-orphans until a future phase
      // name-imports the type. The raw VIDEO_MODELS const is NOT listed — it
      // stays intra-`@comis/core/media` (the VIDEO_CAPABILITY /
      // IMAGE_MODELS_BY_PROVIDER policy), never on the public barrel.
      "VideoModelCaps",
      "VideoDurations",
      // Shared bounded-poll helper (Plan 03, DIVERGENCE 5). createPollDeadline /
      // pollUntilDone already have a real consumer (the @comis/skills FAL
      // adapter's execute()), so they are NOT listed. The PollDeadline /
      // PollOutcome TYPES are ahead-of-consumer planned-orphans: Phase 189's
      // daemon background poller name-imports them when it drives the loop
      // externally. They shrink out when that poller lands.
      "PollDeadline",
      "PollOutcome",
      // Keyless voice (v2.25 Phase 193) — the STT/TTS capability-map + error
      // surface on the public @comis/core barrel (exports/media.ts). Plan 01
      // listed SIX symbols as ahead-of-consumer planned-orphans; Plan 03 (Wave 2)
      // landed the real cross-package consumer (@comis/daemon
      // setup-audio-provider.ts / setup-media.ts), so the THREE now-consumed
      // symbols are SHRUNK OUT of this baseline (shrink-only ratchet, AGENTS.md
      // §2.8 — closing an entry by deleting it, never adding): resolveTranscription
      // Provider + resolveTtsProvider (name-imported by setup-audio-provider.ts) +
      // STT_ERR_TO_LOG (name-imported by setup-media.ts for the honest-unavailable
      // WARN). The THREE below stay listed — they are surfaced on the public barrel
      // but have NO cross-package NAME-import consumer: VOICE_KEYLESS +
      // MAIN_PROVIDER_AUDIO are consumed INSIDE the pure resolvers (intra-
      // `@comis/core/media`), and SttErrorKind is consumed structurally (the
      // daemon reads sel.errorKind off the result, not a named type import). They
      // SHRINK out only if a future phase name-imports them cross-package. The
      // SttSelection / TtsSelection / *SelectionConfig TYPES are NOT listed — they
      // stay intra-`@comis/core/media` (the ImageProviderSelection /
      // VideoProviderSelection policy), consumed structurally by the daemon.
      "VOICE_KEYLESS",
      "MAIN_PROVIDER_AUDIO",
      "SttErrorKind",
      // Verified Learning outcome signal (v2.26 Phase 198 Plan 01, Wave 1) — the
      // greenfield OutcomeSignalPort + its DTOs surfaced on the public @comis/core
      // barrel (exports/ports.ts) so the LATER-wave plans can import them BY TYPE:
      // Plan 02's @comis/memory `createSqliteOutcomeStore` implements the port,
      // Plan 03's judge seam + Plan 04's @comis/daemon `setup-learning` wiring
      // construct/observe/resolve against it. These are interface-first ahead-of-
      // consumer planned-orphans (the TunedAlphaStore / MemoryLifecyclePort
      // precedent directly above — listed so the gate is green before the consumer
      // lands, never under-listed). Each SHRINKS out of this baseline when its real
      // cross-package consumer lands (the shrink-only ratchet, AGENTS.md §2.8):
      // OutcomeSignalPort + the 4 DTOs go when Plan 02's adapter name-imports them.
      "OutcomeSignalPort",
      "LearningScope",
      "OutcomeObservation",
      "ResolvedOutcome",
      "OutcomePruneResult",
      // Mental Model doc store port (v2.31 Phase 223) — the type-only
      // MentalModelStorePort + its DTOs (MentalModel, AdmitMentalModelInput),
      // surfaced on the public @comis/core barrel (exports/ports.ts) so @comis/memory
      // (the sqlite-mental-model-store adapter) + @comis/daemon (the reflection
      // wiring) import them BY TYPE — the closed-graph SEC-01 cut (agent↛memory).
      // The v2.26 SkillSynthesisPort / SynthesisInput / CandidateSkill +
      // SkillValidationPort / SkillValidationResult / SkillValidationFinding /
      // ReplayContext entries were DELETED in Phase 223 Plan 07 with the orphaned
      // skill-synthesis-port.ts / skill-validation-port.ts files — the embedding-
      // clustering synthesis pipeline + the dynamic sandbox they typed are gone
      // (Plans 04-06), leaving zero consumers (the reflection engine replaced them).
      // Each entry below SHRINKS out of this baseline when its real cross-package
      // NAME-import consumer lands (the shrink-only ratchet, AGENTS.md §2.8 — never
      // under-listed, closed by deletion).
      "MentalModelStorePort",
      "MentalModel",
      "AdmitMentalModelInput",
      // Reflection delta-ops (v2.31 Phase 223 Plan 03, Wave 2) — the @comis/core
      // reflection-port: the DocSection/StructuredBody/DeltaOp types + the pure
      // applyDeltaOps (byte-stable section refresh, REFLECT-04 — untargeted
      // sections survive by reference) + renderStructuredBody (AST → markdown).
      // Surfaced on the public barrel (exports/ports.ts) so the LATER-wave consumer
      // can import them: Plan 04 (@comis/agent reflection-job + reflection-prompt
      // parser) applies the LLM's delta-ops against the prior doc's AST. Until that
      // plan lands, the only callers are this port's own pure tests (intra-core,
      // excluded from the consumer scan) — interface-first, the MentalModelStorePort
      // precedent directly above. Each SHRINKS out when Plan 04's name-import lands
      // (the shrink-only ratchet, AGENTS.md §2.8). StructuredBody is ALSO consumed
      // intra-core by learned-skill-store.ts (MentalModel.structuredBody), so it
      // stays listed only until the cross-package consumer (Plan 04) lands.
      "DocSection",
      "StructuredBody",
      "DeltaOp",
      "applyDeltaOps",
      "renderStructuredBody",
      // MemoryLifecyclePort + MemoryLifecycleScope +
      // MemoryTier + LifecycleSweepReport were tracked here as SCAFFOLD-DORMANT
      // ahead-of-consumer planned-orphans. REMOVED:
      // the sole @comis/memory lifecycle adapter `createSqliteMemoryLifecycleStore`
      // (packages/memory/src/sqlite-memory-lifecycle-store.ts) now name-imports
      // all four from @comis/core BY TYPE in non-test src — they have a real
      // cross-package consumer, so they are no longer orphans (the daemon cron
      // adds a second). Mirrors the TunedAlphaStore shrink below.
      // TunedAlphaStore + TunedAlphaScope +
      // TunedAlphaVector were tracked here as ahead-of-consumer planned-orphans.
      // REMOVED: the sole SQLite adapter
      // `createSqliteTunedAlphaStore` (packages/memory/src/sqlite-tuned-alpha-store.ts)
      // now name-imports all three from @comis/core in non-test src — they
      // have a real cross-package consumer, so they are no longer orphans.
      // RagConfig: surface-only export. The createRagRetriever factory in
      // packages/agent/src/rag/rag-retriever.ts was deleted; the canonical
      // post-deletion consumer is
      // packages/agent/src/executor/prompt-assembly.ts:649 which reads
      // `config.rag.includeTrustLevels` off the PerAgentConfig.rag slot
      // typed via the schema. No production code carries `RagConfig` as a
      // named import after the factory removal. Kept exported because the
      // RagConfigSchema is still operator-facing config; the type alias is
      // simply zero-consumer until the next round of public-API trimming.
      "RagConfig",
      "HookName",
      "ModifyingHookName",
      "VoidHookName",
      "HookHandlerMap",
      "HookBeforeAgentStartEvent",
      "HookBeforeAgentStartContext",
      "HookBeforeAgentStartResult",
      "HookAgentEndEvent",
      "HookAgentEndContext",
      "HookBeforeToolCallEvent",
      "HookBeforeToolCallContext",
      "HookBeforeToolCallResult",
      "HookAfterToolCallEvent",
      "HookAfterToolCallContext",
      "HookToolResultPersistEvent",
      "HookToolResultPersistContext",
      "HookToolResultPersistResult",
      "HookBeforeCompactionEvent",
      "HookBeforeCompactionContext",
      "HookBeforeCompactionResult",
      "HookAfterCompactionEvent",
      "HookAfterCompactionContext",
      "HookSessionStartEvent",
      "HookSessionStartContext",
      "HookSessionEndEvent",
      "HookSessionEndContext",
      "HookGatewayStartEvent",
      "HookGatewayStopEvent",
      // HookGatewayStartContext + HookGatewayStopContext became orphans when
      // the dead hookRunner?.runGatewayStart() / runGatewayStop() invocations
      // were removed from packages/gateway/src/server/hono-server.ts.
      // The Event types remain because plugin authors may still
      // declare gateway lifecycle hooks; the Context types are kept in the
      // public surface for symmetry with other Hook* pairs.
      "HookGatewayStartContext",
      "HookGatewayStopContext",
      "PluginPort",
      "RegisteredHook",
      "PluginToolDefinition",
      "PluginHttpRoute",
      "OutputGuardFinding",
      "OutputGuardResult",
      "createSecretManager",
      // Shared-Map refactor. createSecretManagerWithMutableHandle
      // is the daemon composition root factory (setup-secret-manager.ts + daemon.ts);
      // it returns { secretManager, mutableHandle } over ONE backing Map.
      // MutableSecretManager is the write-authority interface (upsert/remove);
      // held only by the daemon composition root, never placed on AppContainer.
      // Both are consumed by @comis/daemon — no in-repo consumer outside daemon.
      "createSecretManagerWithMutableHandle",
      "MutableSecretManager",
      "requiresConfirmation",
      "ActionClassification",
      "AuditEventSchema",
      "AuditEvent",
      "CreateAuditEventParams",
      "BLOCKED_RANGES",
      "CLOUD_METADATA_IPS",
      "ValidatedUrl",
      // SsrfBlockReason: the public union naming WHY the SSRF guard blocked a URL
      // (protocol / cloud_metadata / private / loopback / …), exported from the
      // core security barrel alongside ValidatedUrl. It is part of the documented
      // ssrfBlockHook callback surface ({ url, reason: SsrfBlockReason }); the only
      // in-repo value-level user is the guard itself (intra-core, excluded from the
      // consumer scan). Tracked here — shrink if a cross-package consumer lands.
      "SsrfBlockReason",
      "ExternalContentSource",
      "detectCanaryLeakage",
      "isSecretAccessible",
      "ScopedSecretManagerOptions",
      "AuditAggregator",
      "AuditAggregatorOptions",
      "SecurityEventPayload",
      "InputSecurityGuardResult",
      "InputSecurityGuardConfig",
      "InjectionRateLimiterConfig",
      "RateLimitResult",
      "resolveSecretRef",
      "ResolveSecretRefDeps",
      "ResolveSecretRefOptions",
      // Secret detection keystone — primitives exported from
      // core/security/secret-detection.ts. isSecretFieldName + scanForSecrets
      // are used within core itself (relative imports) rather than via
      // @comis/core, so no in-package-external consumer exists yet.
      // isEnvRefString is the single-source-of-truth env-ref predicate;
      // exported so credential-classify.ts and future consumers share
      // the authoritative scheme/quote-stripping implementation instead of a
      // weaker trim-only copy.
      // classifyHeaderCredential + CredentialKind + HeaderCredentialClassification
      // are header-credential primitives — consumers land downstream.
      // SecretFinding is used only in core's own test files (excluded from scan).
      "isSecretFieldName",
      "isEnvRefString",
      "scanForSecrets",
      "SecretFinding",
      "classifyHeaderCredential",
      "CredentialKind",
      "HeaderCredentialClassification",
      "scanConfigForSecrets",
      "scanEnvForSecrets",
      "AuditSeverity",
      "AuditOptions",
      // sanitizer.ts BC re-export deleted; the only remaining in-repo
      // consumer is sanitizer.test.ts (test files are excluded from
      // public-export-consumers.test.ts's consumer scan). ZERO_WIDTH_REGEX
      // is part of the documented @comis/core security surface (paired
      // with TAG_BLOCK_REGEX, stripInvisible, containsTagBlockChars).
      "ZERO_WIDTH_REGEX",
      "TAG_BLOCK_REGEX",
      "IGNORE_INSTRUCTIONS_BROAD",
      "DISREGARD_PREVIOUS",
      "FORGET_INSTRUCTIONS_BROAD",
      "YOU_ARE_NOW_ARTICLE",
      "NEW_INSTRUCTIONS_COLON",
      "SYSTEM_COMMAND",
      "ROLE_BOUNDARY",
      "EXEC_COMMAND",
      "ELEVATED_TRUE",
      "RM_RF",
      "DELETE_ALL",
      "DANGEROUS_COMMAND_PATTERNS",
      "HEX_SECRET_32",
      "BASE64_SECRET",
      "PRIVATE_KEY_HEADER",
      "GITHUB_TOKEN",
      "SLACK_TOKEN",
      "SYSTEM_PROMPT_LABEL",
      "INSTRUCTIONS_LABEL",
      "PROMPT_EXTRACTION_PATTERNS",
      "SK_API_KEY",
      "BEARER_TOKEN_LOG",
      "TELEGRAM_BOT_TOKEN",
      "GOOGLE_API_KEY",
      "JWT_PATTERN",
      "URL_PASSWORD",
      "HTML_COMMENT_INJECTION",
      "HIDDEN_DIV_PATTERN",
      "TRANSLATE_EXECUTE_PATTERN",
      "EXFIL_CURL_PATTERN",
      "READ_SECRETS_PATTERN",
      "StripResult",
      "MessagingEvents",
      "AgentEvents",
      "ChannelEvents",
      "InfraEvents",
      "AgentConfigSchema",
      "AgentsMapSchema",
      "BudgetConfigSchema",
      "CircuitBreakerConfigSchema",
      "DmScopeConfigSchema",
      "ElevatedReplyConfigSchema",
      "ModelRoutesSchema",
      "HeartbeatConfigSchema",
      "HeartbeatTargetSchema",
      "PerAgentCronConfigSchema",
      "PruningConfigSchema",
      "RagConfigSchema",
      "ResetPolicyOverrideSchema",
      "RoutingBindingSchema",
      "RoutingConfigSchema",
      "SessionResetPolicySchema",
      "TracingConfigSchema",
      "ChannelConfigSchema",
      "ChannelEntrySchema",
      "ChannelHealthCheckSchema",
      "MemoryConfigSchema",
      "CompactionConfigSchema",
      "RetentionConfigSchema",
      "SecurityConfigSchema",
      "PermissionConfigSchema",
      "ActionConfirmationConfigSchema",
      "AgentToAgentConfigSchema",
      "DaemonConfigSchema",
      "LoggingConfigSchema",
      "TracingDefaultsSchema",
      "ConfigWebhookSchema",
      "GatewayConfigSchema",
      "GatewayTlsConfigSchema",
      "GatewayTokenSchema",
      "GatewayRateLimitSchema",
      "IntegrationsConfigSchema",
      "BraveSearchConfigSchema",
      "McpServerEntrySchema",
      "McpConfigSchema",
      "TranscriptionConfigSchema",
      "TtsConfigSchema",
      "TtsAutoModeSchema",
      "ElevenLabsVoiceSettingsSchema",
      "TtsOutputFormatSchema",
      "ImageAnalysisConfigSchema",
      "VisionScopeRuleSchema",
      "VisionConfigSchema",
      "LinkUnderstandingConfigSchema",
      "MediaConfigSchema",
      "AutoReplyRuleSchema",
      "AutoReplyConfigSchema",
      "MonitoringConfigSchema",
      "PluginsConfigSchema",
      "PluginEntrySchema",
      "QueueConfigSchema",
      "QueueModeSchema",
      "OverflowPolicySchema",
      "PerChannelQueueConfigSchema",
      "OverflowConfigSchema",
      "DebounceBufferConfigSchema",
      "FollowupConfigSchema",
      "StreamingConfigSchema",
      "PerChannelStreamingConfigSchema",
      "TypingModeSchema",
      "ChunkModeSchema",
      "DeliveryMirrorConfigSchema",
      "DeliveryQueueConfigSchema",
      "DeliveryTimingConfigSchema",
      "DeliveryTimingModeSchema",
      "CoalescerConfigSchema",
      "AutoReplyEngineConfigSchema",
      "GroupActivationModeSchema",
      "SendPolicyConfigSchema",
      "SendPolicyRuleSchema",
      "SendActionSchema",
      "EnvelopeConfigSchema",
      "WebhooksConfigSchema",
      "WebhookMappingConfigSchema",
      "WebhookMappingMatchSchema",
      "AgentSecretsConfigSchema",
      "DocumentationConfigSchema",
      "DocumentationLinkSchema",
      "ImageGenerationConfigSchema",
      // Video-generation config schema (v2.24). Documented config-API surface,
      // parity sibling of ImageGenerationConfigSchema: out-of-package consumers
      // (daemon, CLI wizard) use the inferred VideoGenerationConfig TYPE, so the
      // schema VALUE is a baseline orphan here. The CLI init-wizard drift-guard
      // test parses it to keep SUPPORTED_VIDEO_PROVIDERS aligned with the enum.
      "VideoGenerationConfigSchema",
      "NotificationConfigSchema",
      "VerbosityConfigSchema",
      "VerbosityLevelSchema",
      "VerbosityOverrideSchema",
      "OutputRetentionConfigSchema",
      "MemoryReviewConfigSchema",
      // Per-agent consolidation config schema. Wired into PerAgentConfig
      // (schema-agent-runtime) WITHIN @comis/core; the daemon consumes the
      // INFERRED config TYPE, not the schema value. The schema value therefore has no
      // out-of-package consumer — baseline orphan (mirror MemoryReviewConfigSchema).
      "MemoryConsolidationConfigSchema",
      // Per-agent reasoning config schema + type. Wired into
      // PerAgentConfig (schema-agent-runtime) WITHIN @comis/core; the schema-runtime attach
      // is a self-import (the public-export-consumers gate skips same-package imports), so
      // both the schema value AND the inferred config TYPE are surfaced AHEAD of their
      // cross-package consumers — the reasoning job reads MemoryReasoningConfig
      // (the factory-orphan dance, mirror MemoryConsolidationConfigSchema +
      // runMemoryTripleExtraction). Shrink when the consumer lands.
      "MemoryReasoningConfigSchema",
      "MemoryReasoningConfig",
      "ProvidersConfigSchema",
      "UserModelSchema",
      "ModelCostSchema",
      "OperationModelEntrySchema",
      "OperationModelsSchema",
      "OAuthConfigSchema",
      "substituteEnvVars",
      "mergeLayered",
      "loadLayered",
      "IMMUTABLE_CONFIG_PREFIXES",
      "MANAGED_SECTIONS",
      "ToolingConfigSchema",
      "DmScopeConfig",
      "ModelRoutes",
      "PruningConfig",
      "HeartbeatTarget",
      "PerAgentCronConfig",
      "PerAgentSchedulerConfig",
      "TracingConfig",
      "ChannelConfig",
      "ChannelEntry",
      "ChannelHealthCheckConfig",
      // AckReactionConfig: the only in-repo consumer
      // (ChannelManagerDeps.ackReactionConfig field, plus its mirror on
      // InboundPipelineDeps and SetupDeps) was deleted — the deps slot was
      // never wired by the daemon and the absent-mode (no ack reactions sent
      // through inbound setup; lifecycle reactor owns the reaction surface
      // when enabled) IS the production code path. Schema + type stay on the
      // public surface (AckReactionConfigSchema is operator-facing YAML)
      // until a future cleanup consolidates the schema under the
      // lifecycle-reactor section.
      "AckReactionConfig",
      "CompactionConfig",
      "RetentionConfig",
      "SecurityConfig",
      "PermissionConfig",
      "ActionConfirmationConfig",
      "DaemonConfig",
      "TracingDefaults",
      "ConfigWebhook",
      "GatewayTlsConfig",
      "GatewayToken",
      "GatewayRateLimit",
      "IntegrationsConfig",
      "BraveSearchConfig",
      "McpConfig",
      "ElevenLabsVoiceSettings",
      "ImageAnalysisConfig",
      "MediaConfig",
      "AutoReplyRule",
      "AutoReplyConfig",
      "MonitoringConfig",
      "PluginsConfig",
      "PluginEntry",
      "QueueMode",
      "OverflowPolicy",
      "FollowupConfig",
      "TypingMode",
      "ChunkMode",
      "DeliveryMirrorConfig",
      "DeliveryQueueConfig",
      "DeliveryTimingMode",
      "GroupActivationMode",
      "SendAction",
      "WebhooksConfig",
      "AgentSecretsConfig",
      "ConfigError",
      "ConfigErrorCode",
      "HistoryEntry",
      "GitManagerDeps",
      "EnvValueWarning",
      "UnresolvedEnvRef",
      "DocumentationLink",
      "VerbosityOverride",
      "ProvidersConfig",
      "UserModel",
      "ModelCost",
      "OAuthConfig",
      "createPluginRegistry",
      "createHookRunner",
      "BeforeAgentStartResultSchema",
      "BeforeToolCallResultSchema",
      "ToolResultPersistResultSchema",
      "BeforeCompactionResultSchema",
      "BeforeDeliveryResultSchema",
      "mergeBeforeAgentStart",
      "mergeBeforeToolCall",
      "mergeToolResultPersist",
      "mergeBeforeCompaction",
      "mergeBeforeDelivery",
      // setGlobalHookRunner / getGlobalHookRunner / clearGlobalHookRunner
      // were removed when packages/core/src/hooks/hook-runner-global.ts
      // was deleted. Delivery composition now threads HookRunner via
      // DeliveryServiceDeps.
      "PluginRegistryOptions",
      "HookRunnerOptions",
      "ApprovalGateDeps",
      "getAllToolMetadata",
      "assertEnvLoaded",
      "resetEnvLoadedForTest",
      "RequestContextSchema",
      "UserTrustLevelSchema",
      "getContext",
      "RequestContext",
      "BootstrapOptions",
      // The Markdown IR pipeline + delivery helpers moved from
      // @comis/channels/src/shared/ to @comis/core/src/delivery/. These
      // 9 entries are baseline orphans post-move: 5 were @comis/channels
      // baseline orphans before (PERMANENT_ERROR_PATTERNS,
      // ChunkForDeliveryOptions, guardTelegramFileRefs,
      // isTelegramFileGuardEnabled, ALWAYS_GUARD_EXTENSIONS,
      // AMBIGUOUS_EXTENSIONS), 3 are newly-public surfaces (parseMarkdownToIR,
      // BlockRetryGuard), and 1 is RetryConfig — previously consumed
      // cross-package via @comis/core but now consumed only via the
      // intra-core relative import in delivery/retry-engine.ts.
      "RetryConfig",
      "ChunkForDeliveryOptions",
      "BlockRetryGuard",
      "PERMANENT_ERROR_PATTERNS",
      "parseMarkdownToIR",
      "guardTelegramFileRefs",
      "isTelegramFileGuardEnabled",
      "ALWAYS_GUARD_EXTENSIONS",
      "AMBIGUOUS_EXTENSIONS",
      // The createDeliveryService factory + DeliveryService /
      // DeliveryServiceDeps interfaces are surfaced before production
      // callers migrate. Once daemon/wiring (setup-channels,
      // message-handlers, setup-cross-session) and the channels
      // execution-pipeline / approval-notifier / inbound-gate consume
      // them, these three entries will have in-repo consumers and these
      // baseline-orphan entries can be removed. Until then they live here.
      "createDeliveryService",
      "DeliveryService",
      "DeliveryServiceDeps",
      // Symbols formerly exported by @comis/channels via
      // packages/channels/src/shared/deliver-to-channel.ts. They were
      // re-exported from @comis/core via core/src/exports/delivery.ts
      // for surface continuity. After the deletion of the channels-side
      // file, the only in-repo consumer of QUEUE_BACKOFF_SCHEDULE_MS /
      // resolveChunkLimit / chunkBlocks / DeliveryStrategy /
      // ChunkDeliveryResult / DeliveryResult was the deleted file; the
      // helpers remain on the public surface (downstream embedders may
      // consume them). computeQueueBackoff has an in-repo consumer
      // (daemon's setup-delivery.ts) so it is NOT listed here.
      "QUEUE_BACKOFF_SCHEDULE_MS",
      "resolveChunkLimit",
      "chunkBlocks",
      "DeliveryStrategy",
      "ChunkDeliveryResult",
      "DeliveryResult",
      // Contract-registry foundation. The registry + its types/helpers are
      // the public surface that handlers, CLI client, and codegen consume.
      // The bidirectional + allowlist + internal-fields architecture tests
      // exercise them at test-time, but the public-export-consumers walker
      // only follows `import ... from "@comis/<pkg>"` statements outside
      // the package — architecture tests are an in-repo consumer for the
      // value-side, but the walker scope intentionally excludes them.
      "API_CONTRACTS",
      "API_CONTRACTS_ORDERED",
      "ApiContract",
      "Scope",
      "MethodName",
      "defineContract",
      "INTERNAL_FIELD_NAMES",
      "stripInternalFields",
      // Autonomy-domain admin contracts (213-03, REVOKE-01/03). LeaseRevokeContract
      // + RunKillContract are scopes:["admin"] RPC contracts declared in Wave 1
      // (this plan); their `[LeaseRevokeContract.method]` / `[RunKillContract.method]`
      // daemon handlers land in Plan 06 (Wave 3) — a documented cross-wave seam
      // (the same VideoGenerateContract pattern in @comis/core/media). Until the
      // handler lands they have no in-repo consumer; the bidirectional 1:1 +
      // codegen-drift arch tests exercise them at test-time. AUTONOMY_HANDLERS_CONTRACTS
      // is the per-domain aggregator array, composed into ORCHESTRATOR_CONTRACTS →
      // API_CONTRACTS_ORDERED intra-package (the walker skips self-imports).
      "LeaseRevokeContract",
      "RunKillContract",
      "AUTONOMY_HANDLERS_CONTRACTS",
      // Capabilities-domain aggregator (215, INTRO-01/02). Same pattern as
      // DAEMON_CONTRACTS / AUTH_CONTRACTS: the per-method
      // `CapabilitiesIntrospectContract` HAS in-repo consumers (its
      // `[CapabilitiesIntrospectContract.method]` daemon handler in
      // capabilities-handlers.ts + the `comis whoami` CLI in commands/whoami.ts),
      // so it is NOT policy-listed. `CAPABILITIES_CONTRACTS` IS policy-listed: it
      // is composed into `API_CONTRACTS_ORDERED` inside @comis/core's own
      // index.ts (intra-package — the walker skips self-imports), and no external
      // consumer imports the per-domain array directly.
      "CAPABILITIES_CONTRACTS",
      // Daemon-domain contracts. The per-method contracts
      // (`DaemonSetLogLevelContract`, `SystemPingContract`) have in-repo
      // consumers (daemon-handlers.ts + CLI's daemon-guard.ts +
      // commands/daemon.ts), so they are NOT policy-listed here.
      // `DAEMON_CONTRACTS` IS policy-listed: it is composed into
      // `API_CONTRACTS_ORDERED` inside @comis/core's own index.ts
      // (intra-package — the walker skips self-imports), and no external
      // consumer imports the per-domain array directly.
      "DAEMON_CONTRACTS",
      // Auth-domain contracts. Same pattern as DAEMON_CONTRACTS:
      // `AuthListContract` + `AuthLogoutContract` have in-repo consumers
      // (daemon-handlers.ts + commands/auth.ts), so only the per-domain
      // aggregator array `AUTH_CONTRACTS` lacks an external consumer
      // (composed into `API_CONTRACTS_ORDERED` intra-package).
      "AUTH_CONTRACTS",
      // Secrets-domain contracts. The 4 per-method contracts
      // (SecretsSetContract, SecretsGetContract, SecretsListContract,
      // SecretsDeleteContract) have in-repo consumers
      // (packages/daemon/src/api/secrets-handlers.ts +
      // packages/cli/src/commands/secrets.ts), so only the per-domain
      // aggregator array `SECRETS_CONTRACTS` lacks an external consumer
      // (composed into `API_CONTRACTS_ORDERED` intra-package).
      "SECRETS_CONTRACTS",
      // Tokens-domain contracts. Web-SPA-only: no CLI consumer exists for
      // `tokens.list|create|revoke|rotate` in packages/cli/src/commands/.
      // The 4 per-method contracts (TokensListContract,
      // TokensCreateContract, TokensRevokeContract, TokensRotateContract)
      // have in-repo consumers via packages/daemon/src/api/token-handlers.ts.
      // The web SPA consumes its own typed registry at
      // packages/web/src/api/types/rpc-registry.ts (not @comis/core directly);
      // codegen bridges those types from this contract registry. Only the
      // per-domain aggregator array `TOKENS_CONTRACTS` lacks an external
      // consumer (composed into `API_CONTRACTS_ORDERED` intra-package).
      "TOKENS_CONTRACTS",
      // MCP-domain contracts. Web-SPA-only: no CLI consumer exists for
      // `mcp.list|status|connect|disconnect|reconnect|test` in
      // packages/cli/src/commands/. (The CLI's `comis mcp` surface touches
      // `config.read` / `config.patch` for `integrations.mcp.servers`
      // entries, NOT these admin RPCs.) The 6 per-method contracts
      // (McpListContract, McpStatusContract, McpConnectContract,
      // McpDisconnectContract, McpReconnectContract, McpTestContract) have
      // in-repo consumers via packages/daemon/src/api/mcp-handlers.ts. The
      // web SPA consumes its own typed registry; codegen bridges those
      // types from this contract registry. Only the per-domain aggregator
      // array `MCP_CONTRACTS` lacks an external consumer (composed into
      // `API_CONTRACTS_ORDERED` intra-package).
      "MCP_CONTRACTS",
      // Config + env + gateway-infrastructure contracts (12 methods:
      // 8 config.* + 2 gateway.* + 2 env.*). The 12 per-method contracts
      // (ConfigReadContract, ConfigSchemaContract, ConfigPatchContract,
      // ConfigApplyContract, ConfigHistoryContract, ConfigDiffContract,
      // ConfigRollbackContract, ConfigGcContract, GatewayStatusContract,
      // GatewayRestartContract, EnvSetContract, EnvListContract) have
      // in-repo consumers via packages/daemon/src/api/config-handlers.ts +
      // packages/daemon/src/api/env-handlers.ts + the CLI retarget
      // (packages/cli/src/commands/config.ts imports ConfigReadContract /
      // ConfigPatchContract / ConfigHistoryContract / ConfigDiffContract /
      // ConfigRollbackContract). Only the per-domain aggregator array
      // `CONFIG_CONTRACTS` lacks an external consumer (composed into
      // `API_CONTRACTS_ORDERED` intra-package — the walker skips
      // self-imports).
      "CONFIG_CONTRACTS",
      // Observability-domain contracts (18 methods: obs.diagnostics + 5
      // obs.billing.* + 3 obs.channels.* + 2 obs.delivery.* + 2 obs.context.* +
      // 2 obs.reset.* + obs.getCacheStats + agent.cacheStats +
      // memory.embeddingCache). Web-SPA-only (verified via empty CLI grep
      // for `client.call("obs.*|"agent.cacheStats|"memory.embeddingCache`).
      // The 18 per-method contracts have in-repo consumers via
      // packages/daemon/src/api/obs-handlers.ts (imports all 18 contracts +
      // uses each as a computed property key). Only the per-domain aggregator
      // array `OBSERVABILITY_CONTRACTS` lacks an external consumer
      // (composed into `API_CONTRACTS_ORDERED` intra-package — the walker
      // skips self-imports).
      "OBSERVABILITY_CONTRACTS",
      // Workspace-umbrella contracts (36 methods spanning 5 handler-factory
      // files that share the WorkspaceApiDeps cluster slice):
      //   - workspace-handlers.ts  (12 methods)
      //   - browser-handlers.ts    (13 methods)
      //   - approval-handlers.ts   ( 4 methods incl. admin.approval.resolveAll)
      //   - skill-handlers.ts      ( 6 methods incl. skills.create / skills.update)
      //   - notification-handlers.ts ( 1 method: notification.send)
      // Web-SPA-only (verified via empty CLI grep). The 36 per-method
      // contracts have in-repo consumers via the 5 handler factories
      // (imports + computed property keys). Only the per-domain aggregator
      // array `WORKSPACE_CONTRACTS` lacks an external consumer (composed
      // into `API_CONTRACTS_ORDERED` intra-package).
      "WORKSPACE_CONTRACTS",
      // Memory + context-domain contracts (15 methods spanning 2
      // handler-factory files that share the MemoryApiDeps cluster slice):
      //   - memory-handlers.ts  (8 methods)
      //   - context-handlers.ts (7 methods)
      // The 19 per-method contracts (8 memory + 4 diagnostics + 7
      // context) have in-repo consumers via both
      // handler factories (imports + computed property keys). Only the
      // per-domain aggregator arrays MEMORY_CONTRACTS / MEMORY_DIAGNOSTIC_CONTRACTS
      // lack an external consumer (composed into API_CONTRACTS_ORDERED /
      // spread into MEMORY_CONTRACTS intra-package — the walker skips
      // self-imports). MEMORY_DIAGNOSTIC_CONTRACTS is the
      // diagnostic group, now folded into MEMORY_CONTRACTS but still surfaced
      // on the public barrel for symmetry with the other domain arrays.
      // MEMORY_PORTABILITY_CONTRACTS is the portability-methods slice array
      // (extracted to keep memory.ts ≤ 800 lines); spread into MEMORY_CONTRACTS
      // intra-package — same pattern as MEMORY_DIAGNOSTIC_CONTRACTS.
      // MEMORY_PINNING_CONTRACTS is the pinning-methods slice array (memory.pin/
      // memory.unpin), extracted to memory-pinning.ts and spread into
      // MEMORY_CONTRACTS intra-package — same pattern as the arrays above.
      "MEMORY_CONTRACTS",
      "MEMORY_DIAGNOSTIC_CONTRACTS",
      "MEMORY_PORTABILITY_CONTRACTS",
      "MEMORY_PINNING_CONTRACTS",
      // (The memory.ask cross-wave seam is now closed: MemoryAskContract
      // is spread into MEMORY_CONTRACTS in the same diff that landed its daemon
      // handler in memory-handlers.ts — its in-repo consumer now exists — so it was
      // REMOVED from this ahead-of-consumer allowlist.)
      // Media + image-domain contracts (16 methods spanning 2
      // handler-factory files that share the MediaApiDeps cluster slice):
      //   - media-handlers.ts  (15 methods)
      //   - image-handlers.ts  ( 1 method)
      // The 16 per-method contracts have in-repo consumers via both
      // handler factories (imports + computed property keys). Only the
      // per-domain aggregator array MEDIA_CONTRACTS lacks an external
      // consumer (composed into API_CONTRACTS_ORDERED intra-package —
      // the walker skips self-imports).
      "MEDIA_CONTRACTS",
      // Agents + models + providers-domain contracts (17 methods spanning
      // 3 handler-factory files that share the AgentsApiDeps cluster slice):
      //   - agent-handlers.ts     (7 methods — agents.* + agent.getOperationModels)
      //   - model-handlers.ts     (3 methods — models.*)
      //   - provider-handlers.ts  (7 methods — providers.*)
      // The 17 per-method contracts have in-repo consumers via all 3
      // handler factories (imports + computed property keys) AND via 3 CLI
      // command files (callTyped retargets in commands/agent.ts +
      // commands/models.ts + commands/providers.ts). Only the per-domain
      // aggregator array AGENTS_CONTRACTS lacks an external consumer
      // (composed into API_CONTRACTS_ORDERED intra-package — the walker
      // skips self-imports).
      "AGENTS_CONTRACTS",
      // Context (LCD lossless-store) operator-browse contracts (2 methods:
      // context.conversations + context.tree) backing the web Context DAG
      // browser. The 2 per-method contracts have an in-repo consumer via
      // packages/daemon/src/api/context-handlers.ts (imports + computed property
      // keys). Web-SPA-only (no CLI consumer). Only the per-domain aggregator
      // array CONTEXT_CONTRACTS lacks an external consumer (composed into
      // API_CONTRACTS_ORDERED intra-package — the walker skips self-imports).
      "CONTEXT_CONTRACTS",
      // Channels + message + platform-action contracts (19 methods spanning
      // 2 handler-factory files that share the ChannelsApiDeps cluster slice):
      //   - channel-handlers.ts  (8 methods — channels.* + delivery.queue.status)
      //   - message-handlers.ts  (11 methods — message.* + 4 platform.action)
      // Web-SPA-only (verified via empty CLI grep for
      // `client.call("channels.*|"message.*|"telegram.action|"discord.action|
      // "slack.action|"whatsapp.action|"delivery.queue.status`). The 19
      // per-method contracts have in-repo consumers via both handler
      // factories (imports + computed property keys). Only the per-domain
      // aggregator array CHANNELS_CONTRACTS lacks an external consumer
      // (composed into API_CONTRACTS_ORDERED intra-package — the walker
      // skips self-imports).
      "CHANNELS_CONTRACTS",
      // Orchestrator-umbrella contracts (27 methods spanning 4
      // handler-factory files that share the OrchestratorApiDeps cluster
      // slice):
      //   - cron-handlers.ts       (8 methods — cron.* + scheduler.wake)
      //   - graph-handlers.ts      (12 methods — graph.*)
      //   - heartbeat-handlers.ts  (4 methods — heartbeat.*)
      //   - subagent-handlers.ts   (3 methods — subagent.*)
      // Web-SPA-only (verified via empty CLI grep for
      // `client.call("cron.*|"graph.*|"heartbeat.*|"subagent.*`). The 27
      // per-method contracts have in-repo consumers via all 4 handler
      // factories (imports + computed property keys). setup-gateway-api.ts
      // has no inline cron.add special-case registration; the handler body
      // normalizes both web (nested schedule) and legacy (flat) shapes.
      // The single-scope invariant is verified by orchestrator.test.ts.
      // Only the per-domain aggregator array ORCHESTRATOR_CONTRACTS lacks
      // an external consumer (composed into API_CONTRACTS_ORDERED
      // intra-package — the walker skips self-imports).
      "ORCHESTRATOR_CONTRACTS",
      // Per-family slice arrays introduced by the workspace.ts and
      // orchestrator.ts subdirectory splits. Each slice array is composed
      // into the parent aggregator (WORKSPACE_CONTRACTS /
      // ORCHESTRATOR_CONTRACTS) inside @comis/core itself via the
      // subdirectory `index.ts` barrel — same self-import skip rule as
      // the parent aggregator arrays above. The `export *` from each
      // family file in the barrel surfaces these slice consts on
      // @comis/core's public barrel; tightening to named re-exports
      // without the slice consts would require listing 36 + 27 individual
      // contracts in the sub-aggregators, which would be a
      // determinism-fragile change (any future contract added to a
      // handler-family file would need a matching named export in the
      // aggregator).
      "WORKSPACE_HANDLERS_CONTRACTS",
      "BROWSER_HANDLERS_CONTRACTS",
      "APPROVAL_HANDLERS_CONTRACTS",
      "SKILL_HANDLERS_CONTRACTS",
      "NOTIFICATION_HANDLERS_CONTRACTS",
      "CRON_HANDLERS_CONTRACTS",
      "GRAPH_HANDLERS_CONTRACTS",
      "HEARTBEAT_HANDLERS_CONTRACTS",
      "SUBAGENT_HANDLERS_CONTRACTS",
      // Sessions contracts (12 methods spanning the single
      // session-handlers.ts factory file that owns the SessionsApiDeps
      // cluster slice): session.status / agents.list / session.list /
      // session.search / session.history / session.send / session.spawn /
      // session.run_status / session.delete / session.reset /
      // session.export / session.compact. CLI consumers: 5 sites
      // retargeted to callTyped across packages/cli/src/commands/sessions.ts
      // (3 sites) + packages/cli/src/commands/reset.ts (2 sites). The 12
      // per-method contracts have in-repo consumers via the handler factory
      // (imports + computed property keys) AND the CLI command files. Only
      // the per-domain aggregator array SESSIONS_CONTRACTS lacks an
      // external consumer (composed into API_CONTRACTS_ORDERED
      // intra-package — the walker skips self-imports).
      "SESSIONS_CONTRACTS",
      // Four runtime adapters in @comis/core that severed the last
      // cli → @comis/agent + cli → @comis/infra import sites. The adapters
      // landed additively; the existing scheduler-side `createFileLock`
      // and agent-side `isRemoteEnvironment` stayed in place until the
      // CLI retarget completed. With no in-repo consumer importing these
      // names FROM @comis/core, they're tracked as planned-orphan policy
      // entries (same pattern as the contract-registry entries directly
      // above). `isDocker` already had a consumer and is NOT listed.
      "isRemoteEnvironment",
      "IsRemoteEnvironmentInput",
      "createConsoleLogger",
      "createFileLock",
      "ExecutionLockOptions",
      // Note: withExecutionLock + isLocked are preserved verbatim inside
      // packages/core/src/runtime/file-lock.ts for byte-equivalence with
      // the relocation source (scheduler/src/execution/execution-lock.ts),
      // but they are NOT re-exported via the @comis/core barrel — the
      // canonical non-scheduler surface is createFileLock(): FileLockPort.
      // No policy entry needed for them; the public-export-consumers gate
      // only walks the @comis/core barrel surface.
      //
      // OAuth helpers relocated from @comis/agent. Agent re-exports remain
      // live so existing in-tree consumers (CLI, daemon, wizard) resolve
      // through @comis/agent. The @comis/core barrel exposes the relocated
      // symbols but no in-repo source consumes them FROM @comis/core yet —
      // tracked here as planned-orphan policy entries.
      "selectOAuthCredentialStore",
      "SelectOAuthCredentialStoreInput",
      "OAuthStorageMode",
      "loginOpenAICodexOAuth",
      "LoginError",
      "LoginRunnerSuccess",
      "LoginRunnerParams",
      "RunnerPrompter",
      "OAuthError",
      "OAuthTokenManager",
      "OAuthTokenManagerDeps",
      "OAuthCredentials",
      "createOAuthCredentialStoreFile",
      "OAuthCredentialStoreFileConfig",
      "loginOpenAICodexDeviceCode",
      "DeviceCodeVerificationPrompt",
      "LoginOpenAICodexDeviceCodeOptions",
      // CLI + daemon consume createModelCatalog + workspace helpers from
      // @comis/core — only the subset of relocated symbols WITHOUT in-repo
      // consumers remains in policy. Each entry below tracks a specific
      // orphan that surfaces because the relocated agent source had no
      // test or import for the symbol outside the workspace barrel
      // (incrementOnboardingCount, TEMPLATE_MARKER, etc.). Removable when
      // a consumer materializes.
      "ZERO_COST",
      "PerTokenCostRates",
      "registerWorkspaceFilesInTracker",
      "TEMPLATE_MARKER",
      "readWorkspaceState",
      "writeWorkspaceState",
      "incrementOnboardingCount",
      "isIdentityFilled",
      "STATE_FILENAME",
      "WorkspaceStateSchema",
      "WorkspaceSeedTracker",
      "RegisterWorkspaceResult",
      "WorkspaceState",
      // runOAuthTlsPreflight relocated from @comis/agent — pure-function
      // relocation needed to close the last CLI → @comis/agent import edge.
      // Function is consumed by packages/cli/src/doctor/checks/oauth-health.ts
      // via the @comis/core barrel; the three type aliases below are
      // referenced only inside the module itself (no exported consumers yet —
      // future doctor checks may surface them when they need to discriminate
      // the result kinds).
      "TlsPreflightResult",
      "TlsPreflightFailureKind",
      "RunOAuthTlsPreflightOptions",
      // The following symbols had external consumers in agent's now-deleted
      // oauth-login-runner.ts / oauth-device-code.ts. The relocated copies
      // in @comis/core/oauth/ consume them via relative paths (not via the
      // @comis/core barrel), so the public-export-consumers gate now counts
      // them as orphans. The symbols themselves are still exported because
      // workspace helpers (workspace-resolver, workspace-manager) and other
      // internals continue to reference them — the surface is intentional,
      // just currently consumer-less outside core.
      "LockOptions",
      "LockError",
      "FileLockPort",
      "OAuthErrorCode",
      "resolveCodexAccessTokenExpiry",
      "EnsureWorkspaceOptions",
      "WorkspaceFiles",
      "WorkspaceStatus",
      // SystemIntervalHandle was the paired opaque-handle type for
      // `systemSetInterval`, consumed via mcp-client-types.ts state Map
      // generic + index.ts factory initializer. The SystemTimeoutHandle
      // consumer in packages/daemon/src/api/mcp-config-mutated-coalescer.ts
      // (trailing-edge debounce timer) removed the planned-orphan entry that
      // previously tracked SystemTimeoutHandle -- the symbol is now consumed.
      // The mcp.oauth_login / mcp.oauth_logout contract registry, mirroring
      // MCP_CONTRACTS / SESSION_CONTRACTS etc. Consumed by the dispatcher
      // composition + the contract-handler-parity AST walker, both of which
      // iterate the union of *_CONTRACTS arrays via patterns the AST
      // consumer-scan does not flag. Documented public-contract surface;
      // not a baseline orphan.
      "MCP_OAUTH_CONTRACTS",
      // Sub-agent tool governance symbols.
      // SUB_AGENT_TOOL_PROFILES is a static data copy (drift-guard tested in
      // tool-policy.test.ts — excluded from consumer scan). Its primary
      // production consumer is the spawn-time required_tools gate in
      // sub-agent-runner.ts. RequiredToolsUnreachableError +
      // UnreachableToolEntry are the error class + entry type thrown by that
      // gate. SUB_AGENT_TOOL_DENYLIST / toolReachableGroups have live in-repo
      // consumers (daemon + agent pi-event-bridge) and are NOT policy-listed.
      // SUB_AGENT_TOOL_GROUPS mirrors TOOL_GROUPS for gate
      // expansion; consumed by drift-guard test (excluded from scan)
      // and by computeReachableToolNames. computeReachableToolNames has a live
      // consumer in session-mutate.ts but the AST walker may miss daemon imports
      // that go through indirect re-exports — policy-listed for safety.
      "SUB_AGENT_TOOL_PROFILES",
      "SUB_AGENT_TOOL_GROUPS",
      "computeReachableToolNames",
      "RequiredToolsUnreachableError",
      "UnreachableToolEntry",
      // ── Memory consolidation (interface-first foundation) ──
      // The segregated MemoryConsolidationStore port + its DTOs are the
      // contract the consolidation adapter (@comis/memory), job
      // (@comis/agent), and daemon wiring depend on
      // existing first (the same interface-first pattern as MemoryEntityStore,
      // whose own consumers landed across its plans). Shipped on the
      // @comis/core barrel now; the in-repo consumers land later.
      // Shrink each entry as it gains a real consumer.
      "MemoryConsolidationStore",
      "ConsolidationCandidate",
      "ConsolidationPlan",
      // ── Memory pinning (interface-first foundation) ──
      // The segregated MemoryPinnedStore port is the agent↛memory build-cut
      // type: recall-types.ts imports this from @comis/core; the concrete
      // adapter lives in @comis/memory. In-repo consumers land across plans
      // 03-02..03-05. Shrink this entry as each consumer lands.
      "MemoryPinnedStore",
      // Provider-catalog symbols. The broker
      // in @comis/infra imports resolveBinding, applyInjections, normalizeHost,
      // BrokerBinding, InjectionRule, HostRule, InjectionInput — all consumed.
      // pathAllowed is exported for external callers that need to gate requests;
      // the broker uses resolveBinding (which calls pathAllowed internally).
      // Broker wiring in the daemon composition root lands later.
      "pathAllowed",
      // BrokerBindingConfigSchema: the Zod validator for a single executor.broker
      // binding entry. Operator-facing config schema; exported on the public
      // surface for embedders and CLI validation helpers. BrokerBindingConfig (the
      // inferred type) IS consumed by packages/daemon/src/wiring/
      // broker-placeholder-builder.ts (satisfies the type-consumer gate).
      // BrokerBindingConfigSchema (the value, the Zod schema object) has no
      // cross-package consumer yet — the daemon calls the config system via the
      // schema-executor.ts registered schema, not by importing the Zod object
      // directly. Tracked here as a planned-orphan policy entry until a runtime
      // validation site outside @comis/core emerges (e.g. a CLI `broker validate`
      // command or a broker health-check handler).
      "BrokerBindingConfigSchema",
      // Trust-first bi-temporal KG port. The
      // TripleStorePort interface + TripleScope + TripleInput already have real
      // in-repo consumers (the @comis/memory adapter imports them by TYPE). The
      // TripleTrust ladder alias is referenced only INSIDE TripleInput.trust (a
      // field type, not a standalone import), so the export-graph walker counts
      // it as an orphan. It is part of the documented port API surface (callers
      // construct a TripleInput by naming the trust literal) — tracked here.
      // Shrinks when the offline writer / lane reference it directly.
      "TripleTrust",
      // Per-user representation port + prefix-type enum.
      // This is the first piece: the type-only
      // UserRepresentationStore port + the UserRepresentationType prefix-type enum
      // are the contract every later piece consumes — the SOLE @comis/memory
      // adapter, the offline profile-builder, the LLM-free
      // prompt-assembly injection, and the daemon wiring all
      // import these from @comis/core BY TYPE (never @comis/memory — the agent↛
      // memory build cut). No in-repo consumer exists yet (the adapter lands
      // later), so the export-graph walker counts them as orphans. They are the
      // documented port API surface — tracked here as planned-orphans,
      // mirror the TripleStorePort / MemoryEmbeddingStore ahead-of-consumer dance.
      // Shrinks as the adapter (by TYPE) → the builder/injection →
      // the daemon wiring reference each name directly.
      "UserRepresentationStore",
      "UserRepresentationScope",
      // UserRepresentationTrust is referenced only INSIDE UserRepresentationInput.trust
      // (a field type, not a standalone import) — the same orphan shape as TripleTrust.
      "UserRepresentationTrust",
      "UserRepresentationEntry",
      "UserRepresentationInput",
      // The prefix-type enum (value schema + inferred type). The builder
      // classifies entries with UserRepresentationTypeSchema; the port consumes the
      // inferred UserRepresentationType. Shrinks when those consumers land.
      "UserRepresentationTypeSchema",
      "UserRepresentationType",
      // Directional relationship port. This is
      // the first piece: the type-only RelationshipStore port
      // carrying the directional (subjectUserId, aboutUserId) pair + the
      // (tenant, agent, channel) scope is the contract every later piece consumes —
      // the SOLE @comis/memory adapter, the offline directional builder,
      // the (optional) LLM-free injection, and the daemon wiring all import these
      // from @comis/core BY TYPE (never @comis/memory — the agent↛memory build cut).
      // No in-repo consumer exists yet (the adapter lands later), so the
      // export-graph walker counts them as orphans. They are the documented
      // port API surface — tracked here as planned-orphans, mirror the
      // UserRepresentationStore / TripleStorePort ahead-of-consumer dance. Shrinks as
      // the adapter (by TYPE) → the builder/injection → the daemon wiring
      // reference each name directly.
      "RelationshipStore",
      "RelationshipScope",
      // RelationshipTrust is referenced only INSIDE RelationshipInput.trust (a field
      // type, not a standalone import) — the same orphan shape as TripleTrust /
      // UserRepresentationTrust.
      "RelationshipTrust",
      "RelationshipEntry",
      "RelationshipInput",
      // StorageModePreRead is the return type of preReadStorageMode (daemon-boot
      // pre-read); the daemon imports preReadStorageMode (which has an in-repo
      // consumer) but does not import the return type name directly, so it is an
      // orphan export that shrinks when a real cross-package consumer materializes.
      "StorageModePreRead",
      // Memory-portability envelope types + schemas. The CLI imports
      // parseMemoryExportEnvelope (the value function — satisfies the gate) but
      // does NOT import the schema values (MemoryExportEnvelopeSchema /
      // MemoryExportEntrySchema) or the inferred types (MemoryExportEnvelope /
      // MemoryExportEntry) by name — these are structural consumers only. Tracked
      // here as planned-orphan policy entries; shrink when a cross-package
      // consumer imports them by name.
      "MemoryExportEnvelopeSchema",
      "MemoryExportEntrySchema",
      "MemoryExportEnvelope",
      "MemoryExportEntry",
      // LCD provenance read port + write input type (172-01 contract layer).
      // LcdProvenanceReadStore is the read-side port consumed BY TYPE in
      // @comis/agent's distillation runner (lcd-distillation-runner.ts) via the
      // ContextStorePort optional methods (appendProvenance? / markProvenanceSuperseded?).
      // AppendProvenanceInput is the payload type for those optional methods.
      // The agent package imports only @comis/core types (never @comis/memory — the
      // agent↛memory architecture cut); the concrete SQLite adapter lives in
      // @comis/memory and is injected by the daemon. The AST walker counts them as
      // orphans because the agent imports them by TYPE only (erased at runtime).
      // Shrinks when the daemon wiring or a cross-package consumer imports them by name.
      "LcdProvenanceReadStore",
      "AppendProvenanceInput",
      // ── script classification (Phase 179) ───────────────────────────
      // SCRIPT_CLASSES + the classifier functions ship dark in 179. Phase 180's
      // consumers landed (FTS routing + the OBS-01 event sites + the LcdSearchResult
      // widening), so the symbols that gained a real cross-package consumer were
      // SHRUNK from this list in plan 180-08:
      //   - dominantScript → value-consumed by @comis/memory (lcd-fts.ts) AND
      //     @comis/agent (compaction-zone-helpers.ts, the summary_language_mismatch
      //     detector) — REMOVED.
      //   - ScriptClass → type-consumed by @comis/memory (lcd-fts.ts LcdSearchResult
      //     `scriptZeroHit`) — REMOVED.
      // The following SURVIVE — their only consumers are core-internal (relative
      // imports inside packages/core/src/text), which the cross-package AST walker
      // does not count, so removing them would fail public-export-consumers:
      //   - scriptShares: the expected Phase 181 DET-02 (reply-language resolver)
      //     consumer; today used only inside dominantScript (script-classes.ts).
      //   - classifyCodepoint: consumed only by core-internal token-factor.ts +
      //     trigram-query.ts (relative imports) — no cross-package caller yet.
      //   - SCRIPT_CLASSES / ScriptClassRow: the data table + its row type; consumed
      //     only inside core (script-classes.ts / token-factor.ts) — Phase 181/182.
      // Shrink each remaining entry as a real cross-package production caller lands.
      "SCRIPT_CLASSES",
      "ScriptClassRow",
      "classifyCodepoint",
      "scriptShares",
      // ── search primitives (Phase 180) ───────────────────────────────
      // normalizeForSearch (FTS-02) + routeSearchQuery/TrigramRoute/SearchLane
      // (FTS-01) shipped dark in plan 180-01. Plan 180-08 swept these now that the
      // memory/cli consumers (plans 180-04..180-07) exist:
      //   - normalizeForSearch → value-consumed by @comis/memory (lcd-store-fts-populate,
      //     row-mapper, sqlite-memory-consolidation-store, lcd-fts) AND @comis/cli
      //     (doctor/repairs/repair-lcd) — REMOVED.
      //   - routeSearchQuery → value-consumed by @comis/memory (lcd-fts, hybrid-search)
      //     — REMOVED.
      //   - SearchLane → type-consumed by @comis/memory (lcd-fts.ts) — REMOVED.
      // TrigramRoute SURVIVES: routeSearchQuery returns it, but no cross-package file
      // imports the type NAME (callers use it inline via the returned value), so the
      // walker still counts it an orphan. Shrink when a consumer imports it by name.
      "TrigramRoute",
      // ── agent autonomy named-profile resolver (Phase 210 / v8 §3.8) ──
      // The §3.8 named-profile layer (AutonomyConfigSchema -> resolveAutonomy)
      // lands FIRST so the cap injection (Plan 04: createAgentRpcCall computes
      // _capabilities from resolveAutonomy(agent.autonomy)) and the legible
      // boot log (Plan 06) receive the exact resolved cap/guard shape. Until
      // those land, the only callers are this leaf's own tests + the
      // section-registry/serializer derivations (intra-core, excluded from the
      // consumer scan). Shrink each entry as a real cross-package production
      // caller lands.
      "AutonomyConfigSchema",
      "AutonomyMessageConfigSchema",
      "AUTONOMY_PROFILES",
      "AGENT_CAPABILITIES",
      "STANDARD_FLOOR_CAPABILITIES",
      "resolveAutonomy",
      "AutonomyConfig",
      "AutonomyMessageConfig",
      "AutonomyProfileName",
      "AutonomyMode",
      "AgentCapability",
      "ResolvedAutonomy",
      "ResolvedCapability",
      // Honest legible degrade (Phase 210 / PROFILE-03). Consumed by the daemon
      // boot log + the preflight doctor (Plan 06, same wave). Listed here so the
      // type-only `AutonomyDownshift`/`AutonomyPreflightResult` (erased at runtime,
      // never named cross-package) don't read as orphans; shrink as those callers
      // import them by name.
      "degradeAutonomy",
      "AutonomyDownshift",
      "AutonomyPreflightResult",
      // The security-layer capability primitives (Phase 210 / security/capability.ts).
      // AGENT_CAPABILITIES + AgentCapability above are imported from this same
      // canonical module (single source of truth — the config leaf no longer keeps
      // its own copy). The cross-package consumer lands with Plan 04 (daemon handler
      // gating: requireCapability on each gated handler reads injected _capabilities).
      "checkCapability",
      "requireCapability",
      "CapabilityDeniedError",
      // HANDLER_CAPABILITY_MAP — the single auditable method→capability
      // source-of-truth (CAP-04, security/capability.ts). It is consumed TODAY
      // inside @comis/core (the capability layer's own invariant tests assert
      // map↔gate parity) and by the daemon's per-handler gate, but the daemon's
      // _capabilities injection (Plan 04) reads it via the resolveAutonomy →
      // _capabilities flow rather than name-importing the map, so the
      // cross-package name-consumer scan sees no importer yet. The full
      // cross-package consumers (an operator-facing capability-audit surface that
      // enumerates the map, and the gateway-side gate enumeration) land in Phase
      // 211/212. HandlerCapabilityClassification + GatedMethodName are the map's
      // value/key shape types (erased at runtime, never named cross-package).
      // Shrink each entry as a real cross-package name-importer lands.
      "HANDLER_CAPABILITY_MAP",
      "HandlerCapabilityClassification",
      "GatedMethodName",
      // SELF_SCOPED_AGENT_READS (Phase 219, CLI-01/02): the tight cap-socket
      // audience exception. The VALUE const is consumed cross-package by the
      // @comis/infra lease audience (lease-manager.ts), so it has a real
      // name-importer and is NOT tracked here. SelfScopedAgentRead is the const's
      // erased member type (runtime-free, never named cross-package yet) — tracked
      // here beside GatedMethodName until a real type-importer lands.
      "SelfScopedAgentRead",
      // CliSubcommand (Phase 219, CLI-01): the comis-agent subcommand→{tool|method}
      // table's `keyof typeof` key type, erased at runtime and never named
      // cross-package yet — tracked here beside GatedMethodName until a real
      // cross-package type-importer lands. The VALUE const CLI_SUBCOMMAND_MAP and
      // the CliCallTarget shape type are NOT tracked here: the @comis/skills
      // comis-agent-cli.ts name-imports both from @comis/core (real consumers).
      "CliSubcommand",
      // ── Durability-resume engine (Phase 216, interface-first Wave 1) ──
      // The DurableRunPort (run checkpoint store) + OutwardSendLedgerPort
      // (three-state outward-send ledger) + the DurableRunRecord domain type +
      // the ChannelPort.reconcileSend? query/outcome types land FIRST (Plan
      // 216-01) so every downstream plan implements against one contract: the
      // SQLite stores (Wave 2), the resume engine + adapters (Wave 3), the boot
      // wiring (Wave 4). Until those land, the only callers are this plan's own
      // domain test (intra-core, excluded from the consumer scan). Shrink each
      // entry as a real cross-package production consumer lands — the SQLite
      // adapter (@comis/memory, Wave 2) consumes the port + record types, the
      // daemon resume wiring (Wave 4) consumes the ports, and the channel
      // adapters consume ReconcileSendQuery/ReconcileSendOutcome. Mirrors the
      // Phase 212 tool.invoke + Phase 211 validateBindMount + Phase 199 REACT-01
      // interface-first precedents above. parseDurableRunRecord/the *Schema
      // values are part of the documented durability API surface.
      "DurableRunPort",
      "DurableRunStatusSchema",
      "DurableRunStatus",
      "DurableRunRecordSchema",
      "DurableRunRecord",
      "parseDurableRunRecord",
      "AgentCapabilitySchema",
      "OutwardSendLedgerPort",
      "OutwardSendState",
      "ReconcileOutcome",
      "OutwardSendRecord",
      "OutwardSendBeginInput",
      "ReconcileSendQuery",
      "ReconcileSendOutcome",
    ])],
    // @comis/daemon: baseline orphans tracked here. All three
    // value-side root re-exports (createAnnouncementDeadLetterQueue,
    // createAgentHandlers, createTracingLogger)
    // DO have real test consumers — they are tracked here only because
    // the public-export-consumers AST walker excludes `test/**` and
    // ignores dynamic `require("@comis/daemon")` patterns (it walks
    // only static `import`/`export from` declarations outside the
    // package). Per the Path B disposition: each surviving re-export has a
    // documented test caller; no further deletion is safe without
    // retargeting those consumers.
    //
    // Consumer audit (2026-05-21):
    //   - createAnnouncementDeadLetterQueue / AnnouncementDeadLetterQueue / DeadLetterEntry
    //     → test/integration/resilience-e2e-dead-letter.test.ts:22 (static import)
    //   - createAgentHandlers / AgentHandlerDeps
    //     → test/integration/oauth-multi-account.test.ts:80,580 (static import +
    //       direct factory call — drives the agents.update RPC handler against a
    //       shared agents map mirroring the daemon-runtime container.config.agents
    //       pattern at daemon.ts:594/634)
    //   - createTracingLogger / TracingLoggerOptions
    //     → test/support/daemon-harness.ts:434-442 (DYNAMIC require("@comis/daemon"),
    //       threads LoggerOptions.disableRedaction through to the daemon's
    //       production logger for the residency integration test)
    ["@comis/daemon", new Set<string>([
      "main",
      "DaemonInstance",
      "DaemonOverrides",
      // Sub-agent runtime relocated to @comis/agent. The 9 entries
      // previously tracked here (createSubAgentRunner,
      // ANNOUNCE_PARENT_TIMEOUT_MS, the 4 type names, sweepResultFiles,
      // buildAnnouncementMessage, deliverFailureNotification) have been
      // removed from packages/daemon/src/index.ts and the 7 orphan entries
      // are now tracked under @comis/agent above.
      "createAnnouncementDeadLetterQueue",
      "AnnouncementDeadLetterQueue",
      "DeadLetterEntry",
      "createAgentHandlers",
      "AgentHandlerDeps",
      // MCP install persistence — re-exported so the integration test at
      // test/integration/mcp-persistence.test.ts can drive the real
      // mcp.connect / mcp.disconnect handlers against a tmpdir config path.
      // The test imports these statically from @comis/daemon, but the
      // public-export-consumers AST walker only scans packages/*/src/**
      // (NOT test/), so the orphan list is the canonical place to record
      // these intentional test-only public exports.
      "createMcpHandlers",
      "McpHandlerDeps",
      // Memory + memory-diagnostic handlers — re-exported so the integration
      // test at test/integration/security/recall-diagnostics-isolation.test.ts
      // can drive the real admin-gated memory.observations / memory.entities /
      // memory.recall_stats / memory.recall_trace handlers against the REAL
      // wired scoped stores (the cross-scope-leak negative + the EoP
      // admin-reject through the RPC layer). Same rationale as createMcpHandlers:
      // the test imports them statically from @comis/daemon, but the
      // public-export-consumers AST walker only scans packages/*/src/** (NOT
      // test/), so this orphan list is the canonical place to record these
      // intentional test-only public exports.
      "createMemoryHandlers",
      "MemoryHandlerDeps",
      // _resetSigusr1Timer + _resetMutationFence are PROCESS-WIDE state
      // resets required by any test that exercises the real persistToConfig
      // writer (see persist-to-config.ts:12-43 module-level state docs).
      "_resetSigusr1Timer",
      "_resetMutationFence",
      // _resetConfigMutatedCoalescer is the process-wide reset for the
      // trailing-edge debounce coalescer that packs config:mutated emits
      // (per mcp-config-mutated-coalescer.ts). Consumer is
      // test/integration/mcp-config-refresh.test.ts; public-export-consumers
      // AST walker excludes test/** so this is the canonical place to record
      // the planned consumer.
      "_resetConfigMutatedCoalescer",
      // Residency-test harness consumers (dynamic require).
      "createTracingLogger",
      "TracingLoggerOptions",
      // Replay harness consumers.
      // Consumer: test/integration/incident-replay-2026-05-24.test.ts
      "emitStartupInvariants",
      "StartupInvariantsDeps",
      "StartupInvariants",
      // mcp.oauth_login / mcp.oauth_logout handler factory + deps type.
      // Mounted by the dispatcher composition root; the
      // public-export-consumers walker does not pick the boot-path wiring
      // up because the dispatcher setup imports them via the index barrel
      // for the same reason createMcpHandlers + McpHandlerDeps appear here
      // (test-API surface for the integration test
      // mcp-oauth-roundtrip.test.ts to harness the handlers against a
      // tmpdir token store, mirroring the mcp-persistence precedent).
      // Not a baseline orphan.
      "createMcpOauthHandlers",
      "McpOauthHandlerDeps",
      // Bundle-install helper + boot-orchestrator + thin discovery-only
      // registry pre-pass surfaced through the daemon barrel so the
      // integration test at test/integration/skill-bundle-install.test.ts
      // can drive the atomic-install reject path + the boot re-merge
      // idempotence path against the REAL persistToConfig + audit JSONL
      // pipeline. Mirrors the createMcpHandlers / persistMcpServers
      // precedents above (public-export-consumers AST walker excludes
      // test/** so the orphan list is the canonical place to record planned
      // test consumers).
      "applyBundleInstall",
      "ApplyBundleInstallArgs",
      "ApplyBundleInstallResult",
      "setupSkillBundles",
      "buildSkillRegistriesForBundles",
      "SetupSkillBundlesDeps",
      // Resolve-seam learned-skill promote/demote loop body + the in-process
      // decay-aware trend tracker, surfaced through the daemon barrel so the
      // Phase-222 MODEL-04 source-agnostic characterization
      // (test/integration/mental-model-readonly-lifecycle.test.ts) drives the
      // REAL transition path (a hand-authored no-synthesis mental_models doc
      // promotes via promoteByName exactly as a synthesized skill) rather than a
      // store-only fallback. Two test-driven exports, the sanctioned
      // skill-bundle-install pattern; both are name-keyed + (tenant, agent)-scoped
      // (no new data path / secret / cross-tenant widening). The
      // public-export-consumers AST walker excludes test/**, so the orphan list is
      // the canonical place to record the planned test consumer.
      "applySkillOutcomeTransitions",
      "createSkillTrendTracker",
      // Extracted single-writer persistMcpServers, surfaced through the
      // daemon barrel as the rule-of-three fulfillment. Direct in-repo
      // consumers live in packages/daemon/src/ leaf modules
      // (bundle-install-helper, setup-skill-bundles, mcp-handlers) — all
      // of which import via the LEAF path
      // (`./api/shared/persist-mcp-servers.js`) rather than the barrel to
      // avoid a self-cycle through packages/daemon/src/index.ts. The barrel
      // re-export is the documented test-API surface (mirrors the
      // createMcpHandlers / _resetSigusr1Timer precedents above).
      "persistMcpServers",
      "PersistMcpResult",
      // Auth handlers: auth.set / auth.list / auth.logout RPC handler factory
      // + deps type. Re-exported so the auth-set-encrypted integration test
      // (test/integration/auth-set-encrypted.test.ts) can drive the real
      // admin-gated auth.set handler against a mock OAuthCredentialStorePort,
      // proving the round-trip + residency invariant (no plaintext
      // token bytes in responses / logs / audit) without spinning up a full
      // daemon. Same rationale as createContextHandlers + createMemoryHandlers:
      // public-export-consumers AST walker excludes test/** so this orphan
      // list is the canonical place to record the planned test consumer.
      "createAuthHandlers",
      "AuthHandlerDeps",
      // Obs-explain assembler + reader DI seam (Phase 156 G1) — re-exported so
      // the RE-PROVE scenario + its self-test (test/live/support +
      // test/live/scenarios/prove) can call the FROZEN Phase-153 assembler over
      // a fixture reader via the clean @comis/daemon alias. Same rationale as
      // createMcpHandlers / emitStartupInvariants: the consumer imports these
      // statically from @comis/daemon under test/**, which the
      // public-export-consumers AST walker excludes, so this orphan list is the
      // canonical place to record the planned test consumer. SECURITY: the
      // surface widens by EXACTLY the gate-free assembler + reader seam — the
      // admin gate stays on bindObsExplainHandlers (obs-explain.ts:188), which
      // is NOT re-exported.
      // Consumer: test/live/support/diagnosis-reprove.test.ts +
      //           test/live/scenarios/prove/diagnosis-reprove.test.ts (Plan 156-02)
      "assembleIncidentReportFromSources",
      "makeRealReader",
      "IncidentSourceReader",
      // Fleet-health assembler (Phase 162-01 RE-PROVE seam) — re-exported from
      // the TOP-LEVEL daemon barrel so the keyless deterministic fleet RE-PROVE
      // scenario can call it over a seeded tmp store via the clean @comis/daemon
      // alias (the live config aliases only the top-level @comis/daemon →
      // daemon/dist/index.js, with no obs-handlers subpath alias). Exact analog
      // of assembleIncidentReportFromSources above: the sole external consumer
      // imports it statically from @comis/daemon under test/**, which the
      // public-export-consumers AST walker excludes, so this orphan list is the
      // canonical place to record the planned test consumer. SECURITY: the
      // surface widens by EXACTLY the assembler — the admin gate stays on the
      // bindObsFleetHealthHandlers RPC (NOT re-exported), and the assembler
      // itself excludes synthetic sessions (excludeSynthetic: true) and reads
      // only sqlite + the session-index JSONL (never daemon.log).
      // Consumer: test/live/scenarios/prove/fleet-reprove.test.ts (Plan 162-01)
      "assembleFleetHealthReport",
      // Outward-send crash-injection seam (Phase 216 Plan 08, MED-6) — re-exported
      // from the daemon barrel so the exactly-once chaos test can arm/disarm a
      // REAL mid-send crash (BETWEEN markUnknown and commit) and assert the
      // sentinel propagates. INERT in production (__crashHook is never armed; the
      // setter is the only writer). Same rationale as the _resetSigusr1Timer /
      // _resetMutationFence process-state seams above: the consumers import these
      // statically from @comis/daemon under test/** (the in-process chaos test),
      // which the public-export-consumers AST walker excludes, so this orphan list
      // is the canonical place to record the test-only public export.
      // OutwardSendCrashHookMode is the setter's argument type (the two crash
      // variants); the walker classifies the re-export as a value, so it is tracked
      // here alongside the value exports.
      // Consumer: test/integration/durable-resume-e2e.test.ts:66 (static import)
      "__setOutwardSendCrashHookForTest",
      "OUTWARD_SEND_CRASH_SENTINEL",
      "OutwardSendCrashHookMode",
      // Cap-socket denylist RE-PROVE seam (Phase 219-05, CLI-02/03) — re-exported
      // from the TOP-LEVEL daemon barrel so the comis-agent-same-gate /
      // comis-agent-no-admin arch-tests DERIVE the denylisted-method set from the
      // SAME source the cap endpoint's pre-check uses (not a hand-copied literal
      // that drifts). @comis/core CANNOT import it (a package cycle), so the
      // cross-check must live in the architecture suite. Exact analog of
      // assembleFleetHealthReport above: the sole external consumers import it
      // statically from @comis/daemon under test/architecture/**, which the
      // public-export-consumers AST walker (it scans packages/ only) excludes — so
      // this orphan list is the canonical place to record the test-only export.
      // SECURITY: read-only widening — DENYLISTED_RPC_METHODS is an inert
      // closed-door const (the SUB_AGENT_TOOL_DENYLIST soundness loop is
      // unchanged); exporting it grants no new authority and the cap-socket
      // denylist pre-check is untouched.
      // Consumer: test/architecture/comis-agent-same-gate.test.ts +
      //           test/architecture/comis-agent-no-admin.test.ts (Plan 219-05)
      "DENYLISTED_RPC_METHODS",
    ])],
    // @comis/gateway: baseline orphans tracked here.
    // mTLS auth surface (validateCertificates, extractClientCN, CertPaths) is
    // consumed by test/integration/gateway/mtls-handshake.test.ts — integration
    // tests live outside packages/, which the public-export-consumers walker
    // does not scan. Listed here per the documented external-API category.
    ["@comis/gateway", new Set<string>([
      "createRateLimiter",
      "createOAuthCallbackRoute",
      "insertPendingFlow",
      "PENDING_FLOW_TIMEOUT_MS",
      "OAuthCallbackDeps",
      "PendingFlow",
      // Email approval-token route. createApprovalTokenRoute +
      // insertPendingApprovalToken + PendingApprovalToken + ApprovalLinkChoice are
      // consumed by the daemon composition root (setup-interactive-callback.ts +
      // setup-gateway-routes.ts). APPROVAL_TOKEN_TIMEOUT_MS is exported for test
      // parity (mirrors PENDING_FLOW_TIMEOUT_MS) and ApprovalTokenDeps is the
      // route's deps shape (the daemon constructs it inline) — both tracked here.
      "APPROVAL_TOKEN_TIMEOUT_MS",
      "ApprovalTokenDeps",
      // AcpServerDeps is NO LONGER an orphan: the daemon setup-acp-wiring.ts
      // imports the AcpServerDeps type from @comis/gateway to assemble the ACP
      // server deps (executionPlanPort + eventBus + activityStreamPort) — removed.
      // createAcpAgent + startAcpServer remain baseline orphans: the
      // bridges + the executionPlanPort seam are wired INSIDE startAcpServer and
      // startAcpServer is re-exported from the package index, but no daemon/CLI site yet
      // INVOKES startAcpServer (spawning the ACP subprocess entry point is a
      // separate concern). They light up when that caller lands.
      "createAcpAgent",
      "startAcpServer",
      // ACP activity/plan/approval bridges + the local bounded queue.
      // These are now CONSTRUCTED in-repo —
      // createAcpPlanBridge + createAcpActivityBridge + createAcpApprovalBridge in
      // acp-server.ts (startAcpServer / createAcpAgent), createAcpBoundedQueue in
      // acp-activity-bridge.ts — but ALL via RELATIVE (intra-gateway) imports. The
      // public-export-consumers walker only counts cross-package `@comis/gateway`
      // imports, so the barrel re-exports stay tracked orphans until a consumer
      // outside the gateway package imports them by bare-package name. AcpAgentHandle
      // + the three deps types are likewise referenced only intra-gateway. Shrink
      // each entry when a cross-package `@comis/gateway` consumer lands.
      "AcpAgentHandle",
      "createAcpActivityBridge",
      "createAcpPlanBridge",
      "createAcpApprovalBridge",
      "createAcpBoundedQueue",
      "CreateAcpActivityBridgeDeps",
      "CreateAcpPlanBridgeDeps",
      "CreateAcpApprovalBridgeDeps",
      "createMdnsAdvertiser",
      "validateCertificates",
      "extractClientCN",
      "CertPaths",
    ])],
    // @comis/infra: baseline orphans + transient orphans.
    // createSystemClock/createSystemEnv/createSystemTimers are Node-backed
    // runtime adapters surfaced without an in-repo consumer because later
    // bootstrap closure + production retargets consume them. Tracked here
    // per the public-export-consumers gate; removed wholesale when the
    // daemon composition root wires them in.
    // The six fs-safe symbols (SymlinkParentRejected, FileSizeLimitExceeded,
    // AppendRegularFileOptions / Success / Error, PathEscapesConfinementError)
    // previously listed here moved to @comis/observability/src/shared/fs-safe.ts
    // and are no longer exported by @comis/infra's barrel. The
    // log-related runtime adapters (createSystemClock / Env / Timers,
    // LogFields, VALID_LOG_LEVELS) remain baseline orphans — they are
    // Node-backed runtime adapters surfaced for future consumers that
    // get wired in at the daemon composition root.
    ["@comis/infra", new Set<string>([
      "LogFields",
      "VALID_LOG_LEVELS",
      "createSystemClock",
      "createSystemEnv",
      "createSystemTimers",
      // Credential broker — no in-repo consumer yet.
      // The daemon composition root wires these in a future phase.
      "createSessionManager",
      "SessionManager",
      "SessionManagerDeps",
      "IssuedSession",
      "SessionInfo",
      "createMitmBroker",
      "MitmBrokerPort",
      "MitmBrokerDeps",
      // CA manager — no in-repo consumer yet.
      // The daemon composition root wires caManager into the broker in a future phase.
      "createNodeCaManager",
      "NodeCaManagerDeps",
    ])],
    // @comis/memory: baseline orphans tracked here + 5 transient orphans
    // (SessionStore alias + SessionDetailedEntry + 3 Ctx*Row types).
    // Agent's type-only imports for these 5 names were retargeted from
    // @comis/memory → @comis/core (the canonical home). Memory's index.ts
    // still re-exports them — as backward-compat aliases — but no
    // production code in any other package consumes them through memory's
    // barrel anymore. The 5 entries below document this transient state.
    ["@comis/memory", new Set<string>([
      "initSchema",
      // Durable run checkpoint store (v2.30, Phase 216 Plan 02, DUR-01). The
      // SQLite DurableRunPort adapter `createSqliteDurableRunStore`, its options
      // type `DurableRunStoreOptions`, and the idempotent DDL `ensureDurableRunTable`
      // are surfaced ahead of their consumer: the daemon composition root wires the
      // store (and the chaos test calls ensureDurableRunTable) in Plan 07. These are
      // interface-first planned orphans that SHRINK OUT once that wiring lands
      // (mirror the createSqliteOutcomeStore / lifecycle / tuned-alpha factory-orphan
      // dance below + the Phase 216 Plan 01 @comis/core interface-first entries;
      // allowlist-shrink.test.ts enforces shrink-only).
      "createSqliteDurableRunStore",
      "DurableRunStoreOptions",
      "ensureDurableRunTable",
      // Outward-send exactly-once ledger (v2.30, Phase 216 Plan 03, ONCE-01..04).
      // The SQLite OutwardSendLedgerPort adapter `createSqliteOutwardSendLedger`
      // and the idempotent DDL `ensureOutwardLedgerTable` are surfaced ahead of
      // their consumer: the send-wrap site (Plan 05) + the resume reconcile loop
      // (Plan 04) + the daemon composition root (Plan 07) wire them in later waves.
      // Interface-first planned orphans that SHRINK OUT once that wiring lands
      // (mirror the Plan-02 durable-run entries above; allowlist-shrink enforces
      // shrink-only).
      "createSqliteOutwardSendLedger",
      "ensureOutwardLedgerTable",
      // NOTE (v2.12, Phase 126 Plan 04): createContextStore (the DAG
      // context-store factory) was deleted here along with context-store.ts +
      // its barrel re-export — no longer an orphaned export to track.
      // LCD lossless store (v2.12, Phase 127 Plan 04). createLcdStore (the
      // ContextStorePort SQLite adapter) has a production consumer — the daemon
      // composition root constructs it on the shared memory db (setup-memory) — so
      // the factory is NOT listed here (the factory-orphan dance shrank on
      // schedule; allowlist-shrink enforces shrink-only). reconstructLcdMessage is
      // the named pi-ai reconstruction seam (delegates to the @comis/core
      // parts-codec); its consumer is Phase-128 assembly, so it is a planned
      // orphan until that wiring lands (mirrors the SessionStorePort pattern).
      "reconstructLcdMessage",
      // LCD provenance READ adapter (v2.20, Phase 173, DIST-03 read side). The sole
      // LcdProvenanceReadStore adapter `buildProvenanceReadStore` now has a
      // production consumer — the daemon composition root name-imports it in
      // setup-memory.ts and injects it into createMemoryRecall's provenance pass —
      // so it is NOT listed here (the Task-1 temporary planned orphan was REMOVED
      // once the Task-2 wiring landed; the factory-orphan dance, shrink-only).
      "SessionData",
      "SessionListEntry",
      "InspectFilters",
      "ClearScope",
      "MemoryStats",
      "EmbeddingQueue",
      "EmbeddingProviderOptions",
      "createOpenAIEmbeddingProvider",
      "OpenAIEmbeddingProviderOptions",
      // Reranker provider options type. createLocalRerankerProvider is
      // consumed by the daemon (setup-memory); the options type is part of its public
      // API surface — baseline orphan until an external/test consumer references it.
      "LocalRerankerProviderOptions",
      // Entity-associative recall store. createSqliteMemoryEntityStore
      // is the sole MemoryEntityStore adapter; the daemon composition root constructs
      // it on the memory adapter's db handle (setup-memory). Surfaced
      // here ahead of that wiring — baseline orphans until the daemon consumer lands.
      "createSqliteMemoryEntityStore",
      "MemoryEntityStoreDeps",
      // Temporal-spread store. createSqliteMemoryTemporalStore is the
      // sole MemoryTemporalStore adapter; the daemon composition root constructs it on the
      // memory adapter's db handle (setup-memory) — so the FACTORY has a production consumer.
      // The constructor-deps SHAPE type is part of its public API but is referenced only via
      // inline objects — baseline orphan (mirror MemoryEntityStoreDeps / MemoryUsefulnessStoreDeps).
      "MemoryTemporalStoreDeps",
      // Causal-edge store. createSqliteMemoryCausalStore is the sole
      // MemoryCausalStore adapter; the daemon composition root constructs it on the memory
      // adapter's db handle (setup-memory) — so the FACTORY has a production
      // consumer (the temporary orphan entry was REMOVED here, the factory-orphan
      // dance). The constructor-deps SHAPE type is part of its public API but is referenced only
      // via inline objects — PERMANENT baseline orphan (mirror MemoryEntityStoreDeps /
      // MemoryTemporalStoreDeps).
      "MemoryCausalStoreDeps",
      // Consolidation store. createSqliteMemoryConsolidationStore is the sole
      // MemoryConsolidationStore adapter; the daemon composition root constructs it on the
      // memory adapter's db handle (setup-memory) — so the FACTORY has a
      // production consumer. The constructor-deps SHAPE type is part of its public API but
      // is referenced only via inline objects — baseline orphan (mirror MemoryEntityStoreDeps).
      "MemoryConsolidationStoreDeps",
      // Recall-utility usefulness store. createSqliteMemoryUsefulnessStore
      // is the sole MemoryUsefulnessStore adapter; the daemon composition root constructs it on
      // the memory adapter's db handle (setup-memory) — so the FACTORY has a production consumer.
      // The constructor-deps SHAPE type is part of its public API but is referenced only via
      // inline objects — baseline orphan (mirror MemoryEntityStoreDeps / MemoryConsolidationStoreDeps).
      "MemoryUsefulnessStoreDeps",
      // Trust-first bi-temporal KG triple store.
      // createSqliteTripleStore NOW has a production consumer — the daemon
      // composition root constructs it on the memory adapter's db handle in
      // setup-memory — so its orphan entry was REMOVED here (the
      // factory-orphan dance SHRANK on schedule, mirror createSqliteMemoryCausalStore).
      // MemoryTripleStoreDeps is the constructor-deps SHAPE (referenced via
      // inline objects only) — PERMANENT baseline orphan (mirror MemoryCausalStoreDeps).
      // MemoryTripleRowSchema is the row schema consumed by createRowMapper inside the
      // adapter (an intra-file value reference, not a cross-file import), so the
      // export-graph walker counts it as an orphan — tracked here (mirror the other
      // *RowSchema entries).
      "MemoryTripleStoreDeps",
      "MemoryTripleRowSchema",
      // Per-user representation store.
      // createSqliteUserRepresentationStore's daemon consumer LANDED
      // (setup-memory.ts constructs the SOLE adapter on the shared db handle) — the
      // factory-orphan SHRANK on schedule (mirror createSqliteTripleStore /
      // the entry above); its entry is removed.
      // MemoryUserRepresentationStoreDeps is the constructor-deps SHAPE type
      // (referenced via inline objects only); UserRepresentationRowSchema is the row
      // schema consumed by createRowMapper inside the adapter (an intra-file value
      // reference, not a cross-file import) — both PERMANENT baseline orphans (mirror
      // MemoryTripleStoreDeps / MemoryTripleRowSchema).
      "MemoryUserRepresentationStoreDeps",
      "UserRepresentationRowSchema",
      // Directional relationship store.
      // SHRUNK: the SOLE (tenant, agent, channel)-scoped directional-edge adapter factory is
      // now CONSUMED by its daemon composition-root consumer (setup-memory.ts constructs it on the
      // shared db handle, mirror the per-user-representation adapter), so it was REMOVED from
      // this list (the shrink-only allowlist-shrink.test.ts enforces this shrink — mirror the
      // user-representation / triple-store adapter shrink). MemoryRelationshipStoreDeps is
      // the constructor-deps SHAPE type (referenced via inline objects only); RelationshipRowSchema is
      // the row schema consumed by createRowMapper inside the adapter (an intra-file value reference,
      // not a cross-file import) — both PERMANENT baseline orphans (mirror
      // MemoryUserRepresentationStoreDeps / UserRepresentationRowSchema above).
      "MemoryRelationshipStoreDeps",
      "RelationshipRowSchema",
      // Tuned-alpha store. createSqliteTunedAlphaStore
      // is the SOLE TunedAlphaStore adapter (the per-(tenant, agent) tuned-4-alpha-vector
      // upsert + scoped read; undefined-on-absent). SHRUNK: the daemon
      // composition-root now CONSTRUCTS it on the shared db handle in setup-memory, so
      // the transient factory-orphan was REMOVED from this list (the factory-orphan shrink —
      // mirror createSqliteTripleStore / the user-representation + relationship adapter
      // shrinks; allowlist-shrink enforces shrink-only). MemoryTunedAlphaStoreDeps is the
      // constructor-deps SHAPE type (referenced via inline objects only); TunedAlphaRowSchema
      // is the row schema consumed by createRowMapper inside the adapter (an intra-file value
      // reference, not a cross-file import) — both PERMANENT baseline orphans (mirror
      // MemoryRelationshipStoreDeps / RelationshipRowSchema above).
      "MemoryTunedAlphaStoreDeps",
      "TunedAlphaRowSchema",
      // Memory-lifecycle store.
      // createSqliteMemoryLifecycleStore is the SOLE MemoryLifecyclePort adapter (the
      // (tenant, agent)-scoped DORMANT sweep over the `memories` table + its additive
      // marker columns — it computes strengths/tiers but evicts/demotes NOTHING). It was
      // an ahead-of-consumer factory-orphan; SHRUNK — the daemon composition root
      // (setup-memory.ts) now CONSTRUCTS it on the shared db handle + the default-OFF KEYLESS
      // __MEMORY_LIFECYCLE__ cron sentinel (setup-channels) drives it, so it is no longer an
      // orphan (the factory-orphan shrink, mirror createSqliteTunedAlphaStore above;
      // allowlist-shrink enforces shrink-only). MemoryLifecycleStoreDeps + MemoryLifecyclePolicy
      // are the constructor-deps/policy SHAPE types (referenced via inline objects only — the
      // daemon calls the factory with an inline `{ db, logger }`); MemoryLifecycleRowSchema is
      // the row schema consumed by createRowMapper inside the adapter (an intra-file value
      // reference, not a cross-file import) — all three PERMANENT baseline orphans (mirror
      // MemoryTunedAlphaStoreDeps / TunedAlphaRowSchema above).
      "MemoryLifecycleStoreDeps",
      "MemoryLifecyclePolicy",
      "MemoryLifecycleRowSchema",
      // Outcome-signal store (v2.26 Verified Learning WS1, Phase 198 Plan 02).
      // createSqliteOutcomeStore is the SOLE OutcomeSignalPort adapter (the
      // (tenant, agent)-scoped outcome_events ledger — idempotent observe(),
      // precedence-first-then-confidence resolve() with fail-closed unknown, and
      // age-based prune()). It is an AHEAD-OF-CONSUMER factory-orphan: the daemon
      // composition-root consumer LANDS in Plan 04 (Wave 4 — setup-learning.ts
      // constructs it on the shared db handle in setup-memory + the default-OFF
      // learningOutcome wiring subscribes/prunes), at which point this factory
      // entry SHRINKS OUT (mirror createSqliteTunedAlphaStore / the lifecycle +
      // relationship adapter shrinks; allowlist-shrink enforces shrink-only).
      // OutcomeStoreDeps is the constructor-deps SHAPE type (referenced via inline
      // objects only — the daemon calls the factory with an inline `{ db, logger }`)
      // — PERMANENT baseline orphan (mirror MemoryTunedAlphaStoreDeps /
      // MemoryLifecycleStoreDeps above).
      "createSqliteOutcomeStore",
      "OutcomeStoreDeps",
      // Mental Model doc store (v2.31; generalized from the v2.26 Verified Learning
      // WS2 learned-skill store, Phase 201 Plan 02 / Phase 222 Plan 01).
      // createSqliteMentalModelStore is the SOLE MentalModelStorePort adapter (the
      // (tenant, agent)-scoped mental_models doc store — idempotent
      // deterministic-id admit(), scoped get()/list(scope, kind?), and the
      // promote()/demote()/evict() lifecycle, evict being a soft evicted_at set,
      // never a hard DELETE). The daemon composition-root consumer LANDED (Plan 07:
      // setup-memory.ts builds it on the shared db handle, threaded into the
      // __SKILL_SYNTHESIS__ cron), so the FACTORY orphan createSqliteMentalModelStore
      // was REMOVED here (the shrink-only ratchet fired on schedule; mirror
      // createSqliteMemoryEmbeddingStore below). MentalModelStoreDeps is the
      // constructor-deps SHAPE type (the daemon calls the factory with an inline
      // `{ db, logger }`) — PERMANENT baseline orphan (mirror OutcomeStoreDeps above).
      "MentalModelStoreDeps",
      // Scoped embedding-read store. createSqliteMemoryEmbeddingStore
      // is the sole MemoryEmbeddingStore adapter — the (tenant, agent)-scoped LEFT JOIN
      // vec_memories bulk read that hydrates the MMR diversity re-rank. Its daemon
      // composition-root consumer LANDED (setup-memory, the same db handle as
      // the temporal/causal/triple stores) — so the FACTORY orphan was REMOVED here (the
      // factory-orphan dance SHRANK on schedule, mirror createSqliteTripleStore).
      // MemoryEmbeddingStoreDeps is the constructor-deps SHAPE (referenced via inline objects
      // only) — PERMANENT baseline orphan (mirror MemoryTripleStoreDeps /
      // MemoryConsolidationStoreDeps).
      "MemoryEmbeddingStoreDeps",
      "EmbeddingCacheOptions",
      "EmbeddingCacheStats",
      "SqliteEmbeddingCacheOptions",
      "FingerprintManager",
      "ProviderFingerprint",
      "computeEmbeddingIdentityHash",
      "BatchIndexer",
      "BatchIndexerOptions",
      "BatchIndexerResult",
      "openSqliteDatabase",
      "chmodDbFiles",
      "SqliteAdapterOptions",
      "initOAuthProfileSchema",
      "SecretsBootResult",
      "NamedGraphStore",
      "NamedGraphEntry",
      "NamedGraphSummary",
      "ProviderAggregation",
      "AgentAggregation",
      "SessionAggregation",
      "HourlyBucket",
      "DeliveryStats",
      "ObsTableName",
      "ResetResult",
      "PruneResult",
      // NOTE (v2.12, Phase 126 Plan 04): initContextSchema + the 9 Ctx*Row DTOs
      // (CtxConversationRow … CtxExpansionGrantRow) were removed here — the ctx_*
      // schema/store + the @comis/core context-store-types port were deleted, so
      // memory's barrel no longer re-exports them.
      // Agent retargeted these 2 names from @comis/memory → @comis/core.
      // Memory's barrel still re-exports them (SessionStore is a type alias of
      // SessionStorePort). No in-repo production consumer remains until the alias
      // re-exports are retired entirely from packages/memory/src/index.ts.
      "SessionStore",
      "SessionDetailedEntry",
      // Generic RowMapper factory + per-row Zod schemas. Surfaced before
      // consumption at SQLite call sites — tracked here as transient
      // orphans for the gap. Removed wholesale when call sites import
      // them at the retargeted sites.
      // Generic factory + contract (3 entries):
      "createRowMapper",
      "RowMapper",
      "MapperError",
      // Public-row schemas + inferred types (5 × 2 = 10 entries):
      "MemoryRowSchema",
      "MemoryRowFromSchema",
      // Entity-association row schemas. Consumed intra-package by
      // sqlite-memory-entity-store.ts via createRowMapper; surfaced
      // through `export *` so tracked here like the sibling row schemas (the
      // checker counts cross-package barrel consumers only).
      "MemoryEntityRowSchema",
      "EntityLaneRowSchema",
      // Causal one-hop edge-lookup row schema. Consumed
      // intra-package by sqlite-memory-causal-store.ts via createRowMapper;
      // barrel-surfaced through `export *` so tracked here like its entity-association siblings.
      "CausalLaneRowSchema",
      // Graph-spread recursive-CTE node projection schema.
      // Consumed intra-package by sqlite-triple-store.ts (the spreadLane walk) via
      // createRowMapper; barrel-surfaced through `export *` so tracked here like the
      // MemoryTripleRowSchema / CausalLaneRowSchema siblings (the checker counts
      // cross-package barrel consumers only).
      "SpreadNodeRowSchema",
      // Recall-utility usefulness row schema. Consumed
      // intra-package by sqlite-memory-usefulness-store.ts via createRowMapper;
      // barrel-surfaced through `export *` so tracked here like the sibling row
      // schemas (the checker counts cross-package barrel consumers only).
      "MemoryUsefulnessRowSchema",
      // Entity-graph diagnostic row schema (listEntities).
      // Consumed intra-package by sqlite-memory-entity-store.ts via
      // createRowMapper; barrel-surfaced like its entity-association siblings above.
      "EntityListRowSchema",
      "SessionRowSchema",
      "SessionRowFromSchema",
      // LCD lossless-store row schemas (v2.12, Phase 127). Consumed
      // intra-package by lcd-store.ts via createRowMapper (and paired 1:1 with the
      // LcdMessageRow/LcdMessagePartRow interfaces in types.ts via the
      // row-schemas.test.ts drift guard); barrel-surfaced through `export *` so
      // tracked here like the sibling row schemas (the checker counts cross-package
      // barrel consumers only). No *RowFromSchema inferred types are exported —
      // the row interfaces live in types.ts.
      "LcdMessageRowSchema",
      "LcdMessagePartRowSchema",
      // LCD compaction row schemas (v2.12, Phase 129). LcdSummaryRowSchema +
      // LcdContextItemRowSchema are consumed intra-package by lcd-store.ts via
      // createRowMapper (the getSummaries / getContextItems graceful-degrade reads);
      // LcdSummaryMessageRowSchema is the leaf→message link schema paired 1:1 with
      // its LcdSummaryMessageRow interface via the row-schemas.test.ts drift guard.
      // All three are barrel-surfaced through `export *` so tracked here like the
      // sibling row schemas above (the checker counts cross-package barrel consumers
      // only; an intra-file createRowMapper reference is not a cross-file import).
      "LcdSummaryRowSchema",
      "LcdSummaryMessageRowSchema",
      "LcdContextItemRowSchema",
      // LCD multi-tier condensed→child link schema (v2.12, Phase 130-01). The exact
      // analog of LcdSummaryMessageRowSchema: paired 1:1 with its
      // LcdSummaryParentRow interface via the row-schemas.test.ts drift guard, and
      // barrel-surfaced through `export *`. appendCondensedSummary writes the
      // lcd_summary_parents edges via a static prepared statement (it reuses
      // summaryRowMapper for the child-row recompute, not this schema), and no
      // production READ of parent rows exists yet (the expansion/zoom read path is
      // a later phase), so its only current consumer is the drift-guard test —
      // tracked here as a baseline orphan like the sibling link schema above.
      "LcdSummaryParentRowSchema",
      // LCD FTS search-hit row schema (v2.12, Phase 131-02, E1 ctx_search). Consumed
      // intra-package by lcd-fts.ts via createRowMapper(LcdSearchHitRowSchema) — the
      // searchLcd FTS5-MATCH-with-LIKE-fallback hit-row mapper (an intra-file value
      // reference, NOT a cross-file import). Barrel-surfaced through `export *` so the
      // export-graph walker counts it as an orphan — tracked here like the sibling LCD
      // row schemas above (the checker counts cross-package barrel consumers only; the
      // ctx_* tools read the recovered hits via the searchLcd RETURN value, not by
      // importing this schema). No *RowFromSchema inferred type is exported — the
      // LcdSearchHit DTO lives in @comis/core's context-store-types.ts.
      "LcdSearchHitRowSchema",
      // LCD LIKE-fallback hit row schema (v2.12, Phase 132 WR-02). The exact sibling
      // of LcdSearchHitRowSchema MINUS the `rank` column — the LIKE scan has no
      // ranking. Consumed intra-package by lcd-fts.ts via
      // createRowMapper(LcdLikeHitRowSchema) so the LIKE-fallback rows degrade
      // per-row (parseOptionalRow+skip) identically to the MATCH path, instead of a
      // raw `as { ref_id, snippet }` cast that leaked an undefined snippet/refId.
      // An intra-file value reference, NOT a cross-package import; barrel-surfaced
      // through `export *`, so tracked here as a baseline orphan like the sibling
      // LCD row schemas above (the ctx_* tools read hits via the searchLcd RETURN
      // value, never by importing this schema).
      "LcdLikeHitRowSchema",
      "VecSearchRowSchema",
      "VecSearchRowFromSchema",
      "FtsSearchRowSchema",
      "FtsSearchRowFromSchema",
      "NamedGraphRowSchema",
      "NamedGraphRowFromSchema",
      // NOTE (v2.12, Phase 126 Plan 04): the 9 Ctx*RowSchema + their inferred
      // Ctx*RowFromSchema types were removed here — the section-2 ctx_* row
      // schemas were deleted from packages/memory/src/row-schemas.ts with the
      // ctx_* schema/store.
      // Session-store DTO schemas + inferred types (3 × 2 = 6 entries):
      "SessionDataSchema",
      "SessionDataFromSchema",
      "SessionListEntrySchema",
      "SessionListEntryFromSchema",
      "SessionDetailedEntrySchema",
      "SessionDetailedEntryFromSchema",
      // Internal DB-row schemas + inferred types (17 × 2 = 34 entries):
      "TokenUsageDbRowSchema",
      "TokenUsageDbRowFromSchema",
      "DeliveryDbRowSchema",
      "DeliveryDbRowFromSchema",
      "DiagnosticDbRowSchema",
      "DiagnosticDbRowFromSchema",
      // Per-session GROUP-BY rollup row schema (v2.15 A1, Phase 159-01).
      // Declared and exported from observability-store-types.ts (co-located with
      // its sole consumer, sessionSummaryRollupMapper) — a same-file value
      // reference, so it has no cross-file importer and is barrel-surfaced
      // package-publicly via observability-store-types.ts, making the export-graph
      // walker count it as an orphan. Tracked here like the sibling obs
      // *DbRowSchema entries above (the checker counts cross-package barrel
      // consumers only). No *DbRowFromSchema inferred type is exported —
      // SessionSummaryRollup is the camelCase domain type (in
      // observability-store-types.ts).
      "SessionSummaryRollupDbRowSchema",
      "ChannelSnapshotDbRowSchema",
      "ChannelSnapshotDbRowFromSchema",
      "ProviderAggDbRowSchema",
      "ProviderAggDbRowFromSchema",
      "AgentAggDbRowSchema",
      "AgentAggDbRowFromSchema",
      "SessionAggDbRowSchema",
      "SessionAggDbRowFromSchema",
      "HourlyBucketDbRowSchema",
      "HourlyBucketDbRowFromSchema",
      "DeliveryStatsDbRowSchema",
      "DeliveryStatsDbRowFromSchema",
      // system_prompt_reports table row schema.
      "SystemPromptReportDbRowSchema",
      "SystemPromptReportDbRowFromSchema",
      // Audit-query filter shape (176-03 AUDIT-01) — the obs_query {action:"audit"}
      // filter surface. AHEAD-OF-CONSUMER: Plan 05 (the obs.audit.query RPC + the
      // obs_query audit action) is its cross-package consumer; until then it is
      // consumed only intra-package (queryAuditEvents) + the audit-mutations test.
      // Shrinks out when Plan 05's daemon handler name-imports it.
      // (AuditEventDbRowSchema is NOT here — it is co-located in audit-mutations.ts
      // and not surfaced on the barrel.)
      "AuditQueryParams",
      // cache-stats SQL row schemas (4 × 2 = 8 entries).
      "CacheStatsWindowRawDbRowSchema",
      "CacheStatsWindowRawDbRowFromSchema",
      "CacheStatsByProviderRawDbRowSchema",
      "CacheStatsByProviderRawDbRowFromSchema",
      "CacheStatsByModelRawDbRowSchema",
      "CacheStatsByModelRawDbRowFromSchema",
      "CacheStatsByAgentRawDbRowSchema",
      "CacheStatsByAgentRawDbRowFromSchema",
      "OAuthProfileRowSchema",
      "OAuthProfileRowFromSchema",
      "DeliveryMirrorDbRowSchema",
      "DeliveryMirrorDbRowFromSchema",
      "DeliveryQueueDbRowSchema",
      "DeliveryQueueDbRowFromSchema",
      "BatchCacheRowSchema",
      "BatchCacheRowFromSchema",
      // Common projection schemas (2 × 2 = 4 entries):
      "IdProjectionRowSchema",
      "IdProjectionRowFromSchema",
      "CountProjectionRowSchema",
      "CountProjectionRowFromSchema",
      // File-backed SecretStore. createFileSecretStore is the sole
      // FileSecretStore adapter; the daemon composition root wires it via selectSecretStore
      // (bootstrapSecretsAndEnv). selectSecretStore and SelectedSecretStore are
      // the factory + discriminated-union type consumed by the daemon wiring. Baseline orphans
      // until the daemon consumer is added.
      "createFileSecretStore",
      "selectSecretStore",
      "SelectedSecretStore",
      // SQLite-backed SecretStore. createSqliteSecretStore is the AES-256-GCM
      // encrypted secret store adapter. The production daemon wires it via selectSecretStore
      // (via the encrypted path in bootstrapSecretsAndEnv); selectSecretStore is the caller.
      // Directly consumed by integration tests (secret-rotation-fail-closed.test.ts) for
      // canary-mismatch + rotation fail-closed verification. SqliteSecretStoreHandle is the
      // extended type (SecretStorePort + db field). Baseline orphans tracked here — the
      // daemon's existing selectSecretStore call is the sole production consumer of the factory.
      "createSqliteSecretStore",
      "SqliteSecretStoreHandle",
      // Fleet window-rollup reducer (v2.15 R2/A2, Phase 159-02). reduceFleetWindow
      // is the PURE cross-session reduce over the A1 SessionSummaryRollup[] (the
      // synthetic-excluded fleet aggregate); FleetWindowRollup is its output type.
      // Barrel-exported from packages/memory/src/index.ts so the Phase-161
      // obs.fleet.health handler can import it — but no in-repo module consumes the
      // reducer/type until that handler lands. The public-export-consumers walker
      // excludes *.test.ts (the reducer's only current consumer is its own test) and
      // self-imports, so both surface as orphans now. Same rationale + precedent as
      // FleetHealthReportSchema (@comis/core above). Remove when an in-repo
      // non-test value consumer of each lands.
      "reduceFleetWindow",
      "FleetWindowRollup",
      // Cache-break rate-by-reason analytics query (PERSIST-01, Phase 176 Plan 04).
      // queryCacheBreakRateByReason is the GROUP BY json_extract(details,'$.reason')
      // over obs_diagnostics category:'cache_break'; CacheBreakReasonRate is its
      // output row type. Barrel-exported from packages/memory/src/index.ts so a fleet/
      // explain surface (a later plan — this plan only PERSISTS the rows + ships the
      // queryable shape) can import it; the only current consumer is the daemon
      // wiring TEST (the walker excludes *.test.ts), so both surface as orphans now.
      // Same rationale + precedent as reduceFleetWindow/FleetWindowRollup above.
      // (cacheBreakEventToRow is NOT listed — the daemon's cache_break subscriber is
      // its real production consumer.) Remove when the fleet/explain consumer lands.
      "queryCacheBreakRateByReason",
      "CacheBreakReasonRate",
      // Video job store (v2.24 Phase 189, JOB-01). SHRUNK at Plan 02 (the async
      // poller wave): `createVideoJobStore` (constructed in main-helpers
      // buildVideoGenBundle), `VideoJobStore` + `VideoJobRecord` (the poller +
      // handler-deps name-import them) now have real in-repo consumers — removed.
      // STILL ORPHAN (kept — Plan 03 video_status handler / offline path):
      //   - VideoJobInsert / VideoJobDoneInput / VideoJobState: domain types the
      //     store API uses internally; no separate cross-package name-import yet.
      //   - ensureVideoJobTable: wired into initSchema (intra-@comis/memory) +
      //     used only by tests + the offline path; no other-package consumer.
      // Remove each remaining entry when its Plan-03 in-repo value consumer lands.
      "VideoJobState",
      "VideoJobInsert",
      "VideoJobDoneInput",
      "ensureVideoJobTable",
    ])],
    // @comis/scheduler: baseline orphans tracked here.
    ["@comis/scheduler", new Set<string>([
      "SchedulerLogger",
      "CronJob",
      "CronStore",
      "EffectiveHeartbeatConfig",
      "PerAgentHeartbeatRunnerDeps",
      "WAKE_PRIORITY",
      "WakeCoalescerDeps",
      "DeliveryBridgeDeps",
      "DeliveryOutcome",
      "ChannelVisibilityConfig",
      "shouldBypassFileGates",
      "HeartbeatTriggerKind",
      "resolveHeartbeatTriggerKind",
      "buildHeartbeatPrompt",
      "DEFAULT_HEARTBEAT_PROMPT",
      "MEMORY_STATS_THRESHOLD",
      "stripMarkup",
      "stripHeartbeatToken",
      "stripResponsePrefix",
      "classifyHeartbeatResponse",
      "processHeartbeatResponse",
      "HeartbeatResponseOutcome",
      "ClassifyHeartbeatInput",
      "ProcessHeartbeatInput",
      "isQueueBusy",
      "AgentHeartbeatSourceDeps",
      "HeartbeatSessionOps",
      "SystemEventQueueDeps",
      "SystemEventEntrySchema",
      "SystemEventEntry",
    ])],
    // @comis/shared: baseline orphans tracked here.
    ["@comis/shared", new Set<string>([
      "TTLCacheOptions",
      "SILENT_PREFIX",
      "VisibleDeliveryKind",
      "VisibleDeliveryRecord",
    ])],
    // @comis/skills: baseline orphans tracked here.
    // @comis/orchestrator: test-only consumer exports tracked here.
    // createDedupDetector / DedupDetector / DedupDetectorOptions / DedupCheckResult
    // are re-exported so test/integration/incident-replay-2026-05-24.test.ts
    // and the perf test can import the detector by its public name without
    // going through internal source paths. The public-export-consumers AST
    // walker only scans packages/*/src/**  (NOT test/), so the test-side
    // consumer is invisible to the walker — tracked here instead.
    ["@comis/orchestrator", new Set<string>([
      "createDedupDetector",
      "DedupDetector",
      "DedupDetectorOptions",
      "DedupCheckResult",
    ])],
    ["@comis/skills", new Set<string>([
      "createWebSearchTool",
      "__clearSearchCache",
      "createWebFetchTool",
      "fetchUrlContent",
      "__clearFetchCache",
      "DEFAULT_SOURCE_PROFILES",
      "resolveSourceProfile",
      "resolveAllProfiles",
      "resolvePaths",
      "isDeviceFile",
      "FileReadState",
      "InstallDetourDecision",
      "DetourOverlap",
      "parseInstallDetour",
      "SandboxOptions",
      "DetectLogger",
      "wrapWithMetadataEnforcement",
      "expandSkillForInvocation",
      "ContentScanResult",
      "ContentScanFinding",
      "createMemorySearchTool",
      "createMemoryGetTool",
      "createMemoryStoreTool",
      // The dialectic tool. Barrel-exported from ./platform-tools
      // alongside its sibling memory tools; consumed by the registry's memory_ask
      // conditional descriptor via the same-package ./tools import (invisible to the
      // public-export-consumers walker, which scans the public barrel), so it is a
      // baseline orphan exactly like createMemorySearchTool/createMemoryManageTool.
      "createMemoryAskTool",
      "createSessionStatusTool",
      "createSessionsListTool",
      "createSessionsHistoryTool",
      "createSessionSearchTool",
      "createCtxSearchTool",
      "createCtxInspectTool",
      "createCtxRecallTool",
      "createCtxExpandTool",
      "createMemoryManageTool",
      "qualifyToolName",
      "parseQualifiedName",
      "McpClientManagerDeps",
      "McpConnectionStatus",
      "McpToolDefinition",
      "McpToolCallResult",
      "McpToolCallContent",
      "jsonSchemaToTypeBox",
      "sanitizeMcpToolName",
      "classifyMcpErrorType",
      "expandGroups",
      "ToolFilterReason",
      "ToolPolicyResult",
      // Consumed by the architecture test
      // `test/architecture/mcp-prespawn-allowlist.test.ts` and the
      // integration test `test/integration/mcp-env-scrub.test.ts` — both
      // outside packages/skills/, so the source-only consumer scan does
      // not pick them up. Internal-to-skills consumers live in
      // mcp-client-discover.ts (where they are also defined). Documented
      // test-API surface; not a baseline orphan.
      "MCP_STDIO_BUILTIN_ENV_ALLOWLIST",
      "scrubStdioEnv",
      // Consumed by the integration test
      // `test/integration/mcp-osv-check.test.ts` — outside packages/skills/,
      // so the source-only consumer scan does not pick them up.
      // Internal-to-skills consumers live in mcp-client-connect.ts (where
      // the OSV check is invoked pre-spawn). Documented test-API surface;
      // not a baseline orphan.
      "osvMalwareCheck",
      "extractMcpPackageName",
      "DEFAULT_OSV_CACHE_DIR",
      "OsvCheckResult",
      "OsvCheckOptions",
      // Consumed by the integration test
      // `test/integration/mcp-redirect-scrub.test.ts` — outside
      // packages/skills/, so the source-only consumer scan does not pick
      // them up. Internal-to-skills consumer lives in
      // mcp-client-discover.ts (where the wrapped FetchLike is wired into
      // both SSE and Streamable HTTP transport branches). Documented
      // test-API surface; not a baseline orphan.
      "createRedirectPolicyFetch",
      "RedirectPolicyOptions",
      // The OAuth login orchestrator, its associated config/logger types,
      // and the connect-time needs_oauth_login signal guard are re-exported
      // so the daemon RPC handler `mcp-oauth-handlers.ts` can run
      // mcp.oauth_login / oauth_logout WITHOUT a direct
      // @modelcontextprotocol/sdk dep (the daemon depends on @comis/skills,
      // not the SDK). Daemon-side consumers live OUTSIDE packages/skills/,
      // so the source-only consumer scan does not pick them up; the daemon
      // imports them statically via @comis/skills. Documented test-API
      // surface; not a baseline orphan.
      "OAuthLoginConfig",
      "OAuthLoginLogger",
      "TokenStoreDeps",
      "isNeedsOAuthLoginError",
      // The 401 refresh-deduper factory + its types are re-exported so the
      // integration test `test/integration/mcp-oauth-roundtrip.test.ts` can
      // drive Notion rotation + Stripe-Account header + 100-concurrent dedup
      // against the in-process mock authorization server through the PUBLIC
      // @comis/skills barrel (integration tests may not reach src internals
      // — missing re-exports are added to the barrel). Internal-to-skills
      // consumer lives in mcp-client-connect.ts (where connectServer wires
      // the deduper's critical section to state.callQueues). Documented
      // test-API surface; not a baseline orphan.
      "createRefreshDeduper",
      "RefreshDeduper",
      "RefreshDeduperDeps",
      "RefreshResult",
      "DedupedRefreshArgs",
      "RefreshFn",
      // The deduped-refresh fetch wrapper that wires the RefreshDeduper into
      // the production 401 path on the SSE/HTTP transport. Re-exported so
      // the production-path integration test
      // `test/integration/mcp-oauth-deduped-fetch.test.ts` can prove 100
      // concurrent in-flight tool calls hitting a 401 collapse to ONE
      // refresh POST WITHOUT calling dedupedRefresh directly.
      // Internal-to-skills consumer lives in mcp-client-oauth-connect.ts
      // (prepareOAuthProvider composes the wrapper onto
      // `effectiveConfig.oauthFetch`) + mcp-client-discover.ts
      // (createTransport uses `config.oauthFetch ??
      // createRedirectPolicyFetch(...)` as the SSE/HTTP transport's `fetch`
      // option). Documented test-API surface; not a baseline orphan.
      "createDedupedRefreshFetch",
      "DedupedRefreshFetchDeps",
      // SkillManifestSchema + SkillManifestParsed are re-exported through
      // the @comis/skills barrel so daemon-side consumers (bundle-install
      // helper + boot orchestrator) can validate the optional mcpServers
      // block on freshly-written SKILL.md content WITHOUT reaching into
      // the manifest deep-path. The direct in-repo consumers live OUTSIDE
      // packages/skills/ (parseSkillManifest is invoked from
      // packages/daemon/src/skills/), so the public-export-consumers AST
      // walker — which only scans packages/*/src/** — does not pick them
      // up. Documented test-API + cross-package integration surface;
      // not a baseline orphan.
      "SkillManifestSchema",
      "SkillManifestParsed",
      // v2.26 Verified Learning WS2 (P2 Skills, Phase 201) — DELETED in Phase 223 Plan 06.
      // The SkillValidationPort sandbox adapter (the bwrap dynamic-replay half + the
      // now-redundant static scan, which moved to @comis/core validateLearnedDocBody in
      // Plan 02) was the learned-code execution surface. An advisory doc has NO executable
      // surface, so Plan 05 dropped the adapter from the reflect path and Plan 06 deleted
      // sandbox-skill-validation-adapter.ts (the static guard validateLearnedDocBody is ALL
      // that remains, INV-3). Its barrel re-exports are gone — no allowlist entry needed.
    ])],
  ]);
