// @comis/core/config — Layered configuration with Zod validation

// Schemas (for direct validation or extension)
export { AppConfigSchema } from "./schema.js";
export { ApprovalsConfigSchema, ApprovalRuleSchema, checkApprovalsConfig } from "./schema-approvals.js";
export {
  AutoReplyEngineConfigSchema,
  GroupActivationModeSchema,
} from "./schema-auto-reply-engine.js";
export { BrowserConfigSchema } from "./schema-browser.js";
export { MessagesConfigSchema } from "./schema-messages.js";
export { ModelsConfigSchema, ModelAliasSchema } from "./schema-models.js";
export { ProvidersConfigSchema, ProviderEntrySchema, UserModelSchema, ModelCostSchema } from "./schema-providers.js";
export {
  SendPolicyConfigSchema,
  SendPolicyRuleSchema,
  SendActionSchema,
} from "./schema-send-policy.js";
// Gemini cache schema (CachedContent lifecycle)
export { GeminiCacheConfigSchema } from "./schema-gemini-cache.js";

// Notification schema
export { NotificationConfigSchema } from "./schema-notification.js";
export type { NotificationConfig } from "./schema-notification.js";

// Verbosity schema
export { VerbosityConfigSchema, VerbosityLevelSchema, VerbosityOverrideSchema } from "./schema-verbosity.js";
export type { VerbosityConfig, VerbosityLevel, VerbosityOverride } from "./schema-verbosity.js";

// Memory review schema
export { MemoryReviewConfigSchema } from "./schema-memory-review.js";
export type { MemoryReviewConfig } from "./schema-memory-review.js";

// Agent schemas: model selection, session lifecycle, context engine, context guard, agent features
export {
  AgentConfigSchema,
  AgentsMapSchema,
  AuthProfileSchema,
  BootstrapConfigSchema,
  BroadcastGroupSchema,
  BroadcastTargetSchema,
  BudgetConfigSchema,
  CircuitBreakerConfigSchema,
  ToolRetryBreakerConfigSchema,
  ConcurrencyConfigSchema,
  ContextEngineConfigSchema,
  ContextGuardConfigSchema,
  ContextPruningConfigSchema,
  DeferredToolsConfigSchema,
  DmScopeConfigSchema,
  ElevatedReplyConfigSchema,
  FallbackModelSchema,
  HeartbeatTargetSchema,
  ModelFailoverConfigSchema,
  ModelRoutesSchema,
  OperationModelEntrySchema,
  OperationModelsSchema,
  PerAgentConfigSchema,
  PerAgentCronConfigSchema,
  PerAgentHeartbeatConfigSchema,
  PerAgentSchedulerConfigSchema,
  PromptTimeoutConfigSchema,
  PruningConfigSchema,
  RagConfigSchema,
  ResetPolicyOverrideSchema,
  RoutingBindingSchema,
  RoutingConfigSchema,
  SdkRetryConfigSchema,
  SepConfigSchema,
  SessionCompactionConfigSchema,
  SessionResetPolicySchema,
  SourceGateConfigSchema,
  ToolLifecycleConfigSchema,
  TracingConfigSchema,
} from "./schema-agent.js";
export { ChannelConfigSchema, ChannelEntrySchema, AckReactionConfigSchema, MediaProcessingSchema, ChannelHealthCheckSchema, EmailChannelEntrySchema } from "./schema-channel.js";
export {
  MemoryConfigSchema,
  CompactionConfigSchema,
  RetentionConfigSchema,
} from "./schema-memory.js";
export {
  SecurityConfigSchema,
  PermissionConfigSchema,
  ActionConfirmationConfigSchema,
  AgentToAgentConfigSchema,
} from "./schema-security.js";
export { SubagentContextConfigSchema } from "../domain/subagent-context-config.js";
export type { SubagentContextConfig } from "../domain/subagent-context-config.js";
export {
  AgentSecretsConfigSchema,
  SecretsConfigSchema,
} from "./schema-secrets.js";
export { BackgroundTasksConfigSchema } from "./schema-background-tasks.js";
export type { BackgroundTasksConfig } from "./schema-background-tasks.js";
export { SkillsConfigSchema, PromptSkillsConfigSchema } from "./schema-skills.js";
export { DaemonConfigSchema, LoggingConfigSchema, TracingDefaultsSchema, ConfigWebhookSchema } from "./schema-daemon.js";
export { HeartbeatConfigSchema, SchedulerConfigSchema } from "./schema-scheduler.js";
export {
  GatewayConfigSchema,
  GatewayTlsConfigSchema,
  GatewayTokenSchema,
  GatewayRateLimitSchema,
} from "./schema-gateway.js";
export {
  IntegrationsConfigSchema,
  BraveSearchConfigSchema,
  McpServerEntrySchema,
  McpConfigSchema,
  TranscriptionConfigSchema,
  TtsConfigSchema,
  TtsAutoModeSchema,
  ElevenLabsVoiceSettingsSchema,
  TtsOutputFormatSchema,
  ImageAnalysisConfigSchema,
  VisionScopeRuleSchema,
  VisionConfigSchema,
  LinkUnderstandingConfigSchema,
  MediaInfraConfigSchema,
  MediaConfigSchema,
  AutoReplyRuleSchema,
  AutoReplyConfigSchema,
  DOCUMENT_MIME_WHITELIST,
  FileExtractionConfigSchema,
  MediaPersistenceConfigSchema,
  ImageGenerationConfigSchema,
} from "./schema-integrations.js";
export { MonitoringConfigSchema } from "./schema-observability.js";
export { ObservabilityConfigSchema } from "./schema-observability.js";
export type { ObservabilityConfig, ObservabilityPersistenceConfig } from "./schema-observability.js";
export { PluginsConfigSchema, PluginEntrySchema } from "./schema-plugins.js";
export {
  QueueConfigSchema,
  QueueModeSchema,
  OverflowPolicySchema,
  PerChannelQueueConfigSchema,
  OverflowConfigSchema,
  DebounceBufferConfigSchema,
  FollowupConfigSchema,
  PriorityLaneConfigSchema,
  LaneAssignmentConfigSchema,
} from "./schema-queue.js";
export {
  StreamingConfigSchema,
  PerChannelStreamingConfigSchema,
  TypingModeSchema,
  ChunkModeSchema,
  TableModeSchema,
} from "./schema-streaming.js";
export { CoalescerConfigSchema } from "./schema-coalescer.js";
export { DeliveryMirrorConfigSchema, DeliveryQueueConfigSchema, DeliveryTimingConfigSchema, DeliveryTimingModeSchema } from "./schema-delivery.js";
export { DocumentationConfigSchema, DocumentationLinkSchema } from "./schema-documentation.js";
export { EmbeddingConfigSchema } from "./schema-embedding.js";
export { EnvelopeConfigSchema } from "./schema-envelope.js";
export {
  LifecycleReactionsConfigSchema,
  LifecycleReactionsTimingSchema,
  LifecycleReactionsPerChannelSchema,
} from "./schema-lifecycle-reactions.js";
export { ResponsePrefixConfigSchema } from "./schema-response-prefix.js";
export { RetryConfigSchema } from "./schema-retry.js";
export { SenderTrustDisplayConfigSchema } from "./schema-sender-trust-display.js";
export { TelegramFileRefGuardConfigSchema } from "./schema-telegram-file-guard.js";
export {
  WebhooksConfigSchema,
  WebhookMappingConfigSchema,
  WebhookMappingMatchSchema,
} from "./schema-webhooks.js";

// Types (inferred from schemas)
export type {
  AutoReplyEngineConfig,
  GroupActivationMode,
} from "./schema-auto-reply-engine.js";
export type { CoalescerConfig } from "./schema-coalescer.js";
export type { DeliveryMirrorConfig, DeliveryQueueConfig, DeliveryTimingConfig, DeliveryTimingMode } from "./schema-delivery.js";
export type { DocumentationConfig, DocumentationLink } from "./schema-documentation.js";
export type {
  SendPolicyConfig,
  SendPolicyRule,
  SendAction,
} from "./schema-send-policy.js";
// Secrets types
export type {
  AgentSecretsConfig,
  SecretsConfig,
} from "./schema-secrets.js";

// Gemini cache types
export type { GeminiCacheConfig } from "./schema-gemini-cache.js";

// Agent types: model selection, session lifecycle, context engine, context guard, agent features
export type {
  AuthProfileEntry,
  BroadcastGroup,
  BroadcastTarget,
  BudgetConfig,
  CircuitBreakerConfig,
  ToolRetryBreakerConfig,
  ConcurrencyConfig,
  ContextEngineConfig,
  ContextGuardConfig,
  ContextPruningConfig,
  DeferredToolsConfig,
  DmScopeConfig,
  ElevatedReplyConfig,
  FallbackModel,
  HeartbeatTarget,
  ModelFailoverConfig,
  ModelOperationType,
  ModelRoutes,
  OperationModelEntry,
  OperationModels,
  PerAgentHeartbeatConfig,
  PromptTimeoutConfig,
  PruningConfig,
  ResetPolicyOverride,
  SdkRetryConfig,
  SepConfig,
  SessionCompactionConfig,
  SessionResetPolicyConfig,
  SourceGateConfig,
  ToolLifecycleConfig,
  TracingConfig,
} from "./schema-agent.js";
export type {
  AppConfig,
  AgentConfig,
  BootstrapConfig,
  PerAgentConfig,
  PerAgentCronConfig,
  PerAgentSchedulerConfig,
  RagConfig,
  RoutingBinding,
  RoutingConfig,
  ChannelConfig,
  ChannelEntry,
  EmailChannelEntry,
  ChannelHealthCheckConfig,
  AckReactionConfig,
  MemoryConfig,
  CompactionConfig,
  RetentionConfig,
  SecurityConfig,
  PermissionConfig,
  ActionConfirmationConfig,
  AgentToAgentConfig,
  SkillsConfig,
  PromptSkillsConfig,
  DaemonConfig,
  LoggingConfig,
  TracingDefaults,
  ConfigWebhook,
  HeartbeatConfig,
  SchedulerConfig,
  GatewayConfig,
  GatewayTlsConfig,
  GatewayToken,
  GatewayRateLimit,
  IntegrationsConfig,
  BraveSearchConfig,
  McpServerEntry,
  McpConfig,
  TranscriptionConfig,
  TtsConfig,
  TtsAutoMode,
  ElevenLabsVoiceSettings,
  TtsOutputFormat,
  ImageAnalysisConfig,
  VisionScopeRule,
  VisionConfig,
  LinkUnderstandingConfig,
  MediaConfig,
  AutoReplyRule,
  AutoReplyConfig,
  FileExtractionConfig,
  MediaPersistenceConfig,
  ImageGenerationConfig,
  MonitoringConfig,
  DiskMonitorConfig,
  ResourceMonitorConfig,
  SystemdMonitorConfig,
  SecurityUpdateMonitorConfig,
  GitMonitorConfig,
  PluginsConfig,
  PluginEntry,
  QueueConfig,
  PerChannelQueueConfig,
  QueueMode,
  OverflowPolicy,
  OverflowConfig,
  DebounceBufferConfig,
  FollowupConfig,
  PriorityLaneConfig,
  LaneAssignmentConfig,
  StreamingConfig,
  PerChannelStreamingConfig,
  TypingMode,
  ChunkMode,
  TableMode,
  EmbeddingConfig,
  EnvelopeConfig,
  RetryConfig,
  WebhooksConfig,
  WebhookMappingConfig,
  BrowserConfig,
  ModelsConfig,
  ModelAlias,
  ProvidersConfig,
  ProviderEntry,
  UserModel,
  ModelCost,
  MessagesConfig,
  ApprovalsConfig,
  ApprovalRule,
  ConfigError,
  ConfigErrorCode,
} from "./types.js";
export type {
  LifecycleReactionsConfig,
  LifecycleReactionsTimingConfig,
} from "./schema-lifecycle-reactions.js";
export type { ResponsePrefixConfig } from "./schema-response-prefix.js";
export type { SenderTrustDisplayConfig } from "./schema-sender-trust-display.js";
export type { TelegramFileRefGuardConfig } from "./schema-telegram-file-guard.js";

// Loader (file loading + validation)
export { loadConfigFile, validateConfig } from "./loader.js";
export type { ConfigLoadOptions } from "./loader.js";

// Include resolver ($include directive processing)
export { resolveIncludes, MAX_INCLUDE_DEPTH } from "./include-resolver.js";
export type { IncludeResolverDeps } from "./include-resolver.js";

// Environment variable substitution (${VAR} processing)
export { substituteEnvVars, warnSuspiciousEnvValues, type EnvValueWarning } from "./env-substitution.js";

// Config migration (legacy key transformation)
export { migrateConfig } from "./migrate.js";

// Layered merge
export { deepMerge, mergeLayered, loadLayered } from "./layered.js";

// Immutable key guard (runtime config mutation protection)
export { IMMUTABLE_CONFIG_PREFIXES, MUTABLE_CONFIG_OVERRIDES, isImmutableConfigPath, matchesOverridePattern, getMutableOverridesForSection } from "./immutable-keys.js";

// Schema serializer (Zod to JSON Schema conversion)
export { getConfigSchema, getConfigSections } from "./schema-serializer.js";

// Config backup (timestamped backup creation with rotation)
export { createTimestampedBackup } from "./backup.js";
export type { BackupDeps, BackupOptions } from "./backup.js";

// Partial validator (section-by-section validation)
export { validatePartial } from "./partial-validator.js";
export type { PartialValidationResult } from "./partial-validator.js";

// Field metadata (config field introspection for CLI/UI)
export { getFieldMetadata } from "./field-metadata.js";
export type { FieldMetadata } from "./field-metadata.js";

// Git-backed config versioning (init, commit, history, diff, rollback)
export { createConfigGitManager, encodeCommitMessage } from "./git-manager.js";
export type {
  ConfigGitManager,
  GitCommitMetadata,
  HistoryEntry,
  GitManagerDeps,
  ExecGitFn,
} from "./git-manager.js";
