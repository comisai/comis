// SPDX-License-Identifier: Apache-2.0
/**
 * Documented external-API surface + Phase 27 baseline orphan-export tracking.
 *
 * Two categories of entries live here:
 *
 * 1. EXTERNAL-API entries (Plan 01 seed, retained):
 *    `@comis/cli` exposes three entrypoints intended for embedding code:
 *      - `withClient` -- daemon-RPC connection helper for embedding code.
 *      - `credentialsStep` -- wizard step exposed for embed-and-extend.
 *      - `RpcClient` -- direct RPC handle for advanced consumers.
 *
 * 2. PHASE-27-BASELINE orphan-export entries (Plan 05 extension):
 *    Symbols re-exported from packages/<pkg>/src/index.ts that have NO
 *    in-repo consumer at Phase 27 baseline. These are tracked here as the
 *    public-export-consumers.test.ts gate would otherwise fire on them on
 *    every PR. Phase 29 (PUB-EXPORTS-01..05) closes the bulk by either
 *    REMOVING dead exports from the index files (preferred) or PROMOTING
 *    them to the documented external-API surface with a rationale.
 *
 *    The baseline is shrink-only by convention — entries should be removed
 *    as the corresponding export is removed from the package index.ts OR
 *    a real in-repo consumer is added.
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
    // @comis/agent: 349 pre-Phase-29 baseline orphans tracked here (SessionLifecycle + createSessionManager removed in 29-02, L10 closed; SessionLifecycleOptions remains — no in-repo consumer yet).
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
      "createModelAliasResolver",
      "ModelAliasResolver",
      "ModelAliasResolverDeps",
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
      // Phase 28 commit 5 (CORE-PORTS-14 / L4 closure): decodeCodexJwtPayload,
      // resolveCodexStableSubject, resolveCodexAccessTokenExpiry, OAuthErrorCode,
      // RewrittenOAuthError moved to @comis/core/src/security/oauth-helpers.ts
      // and are tracked under "@comis/core" below.
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
      // resolveAgent removed in Phase 32 commit 7 (ORCH-EXT-08) — moved from
      // @comis/agent to @comis/orchestrator alongside createMessageRouter and
      // the MessageRouter type. No baseline entry in @comis/orchestrator
      // (createMessageRouter has setup-channels.ts as in-repo consumer, and
      // MessageRouter has channel-manager.ts + inbound-pipeline.ts as in-repo
      // consumers via the orchestrator-internal relative import). resolveAgent
      // is also without an in-repo consumer post-move, but the
      // public-export-consumers gate is the source of truth — if it surfaces
      // an orphan, re-add to the @comis/orchestrator policy entry.
      "SessionLifecycleOptions",
      "createSessionLabelStore",
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
      "createIdentityLinkResolver",
      "IdentityLinkResolver",
      "IdentityLinkResolverDeps",
      "GreetingGeneratorDeps",
      "MemoryReviewDeps",
      "createRagRetriever",
      "formatMemorySection",
      "RagRetriever",
      "RagRetrieverDeps",
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
      "createPriorityScheduler",
      "PrioritySchedulerDeps",
      "LaneStats",
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
      "CacheTraceConfig",
      "ApiPayloadTraceConfig",
      "TruncationSummary",
      "ToolResultSizeBouncerResult",
      "composeStreamWrappers",
      "createConfigResolver",
      "createRequestBodyInjector",
      "createCacheTraceWriter",
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
      // Phase 34 plan 01 (DAEMON-API-01): sub-agent runtime moved from
      // packages/daemon/src/ to packages/agent/src/spawn/. The 7 entries
      // below are the move's type and helper exports that have no in-repo
      // consumer at the moment (the moved tests/integration coverage import
      // via the local file path, not via @comis/agent). createSubAgentRunner
      // and ANNOUNCE_PARENT_TIMEOUT_MS are NOT listed because they DO have
      // in-repo consumers (wiring/setup-cross-session.ts and
      // graph/graph-completion.ts respectively).
      "SubAgentRunnerDeps",
      "SubAgentRun",
      "SpawnParams",
      "SubAgentRunnerLogger",
      "sweepResultFiles",
      "buildAnnouncementMessage",
      "deliverFailureNotification",
    ])],
    // @comis/channels: 151 pre-Phase-29 baseline orphans tracked here.
    // Phase 30 plan 02 (CONFIG-DELIV-04, -05): the 5 delivery helpers + the
    // Markdown IR pipeline (incl. telegram-file-ref-guard) moved from
    // packages/channels/src/shared/ to packages/core/src/delivery/. The 8
    // channel-baseline entries that came from those moved modules
    // (RetryEngine, chunkForDelivery, ChunkForDeliveryOptions,
    // PERMANENT_ERROR_PATTERNS, guardTelegramFileRefs,
    // isTelegramFileGuardEnabled, ALWAYS_GUARD_EXTENSIONS,
    // AMBIGUOUS_EXTENSIONS) are removed from this set and re-added under
    // @comis/core below (per AGENTS.md §2.3 no back-compat shims).
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
      "createDiscordResolver",
      "DiscordResolverDeps",
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
      "createSignalResolver",
      "SignalResolverDeps",
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
      // Phase 30 plan 06: deliverToChannel, DeliverToChannelDeps,
      // DeliveryResult, ChunkDeliveryResult, resolveChunkLimit, and
      // QUEUE_BACKOFF_SCHEDULE_MS were removed from @comis/channels exports
      // when packages/channels/src/shared/deliver-to-channel.ts was deleted.
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
      // Phase 32 commit 3 (ORCH-EXT-10): two channels-side symbols consumed only
      // by the orchestrator-side test fixtures (`packages/orchestrator/src/
      // execution/execution-pipeline.test.ts`). The public-export-consumers gate
      // excludes `*.test.ts` files from its in-repo consumer scan, so test-only
      // consumers don't satisfy the gate even though the symbols ARE used.
      // Both go away at commit 4 when channel-manager + bucket-A internals
      // (block-pacer + telegram thread-context) move to orchestrator and these
      // entries are removed.
      "PacerConfig",
      "TELEGRAM_THREAD_META_KEYS",
    ])],
    // @comis/cli: 3 documented external-API entries (withClient,
    // credentialsStep, RpcClient). All register*Command factories and
    // output utilities (success/error/warn/info/json/renderTable/
    // renderKeyValue/withSpinner) were removed from cli/src/index.ts
    // in Phase 29 (PUB-EXPORTS-01 / L9 closure) — they remain
    // accessible to the bin only via ./commands/*.js / ./output/*.js
    // direct source paths and are NOT re-exported from the package.
    ["@comis/cli", new Set<string>([
      "withClient",
      "credentialsStep",
      "RpcClient",
    ])],
    // @comis/core: 379 baseline orphans tracked here (367 post-Phase-28; Phase 29-04 sweep dropped 3: ZERO_WIDTH_REGEX, SchedulerConfigSchema, SchedulerConfig; Phase 30 plan 02 added 9; Phase 31 plan 05 added 3 master-key helpers; Phase 38 plan 02 BC-REM-10 re-added ZERO_WIDTH_REGEX after sanitizer.ts re-export deletion — see inline comment near end of this set).
    // added by Phase 30 plan 02 — see the inline comment near the end of
    // this set).
    ["@comis/core", new Set<string>([
      "AttachmentSchema",
      "NormalizedMessageSchema",
      "parseMessage",
      "TrustLevelSchema",
      "MemorySourceSchema",
      "MemoryEntrySchema",
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
      // Phase 28 commit 4 (CORE-PORTS-13): ContextStorePort is declared in
      // Phase 28 but consumed by agent only after Phase 31 commit 1's retarget.
      // No in-repo consumer yet — tracked as a planned-orphan policy entry
      // mirrored from the FileLockPort pattern (Wave 3 retargeted agent's
      // OAuth call sites at commit time, but ContextStorePort waits for
      // Phase 31's agent retarget so the row DTOs can move to core/src/ports
      // /context-store-types.ts via the TS compiler-API walker per RES-PIT-5).
      "ContextStorePort",
      // Phase 31 commit 1 (MEM-CTX-PORTS-03 + MEM-CTX-PORTS-04): row DTOs
      // for ContextStorePort moved from @comis/memory into core/src/ports/
      // context-store-types.ts. The 2 link-table types (CtxSummaryMessageRow,
      // CtxSummaryParentRow) were already orphans under @comis/memory; the
      // 7 method-signature types (CtxConversationRow, CtxMessageRow,
      // CtxMessagePartRow, CtxSummaryRow, CtxContextItemRow, CtxLargeFileRow,
      // CtxExpansionGrantRow) are surfaced on @comis/core in commit 1 but
      // consumed by agent only after Phase 31 commits 2-4 retarget agent's
      // imports from @comis/memory → @comis/core (mirrors the ContextStorePort
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
      // Phase 31 commit 1 (MEM-CTX-PORTS-03): SessionStorePort + its 3 row
      // DTOs are declared in core/src/ports/{session-store,session-store-types}.ts
      // in commit 1; agent/cli value-import retargets land in Phase 31
      // commits 2-4. Until then no in-repo consumer — tracked as
      // planned-orphan policy entries (same pattern as ContextStorePort).
      "SessionStorePort",
      "SessionData",
      "SessionListEntry",
      "SessionDetailedEntry",
      // Phase 31 commit 5 (MEM-CTX-PORTS-09): master-key file helpers
      // extracted from CLI's `secrets init` body into
      // core/src/security/master-key.ts. The CLI rewrite that wires these as
      // the in-repo consumer lands in plan 31-10; until then the three names
      // are surfaced on @comis/core's public barrel without a consumer —
      // tracked here as planned-orphan policy entries (same pattern as
      // SessionStorePort above).
      "writeMasterKeyIfAbsent",
      "generateMasterKey",
      "MasterKeyWriteResult",
      // Phase 28 commit 5 (CORE-PORTS-14 / L4 closure): OAuth helpers
      // consolidated in @comis/core/src/security/oauth-helpers.ts. The two
      // verbatim-moved JWT helpers (decodeCodexJwtPayload,
      // resolveCodexStableSubject) carry no in-repo consumer post-move (same
      // baseline orphan posture they had in @comis/agent pre-move), and the
      // RewrittenOAuthError result type is consumed only via the function's
      // return value (no explicit type-import consumer in repo). The other
      // five helpers (resolveCodexAuthIdentity, redactEmailForLog,
      // rewriteOAuthError, resolveCodexAccessTokenExpiry, OAuthErrorCode) have
      // real in-repo consumers in agent + cli + gateway and are NOT listed.
      "decodeCodexJwtPayload",
      "resolveCodexStableSubject",
      "RewrittenOAuthError",
      "SkillPort",
      "SkillPermissions",
      "SkillInput",
      "SkillOutput",
      "SkillManifest",
      "FileExtractionErrorKind",
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
      "PluginPort",
      "RegisteredHook",
      "PluginToolDefinition",
      "PluginHttpRoute",
      "OutputGuardFinding",
      "OutputGuardResult",
      "Provider",
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
      "SECRET_FIELD_PATTERN",
      "scanConfigForSecrets",
      "scanEnvForSecrets",
      "AuditSeverity",
      "AuditOptions",
      // Re-added by Phase 38 BC-REM-10: sanitizer.ts BC re-export deleted; the
      // only remaining in-repo consumer is sanitizer.test.ts (test files are
      // excluded from public-export-consumers.test.ts's consumer scan).
      // ZERO_WIDTH_REGEX is part of the documented @comis/core security surface
      // (paired with TAG_BLOCK_REGEX, stripInvisible, containsTagBlockChars).
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
      "PriorityLaneConfigSchema",
      "LaneAssignmentConfigSchema",
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
      // Phase 30 plan 06: setGlobalHookRunner / getGlobalHookRunner /
      // clearGlobalHookRunner were removed when
      // packages/core/src/hooks/hook-runner-global.ts was deleted. Delivery
      // composition now threads HookRunner via DeliveryServiceDeps.
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
      // Phase 30 plan 02 (CONFIG-DELIV-04, -05): the Markdown IR pipeline +
      // delivery helpers moved from @comis/channels/src/shared/ to
      // @comis/core/src/delivery/. These 9 entries are baseline orphans
      // post-move: 5 were @comis/channels baseline orphans before
      // (PERMANENT_ERROR_PATTERNS, ChunkForDeliveryOptions,
      // guardTelegramFileRefs, isTelegramFileGuardEnabled,
      // ALWAYS_GUARD_EXTENSIONS, AMBIGUOUS_EXTENSIONS), 3 are newly-public
      // surfaces created by this plan's scope expansion (parseMarkdownToIR,
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
      // Phase 30 plan 03 (CONFIG-DELIV-04, -06): the new
      // createDeliveryService factory + DeliveryService / DeliveryServiceDeps
      // interfaces land before production callers migrate. Plans 04-05 wire
      // them into daemon/wiring (setup-channels, message-handlers,
      // setup-cross-session) and the channels execution-pipeline /
      // approval-notifier / inbound-gate; once those land, these three
      // entries will have in-repo consumers and these baseline-orphan
      // entries can be removed. Until then they live here.
      "createDeliveryService",
      "DeliveryService",
      "DeliveryServiceDeps",
      // Phase 30 plan 06 (CONFIG-DELIV-04, -07): symbols formerly exported
      // by @comis/channels via packages/channels/src/shared/deliver-to-channel.ts
      // (deleted in plan 06). They were re-exported from @comis/core via
      // core/src/exports/delivery.ts for surface continuity. After deletion,
      // the only in-repo consumer of QUEUE_BACKOFF_SCHEDULE_MS /
      // resolveChunkLimit / chunkBlocks / DeliveryStrategy / ChunkDeliveryResult
      // / DeliveryResult was the deleted channels-side file; the helpers
      // remain on the public surface (downstream embedders may consume them).
      // computeQueueBackoff has an in-repo consumer (daemon's
      // setup-delivery.ts) so it is NOT listed here.
      "QUEUE_BACKOFF_SCHEDULE_MS",
      "resolveChunkLimit",
      "chunkBlocks",
      "DeliveryStrategy",
      "ChunkDeliveryResult",
      "DeliveryResult",
      // Phase 35 Wave A (35-01): the contract-registry foundation lands
      // before any Wave C plan adds per-domain consumers. The registry +
      // its types/helpers are the public surface that Wave C handlers, CLI
      // client, and codegen consume. Until Wave C lands (35-06..35-19),
      // there are no in-repo consumers OUTSIDE packages/core/, so these
      // exports are tracked as planned-orphan policy entries. The
      // bidirectional + allowlist + internal-fields architecture tests
      // exercise them at test-time but the public-export-consumers walker
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
      // Phase 35 Wave C (35-06) — daemon-domain contracts. The per-method
      // contracts (`DaemonSetLogLevelContract`, `SystemPingContract`) have
      // in-repo consumers as of Plan 35-06 Task 2 (daemon-handlers.ts +
      // CLI's daemon-guard.ts + commands/daemon.ts), so they are NOT
      // policy-listed here. `DAEMON_CONTRACTS` IS policy-listed: it is
      // composed into `API_CONTRACTS_ORDERED` inside @comis/core's own
      // index.ts (intra-package — the walker skips self-imports), and no
      // external consumer imports the per-domain array directly. Plan
      // 35-19 (Wave C closure) supersedes the registry composition with
      // a final alphabetical aggregation; the entry remains as long as
      // intra-package aggregation is the only consumer.
      "DAEMON_CONTRACTS",
      // Phase 35 Wave C (35-07) — auth-domain contracts. Same pattern as
      // 35-06: `AuthListContract` + `AuthLogoutContract` gain in-repo
      // consumers in this commit (daemon-handlers.ts + commands/auth.ts),
      // so only the per-domain aggregator array `AUTH_CONTRACTS` lacks an
      // external consumer (composed into `API_CONTRACTS_ORDERED`
      // intra-package). Same supersession path as `DAEMON_CONTRACTS`
      // when Plan 35-19 lands.
      "AUTH_CONTRACTS",
      // Phase 35 Wave C (35-08) — secrets-domain contracts. Same pattern as
      // 35-06/35-07: the 4 per-method contracts (SecretsSetContract,
      // SecretsGetContract, SecretsListContract, SecretsDeleteContract)
      // gain in-repo consumers in this commit
      // (packages/daemon/src/api/secrets-handlers.ts + packages/cli/src/
      // commands/secrets.ts), so only the per-domain aggregator array
      // `SECRETS_CONTRACTS` lacks an external consumer (composed into
      // `API_CONTRACTS_ORDERED` intra-package). Same supersession path
      // as `DAEMON_CONTRACTS` / `AUTH_CONTRACTS` when Plan 35-19 lands.
      "SECRETS_CONTRACTS",
      // Phase 35 Wave C (35-09) — tokens-domain contracts. BLOCKER 1
      // exemption: tokens are managed via the web SPA only — no CLI
      // consumer exists for `tokens.list|create|revoke|rotate` in
      // packages/cli/src/commands/. The 4 per-method contracts
      // (TokensListContract, TokensCreateContract, TokensRevokeContract,
      // TokensRotateContract) gain in-repo consumers in this commit via
      // packages/daemon/src/api/token-handlers.ts. The web SPA consumes
      // its own typed registry at packages/web/src/api/types/
      // rpc-registry.ts (not @comis/core directly); Wave D codegen will
      // bridge those types from this contract registry. Only the
      // per-domain aggregator array `TOKENS_CONTRACTS` lacks an external
      // consumer (composed into `API_CONTRACTS_ORDERED` intra-package).
      // Same supersession path as `DAEMON_CONTRACTS` / `AUTH_CONTRACTS`
      // / `SECRETS_CONTRACTS` when Plan 35-19 lands.
      "TOKENS_CONTRACTS",
      // Phase 35 Wave C (35-10) — mcp-domain contracts. BLOCKER 1
      // exemption: MCP RPC methods are managed via the web SPA only —
      // no CLI consumer exists for
      // `mcp.list|status|connect|disconnect|reconnect|test` in
      // packages/cli/src/commands/. (The CLI's `comis mcp` surface
      // touches `config.read` / `config.patch` for
      // `integrations.mcp.servers` entries, NOT these admin RPCs.) The
      // 6 per-method contracts (McpListContract, McpStatusContract,
      // McpConnectContract, McpDisconnectContract, McpReconnectContract,
      // McpTestContract) gain in-repo consumers in this commit via
      // packages/daemon/src/api/mcp-handlers.ts. The web SPA consumes
      // its own typed registry; Wave D codegen will bridge those types
      // from this contract registry. Only the per-domain aggregator
      // array `MCP_CONTRACTS` lacks an external consumer (composed
      // into `API_CONTRACTS_ORDERED` intra-package). Same supersession
      // path as `DAEMON_CONTRACTS` / `AUTH_CONTRACTS` /
      // `SECRETS_CONTRACTS` / `TOKENS_CONTRACTS` when Plan 35-19 lands.
      "MCP_CONTRACTS",
      // Phase 35 Wave C (35-11) — config + env + gateway-infrastructure
      // contracts (12 methods: 8 config.* + 2 gateway.* + 2 env.*).
      // The 12 per-method contracts (ConfigReadContract,
      // ConfigSchemaContract, ConfigPatchContract, ConfigApplyContract,
      // ConfigHistoryContract, ConfigDiffContract, ConfigRollbackContract,
      // ConfigGcContract, GatewayStatusContract, GatewayRestartContract,
      // EnvSetContract, EnvListContract) gain in-repo consumers in this
      // commit via packages/daemon/src/api/config-handlers.ts +
      // packages/daemon/src/api/env-handlers.ts + the CLI retarget
      // (packages/cli/src/commands/config.ts imports
      // ConfigReadContract / ConfigPatchContract / ConfigHistoryContract /
      // ConfigDiffContract / ConfigRollbackContract — closes BLOCKER 1
      // for the config.* portion). Only the per-domain aggregator
      // array `CONFIG_CONTRACTS` lacks an external consumer (composed
      // into `API_CONTRACTS_ORDERED` intra-package — the walker skips
      // self-imports). Same supersession path as the prior 5 Wave C
      // aggregator arrays when Plan 35-19 lands.
      "CONFIG_CONTRACTS",
      // Phase 35 Wave C (35-12) — observability-domain contracts (18
      // methods: obs.diagnostics + 5 obs.billing.* + 3 obs.channels.* +
      // 2 obs.delivery.* + 2 obs.context.* + 2 obs.reset.* +
      // obs.getCacheStats + agent.cacheStats + memory.embeddingCache).
      // BLOCKER 1 exemption (web-SPA only — verified via empty CLI grep
      // for `client.call("obs.*|"agent.cacheStats|"memory.embeddingCache`).
      // The 18 per-method contracts gain in-repo consumers in this
      // commit via packages/daemon/src/api/obs-handlers.ts (imports all
      // 18 contracts + uses each as a computed property key). Only the
      // per-domain aggregator array `OBSERVABILITY_CONTRACTS` lacks an
      // external consumer (composed into `API_CONTRACTS_ORDERED`
      // intra-package — the walker skips self-imports). Same
      // supersession path as `DAEMON_CONTRACTS` / `AUTH_CONTRACTS` /
      // `SECRETS_CONTRACTS` / `TOKENS_CONTRACTS` / `MCP_CONTRACTS` /
      // `CONFIG_CONTRACTS` when Plan 35-19 lands.
      "OBSERVABILITY_CONTRACTS",
      // Phase 35 Wave C (35-13) — workspace-umbrella contracts (36 methods
      // spanning 5 handler-factory files that share the WorkspaceApiDeps
      // cluster slice from Phase 34 plan 34-08a):
      //   - workspace-handlers.ts  (12 methods)
      //   - browser-handlers.ts    (13 methods)
      //   - approval-handlers.ts   ( 4 methods incl. admin.approval.resolveAll)
      //   - skill-handlers.ts      ( 6 methods incl. skills.create / skills.update)
      //   - notification-handlers.ts ( 1 method: notification.send)
      // Plan 35-13 SPLIT the contract authoring into Task 1 (workspace +
      // browser = 25 contracts) and Task 2 (approval + skill + notification
      // = 11 more). The policy entry is added in Task 1 so the
      // public-export-consumers gate covers the aggregator from the first
      // commit. BLOCKER 1 exemption (web-SPA only — verified via empty CLI
      // grep). The 36 per-method contracts gain in-repo consumers across
      // the two commits via the 5 handler factories (imports + computed
      // property keys). Only the per-domain aggregator array
      // `WORKSPACE_CONTRACTS` lacks an external consumer (composed into
      // `API_CONTRACTS_ORDERED` intra-package). Same supersession path as
      // `DAEMON_CONTRACTS` / `AUTH_CONTRACTS` / `SECRETS_CONTRACTS` /
      // `TOKENS_CONTRACTS` / `MCP_CONTRACTS` / `CONFIG_CONTRACTS` /
      // `OBSERVABILITY_CONTRACTS` when Plan 35-19 lands.
      "WORKSPACE_CONTRACTS",
      // Phase 35 Wave C (35-14) — memory + context-domain contracts (15
      // methods spanning 2 handler-factory files that share the
      // MemoryApiDeps cluster slice from Phase 34 plan 34-08a):
      //   - memory-handlers.ts  (8 methods)
      //   - context-handlers.ts (7 methods)
      // The 15 per-method contracts gain in-repo consumers in the same
      // commit via both handler factories (imports + computed property
      // keys). Only the per-domain aggregator array MEMORY_CONTRACTS
      // lacks an external consumer (composed into API_CONTRACTS_ORDERED
      // intra-package — the walker skips self-imports). Same supersession
      // path as DAEMON_CONTRACTS / AUTH_CONTRACTS / SECRETS_CONTRACTS /
      // TOKENS_CONTRACTS / MCP_CONTRACTS / CONFIG_CONTRACTS /
      // OBSERVABILITY_CONTRACTS / WORKSPACE_CONTRACTS when Plan 35-19
      // lands.
      "MEMORY_CONTRACTS",
      // Phase 35 Wave C (35-15) — media + image-domain contracts (16
      // methods spanning 2 handler-factory files that share the
      // MediaApiDeps cluster slice from Phase 34 plan 34-08a):
      //   - media-handlers.ts  (15 methods)
      //   - image-handlers.ts  ( 1 method)
      // The 16 per-method contracts gain in-repo consumers in the same
      // commit via both handler factories (imports + computed property
      // keys). Only the per-domain aggregator array MEDIA_CONTRACTS
      // lacks an external consumer (composed into API_CONTRACTS_ORDERED
      // intra-package — the walker skips self-imports). Same supersession
      // path as DAEMON_CONTRACTS / AUTH_CONTRACTS / SECRETS_CONTRACTS /
      // TOKENS_CONTRACTS / MCP_CONTRACTS / CONFIG_CONTRACTS /
      // OBSERVABILITY_CONTRACTS / WORKSPACE_CONTRACTS / MEMORY_CONTRACTS
      // when Plan 35-19 lands.
      "MEDIA_CONTRACTS",
      // Phase 35 Wave C (35-16) — agents + models + providers-domain
      // contracts (17 methods spanning 3 handler-factory files that share
      // the AgentsApiDeps cluster slice from Phase 34 plan 34-08a):
      //   - agent-handlers.ts     (7 methods — agents.* + agent.getOperationModels)
      //   - model-handlers.ts     (3 methods — models.*)
      //   - provider-handlers.ts  (7 methods — providers.*)
      // The 17 per-method contracts gain in-repo consumers in the same
      // commit via all 3 handler factories (imports + computed property
      // keys) AND via 3 CLI command files (callTyped retargets in
      // commands/agent.ts + commands/models.ts + commands/providers.ts).
      // Only the per-domain aggregator array AGENTS_CONTRACTS lacks an
      // external consumer (composed into API_CONTRACTS_ORDERED intra-
      // package — the walker skips self-imports). Same supersession path
      // as DAEMON_CONTRACTS / AUTH_CONTRACTS / SECRETS_CONTRACTS /
      // TOKENS_CONTRACTS / MCP_CONTRACTS / CONFIG_CONTRACTS /
      // OBSERVABILITY_CONTRACTS / WORKSPACE_CONTRACTS / MEMORY_CONTRACTS /
      // MEDIA_CONTRACTS when Plan 35-19 lands.
      "AGENTS_CONTRACTS",
      // Phase 35 Wave C (35-17) — channels + message + platform-action
      // contracts (19 methods spanning 2 handler-factory files that share
      // the ChannelsApiDeps cluster slice from Phase 34 plan 34-08a):
      //   - channel-handlers.ts  (8 methods — channels.* + delivery.queue.status)
      //   - message-handlers.ts  (11 methods — message.* + 4 platform.action)
      // BLOCKER 1 exemption (web-SPA only — verified via empty CLI grep
      // for `client.call("channels.*|"message.*|"telegram.action|"discord.action|
      // "slack.action|"whatsapp.action|"delivery.queue.status`). The 19
      // per-method contracts gain in-repo consumers in this commit via both
      // handler factories (imports + computed property keys). Only the
      // per-domain aggregator array CHANNELS_CONTRACTS lacks an external
      // consumer (composed into API_CONTRACTS_ORDERED intra-package — the
      // walker skips self-imports). Same supersession path as
      // DAEMON_CONTRACTS / AUTH_CONTRACTS / SECRETS_CONTRACTS /
      // TOKENS_CONTRACTS / MCP_CONTRACTS / CONFIG_CONTRACTS /
      // OBSERVABILITY_CONTRACTS / WORKSPACE_CONTRACTS / MEMORY_CONTRACTS /
      // MEDIA_CONTRACTS / AGENTS_CONTRACTS when Plan 35-19 lands.
      "CHANNELS_CONTRACTS",
      // Phase 35 Wave C (35-18) — orchestrator-umbrella contracts (27
      // methods spanning 4 handler-factory files that share the
      // OrchestratorApiDeps cluster slice from Phase 34 plan 34-08a):
      //   - cron-handlers.ts       (8 methods — cron.* + scheduler.wake)
      //   - graph-handlers.ts      (12 methods — graph.*)
      //   - heartbeat-handlers.ts  (4 methods — heartbeat.*)
      //   - subagent-handlers.ts   (3 methods — subagent.*)
      // BLOCKER 1 exemption (web-SPA only — verified via empty CLI grep
      // for `client.call("cron.*|"graph.*|"heartbeat.*|"subagent.*`). The
      // 27 per-method contracts gain in-repo consumers in this commit via
      // all 4 handler factories (imports + computed property keys). Also
      // folds the cron.add transformer relocation per PATTERNS OQ-4
      // option (c) — setup-gateway-api.ts loses the inline cron.add
      // special-case registration; the handler body normalizes both web
      // (nested schedule) and legacy (flat) shapes. BLOCKER 8 (single-scope
      // invariant) verified by orchestrator.test.ts. Only the per-domain
      // aggregator array ORCHESTRATOR_CONTRACTS lacks an external consumer
      // (composed into API_CONTRACTS_ORDERED intra-package — the walker
      // skips self-imports). Same supersession path as DAEMON_CONTRACTS /
      // AUTH_CONTRACTS / SECRETS_CONTRACTS / TOKENS_CONTRACTS /
      // MCP_CONTRACTS / CONFIG_CONTRACTS / OBSERVABILITY_CONTRACTS /
      // WORKSPACE_CONTRACTS / MEMORY_CONTRACTS / MEDIA_CONTRACTS /
      // AGENTS_CONTRACTS / CHANNELS_CONTRACTS when Plan 35-19 lands.
      "ORCHESTRATOR_CONTRACTS",
      // Phase 35 Wave C (35-19 — Wave C CLOSURE) — sessions contracts
      // (12 methods spanning the single session-handlers.ts factory file
      // that owns the SessionsApiDeps cluster slice from Phase 34 plan
      // 34-08a): session.status / agents.list / session.list /
      // session.search / session.history / session.send / session.spawn /
      // session.run_status / session.delete / session.reset /
      // session.export / session.compact. CLI consumers: 5 sites
      // retargeted to callTyped across packages/cli/src/commands/sessions.ts
      // (3 sites) + packages/cli/src/commands/reset.ts (2 sites). The 12
      // per-method contracts gain in-repo consumers in this commit via the
      // handler factory (imports + computed property keys) AND the CLI
      // command files. Only the per-domain aggregator array
      // SESSIONS_CONTRACTS lacks an external consumer (composed into
      // API_CONTRACTS_ORDERED intra-package — the walker skips
      // self-imports). Plan 35-19 ALSO performs the BLOCKER 6 atomic
      // edit of api-contracts/index.ts (final 14-domain alphabetically-
      // sorted aggregator), the BLOCKER 2 closure (cli-uses-typed-rpc
      // un-skip), and the BLOCKER 9 closure (bidirectional test is the
      // authoritative count — no hardcoded floor).
      "SESSIONS_CONTRACTS",
      // Phase 35 Wave A (35-02) — D-01 #1/#3/#5 + WEB-CONTRACTS-04/05:
      // four runtime adapters relocated/added in @comis/core so Plan 35-05
      // can sever the last cli → @comis/agent + cli → @comis/infra import
      // sites. The adapters land here in Wave A (purely additive); the
      // existing scheduler-side `createFileLock` and agent-side
      // `isRemoteEnvironment` stay in place until Plan 35-04/05 deletes
      // them. Until Plan 35-05's CLI retarget, no in-repo consumer
      // imports these names FROM @comis/core, so they're tracked as
      // planned-orphan policy entries (same pattern as the Wave A
      // contract-registry entries directly above). `isDocker` already had
      // a consumer pre-Phase-35 (Phase 33 SKILLS-SPLIT-09 moved its
      // canonical home to core) and is NOT listed.
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
      // Phase 35 Plan 35-03 (WEB-CONTRACTS-02 D-01 #2) — OAuth helpers
      // relocated from @comis/agent. Wave A additive: agent re-exports
      // remain live so existing in-tree consumers (CLI, daemon, wizard)
      // still resolve through @comis/agent until Plan 35-05 retargets.
      // The new @comis/core barrel exposes the relocated symbols but no
      // in-repo source consumes them FROM @comis/core yet — track them
      // as planned-orphan policy entries. Plan 35-05 removes these as it
      // retargets CLI imports.
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
      // Phase 35 Plan 35-04 (D-01 #4/#5): CLI + daemon now consume
      // createModelCatalog + workspace helpers from @comis/core — only the
      // subset of relocated symbols WITHOUT in-repo consumers remains in
      // policy. Each entry below tracks a specific orphan that surfaces
      // because the relocated agent source had no test or import for the
      // symbol outside the workspace barrel (incrementOnboardingCount,
      // TEMPLATE_MARKER, etc.). Removable when a Phase 36 consumer materializes.
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
      // Phase 35 Plan 35-04 (drift recovery): runOAuthTlsPreflight relocated
      // from @comis/agent — pure-function relocation needed to close the last
      // CLI → @comis/agent import edge. Function is consumed by
      // packages/cli/src/doctor/checks/oauth-health.ts via the @comis/core
      // barrel; the three type aliases below are referenced only inside the
      // module itself (no exported consumers yet — Phase 36 may surface them
      // when other doctor checks need to discriminate the result kinds).
      "TlsPreflightResult",
      "TlsPreflightFailureKind",
      "RunOAuthTlsPreflightOptions",
      // Phase 35 Plan 35-04 (D-01): the following symbols had external
      // consumers in agent's now-deleted oauth-login-runner.ts /
      // oauth-device-code.ts. The relocated copies in @comis/core/oauth/
      // consume them via relative paths (not via the @comis/core barrel)
      // so the public-export-consumers gate now counts them as orphans.
      // Re-add to policy until a Phase 36 consumer surfaces them via the
      // barrel. The symbols themselves are still exported because workspace
      // helpers (workspace-resolver, workspace-manager) and other internals
      // continue to reference them — the surface is intentional, just
      // currently consumer-less outside core.
      "LockOptions",
      "LockError",
      "FileLockPort",
      "OAuthErrorCode",
      "resolveCodexAccessTokenExpiry",
      "EnsureWorkspaceOptions",
      "WorkspaceFiles",
      "WorkspaceStatus",
    ])],
    // @comis/daemon: 19 pre-Phase-29 baseline orphans tracked here.
    // Phase 31 plan 13 (MEM-CTX-PORTS-14 part 2 / RES-PIT-31-2) adds two more
    // entries: createTracingLogger + TracingLoggerOptions are consumed by the
    // residency-test daemon harness via DYNAMIC require("@comis/daemon"), which
    // the public-export-consumers AST walker does not track (it only sees
    // static `import` and re-export `export from` declarations). Documented
    // here per L9/L10/L11 policy contract.
    ["@comis/daemon", new Set<string>([
      "main",
      "DaemonInstance",
      "DaemonOverrides",
      // Phase 34 plan 01 (DAEMON-API-01): sub-agent runtime relocated to
      // @comis/agent. The 9 entries previously tracked here
      // (createSubAgentRunner, ANNOUNCE_PARENT_TIMEOUT_MS, the 4 type names,
      // sweepResultFiles, buildAnnouncementMessage, deliverFailureNotification)
      // have been removed from packages/daemon/src/index.ts and the 7
      // orphan entries are now tracked under @comis/agent above.
      "createAnnouncementDeadLetterQueue",
      "AnnouncementDeadLetterQueue",
      "DeadLetterEntry",
      "createContextHandlers",
      "ContextHandlerDeps",
      "createAgentHandlers",
      "AgentHandlerDeps",
      // Plan 31-13: residency-test harness consumers (dynamic require).
      "createTracingLogger",
      "TracingLoggerOptions",
    ])],
    // @comis/gateway: 9 pre-Phase-29 baseline orphans tracked here.
    ["@comis/gateway", new Set<string>([
      "createRateLimiter",
      "createOAuthCallbackRoute",
      "insertPendingFlow",
      "PENDING_FLOW_TIMEOUT_MS",
      "OAuthCallbackDeps",
      "PendingFlow",
      "createAcpAgent",
      "AcpServerDeps",
      "createMdnsAdvertiser",
    ])],
    // @comis/infra: 2 pre-Phase-29 baseline orphans tracked here.
    ["@comis/infra", new Set<string>([
      "LogFields",
      "VALID_LOG_LEVELS",
    ])],
    // @comis/memory: 43 pre-Phase-29 baseline orphans tracked here + 5 Phase-31
    // commit-3 transient orphans (SessionStore alias + SessionDetailedEntry
    // + 3 Ctx*Row types). Phase 31 commit 3 retargets agent's type-only
    // imports for these 5 names from @comis/memory → @comis/core (the canonical
    // home after commits 1-2). Memory's index.ts still re-exports them — as
    // backward-compat aliases — but no production code in any other package
    // consumes them through memory's barrel anymore. The 5 entries below
    // document this transient state. They're removed wholesale when plan 31-04
    // (a) rewrites the OAuth selector to drop the lone value-import and
    // (b) downgrades @comis/memory to a devDependency on @comis/agent, after
    // which co-located agent test files can still type-resolve the names via
    // memory's barrel for now (closed atomically by later phase that retires
    // the alias re-exports entirely).
    ["@comis/memory", new Set<string>([
      "initSchema",
      "SessionData",
      "SessionListEntry",
      "InspectFilters",
      "ClearScope",
      "MemoryStats",
      "GuardrailResult",
      "EmbeddingQueue",
      "EmbeddingProviderOptions",
      "createOpenAIEmbeddingProvider",
      "OpenAIEmbeddingProviderOptions",
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
      // Phase 31 commit 3 (MEM-CTX-PORTS-01) — agent retargeted these 5 names
      // from @comis/memory → @comis/core. Memory's barrel still re-exports
      // them (SessionStore is now a type alias of SessionStorePort per
      // commit 2). No in-repo production consumer remains until later phases
      // retire the alias re-exports entirely. Closed: plan that drops the
      // re-export from packages/memory/src/index.ts.
      "SessionStore",
      "SessionDetailedEntry",
      "CtxMessageRow",
      "CtxSummaryRow",
      "CtxContextItemRow",
    ])],
    // @comis/scheduler: 48 pre-Phase-29 baseline orphans tracked here (Phase 28 CORE-PORTS-09 removed isLocked + ExecutionLockOptions from scheduler/src/index.ts; Phase 29-04 sweep dropped the two stale policy entries for those deletions).
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
      "TaskExtractorDeps",
      "ExtractionFn",
      "TaskStore",
      "ExtractedTask",
      "TaskPriority",
      "TaskStatus",
      "TaskExtractionResult",
      "ExtractedTaskSchema",
      "TaskExtractionResultSchema",
      "TaskPrioritySchema",
      "TaskStatusSchema",
      "scorePriority",
      "rankTasks",
      "PRIORITY_WEIGHTS",
      "PriorityScore",
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
      "buildCronEventPrompt",
      "buildExecEventPrompt",
      "shouldSkipHeartbeatOnlyDelivery",
      "isQueueBusy",
      "AgentHeartbeatSourceDeps",
      "HeartbeatSessionOps",
      "SystemEventQueueDeps",
      "SystemEventEntrySchema",
      "SystemEventEntry",
    ])],
    // @comis/shared: 5 pre-Phase-29 baseline orphans tracked here.
    ["@comis/shared", new Set<string>([
      "TTLCacheOptions",
      "SILENT_PREFIX",
      "VisibleDeliveryKind",
      "VisibleDeliveryRecord",
      "parseSanitizedMcpToolName",
    ])],
    // @comis/skills: 45 pre-Phase-29 baseline orphans tracked here (extractMcpServerName removed in 29-01, L11 closed).
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
    ])],
  ]);
