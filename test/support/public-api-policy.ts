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
      // ContextStorePort is declared but not yet consumed by agent —
      // tracked as a planned-orphan policy entry mirrored from the
      // FileLockPort pattern.
      "ContextStorePort",
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
      // packages/agent/src/rag/rag-retriever.ts was deleted in Phase 53
      // Plan 01 (DEAD-MOD-08); the canonical post-deletion consumer is
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
      // were removed from packages/gateway/src/server/hono-server.ts (Plan
      // 55-01). The Event types remain because plugin authors may still
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
      "SECRET_FIELD_PATTERN",
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
      // The 15 per-method contracts have in-repo consumers via both
      // handler factories (imports + computed property keys). Only the
      // per-domain aggregator array MEMORY_CONTRACTS lacks an external
      // consumer (composed into API_CONTRACTS_ORDERED intra-package —
      // the walker skips self-imports).
      "MEMORY_CONTRACTS",
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
    ])],
    // @comis/daemon: baseline orphans tracked here. All four
    // value-side root re-exports (createAnnouncementDeadLetterQueue,
    // createContextHandlers, createAgentHandlers, createTracingLogger)
    // DO have real test consumers — they are tracked here only because
    // the public-export-consumers AST walker excludes `test/**` and
    // ignores dynamic `require("@comis/daemon")` patterns (it walks
    // only static `import`/`export from` declarations outside the
    // package). Per Phase 52 Plan 04 (BC-REM-12 sub-A) Path B disposition:
    // each surviving re-export has a documented test caller; no further
    // deletion is safe without retargeting those consumers.
    //
    // Consumer audit (2026-05-21, Phase 52 Plan 04):
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
      // Residency-test harness consumers (dynamic require).
      "createTracingLogger",
      "TracingLoggerOptions",
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
      "createAcpAgent",
      "AcpServerDeps",
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
