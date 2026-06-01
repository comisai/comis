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
      // Consolidation job Deps (Phase 84-03). runMemoryConsolidation is consumed by the
      // daemon (Plan 84-05, setup-channels-credentials __MEMORY_CONSOLIDATION__ sentinel),
      // but it is called with an inline object, so the named Deps SHAPE type has no
      // production consumer — baseline orphan (mirror MemoryReviewDeps).
      "MemoryConsolidationDeps",
      // Offline triple-extraction job (Phase 100-05, Track F — KG-01, decision 6).
      // runMemoryTripleExtraction is the offline writer; its daemon cron wiring is
      // OPTIONAL in Plan 100-05 (the job is default-OFF and the benchmark in Plan
      // 100-06 calls runMemoryTripleExtraction directly / seeds via tripleStore.upsertTriple).
      // Surfaced here AHEAD of that consumer — the factory-orphan dance (mirror
      // runMemoryConsolidation @ 84-03 before its sentinel landed): this entry
      // SHRINKS when Plan 100-06 (or a later cron-wiring plan) lands the consumer.
      // The Deps/Config/Stats SHAPE types + the TripleCandidate extractor-output type
      // are referenced via inline objects only — baseline orphans (mirror MemoryConsolidationDeps).
      "runMemoryTripleExtraction",
      "MemoryTripleExtractionDeps",
      "MemoryTripleExtractionConfig",
      "MemoryTripleExtractionStats",
      "TripleCandidate",
      // Offline reasoning job (Phase 101-05, Track D — REASON-02/03/04). runMemoryReasoning
      // is the offline deductive+inductive writer; its daemon cron wiring lands in Plan
      // 101-06 (the __MEMORY_REASONING__ sentinel, mirroring __MEMORY_CONSOLIDATION__).
      // Within THIS plan the only consumer is the non-gated unit test — surfaced here
      // AHEAD of the cross-package consumer (the factory-orphan dance, mirror
      // runMemoryTripleExtraction @ 100-05 + runMemoryConsolidation @ 84-03). SHRINKS
      // when 101-06 wires the daemon sentinel. The Deps/Config/Stats/Result SHAPE types +
      // the ReasoningOutput seam-output type are referenced via inline objects only —
      // baseline orphans (mirror MemoryTripleExtractionDeps).
      "runMemoryReasoning",
      "MemoryReasoningDeps",
      "MemoryReasoningConfig",
      "MemoryReasoningStats",
      "MemoryReasoningResult",
      "ReasoningOutput",
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
      // createExecutionPlanHolder + ExecutionPlanHolder (Phase 74, workstream D,
      // ACP-03) are NO LONGER orphans: 74-07 wired the composition root. The
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
      // Recall orchestrator (Phase 80). Consumed internally by prompt-assembly via a
      // direct relative import; exported for the Phase-80/05 eval harness + external
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
      "reconcileJsonlToDag",
      "installDagIngestionHook",
      "createDagContextEngine",
      "runLeafPass",
      "runCondensedPass",
      "resolveFreshTailBoundary",
      "shouldCompact",
      "markAncestorsDirty",
      "recomputeDescendantCounts",
      "runDagCompaction",
      "checkIntegrity",
      "CHARS_PER_TOKEN_RATIO",
      "ReconciliationResult",
      "DagContextEngineDeps",
      "CompactionDeps",
      "DagCompactionConfig",
      "DagCompactionDeps",
      "IntegrityCheckDeps",
      "IntegrityReport",
      "IntegrityIssue",
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
      // buildRecallTrace (Phase 86 OBS-02 gap-closure): consumed by the
      // recall-diagnostics-isolation integration test (the OBS-02 e2e
      // redaction proof + OBS-08 cross-scope-leak negative drive the real
      // recorder through the @comis/agent barrel — see
      // test/integration/security/recall-diagnostics-isolation.test.ts:61).
      // The public-export-consumers AST walker only scans packages/*/src/**
      // (NOT test/), so that cross-package consumer doesn't satisfy the gate.
      // The production consumer is intra-package (prompt-assembly.ts threads
      // the same envelope), which the walker skips as a self-import. Mirrors
      // the createMemoryHandlers / MEMORY_DIAGNOSTIC_CONTRACTS precedent from
      // Phase 86. Keep the barrel export — the integration test needs it via
      // the bare `@comis/agent` import.
      "buildRecallTrace",
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
      // Discord channel narrowing surface. Consumed to retarget the 18
      // `as any` casts in `discord-actions.ts` + the 5 thread-iteration
      // sites. The 4 entries are removed once discord-actions.ts is
      // retargeted to consume them.
      "asTextLike",
      "DiscordTextLikeChannel",
      "asThreadInfo",
      "DiscordThreadInfo",
      // Activity-renderer surface re-exported in 71-05 so the daemon's
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
    // @comis/cli: 3 documented external-API entries (withClient,
    // credentialsStep, RpcClient). All register*Command factories and
    // output utilities (success/error/warn/info/json/renderTable/
    // renderKeyValue/withSpinner) are not re-exported from the package;
    // they remain accessible to the bin only via ./commands/*.js /
    // ./output/*.js direct source paths.
    ["@comis/cli", new Set<string>([
      "withClient",
      "credentialsStep",
      "RpcClient",
    ])],
    // @comis/core: baseline orphans tracked here. See inline comments
    // throughout this set for per-entry rationale.
    ["@comis/core", new Set<string>([
      // ── v2.5 Agent Transparency (Phase 73 — interactive approvals) ──
      // ParsedCallback is the documented return shape of the public
      // parseCallbackData (73-01). The orchestrator router consumes the
      // function, not the type name (it destructures the value), so the type
      // has no production import. It is part of the signing API surface external
      // consumers of parseCallbackData rely on; tracked here.
      "ParsedCallback",
      // ── v2.5 Agent Transparency (Phase 70 foundation) ──────────────
      // Activity + redaction public surface shipped in the @comis/core
      // barrel per ACT-12 (foundation phase). Consumers land in Phases
      // 71-76: channel renderers wire chatProjection/acpProjection/
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
      // hasRegisteredLabelSpec (Phase 76, LBL-03): the explicit-registration
      // introspection primitive the transparency coverage gate
      // (packages/skills/src/__tests__/transparency-label-coverage.test.ts)
      // calls. resolveLabelSpec is total (always returns a humanized fallback)
      // so it cannot gate; the gate must ask "was a spec explicitly
      // registered?". The sole consumer is that __tests__ gate (excluded from
      // the consumer scan), so the public primitive has no in-repo production
      // import yet — tracked here. Shrink when a production caller lands.
      "hasRegisteredLabelSpec",
      // ThemeName (Phase 75, UX-01): the activity-theme name union shipped on
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
      "TrustLevelSchema",
      "MemorySourceSchema",
      "MemoryEntrySchema",
      // Structured-extraction (Phase 82, EXTR-01) + entity (Phase 83) domain
      // types. MemoryEntity is the Phase-83 entity import target; the
      // extraction LLM-output types describe the shape @comis/agent's
      // parseExtractionResult validates. These 6 (3 schemas + 3 inferred
      // types) are consumed intra-core (memory-entry.ts builds the
      // MemoryExtractionResult chain from them) + are downstream-facing public
      // domain API surface, but carry NO cross-package value/type import by
      // name yet — the checker counts cross-package barrel consumers only.
      // (MemoryExtractionResultSchema + MemoryExtractionResult are NOT listed:
      // @comis/agent's parseExtractionResult imports both from @comis/core, so
      // they have a real cross-package consumer.) Mirrors the @comis/memory
      // row-schema / Phase-80 reranker baseline-orphan precedent. Shrink each
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
      // ContextStorePort is declared but not yet consumed by agent —
      // tracked as a planned-orphan policy entry mirrored from the
      // FileLockPort pattern. Preserved this entry through the split:
      // ContextStorePort is now a type alias
      // (`type ContextStorePort = ContextEngineStore & ContextAdminStore`)
      // and remains an in-codebase symbol consumed primarily by the
      // daemon's context-handlers + the memory contract test.
      "ContextStorePort",
      // ContextEngineStore (34 per-session read/write methods). Consumed
      // by the agent context-engine + the executor injection-deps types;
      // the public-export-consumers test resolves the consumer files (so
      // a runtime consumer entry is not required here for Engine).
      // Tracked alongside ContextAdminStore for documentation symmetry.
      // ContextAdminStore (4 admin/cleanup methods). The admin half of
      // ContextStorePort. No production consumer imports this name as a
      // value-typed annotation today — the daemon's context-handlers +
      // api/types.ts consume the wider intersection alias
      // `ContextStorePort` (which still resolves structurally through
      // the alias to the union of Engine + Admin methods). Tracked as a
      // planned-orphan policy entry mirroring the ContextStorePort
      // pattern above; the memory contract test gates the type contract
      // via `.toExtend<ContextAdminStore>()`.
      "ContextAdminStore",
      // Row DTOs for ContextStorePort moved from @comis/memory into
      // core/src/ports/context-store-types.ts. The 2 link-table types
      // (CtxSummaryMessageRow, CtxSummaryParentRow) were already orphans
      // under @comis/memory; the 7 method-signature types
      // (CtxConversationRow, CtxMessageRow, CtxMessagePartRow,
      // CtxSummaryRow, CtxContextItemRow, CtxLargeFileRow,
      // CtxExpansionGrantRow) are surfaced on @comis/core but consumed by
      // agent only after the agent imports are retargeted from
      // @comis/memory → @comis/core (mirrors the ContextStorePort
      // planned-orphan posture above).
      "CtxConversationRow",
      "CtxMessageRow",
      "CtxMessagePartRow",
      "CtxSummaryRow",
      "CtxSummaryMessageRow",
      "CtxSummaryParentRow",
      "CtxContextItemRow",
      "CtxLargeFileRow",
      "CtxExpansionGrantRow",
      // SessionStorePort + its 3 row DTOs are declared in
      // core/src/ports/{session-store,session-store-types}.ts but not yet
      // consumed by agent/cli value-import retargets — tracked as
      // planned-orphan policy entries (same pattern as ContextStorePort).
      "SessionStorePort",
      "SessionData",
      "SessionListEntry",
      "SessionDetailedEntry",
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
      "requiresConfirmation",
      "ActionClassification",
      "AuditEventSchema",
      "AuditEvent",
      "CreateAuditEventParams",
      "BLOCKED_RANGES",
      "CLOUD_METADATA_IPS",
      "ValidatedUrl",
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
      "SecretsConfigSchema",
      "DocumentationConfigSchema",
      "DocumentationLinkSchema",
      "ImageGenerationConfigSchema",
      "NotificationConfigSchema",
      "VerbosityConfigSchema",
      "VerbosityLevelSchema",
      "VerbosityOverrideSchema",
      "OutputRetentionConfigSchema",
      "MemoryReviewConfigSchema",
      // Per-agent consolidation config schema (Phase 84-04). Wired into PerAgentConfig
      // (schema-agent-runtime) WITHIN @comis/core; the daemon (Plan 84-05) consumes the
      // INFERRED config TYPE, not the schema value. The schema value therefore has no
      // out-of-package consumer — baseline orphan (mirror MemoryReviewConfigSchema).
      "MemoryConsolidationConfigSchema",
      // Per-agent reasoning config schema + type (Phase 101-02, REASON-04). Wired into
      // PerAgentConfig (schema-agent-runtime) WITHIN @comis/core; the schema-runtime attach
      // is a self-import (the public-export-consumers gate skips same-package imports), so
      // both the schema value AND the inferred config TYPE are surfaced AHEAD of their
      // cross-package consumers — the reasoning job reads MemoryReasoningConfig in 101-04/06
      // (the factory-orphan dance, mirror MemoryConsolidationConfigSchema @ 84-04 +
      // runMemoryTripleExtraction @ 100-05). Shrink when the 101-04/06 consumer lands.
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
      "SecretsConfig",
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
      // The 19 per-method contracts (8 memory + 4 OBS-06 diagnostics + 7
      // context as of Phase 86 Plan 05) have in-repo consumers via both
      // handler factories (imports + computed property keys). Only the
      // per-domain aggregator arrays MEMORY_CONTRACTS / MEMORY_DIAGNOSTIC_CONTRACTS
      // lack an external consumer (composed into API_CONTRACTS_ORDERED /
      // spread into MEMORY_CONTRACTS intra-package — the walker skips
      // self-imports). MEMORY_DIAGNOSTIC_CONTRACTS is the Phase-86 OBS-06
      // diagnostic group, now folded into MEMORY_CONTRACTS but still surfaced
      // on the public barrel for symmetry with the other domain arrays.
      "MEMORY_CONTRACTS",
      "MEMORY_DIAGNOSTIC_CONTRACTS",
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
      // ── v2.6 Memory consolidation (Phase 84 — interface-first foundation) ──
      // The segregated MemoryConsolidationStore port + its DTOs are the
      // contract the consolidation adapter (Plan 02, @comis/memory), job
      // (Plan 03, @comis/agent), and daemon wiring (Plan 05) depend on
      // existing first (the same interface-first pattern as MemoryEntityStore,
      // whose own consumers landed across Phase 83's plans). Shipped on the
      // @comis/core barrel now; the in-repo consumers land in Plans 02-05.
      // Shrink each entry as it gains a real consumer.
      "MemoryConsolidationStore",
      "ConsolidationCandidate",
      "ConsolidationPlan",
      // Provider-catalog symbols added in Phase 2 (BROKER-01..03). The broker
      // in @comis/infra imports resolveBinding, applyInjections, normalizeHost,
      // BrokerBinding, InjectionRule, HostRule, InjectionInput — all consumed.
      // pathAllowed is exported for external callers that need to gate requests;
      // the broker uses resolveBinding (which calls pathAllowed internally).
      // Broker wiring in the daemon composition root is Phase 3.
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
      // command or a broker health-check handler in Phase 9).
      "BrokerBindingConfigSchema",
      // Trust-first bi-temporal KG port (Phase 100-01, Track F — KG-01). The
      // TripleStorePort interface + TripleScope + TripleInput already have real
      // in-repo consumers (the @comis/memory adapter imports them by TYPE). The
      // TripleTrust ladder alias is referenced only INSIDE TripleInput.trust (a
      // field type, not a standalone import), so the export-graph walker counts
      // it as an orphan. It is part of the documented port API surface (callers
      // construct a TripleInput by naming the trust literal) — tracked here.
      // Shrinks when the Plan-02 offline writer / Plan-04 lane reference it directly.
      "TripleTrust",
    ])],
    // @comis/daemon: baseline orphans tracked here. All four
    // value-side root re-exports (createAnnouncementDeadLetterQueue,
    // createContextHandlers, createAgentHandlers, createTracingLogger)
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
    //   - createContextHandlers / ContextHandlerDeps
    //     → test/integration/context-dag-integration.test.ts:52-53 (static import)
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
      "createContextHandlers",
      "ContextHandlerDeps",
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
      // wired scoped stores (the OBS-08 cross-scope-leak negative + the EoP
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
      // Email approval-token route (73-10). createApprovalTokenRoute +
      // insertPendingApprovalToken + PendingApprovalToken + ApprovalLinkChoice are
      // consumed by the daemon composition root (setup-interactive-callback.ts +
      // setup-gateway-routes.ts). APPROVAL_TOKEN_TIMEOUT_MS is exported for test
      // parity (mirrors PENDING_FLOW_TIMEOUT_MS) and ApprovalTokenDeps is the
      // route's deps shape (the daemon constructs it inline) — both tracked here.
      "APPROVAL_TOKEN_TIMEOUT_MS",
      "ApprovalTokenDeps",
      // AcpServerDeps is NO LONGER an orphan: 74-07's daemon setup-acp-wiring.ts
      // imports the AcpServerDeps type from @comis/gateway to assemble the ACP
      // server deps (executionPlanPort + eventBus + activityStreamPort) — removed.
      // createAcpAgent + startAcpServer remain baseline orphans: 74-07 wired the
      // bridges + the executionPlanPort seam INSIDE startAcpServer and re-exported
      // startAcpServer from the package index (IN-02), but no daemon/CLI site yet
      // INVOKES startAcpServer (spawning the ACP subprocess entry point is a
      // separate concern, out of ACP-01..05). They light up when that caller lands.
      "createAcpAgent",
      "startAcpServer",
      // ACP activity/plan/approval bridges + the local bounded queue (Phase 74,
      // workstream D). After 74-07 these are CONSTRUCTED in-repo —
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
      // Credential broker (Phase 2) — no in-repo consumer yet.
      // The daemon composition root wires these in a future phase.
      "createSessionManager",
      "SessionManager",
      "SessionManagerDeps",
      "IssuedSession",
      "SessionInfo",
      "createMitmBroker",
      "MitmBrokerPort",
      "MitmBrokerDeps",
      // CA manager (Phase 3) — no in-repo consumer yet.
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
      "SessionData",
      "SessionListEntry",
      "InspectFilters",
      "ClearScope",
      "MemoryStats",
      "EmbeddingQueue",
      "EmbeddingProviderOptions",
      "createOpenAIEmbeddingProvider",
      "OpenAIEmbeddingProviderOptions",
      // Reranker provider options type (Phase 80). createLocalRerankerProvider is
      // consumed by the daemon (setup-memory); the options type is part of its public
      // API surface — baseline orphan until an external/test consumer references it.
      "LocalRerankerProviderOptions",
      // Entity-associative recall store (Phase 83-02). createSqliteMemoryEntityStore
      // is the sole MemoryEntityStore adapter; the daemon composition root constructs
      // it on the memory adapter's db handle in Plan 83-05 (setup-memory). Surfaced
      // here ahead of that wiring — baseline orphans until the daemon consumer lands.
      "createSqliteMemoryEntityStore",
      "MemoryEntityStoreDeps",
      // Temporal-spread store (Phase 95-02, LANES-02). createSqliteMemoryTemporalStore is the
      // sole MemoryTemporalStore adapter; the daemon composition root constructs it on the
      // memory adapter's db handle (setup-memory) — so the FACTORY has a production consumer.
      // The constructor-deps SHAPE type is part of its public API but is referenced only via
      // inline objects — baseline orphan (mirror MemoryEntityStoreDeps / MemoryUsefulnessStoreDeps).
      "MemoryTemporalStoreDeps",
      // Causal-edge store (Phase 96, EXTRACT-03). createSqliteMemoryCausalStore is the sole
      // MemoryCausalStore adapter; the daemon composition root constructs it on the memory
      // adapter's db handle in Plan 96-03 (setup-memory) — so the FACTORY has a production
      // consumer (the temporary 96-01 orphan entry was REMOVED here, the 95-02 factory-orphan
      // dance). The constructor-deps SHAPE type is part of its public API but is referenced only
      // via inline objects — PERMANENT baseline orphan (mirror MemoryEntityStoreDeps /
      // MemoryTemporalStoreDeps).
      "MemoryCausalStoreDeps",
      // Consolidation store (Phase 84-02). createSqliteMemoryConsolidationStore is the sole
      // MemoryConsolidationStore adapter; the daemon composition root constructs it on the
      // memory adapter's db handle in Plan 84-05 (setup-memory) — so the FACTORY has a
      // production consumer. The constructor-deps SHAPE type is part of its public API but
      // is referenced only via inline objects — baseline orphan (mirror MemoryEntityStoreDeps).
      "MemoryConsolidationStoreDeps",
      // Recall-utility usefulness store (Phase 93-01, FEED-02). createSqliteMemoryUsefulnessStore
      // is the sole MemoryUsefulnessStore adapter; the daemon composition root constructs it on
      // the memory adapter's db handle (setup-memory) — so the FACTORY has a production consumer.
      // The constructor-deps SHAPE type is part of its public API but is referenced only via
      // inline objects — baseline orphan (mirror MemoryEntityStoreDeps / MemoryConsolidationStoreDeps).
      "MemoryUsefulnessStoreDeps",
      // Trust-first bi-temporal KG triple store (Phase 100-01, Track F — KG-01).
      // createSqliteTripleStore NOW has a production consumer — the daemon
      // composition root constructs it on the memory adapter's db handle in
      // setup-memory (Plan 100-05) — so its orphan entry was REMOVED here (the
      // factory-orphan dance SHRANK on schedule, mirror createSqliteMemoryCausalStore
      // @ 96-03). MemoryTripleStoreDeps is the constructor-deps SHAPE (referenced via
      // inline objects only) — PERMANENT baseline orphan (mirror MemoryCausalStoreDeps).
      // MemoryTripleRowSchema is the row schema consumed by createRowMapper inside the
      // adapter (an intra-file value reference, not a cross-file import), so the
      // export-graph walker counts it as an orphan — tracked here (mirror the other
      // *RowSchema entries).
      "MemoryTripleStoreDeps",
      "MemoryTripleRowSchema",
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
      "initContextSchema",
      "CtxConversationRow",
      "CtxMessagePartRow",
      "CtxSummaryMessageRow",
      "CtxSummaryParentRow",
      "CtxLargeFileRow",
      "CtxExpansionGrantRow",
      // Agent retargeted these 5 names from @comis/memory → @comis/core.
      // Memory's barrel still re-exports them (SessionStore is now a type
      // alias of SessionStorePort). No in-repo production consumer remains
      // until the alias re-exports are retired entirely from
      // packages/memory/src/index.ts.
      "SessionStore",
      "SessionDetailedEntry",
      "CtxMessageRow",
      "CtxSummaryRow",
      "CtxContextItemRow",
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
      // Entity-association row schemas (Phase 83-01). Consumed intra-package by
      // sqlite-memory-entity-store.ts (Plan 83-02) via createRowMapper; surfaced
      // through `export *` so tracked here like the sibling row schemas (the
      // checker counts cross-package barrel consumers only).
      "MemoryEntityRowSchema",
      "EntityLaneRowSchema",
      // Causal one-hop edge-lookup row schema (Phase 96-01, EXTRACT-03). Consumed
      // intra-package by sqlite-memory-causal-store.ts via createRowMapper;
      // barrel-surfaced through `export *` so tracked here like its Phase-83 siblings.
      "CausalLaneRowSchema",
      // Graph-spread recursive-CTE node projection schema (Phase 100-04, KG-04).
      // Consumed intra-package by sqlite-triple-store.ts (the spreadLane walk) via
      // createRowMapper; barrel-surfaced through `export *` so tracked here like the
      // MemoryTripleRowSchema / CausalLaneRowSchema siblings (the checker counts
      // cross-package barrel consumers only).
      "SpreadNodeRowSchema",
      // Recall-utility usefulness row schema (Phase 93-01, FEED-02). Consumed
      // intra-package by sqlite-memory-usefulness-store.ts via createRowMapper;
      // barrel-surfaced through `export *` so tracked here like the sibling row
      // schemas (the checker counts cross-package barrel consumers only).
      "MemoryUsefulnessRowSchema",
      // OBS-06 entity-graph diagnostic row schema (Phase 86 / listEntities).
      // Consumed intra-package by sqlite-memory-entity-store.ts via
      // createRowMapper; barrel-surfaced like its Phase-83 siblings above.
      "EntityListRowSchema",
      "SessionRowSchema",
      "SessionRowFromSchema",
      "VecSearchRowSchema",
      "VecSearchRowFromSchema",
      "FtsSearchRowSchema",
      "FtsSearchRowFromSchema",
      "NamedGraphRowSchema",
      "NamedGraphRowFromSchema",
      // Context-store row schemas + inferred types (9 × 2 = 18 entries):
      "CtxConversationRowSchema",
      "CtxConversationRowFromSchema",
      "CtxMessageRowSchema",
      "CtxMessageRowFromSchema",
      "CtxMessagePartRowSchema",
      "CtxMessagePartRowFromSchema",
      "CtxSummaryRowSchema",
      "CtxSummaryRowFromSchema",
      "CtxSummaryMessageRowSchema",
      "CtxSummaryMessageRowFromSchema",
      "CtxSummaryParentRowSchema",
      "CtxSummaryParentRowFromSchema",
      "CtxContextItemRowSchema",
      "CtxContextItemRowFromSchema",
      "CtxLargeFileRowSchema",
      "CtxLargeFileRowFromSchema",
      "CtxExpansionGrantRowSchema",
      "CtxExpansionGrantRowFromSchema",
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
    ])],
  ]);
