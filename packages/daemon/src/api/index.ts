// SPDX-License-Identifier: Apache-2.0
// @comis/daemon RPC handlers -- domain-specific handler modules
export type { RpcHandler } from "./types.js";
export { createCronHandlers, type CronHandlerDeps } from "./cron-handlers.js";
export { createMemoryHandlers, type MemoryHandlerDeps } from "./memory-handlers.js";
export { createSessionHandlers, type SessionHandlerDeps } from "./session-handlers/index.js";
export { createMessageHandlers, type MessageHandlerDeps } from "./message-handlers.js";
export { createMediaHandlers, type MediaHandlerDeps } from "./media-handlers.js";
export { createConfigHandlers, type ConfigHandlerDeps } from "./config-handlers/index.js";
export { createBrowserHandlers, type BrowserHandlerDeps } from "./browser-handlers.js";
export { createSubagentHandlers } from "./subagent-handlers.js";
export { createApprovalHandlers, type ApprovalHandlerDeps } from "./approval-handlers.js";
export { createAgentHandlers, type AgentHandlerDeps } from "./agent-handlers.js";
export { createObsHandlers, type ObsHandlerDeps } from "./obs-handlers/index.js";
export { createCacheHandlers } from "./cache-handlers.js";
export { createModelHandlers, type ModelHandlerDeps } from "./model-handlers.js";
export { createChannelHandlers, type ChannelHandlerDeps } from "./channel-handlers.js";
export { createTokenHandlers, createTokenRegistry, type TokenHandlerDeps, type TokenRegistry } from "./token-handlers.js";
export { createMcpHandlers, type McpHandlerDeps } from "./mcp-handlers.js";
export { createMcpOauthHandlers, type McpOauthHandlerDeps } from "./mcp-oauth-handlers.js";
export { createWorkspaceHandlers, type WorkspaceHandlerDeps } from "./workspace-handlers.js";
export { createDaemonHandlers, type DaemonHandlerDeps } from "./daemon-handlers.js";
export { createEnvHandlers, type EnvHandlerDeps } from "./env-handlers.js";
export { createSecretsHandlers, type SecretsHandlerDeps } from "./secrets-handlers.js";
export { createAuthHandlers, type AuthHandlerDeps } from "./auth-handlers.js";
export { createGraphHandlers, type GraphHandlerDeps } from "./graph-handlers/index.js";
export { createHeartbeatHandlers, type HeartbeatHandlerDeps } from "./heartbeat-handlers.js";
export { createSkillHandlers, type SkillHandlerDeps } from "./skill-handlers.js";
export { createRpcDispatch, classifyRpcError, type ApiDispatchDeps } from "./rpc-dispatch.js";
