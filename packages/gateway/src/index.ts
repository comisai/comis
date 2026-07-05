// SPDX-License-Identifier: Apache-2.0
// @comis/gateway -- HTTPS gateway with mTLS, JSON-RPC, WebSocket, and webhook support
// Public API -- all exports have verified external consumers.

// Server
export { createGatewayServer } from "./server/hono-server.js";
export type { GatewayServerHandle } from "./server/hono-server.js";

// MCP server endpoint: the mount helper itself stays
// gateway-internal (consumed via relative import by hono-server.ts). The
// daemon-side factory in packages/daemon/src/api/mcp-server-handlers.ts
// imports TokenClient from this index to type its `buildMcpServerForClient`
// signature; that re-export is below ("Auth -- Token").

// Auth -- Token
export { createTokenStore, extractBearerToken, checkScope } from "./auth/token-auth.js";
// TokenClient is consumed by the daemon's MCP server
// factory (packages/daemon/src/api/mcp-server-handlers.ts) to type the
// verified-client param. The other token types remain internal — daemon
// callers obtain them transitively via `ReturnType<typeof createTokenStore>`.
export type { TokenClient } from "./auth/token-auth.js";

// Auth -- mTLS
export { validateCertificates, extractClientCN } from "./auth/mtls-verifier.js";
export type { CertPaths } from "./auth/mtls-verifier.js";

// Rate limiting
export { createRateLimiter } from "./rate-limit/rate-limiter.js";

// RPC -- method router
export { createDynamicMethodRouter } from "./rpc/method-router.js";
export type { DynamicMethodRouter } from "./rpc/method-router.js";

// RPC -- adapters
export { createRpcAdapters } from "./rpc/rpc-adapters.js";
export type { RpcAdapterDeps } from "./rpc/rpc-adapters.js";

// RPC -- WebSocket
export { WsConnectionManager } from "./rpc/ws-handler.js";

// Webhook
export { createMappedWebhookEndpoint } from "./webhook/webhook-endpoint.js";
export { getPresetMappings } from "./webhook/webhook-presets.js";

// Channel ingress -- Microsoft Teams inbound activities (mounted per-channel
// by the daemon; framework-agnostic over injected validator + adapter driver)
export { createMsTeamsIngress } from "./channel-ingress/msteams-ingress.js";
export type { MsTeamsIngressDeps } from "./channel-ingress/msteams-ingress.js";

// OAuth callback route exports
export {
  createOAuthCallbackRoute,
  insertPendingFlow,
  PENDING_FLOW_TIMEOUT_MS,
} from "./oauth/oauth-callback-route.js";
export type {
  OAuthCallbackDeps,
  PendingFlow,
} from "./oauth/oauth-callback-route.js";

// Web -- media routes
export { createMediaRoutes } from "./web/index.js";

// Web -- email approval-token route (single-use, 5-min, revoke-on-first-touch)
export {
  createApprovalTokenRoute,
  insertPendingApprovalToken,
  APPROVAL_TOKEN_TIMEOUT_MS,
} from "./web/index.js";
export type {
  ApprovalTokenDeps,
  PendingApprovalToken,
  ApprovalLinkChoice,
} from "./web/index.js";

// OpenAI compatibility endpoints
export { createOpenaiCompletionsRoute } from "./openai/index.js";
export { createOpenaiModelsRoute } from "./openai/index.js";
export { createOpenaiEmbeddingsRoute } from "./openai/index.js";

// OpenResponses endpoint
export { createResponsesRoute } from "./responses/index.js";

// ACP server for IDE integration
export { createAcpAgent, startAcpServer } from "./acp/index.js";
export type { AcpServerDeps, AcpAgentHandle } from "./acp/index.js";

// ACP activity/plan/approval bridges + local queue — the daemon composition
// root constructs these per ACP session (createAcpAgent's AcpAgentHandle
// provides getConnection; the holder from @comis/agent is the ExecutionPlanPort).
export {
  createAcpActivityBridge,
  createAcpPlanBridge,
  createAcpApprovalBridge,
  createAcpBoundedQueue,
} from "./acp/index.js";
export type {
  CreateAcpActivityBridgeDeps,
  CreateAcpPlanBridgeDeps,
  CreateAcpApprovalBridgeDeps,
} from "./acp/index.js";

// mDNS/Bonjour service discovery
export { createMdnsAdvertiser } from "./discovery/index.js";
