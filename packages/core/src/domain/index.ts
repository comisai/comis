// SPDX-License-Identifier: Apache-2.0
// Domain types - Zod schemas as single source of truth

export {
  AttachmentSchema,
  VoiceMetaSchema,
  INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  NormalizedMessageSchema,
  parseMessage,
  parseInboundMessageProvenanceBatch,
  getOriginalInboundMessages,
  getMessageTraceId,
} from "./normalized-message.js";
export type {
  Attachment,
  VoiceMeta,
  OriginalInboundMessage,
  NormalizedMessage,
} from "./normalized-message.js";
export { NormalizedReactionSchema, parseReaction } from "./normalized-reaction.js";
export type { NormalizedReaction } from "./normalized-reaction.js";

export {
  TrustLevelSchema,
  MemorySourceSchema,
  MemoryEntrySchema,
  parseMemoryEntry,
  // Structured extraction
  ExtractedEntitySchema,
  StructuredMemorySchema,
  MemoryExtractionResultSchema,
  MemoryEntitySchema,
} from "./memory-entry.js";
export {
  MemoryVisibilityRequestSchema,
  MemoryVisibilitySchema,
  MemoryVisibilityPermissionSchema,
  MemoryWriteScopeSchema,
  MemoryRecallScopeSchema,
  MemoryScopeError,
  createMemoryRecallScope,
  resolveMemoryVisibility,
} from "./memory-scope.js";
export type {
  MemoryVisibilityRequest,
  MemoryVisibility,
  MemoryVisibilityPermission,
  MemoryWriteScope,
  MemoryRecallScope,
} from "./memory-scope.js";
export type {
  TrustLevel,
  MemoryEntry,
  // Structured extraction + resolved-entity domain target
  MemorySource,
  ExtractedEntity,
  StructuredMemory,
  MemoryExtractionResult,
  MemoryEntity,
} from "./memory-entry.js";

export {
  ToolCallSchema,
  TokenUsageSchema,
  AgentResponseSchema,
  parseAgentResponse,
} from "./agent-response.js";
export type { ToolCall, TokenUsage, AgentResponse } from "./agent-response.js";

export { SessionKeySchema, parseSessionKey, formatSessionKey, parseFormattedSessionKey } from "./session-key.js";
export type { SessionKey } from "./session-key.js";
export { SessionStoreError } from "./session-store-error.js";

export {
  PollInputSchema,
  PollOptionResultSchema,
  NormalizedPollResultSchema,
  normalizePollDurationHours,
  validatePollInput,
} from "./poll-input.js";
export type { PollInput, NormalizedPollResult, PollOptionResult } from "./poll-input.js";

export {
  RichButtonSchema,
  RichCardFieldSchema,
  RichCardSchema,
  RichEffectSchema,
  parseRichButtons,
  parseRichCards,
} from "./rich-message.js";
export type { RichButton, RichCard, RichEffect } from "./rich-message.js";

export { ApprovalRequestSchema, ApprovalResolutionSchema, SerializedApprovalRequestSchema, SerializedApprovalCacheEntrySchema } from "./approval-request.js";
export type { ApprovalCallbackOwner, ApprovalRequest, ApprovalResolution, SerializedApprovalRequest, SerializedApprovalCacheEntry } from "./approval-request.js";

export {
  InjectionTypeSchema,
  CredentialMappingSchema,
  parseCredentialMapping,
} from "./credential-mapping.js";
export type { InjectionType, CredentialMapping } from "./credential-mapping.js";

export { SecretRefSchema, isSecretRef, SecretRefOrStringSchema } from "./secret-ref.js";
export type { SecretRef } from "./secret-ref.js";

export {
  McpInstructionBlockSchema,
  isMcpInstructionTextSafe,
  parseMcpInstructionBlock,
} from "./mcp-instruction-block.js";
export type { McpInstructionBlock } from "./mcp-instruction-block.js";

export {
  InstructionSourceKindSchema,
  InstructionTrustSchema,
  InstructionStabilitySchema,
  InstructionSectionSchema,
  WorkspacePolicySnapshotSchema,
  computeWorkspacePolicyCombinedHash,
  hashWorkspacePolicyContent,
  parseWorkspacePolicySnapshot,
  verifyWorkspacePolicySnapshot,
} from "./workspace-policy.js";

export {
  CanonicalLocaleSchema,
  ResponseLocaleSourceSchema,
  ResponseLocalePolicySchema,
  parseResponseLocalePolicy,
} from "./response-locale-policy.js";
export type {
  ResponseLocaleSource,
  ResponseLocalePolicy,
} from "./response-locale-policy.js";
export type {
  InstructionSourceKind,
  InstructionTrust,
  InstructionStability,
  InstructionSection,
  WorkspacePolicySnapshot,
  WorkspacePolicyVerificationError,
} from "./workspace-policy.js";

export {
  MemoryExportEnvelopeSchema,
  MemoryExportEntrySchema,
  parseMemoryExportEnvelope,
} from "./memory-export-envelope.js";
export type { MemoryExportEnvelope, MemoryExportEntry } from "./memory-export-envelope.js";

export { DeliveryOriginSchema, createDeliveryOrigin } from "./delivery-origin.js";
export type { DeliveryOrigin } from "./delivery-origin.js";

export {
  DeliveryStatusSchema,
  DeliveryFailureStageSchema,
  parseDeliveryFailureStage,
  parseDeliveryStatus,
} from "./delivery-status.js";
export type { DeliveryStatus, DeliveryFailureStage } from "./delivery-status.js";

export {
  NodeStatusSchema,
  GraphStatusSchema,
  GraphNodeSchema,
  NodeExecutionStateSchema,
  GraphBudgetSchema,
  ExecutionGraphSchema,
  GraphValidationError,
  parseExecutionGraph,
  topologicalSort,
  validateAndSortGraph,
  NodeTypeIdSchema,
} from "./execution-graph.js";
export type {
  NodeStatus,
  GraphStatus,
  GraphNode,
  NodeExecutionState,
  GraphBudget,
  ExecutionGraph,
  ValidatedGraph,
  NodeTypeId,
} from "./execution-graph.js";

// Node type driver
export type {
  NodeTypeDriver,
  NodeDriverAction,
  NodeDriverContext,
} from "./node-type-driver.js";

// Subagent context lifecycle types
export {
  SubagentResultSchema,
  SubagentEndReasonSchema,
  parseSubagentResult,
} from "./subagent-context-types.js";
export type {
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
} from "./subagent-context-types.js";

export { SubagentContextConfigSchema } from "./subagent-context-config.js";
export type { SubagentContextConfig } from "./subagent-context-config.js";

// Model compat config
export {
  ToolSchemaProfileSchema,
  ToolCallArgumentsEncodingSchema,
  ModelCompatConfigSchema,
} from "./model-compat.js";
export type {
  ToolSchemaProfile,
  ToolCallArgumentsEncoding,
  ModelCompatConfig,
} from "./model-compat.js";

// Provider capabilities
export {
  ProviderFamilySchema,
  TranscriptToolCallIdModeSchema,
  ProviderCapabilitiesSchema,
} from "./provider-capabilities.js";
export type {
  ProviderFamily,
  TranscriptToolCallIdMode,
  ProviderCapabilities,
} from "./provider-capabilities.js";

// Sub-agent tool governance
export {
  SUB_AGENT_TOOL_DENYLIST,
  SUB_AGENT_TOOL_PROFILES,
  SUB_AGENT_TOOL_GROUPS,
  RequiredToolsUnreachableError,
  toolReachableGroups,
  computeReachableToolNames,
} from "./sub-agent-tool-denylist.js";
export type { UnreachableToolEntry } from "./sub-agent-tool-denylist.js";

// RPC typed-refusal classification — the single source of truth the daemon
// rpc-dispatch classifier AND the @comis/gateway method-router classifier both
// delegate to, so intentional policy/security refusals classify consistently
// (warn, never internal/ERROR) at every log layer.
export { classifyTypedRpcError } from "./rpc-error-classification.js";
export type { TypedRpcErrorKind, TypedRpcErrorClassification } from "./rpc-error-classification.js";

export {
  ChannelEndpointSchema,
  PrincipalScopeSchema,
  PlatformPrincipalAssertionSchema,
  ConversationPartitionSchema,
  ConversationScopeSchema,
  ResolvedTurnScopeSchema,
  ConversationRefSchema,
  ConversationLocatorSchema,
  ConversationScopeError,
  encodeConversationScope,
  createConversationRef,
  createConversationLocator,
  conversationScopeToSessionKey,
} from "./conversation-scope.js";
export type {
  ChannelEndpoint,
  PrincipalScope,
  PlatformPrincipalAssertion,
  ConversationPartition,
  ConversationScope,
  ResolvedTurnScope,
  ConversationRef,
  ConversationLocator,
} from "./conversation-scope.js";

export {
  AgentExecutionFinishReasonSchema,
  AgentExecutionAbortReasonSchema,
  ModelResolutionSourceSchema,
  ExecutionSideEffectSummarySchema,
  AgentTurnExecutionOutcomeSchema,
  classifyAgentFinishErrorKind,
  classifyAgentAbortErrorKind,
  classifyAgentTurnExecutionOutcome,
} from "./agent-execution-outcome.js";
export type {
  AgentExecutionFinishReason,
  AgentExecutionAbortReason,
  ModelResolutionSource,
  ExecutionSideEffectSummary,
  AgentTurnExecutionOutcome,
} from "./agent-execution-outcome.js";
export {
  PrincipalMappingSchema,
  createPrincipalResolver,
} from "./principal-resolver.js";
export type { PrincipalMapping } from "./principal-resolver.js";
