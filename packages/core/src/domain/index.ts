// SPDX-License-Identifier: Apache-2.0
// Domain types - Zod schemas as single source of truth

export { AttachmentSchema, VoiceMetaSchema, NormalizedMessageSchema, parseMessage } from "./normalized-message.js";
export type { Attachment, VoiceMeta, NormalizedMessage } from "./normalized-message.js";

export {
  TrustLevelSchema,
  MemorySourceSchema,
  MemoryEntrySchema,
  parseMemoryEntry,
} from "./memory-entry.js";
export type { TrustLevel, MemoryEntry } from "./memory-entry.js";

export {
  ToolCallSchema,
  TokenUsageSchema,
  AgentResponseSchema,
  parseAgentResponse,
} from "./agent-response.js";
export type { ToolCall, TokenUsage, AgentResponse } from "./agent-response.js";

export { SessionKeySchema, parseSessionKey, formatSessionKey, parseFormattedSessionKey } from "./session-key.js";
export type { SessionKey } from "./session-key.js";

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
export type { ApprovalRequest, ApprovalResolution, SerializedApprovalRequest, SerializedApprovalCacheEntry } from "./approval-request.js";

export {
  InjectionTypeSchema,
  CredentialMappingSchema,
  parseCredentialMapping,
} from "./credential-mapping.js";
export type { InjectionType, CredentialMapping } from "./credential-mapping.js";

export { SecretRefSchema, isSecretRef, SecretRefOrStringSchema } from "./secret-ref.js";
export type { SecretRef } from "./secret-ref.js";

export { DeliveryOriginSchema, createDeliveryOrigin } from "./delivery-origin.js";
export type { DeliveryOrigin } from "./delivery-origin.js";

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
