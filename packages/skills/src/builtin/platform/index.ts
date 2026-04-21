// SPDX-License-Identifier: Apache-2.0
/**
 * Platform tool helpers and tool factories.
 *
 * Re-exports tool output helpers and all platform tool factories.
 *
 * @module
 */

export {
  jsonResult,
  imageResult,
  dualImageResult,
  readStringParam,
  readNumberParam,
  readBooleanParam,
  readEnumParam,
  createActionGate,
  throwToolError,
  TRUST_HIERARCHY,
  meetsMinimumTrust,
  createTrustGuard,
} from "./tool-helpers.js";
export type { ToolErrorCode } from "./tool-helpers.js";

// Memory tools
export { createMemorySearchTool } from "./memory-search-tool.js";
export { createMemoryGetTool } from "./memory-get-tool.js";
export { createMemoryStoreTool } from "./memory-store-tool.js";

// Session tools
export { createSessionStatusTool } from "./session-status-tool.js";
export { createSessionsListTool } from "./sessions-list-tool.js";
export { createSessionsHistoryTool } from "./sessions-history-tool.js";
export { createSessionsSendTool } from "./sessions-send-tool.js";
export { createSessionsSpawnTool } from "./sessions-spawn-tool.js";
export { createSessionSearchTool } from "./session-search-tool.js";

// Agent tools
export { createAgentsListTool } from "./agents-list-tool.js";
export { createSubagentsTool } from "./subagents-tool.js";
export { createPipelineTool } from "./pipeline-tool.js";

// Messaging factory
export { createRpcDispatchTool, createMultiActionDispatchTool } from "./messaging-factory.js";
export type { RpcDispatchToolConfig, MultiActionDispatchConfig } from "./messaging-factory.js";

// Messaging
export { createMessageTool } from "./message-tool.js";

// Scheduling
export { createCronTool, type RpcCall } from "./cron-tool.js";

// Platform actions
export { createPlatformActionTool } from "./platform-action-tool.js";
export type { PlatformActionDescriptor } from "./platform-action-tool.js";
export { createDiscordActionTool } from "./discord-action-tool.js";
export { createTelegramActionTool } from "./telegram-action-tool.js";
export { createSlackActionTool } from "./slack-action-tool.js";
export { createWhatsAppActionTool } from "./whatsapp-action-tool.js";

// Media tools
export { createImageTool } from "./image-tool.js";
export { createTTSTool } from "./tts-tool.js";
export { createTranscribeAudioTool } from "./transcribe-audio-tool.js";
export { createDescribeVideoTool } from "./describe-video-tool.js";
export { createExtractDocumentTool } from "./extract-document-tool.js";

// Infrastructure
export { createGatewayTool } from "./gateway-tool.js";
export { createBrowserTool } from "./browser-tool.js";

// Context DAG tools
export { createCtxSearchTool } from "./ctx-search-tool.js";
export { createCtxInspectTool } from "./ctx-inspect-tool.js";
export { createCtxRecallTool } from "./ctx-recall-tool.js";
export { createCtxExpandTool } from "./ctx-expand-tool.js";

// Unified tools (action dispatch -- consolidates individual tools above)
export { createUnifiedSessionTool } from "./unified-session-tool.js";
export { createUnifiedMemoryTool } from "./unified-memory-tool.js";
export { createUnifiedContextTool } from "./unified-context-tool.js";

// Notifications
export { createNotifyTool } from "./notify-tool.js";

// Image generation
export { createImageGenerateTool } from "./image-generate-tool.js";

// Heartbeat management
export { createHeartbeatManageTool } from "./heartbeat-manage-tool.js";

// Admin manage factory
export { createAdminManageTool } from "./admin-manage-factory.js";
export type { AdminManageDescriptor } from "./admin-manage-factory.js";

// Fleet management
export { createAgentsManageTool } from "./agents-manage-tool.js";
export { createObsQueryTool } from "./obs-query-tool.js";
export { createMemoryManageTool } from "./memory-manage-tool.js";
export { createSessionsManageTool } from "./sessions-manage-tool.js";
export { createModelsManageTool } from "./models-manage-tool.js";
export { createTokensManageTool } from "./tokens-manage-tool.js";
export { createChannelsManageTool } from "./channels-manage-tool.js";
export { createSkillsManageTool } from "./skills-manage-tool.js";
export { createMcpManageTool } from "./mcp-manage-tool.js";

// Background tasks
export { createBackgroundTasksTool } from "./background-tasks-tool.js";
