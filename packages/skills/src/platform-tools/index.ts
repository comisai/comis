// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/skills/platform-tools — Public surface for the `./platform-tools` subpath.
 *
 * Re-exports the tool output helpers (jsonResult, imageResult, readEnumParam,
 * createActionGate, etc.), the messaging / admin-manage / platform-action
 * factory shells, and the 38+ RPC-coupled per-tool factories that live under
 * `./tools/`. This is one of the three subpath exports — the daemon's wiring
 * uses it (alongside the `.` subpath for skill registry / bridge symbols and
 * `./tools` for built-in / media / integration factories) to compose the
 * per-agent tool set.
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
export { createMemorySearchTool } from "./tools/memory-search-tool.js";
export { createMemoryGetTool } from "./tools/memory-get-tool.js";
export { createMemoryStoreTool } from "./tools/memory-store-tool.js";
// The dialectic tool. Consumed by the registry's memory_ask
// conditional descriptor; surfaced on the public ./platform-tools barrel alongside its
// sibling memory tools (the registry's same-package import is invisible to the
// public-export-consumers walker, so it is tracked as a baseline orphan in public-api-policy).
export { createMemoryAskTool } from "./tools/memory-ask-tool.js";

// Session tools
export { createSessionStatusTool } from "./tools/session-status-tool.js";
export { createSessionsListTool } from "./tools/sessions-list-tool.js";
export { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
export { createSessionsSendTool } from "./tools/sessions-send-tool.js";
export { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
export { createSessionSearchTool } from "./tools/session-search-tool.js";

// Agent tools
export { createSubagentsTool } from "./tools/subagents-tool.js";
export { createPipelineTool } from "./tools/pipeline-tool.js";

// Messaging factory
export { createRpcDispatchTool, createMultiActionDispatchTool } from "./messaging-factory.js";
export type { RpcDispatchToolConfig, MultiActionDispatchConfig } from "./messaging-factory.js";

// Messaging
export { createMessageTool } from "./tools/message-tool.js";

// Scheduling
export { createCronTool, type RpcCall, type RpcCallMetadata } from "./tools/cron-tool.js";

// Platform actions
export { createPlatformActionTool } from "./platform-action-tool.js";
export type { PlatformActionDescriptor } from "./platform-action-tool.js";
export { createDiscordActionTool } from "./tools/discord-action-tool.js";
export { createTelegramActionTool } from "./tools/telegram-action-tool.js";
export { createSlackActionTool } from "./tools/slack-action-tool.js";
export { createWhatsAppActionTool } from "./tools/whatsapp-action-tool.js";

// Media tools
export { createImageTool } from "./tools/image-tool.js";
export { createTTSTool } from "./tools/tts-tool.js";
export { createTranscribeAudioTool } from "./tools/transcribe-audio-tool.js";
export { createDescribeVideoTool } from "./tools/describe-video-tool.js";
export { createExtractDocumentTool } from "./tools/extract-document-tool.js";

// Infrastructure
export { createGatewayTool } from "./tools/gateway-tool.js";
export { createBrowserTool } from "./tools/browser-tool.js";

// Notifications
export { createNotifyTool } from "./tools/notify-tool.js";

// Image generation
export { createImageGenerateTool } from "./tools/image-generate-tool.js";

// Video generation
export { createVideoGenerateTool } from "./tools/video-generate-tool.js";

// Heartbeat management
export { createHeartbeatManageTool } from "./tools/heartbeat-manage-tool.js";

// Admin manage factory
export { createAdminManageTool } from "./admin-manage-factory.js";
export type { AdminManageDescriptor } from "./admin-manage-factory.js";

// Agent administration
export { createAgentsManageTool } from "./tools/agents-manage-tool.js";
export { createObsQueryTool } from "./tools/obs-query-tool.js";
export { createMemoryManageTool } from "./tools/memory-manage-tool.js";
export { createSessionsManageTool } from "./tools/sessions-manage-tool.js";
export { createModelsManageTool } from "./tools/models-manage-tool.js";
export { createProvidersManageTool } from "./tools/providers-manage-tool.js";
export { createTokensManageTool } from "./tools/tokens-manage-tool.js";
export { createChannelsManageTool } from "./tools/channels-manage-tool.js";
export { createSkillsManageTool } from "./tools/skills-manage-tool.js";
export { createMcpManageTool } from "./tools/mcp-manage-tool.js";
export { createMcpLoginTool } from "./tools/mcp-login-tool.js";

// Background tasks
export { createBackgroundTasksTool } from "./tools/background-tasks-tool.js";

// ===========================================================================
// Descriptor Registry
// ===========================================================================

export { createPlatformToolRegistry } from "./registry.js";
export type {
  PlatformToolDescriptor,
  PlatformToolBuildContext,
} from "./registry.js";
