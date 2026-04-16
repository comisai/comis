/**
 * Re-exported config types for convenient imports.
 *
 * All types are inferred from Zod schemas (single source of truth).
 */

export type { AppConfig } from "./schema.js";
export type { ApprovalsConfig, ApprovalRule } from "./schema-approvals.js";
export type {
  AutoReplyEngineConfig,
  GroupActivationMode,
} from "./schema-auto-reply-engine.js";
export type { BrowserConfig } from "./schema-browser.js";
export type { CoalescerConfig } from "./schema-coalescer.js";
export type { DeliveryMirrorConfig, DeliveryQueueConfig, DeliveryTimingConfig, DeliveryTimingMode } from "./schema-delivery.js";
export type { DocumentationConfig, DocumentationLink } from "./schema-documentation.js";
export type { MessagesConfig } from "./schema-messages.js";
export type { ModelsConfig, ModelAlias } from "./schema-models.js";
export type { ProvidersConfig, ProviderEntry, UserModel, ModelCost } from "./schema-providers.js";
export type {
  SendPolicyConfig,
  SendPolicyRule,
  SendAction,
} from "./schema-send-policy.js";
export type {
  AgentConfig,
  AuthProfileEntry,
  BootstrapConfig,
  BroadcastGroup,
  BroadcastTarget,
  BudgetConfig,
  CircuitBreakerConfig,
  ConcurrencyConfig,
  ContextPruningConfig,
  DmScopeConfig,
  ElevatedReplyConfig,
  FallbackModel,
  ModelFailoverConfig,
  ModelRoutes,
  PerAgentConfig,
  PerAgentCronConfig,
  PerAgentSchedulerConfig,
  PruningConfig,
  RagConfig,
  ResetPolicyOverride,
  RoutingBinding,
  RoutingConfig,
  SdkRetryConfig,
  SessionCompactionConfig,
  SessionResetPolicyConfig,
  SourceGateConfig,
  TracingConfig,
} from "./schema-agent.js";
export type { ChannelConfig, ChannelEntry, ChannelHealthCheckConfig, AckReactionConfig, MediaProcessingConfig, EmailChannelEntry } from "./schema-channel.js";
export type { MemoryConfig, CompactionConfig, RetentionConfig } from "./schema-memory.js";
export type {
  SecurityConfig,
  PermissionConfig,
  ActionConfirmationConfig,
  AgentToAgentConfig,
} from "./schema-security.js";
export type { SkillsConfig, PromptSkillsConfig } from "./schema-skills.js";
export type { DaemonConfig, LoggingConfig, TracingDefaults, ConfigWebhook } from "./schema-daemon.js";
export type { HeartbeatConfig, SchedulerConfig } from "./schema-scheduler.js";
export type {
  GatewayConfig,
  GatewayTlsConfig,
  GatewayToken,
  GatewayRateLimit,
} from "./schema-gateway.js";
export type {
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
  MediaInfraConfig,
  MediaConfig,
  AutoReplyRule,
  AutoReplyConfig,
  FileExtractionConfig,
  MediaPersistenceConfig,
  ImageGenerationConfig,
} from "./schema-integrations.js";
export type {
  MonitoringConfig,
  DiskMonitorConfig,
  ResourceMonitorConfig,
  SystemdMonitorConfig,
  SecurityUpdateMonitorConfig,
  GitMonitorConfig,
} from "./schema-observability.js";
export type { ObservabilityConfig, ObservabilityPersistenceConfig } from "./schema-observability.js";
export type { PluginsConfig, PluginEntry } from "./schema-plugins.js";
export type {
  QueueConfig,
  PerChannelQueueConfig,
  QueueMode,
  OverflowPolicy,
  OverflowConfig,
  DebounceBufferConfig,
  FollowupConfig,
  PriorityLaneConfig,
  LaneAssignmentConfig,
} from "./schema-queue.js";
export type {
  StreamingConfig,
  PerChannelStreamingConfig,
  TypingMode,
  ChunkMode,
  TableMode,
} from "./schema-streaming.js";
export type { EmbeddingConfig } from "./schema-embedding.js";
export type { EnvelopeConfig } from "./schema-envelope.js";
export type {
  LifecycleReactionsConfig,
  LifecycleReactionsTimingConfig,
} from "./schema-lifecycle-reactions.js";
export type { ResponsePrefixConfig } from "./schema-response-prefix.js";
export type { RetryConfig } from "./schema-retry.js";
export type { SenderTrustDisplayConfig } from "./schema-sender-trust-display.js";
export type { TelegramFileRefGuardConfig } from "./schema-telegram-file-guard.js";
export type { WebhooksConfig, WebhookMappingConfig } from "./schema-webhooks.js";
export type { BackgroundTasksConfig } from "./schema-background-tasks.js";

/**
 * Error codes for configuration loading and validation.
 */
export type ConfigErrorCode =
  | "FILE_NOT_FOUND"
  | "PARSE_ERROR"
  | "VALIDATION_ERROR"
  | "INCLUDE_ERROR"
  | "CIRCULAR_INCLUDE"
  | "ENV_VAR_ERROR"
  | "BACKUP_ERROR";

/**
 * Structured error for configuration operations.
 */
export interface ConfigError {
  readonly code: ConfigErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly details?: unknown;
}
