// Port interfaces - Hexagonal architecture boundaries

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
export { ChannelCapabilitySchema } from "./channel-plugin.js";
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
export type { Provider, ImageGenInput, ImageGenOutput, ImageGenerationPort } from "./provider.js";
export type {
  DeliveryQueuePort,
  DeliveryQueueEntry,
  DeliveryQueueEnqueueInput,
  DeliveryQueueStatusCounts,
} from "./delivery-queue.js";
export { createNoOpDeliveryQueue } from "./delivery-queue.js";
export type {
  DeliveryMirrorPort,
  DeliveryMirrorEntry,
  DeliveryMirrorRecordInput,
} from "./delivery-mirror.js";
export { createNoOpDeliveryMirror } from "./delivery-mirror.js";
