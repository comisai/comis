// SPDX-License-Identifier: Apache-2.0
// @comis/core/config — Layered configuration with Zod validation

// Schemas (for direct validation or extension)
export { AppConfigSchema } from "./schema.js";
export { ApprovalsConfigSchema, ApprovalRuleSchema, checkApprovalsConfig } from "./schema-approvals.js";
export {
  ToolingConfigSchema,
  DEFAULT_CLUSTER_CONFIG,
  DEFAULT_BUILTIN_ASSIGNMENTS,
} from "./schema-tooling.js";
export type { ToolingConfig } from "./schema-tooling.js";
export {
  AutoReplyEngineConfigSchema,
  GroupActivationModeSchema,
} from "./schema-auto-reply-engine.js";
export { BrowserConfigSchema } from "./schema-browser.js";
export { MessagesConfigSchema } from "./schema-messages.js";
export { ModelsConfigSchema, ModelAliasSchema } from "./schema-models.js";
export { ProvidersConfigSchema, ProviderEntrySchema, UserModelSchema, ModelCostSchema, PROVIDER_TIMEOUT_MS_DEFAULT } from "./schema-providers.js";
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

// Outcome-signal schema — per-agent, default-ON (opt-out)
export { LearningOutcomeConfigSchema } from "./schema-learning-outcome.js";
export type { LearningOutcomeConfig } from "./schema-learning-outcome.js";

// The unified learning-layer schema — per-agent, default-ON.
export { LearningConfigSchema } from "./schema-learning.js";
export type { LearningConfig } from "./schema-learning.js";

// Memory-lifecycle sweep schema (dormant scaffolding — default-OFF, keyless cron)
export { MemoryLifecycleConfigSchema } from "./schema-memory-lifecycle.js";
export type { MemoryLifecycleConfig } from "./schema-memory-lifecycle.js";

// Dialectic schema: the memory_ask cost gate
export { DialecticConfigSchema } from "./schema-dialectic.js";
export type { DialecticConfig } from "./schema-dialectic.js";

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
  // Agent autonomy named-profile resolver
  AutonomyConfigSchema,
  AutonomyMessageConfigSchema,
  AUTONOMY_PROFILES,
  STANDARD_FLOOR_CAPABILITIES,
  resolveAutonomy,
  // The fail-closed mode resolver primitive — the dispatch chokepoint runs the
  // run's mode through this (absent/forged/unknown → "default", never broader).
  // A VALUE export (it is a runtime function).
  resolveEffectiveMode,
  // The autonomy.durability sub-block schema (the daemon reads it for
  // the boot-time durability resolution).
  DurabilityConfigSchema,
  // The pure inbound-MCP-allowlist resolver — the daemon-side `case "mcp"`
  // executor's layer-2 deny-by-absence gate (per-agent from autonomy.mcp.allow).
  permitsMcpTool,
  // Honest legible degrade
  degradeAutonomy,
} from "./schema-agent/index.js";
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
export type { CredentialStorageMode } from "./schema-security.js";
export { SubagentContextConfigSchema } from "../domain/subagent-context-config.js";
export type { SubagentContextConfig } from "../domain/subagent-context-config.js";
export {
  AgentSecretsConfigSchema,
} from "./schema-secrets.js";
export { preReadStorageMode } from "./pre-read-storage-mode.js";
export type { StorageModePreRead } from "./pre-read-storage-mode.js";
export { BackgroundTasksConfigSchema } from "./schema-background-tasks.js";
export type { BackgroundTasksConfig } from "./schema-background-tasks.js";
export { BrokerBindingConfigSchema } from "./schema-broker.js";
export type { BrokerBindingConfig } from "./schema-broker.js";
export {
  ExecutorConfigSchema,
  ExecutorBrokerConfigSchema,
} from "./schema-executor.js";
export type { ExecutorConfig, ExecutorBrokerConfig } from "./schema-executor.js";
export { OutputRetentionConfigSchema } from "./schema-output-retention.js";
export type { OutputRetentionConfig, RetentionClass } from "./schema-output-retention.js";
export { SkillsConfigSchema, PromptSkillsConfigSchema } from "./schema-skills.js";
export type { TerminalAllowEntry, TerminalDriverConfig } from "./schema-skills.js";
export { DaemonConfigSchema, LoggingConfigSchema, TracingDefaultsSchema, ConfigWebhookSchema } from "./schema-daemon.js";
export { HeartbeatConfigSchema, SchedulerConfigSchema, resolveCronWakeGateEnabled } from "./schema-scheduler.js";
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
  VideoGenerationConfigSchema,
} from "./schema-integrations.js";
export { MonitoringConfigSchema } from "./schema-observability.js";
export { ObservabilityConfigSchema, SpendConfigSchema } from "./schema-observability.js";
export type { ObservabilityConfig, ObservabilityPersistenceConfig, TrajectoryObservabilityConfig, SpendConfig } from "./schema-observability.js";
// Orchestration authoring gate — top-level, default-OFF
export { OrchestrationConfigSchema, OrchestrationAuthoringConfigSchema } from "./schema-orchestration.js";
export type { OrchestrationConfig, OrchestrationAuthoringConfig } from "./schema-orchestration.js";
export { PluginsConfigSchema, PluginEntrySchema } from "./schema-plugins.js";
export {
  QueueConfigSchema,
  QueueModeSchema,
  OverflowPolicySchema,
  PerChannelQueueConfigSchema,
  OverflowConfigSchema,
  DebounceBufferConfigSchema,
  FollowupConfigSchema,
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
  // Agent autonomy named-profile resolver
  AutonomyConfig,
  AutonomyMessageConfig,
  AutonomyProfileName,
  AutonomyMode,
  ResolvedAutonomy,
  ResolvedCapability,
  // Honest legible degrade
  AutonomyDownshift,
  AutonomyPreflightResult,
} from "./schema-agent/index.js";
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
  VideoGenerationConfig,
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
export {
  substituteEnvVars,
  warnSuspiciousEnvValues,
  extractReferencedSecretNames,
  findUnresolvedEnvRefs,
  formatMissingEnvRefError,
  type EnvValueWarning,
  type UnresolvedEnvRef,
} from "./env-substitution.js";

// Layered merge
export { deepMerge, mergeLayered, loadLayered } from "./layered.js";

// Immutable key guard (runtime config mutation protection)
export { IMMUTABLE_CONFIG_PREFIXES, MUTABLE_CONFIG_OVERRIDES, isImmutableConfigPath, matchesOverridePattern, getMutableOverridesForSection, findOperatorOnlyAgentPaths } from "./immutable-keys.js";

// Managed-section redirects (LLM-readable hints for immutable rejections)
export {
  MANAGED_SECTIONS,
  getManagedSectionRedirect,
  formatRedirectHint,
  type ManagedSectionRedirect,
} from "./managed-sections.js";

// Capability default-activation framework.
// Resolves each capability's effective default-OFF→ON state; the activation set
// is EMPTY (no capability has earned default-ON) so every capability resolves OFF.
export {
  V2_9_CAPABILITIES,
  ACTIVATED_CAPABILITIES,
  FROZEN_TRUST_PATHS,
  resolveCapabilityDefault,
  resolveAllCapabilityDefaults,
  type CapabilityId,
  type CapabilityDescriptor,
  type ActivationDecision,
  type ResolvedCapabilityDefault,
} from "./capability-activation.js";

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
