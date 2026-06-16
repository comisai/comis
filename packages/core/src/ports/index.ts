// SPDX-License-Identifier: Apache-2.0
// Port interfaces - Hexagonal architecture boundaries
// Runtime values that previously lived alongside the type-only port
// declarations were moved out of core/src/ports/. The curated re-exports at
// ../exports/ports.ts retarget consumers to the new homes; this file
// re-exports types only.

export type {
  ChannelPort,
  MessageHandler,
  SendMessageOptions,
  FetchMessagesOptions,
  FetchedMessage,
  AttachmentPayload,
} from "./channel.js";
export type {
  MemoryPort,
  MemorySearchOptions,
  MemorySearchResult,
} from "./memory.js";
export type { EmbeddingPort } from "./embedding.js";
export type { RerankerPort } from "./reranker.js";
export type { MemoryEntityStore, EntityScope, EntityRow } from "./memory-entity-store.js";
export type { MemoryPinnedStore } from "./memory-pinned-store.js";
export type { MemoryTemporalStore } from "./memory-temporal-store.js";
export type { MemoryEmbeddingStore } from "./memory-embedding-store.js";
export type { MemoryCausalStore, CausalScope } from "./memory-causal-store.js";
export type {
  TripleStorePort,
  TripleScope,
  TripleTrust,
  TripleInput,
} from "./triple-store.js";
export type {
  UserRepresentationStore,
  UserRepresentationScope,
  UserRepresentationTrust,
  UserRepresentationEntry,
  UserRepresentationInput,
} from "./user-representation-store.js";
export type {
  TunedAlphaStore,
  TunedAlphaScope,
  TunedAlphaVector,
} from "./tuned-alpha-store.js";
export type {
  MemoryLifecyclePort,
  MemoryLifecycleScope,
  MemoryTier,
  LifecycleSweepReport,
} from "./memory-lifecycle.js";
export type {
  RelationshipStore,
  RelationshipScope,
  RelationshipTrust,
  RelationshipEntry,
  RelationshipInput,
} from "./relationship-store.js";
export type {
  MemoryUsefulnessStore,
  UsefulnessScope,
  UsefulnessSignal,
} from "./memory-usefulness-store.js";
export type {
  OutcomeSignalPort,
  LearningScope,
  OutcomeObservation,
  ResolvedOutcome,
  OutcomePruneResult,
} from "./outcome-signal-port.js";
export type {
  MemoryConsolidationStore,
  ConsolidationCandidate,
  ConsolidationPlan,
  ConsolidationFoldPlan,
} from "./memory-consolidation.js";
export type { SessionStorePort } from "./session-store.js";
export type {
  SessionData,
  SessionListEntry,
  SessionDetailedEntry,
} from "./session-store-types.js";
export type { ContextStorePort, ContextBrowsePort, LcdProvenanceReadStore } from "./context-store.js";
export type {
  LcdMessage,
  LcdMessagePart,
  LcdPartMetadata,
  LcdPartKind,
  LcdRole,
  ContextStoreScope,
  ContextBrowseScope,
  LcdConversationSummary,
  LcdConversationPage,
  AppendMessageInput,
  LcdSummary,
  LcdSummaryKind,
  LcdContextItem,
  LcdRefKind,
  LcdSearchHit,
  LcdSearchResult,
  AppendSummaryInput,
  AppendCondensedSummaryInput,
  AppendProvenanceInput,
} from "./context-store-types.js";
export type { FileLockPort, LockOptions, LockError } from "./file-lock.js";
export type { ClockPort } from "./clock.js";
export type { EnvPort } from "./env.js";
export type { TimerPort, TimerHandle } from "./timer.js";
export type { ComputeDailyResetNextRun } from "./schedule-callback.js";
export type {
  TranscriptionPort,
  TranscriptionOptions,
  TranscriptionResult,
} from "./transcription-port.js";
export type {
  TTSPort,
  TTSOptions,
  TTSResult,
} from "./tts-port.js";
export type {
  ImageAnalysisPort,
  ImageAnalysisOptions,
} from "./image-analysis-port.js";
export type {
  VisionRequest,
  VideoRequest,
  VisionResult,
  VisionProvider,
} from "./vision-port.js";
export type {
  ResolvedMedia,
  MediaResolverPort,
} from "./media-resolver-port.js";
export type {
  FileClassification,
  FileExtractionErrorKind,
  FileExtractionError,
  FileExtractionInput,
  FileExtractionResult,
  FileExtractionPort,
} from "./file-extraction-port.js";
export type {
  HookName,
  ModifyingHookName,
  VoidHookName,
  HookHandlerMap,
  HookBeforeAgentStartEvent,
  HookBeforeAgentStartContext,
  HookBeforeAgentStartResult,
  HookBeforeCompactionEvent,
  HookBeforeCompactionContext,
  HookBeforeCompactionResult,
  HookAfterCompactionEvent,
  HookAfterCompactionContext,
  HookSessionStartEvent,
  HookSessionStartContext,
  HookSessionEndEvent,
  HookSessionEndContext,
  HookGatewayStartEvent,
  HookGatewayStartContext,
  HookGatewayStopEvent,
  HookGatewayStopContext,
} from "./hook-types.js";
export type {
  PluginPort,
  PluginRegistryApi,
  RegisteredHook,
} from "./plugin.js";
export type {
  ChannelPluginPort,
  ChannelCapability,
} from "./channel-plugin.js";
export type { ChannelStatus } from "./channel.js";
export type {
  OutputGuardPort,
  OutputGuardFinding,
  OutputGuardResult,
} from "./output-guard.js";
export type {
  SecretStorePort,
  SecretMetadata,
} from "./secret-store.js";
export type { OAuthCredentialStorePort, OAuthProfile } from "./oauth-credential-store.js";
export type { ImageGenInput, ImageGenOutput, ImageGenerationPort } from "./provider.js";
export type {
  VideoGenInput,
  VideoGenJob,
  VideoJobStatus,
  VideoGenOutput,
  VideoGenerationPort,
} from "./provider.js";
export type {
  DeliveryQueuePort,
  DeliveryQueueEntry,
  DeliveryQueueEnqueueInput,
  DeliveryQueueStatusCounts,
} from "./delivery-queue.js";
export type {
  DeliveryMirrorPort,
  DeliveryMirrorEntry,
  DeliveryMirrorRecordInput,
} from "./delivery-mirror.js";
export type {
  ToolCapabilityPort,
  PromptSkillCapability,
  CapabilitySourceRef,
  ClusterConfig,
  McpServerHint,
  SkillHint,
} from "./tool-capability.js";
export type { CaManagerPort } from "./ca-manager.js";
export type {
  EgressControlPort,
  EgressMaterialization,
} from "./egress-control.js";
// NOTE: the test-only stub factory in `__test-helpers/` is intentionally NOT
// re-exported here. It must NEVER appear on this barrel (the architecture-grep
// test enforces this).
