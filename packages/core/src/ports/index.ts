// SPDX-License-Identifier: Apache-2.0
// Port interfaces - Hexagonal architecture boundaries
// Phase 28 commit 1: runtime values that previously lived alongside the type-only port
// declarations were moved out of core/src/ports/ (closes L15 per CORE-PORTS-01). The
// curated re-exports at ../exports/ports.ts retarget consumers to the new homes; this
// file re-exports types only.

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
  MemoryUpdateFields,
} from "./memory.js";
export type {
  SkillPort,
  SkillPermissions,
  SkillInput,
  SkillOutput,
  SkillManifest,
} from "./skill.js";
export type { EmbeddingPort } from "./embedding.js";
export type { ContextStorePort } from "./context-store.js";
export type {
  CtxConversationRow,
  CtxMessageRow,
  CtxMessagePartRow,
  CtxSummaryRow,
  CtxSummaryMessageRow,
  CtxSummaryParentRow,
  CtxContextItemRow,
  CtxLargeFileRow,
  CtxExpansionGrantRow,
} from "./context-store-types.js";
export type { SessionStorePort } from "./session-store.js";
export type {
  SessionData,
  SessionListEntry,
  SessionDetailedEntry,
} from "./session-store-types.js";
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
  HookAgentEndEvent,
  HookAgentEndContext,
  HookBeforeToolCallEvent,
  HookBeforeToolCallContext,
  HookBeforeToolCallResult,
  HookAfterToolCallEvent,
  HookAfterToolCallContext,
  HookToolResultPersistEvent,
  HookToolResultPersistContext,
  HookToolResultPersistResult,
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
  PluginToolDefinition,
  PluginHttpRoute,
} from "./plugin.js";
export type {
  ChannelPluginPort,
  ChannelCapability,
  ChannelStatus,
} from "./channel-plugin.js";
export type {
  DeviceIdentity,
  DeviceIdentityPort,
  PairingRequest,
  PairedDevice,
} from "./device-identity.js";
export type {
  OutputGuardPort,
  OutputGuardFinding,
  OutputGuardResult,
} from "./output-guard.js";
export type {
  SecretStorePort,
  SecretMetadata,
} from "./secret-store.js";
export type { CredentialMappingPort } from "./credential-mapping.js";
export type { OAuthCredentialStorePort, OAuthProfile } from "./oauth-credential-store.js";
export type { Provider, ImageGenInput, ImageGenOutput, ImageGenerationPort } from "./provider.js";
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
// NOTE: the test-only stub factory in `__test-helpers/` is intentionally NOT
// re-exported here. It must NEVER appear on this barrel (the architecture-grep
// test enforces this).
