// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Domain types (Zod schemas, inferred types, parse functions)

export {
  // NormalizedMessage
  AttachmentSchema,
  NormalizedMessageSchema,
  parseMessage,
  getMessageTraceId,
  // MemoryEntry
  TrustLevelSchema,
  // Per-user representation prefix-type enum (Phase 107 — USER-01)
  UserRepresentationTypeSchema,
  MemorySourceSchema,
  MemoryEntrySchema,
  // Structured extraction (Phase 82 — EXTR-01) + Phase-83 domain target
  ExtractedEntitySchema,
  StructuredMemorySchema,
  MemoryExtractionResultSchema,
  MemoryEntitySchema,
  // AgentResponse
  ToolCallSchema,
  TokenUsageSchema,
  AgentResponseSchema,
  // SessionKey
  SessionKeySchema,
  parseSessionKey,
  formatSessionKey,
  parseFormattedSessionKey,
  // Poll
  PollInputSchema,
  PollOptionResultSchema,
  NormalizedPollResultSchema,
  normalizePollDurationHours,
  // Rich Messaging
  RichButtonSchema,
  RichCardFieldSchema,
  RichCardSchema,
  RichEffectSchema,
  // Approval Request
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  SerializedApprovalRequestSchema,
  SerializedApprovalCacheEntrySchema,
  // CredentialMapping
  InjectionTypeSchema,
  CredentialMappingSchema,
  // SecretRef
  SecretRefSchema,
  isSecretRef,
  SecretRefOrStringSchema,
  // DeliveryOrigin
  DeliveryOriginSchema,
  createDeliveryOrigin,
  // ExecutionGraph
  NodeStatusSchema,
  GraphStatusSchema,
  GraphNodeSchema,
  NodeExecutionStateSchema,
  ExecutionGraphSchema,
  GraphValidationError,
  parseExecutionGraph,
  topologicalSort,
  validateAndSortGraph,
  // Subagent context lifecycle
  SubagentResultSchema,
  SubagentEndReasonSchema,
  parseSubagentResult,
  SubagentContextConfigSchema,
  // Node type driver
  NodeTypeIdSchema,
  // Model compat config
  ToolSchemaProfileSchema,
  ToolCallArgumentsEncodingSchema,
  ModelCompatConfigSchema,
  // Provider capabilities
  ProviderFamilySchema,
  TranscriptToolCallIdModeSchema,
  ProviderCapabilitiesSchema,
  // Sub-agent tool governance
  SUB_AGENT_TOOL_DENYLIST,
  SUB_AGENT_TOOL_PROFILES,
  SUB_AGENT_TOOL_GROUPS,
  RequiredToolsUnreachableError,
  toolReachableGroups,
  computeReachableToolNames,
} from "../domain/index.js";

export { BackgroundTaskOriginSchema } from "../domain/background-task-origin.js";
export type { BackgroundTaskOrigin } from "../domain/background-task-origin.js";

export type {
  Attachment,
  NormalizedMessage,
  TrustLevel,
  // Per-user representation prefix type (Phase 107 — USER-01)
  UserRepresentationType,
  MemoryEntry,
  // Structured extraction (Phase 82) + Phase-83 domain target
  MemorySource,
  ExtractedEntity,
  StructuredMemory,
  MemoryExtractionResult,
  MemoryEntity,
  ToolCall,
  TokenUsage,
  AgentResponse,
  SessionKey,
  PollInput,
  NormalizedPollResult,
  PollOptionResult,
  RichButton,
  RichCard,
  RichEffect,
  ApprovalRequest,
  ApprovalResolution,
  SerializedApprovalRequest,
  SerializedApprovalCacheEntry,
  InjectionType,
  CredentialMapping,
  SecretRef,
  DeliveryOrigin,
  // ExecutionGraph
  NodeStatus,
  GraphStatus,
  GraphNode,
  NodeExecutionState,
  ExecutionGraph,
  ValidatedGraph,
  // Subagent context lifecycle
  SubagentResult,
  SubagentEndReason,
  SpawnPacket,
  CondensedResult,
  SubAgentSpawnPreparedEvent,
  SubAgentSpawnRejectedEvent,
  SubAgentSpawnStartedEvent,
  SubAgentResultCondensedEvent,
  SubAgentLifecycleEndedEvent,
  SubAgentContextCompactedEvent,
  SubagentContextConfig,
  // Node type driver
  NodeTypeId,
  NodeTypeDriver,
  NodeDriverAction,
  NodeDriverContext,
  // Model compat config
  ToolSchemaProfile,
  ToolCallArgumentsEncoding,
  ModelCompatConfig,
  // Provider capabilities
  ProviderFamily,
  TranscriptToolCallIdMode,
  ProviderCapabilities,
  // Sub-agent tool governance
  UnreachableToolEntry,
} from "../domain/index.js";
