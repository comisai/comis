// SPDX-License-Identifier: Apache-2.0
// @comis/gateway -- HTTPS gateway with mTLS, JSON-RPC, WebSocket, and webhook support
// Public API -- all exports have verified external consumers.

// Server
export { createGatewayServer } from "./server/hono-server.js";
export type { GatewayServerHandle } from "./server/hono-server.js";

// Auth -- Token
export { createTokenStore, extractBearerToken, checkScope } from "./auth/token-auth.js";

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

// Phase 11: OAuth callback route exports
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

// OpenAI compatibility endpoints
export { createOpenaiCompletionsRoute } from "./openai/index.js";
export { createOpenaiModelsRoute } from "./openai/index.js";
export { createOpenaiEmbeddingsRoute } from "./openai/index.js";

// OpenResponses endpoint
export { createResponsesRoute } from "./responses/index.js";

// ACP server for IDE integration
export { createAcpAgent } from "./acp/index.js";
export type { AcpServerDeps } from "./acp/index.js";

// mDNS/Bonjour service discovery
export { createMdnsAdvertiser } from "./discovery/index.js";
