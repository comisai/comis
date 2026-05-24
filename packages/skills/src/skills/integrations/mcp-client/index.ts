// SPDX-License-Identifier: Apache-2.0
/**
 * MCP Client Manager.
 *
 * Connects to external Model Context Protocol servers and discovers
 * their tools for use by the Comis agent. Manages connection lifecycle
 * (connect/disconnect), tool discovery via listTools(), tool invocation
 * via callTool(), and automatic reconnection with exponential backoff
 * on involuntary disconnects. Each tool is qualified with its server
 * name ("mcp:{server}/{tool}") to avoid collisions.
 *
 * Barrel + thin factory composing state + handle. The factory body
 * constructs the McpClientManagerState and wires the handle methods to
 * the per-concern leaves (connect/call/discover/reconnect).
 *
 * @module
 */

import type { SystemIntervalHandle, SystemTimeoutHandle } from "@comis/core";
import type PQueue from "p-queue";
import type {
  CircuitState,
  McpClientManager,
  McpClientManagerDeps,
  McpClientManagerOptions,
  McpClientManagerState,
  McpConnection,
  McpOAuthDeps,
  McpServerConfig,
  McpToolDefinition,
} from "./mcp-client-types.js";
import type { RefreshResult } from "./oauth/refresh-deduper.js";
import { createTokenStore, type TokenStore } from "./oauth/token-store.js";
import { resolveDiscovery } from "./oauth/discovery.js";
import {
  connectServer,
  disconnectServer,
  disconnectAllServers,
  getAllConnections,
  getConnection,
  reconnectServer,
} from "./mcp-client-connect.js";
import { callTool } from "./mcp-client-call.js";
import { listAllTools } from "./mcp-client-discover.js";

// ---------------------------------------------------------------------------
// Public type + utility re-exports (named-only; no aliases)
// ---------------------------------------------------------------------------

export type {
  McpServerConfig,
  McpConnectionStatus,
  McpReconnectOptions,
  McpConnection,
  McpToolDefinition,
  McpToolCallResult,
  McpToolCallContent,
  McpClientManagerDeps,
  McpOAuthDeps,
  McpClientManager,
} from "./mcp-client-types.js";

// Phase 66 OAUTH-11 (66d): the connect-time needs_oauth_login signal guard.
// Re-exported so the daemon RPC layer can distinguish an auth-needed connect
// failure (→ tell the operator to run `comis mcp login`) from a generic failure.
export { isNeedsOAuthLoginError } from "./mcp-client-connect.js";

// Phase 66 OAUTH-10 (66f): the interactive OAuth login orchestrator + the disk
// token-store factory. Re-exported so the daemon RPC handler
// (`mcp-oauth-handlers.ts`) can run `mcp.oauth_login` (server-side discovery +
// callback + SDK auth() + saveTokens) and `mcp.oauth_logout` (token-store
// deleteAll) WITHOUT importing the MCP SDK directly (the daemon depends on
// @comis/skills, not the SDK). The login orchestrator owns the SDK auth() call.
export { runOauthLogin } from "./oauth/login.js";
export type {
  OAuthLoginResult,
  RunOauthLoginDeps,
  OAuthLoginConfig,
  OAuthLoginLogger,
} from "./oauth/login.js";
export { createTokenStore } from "./oauth/token-store.js";
export type { TokenStore, TokenStoreDeps } from "./oauth/token-store.js";

export { qualifyToolName, parseQualifiedName } from "./mcp-client-types.js";

// Phase 63 SAFETY-01/02: stdio env-scrub primitives re-exported so the
// daemon RPC handler + architecture / integration tests can consume them
// via @comis/skills.
export { MCP_STDIO_BUILTIN_ENV_ALLOWLIST, scrubStdioEnv } from "./mcp-client-discover.js";

// Phase 63 SAFETY-05/06: pre-spawn OSV malware check + package-name
// extraction for stdio MCP commands. Re-exported so the daemon RPC handler
// + architecture / integration tests can consume them via @comis/skills.
export {
  osvMalwareCheck,
  extractMcpPackageName,
  DEFAULT_OSV_CACHE_DIR,
} from "./mcp-client-osv-check.js";
export type { OsvCheckResult, OsvCheckOptions } from "./mcp-client-osv-check.js";

// Phase 63 SAFETY-07: custom FetchLike with cross-host redirect header scrub
// for SSE + Streamable HTTP MCP transports. Re-exported so the integration
// test under test/integration/ can consume it via @comis/skills.
export { createRedirectPolicyFetch } from "./mcp-client-redirect-policy.js";
export type { RedirectPolicyOptions } from "./mcp-client-redirect-policy.js";

// Phase 65 OPUX-10: capability-gate helpers re-exported so the platform-tool
// registry (../../platform-tools/registry.ts) can gate the resources/prompts
// descriptors on a connected server advertising the matching capability. The
// 4 RPC adapters are consumed by the tool factories via the relative
// mcp-client-resources.js path (same package) and so are not surfaced here.
export {
  serverAdvertisesResources,
  serverAdvertisesPrompts,
} from "./mcp-client-resources.js";
export type {
  ResourceListEntry,
  ResourceContents,
  PromptListEntry,
  PromptGetResult,
} from "./mcp-client-resources.js";

// ---------------------------------------------------------------------------
// Factory (state-first composition)
// ---------------------------------------------------------------------------

/**
 * Create an MCP client manager that handles connection lifecycle,
 * tool discovery, tool invocation, and automatic reconnection for
 * external MCP servers.
 */
export function createMcpClientManager(deps: McpClientManagerDeps): McpClientManager {
  // Resolve defaults at construction
  const options: McpClientManagerOptions = {
    connectTimeoutMs: deps.connectTimeoutMs ?? 30_000,
    callToolTimeoutMs: deps.callToolTimeoutMs ?? 60_000,
    stdioDefaultConcurrency: deps.stdioDefaultConcurrency ?? 1,
    httpDefaultConcurrency: deps.httpDefaultConcurrency ?? 4,
    reconnectOpts: {
      maxAttempts: deps.reconnectOptions?.maxAttempts ?? 5,
      initialDelayMs: deps.reconnectOptions?.initialDelayMs ?? 1000,
      maxDelayMs: deps.reconnectOptions?.maxDelayMs ?? 30_000,
      growFactor: deps.reconnectOptions?.growFactor ?? 2,
    },
    keepaliveIntervalMs: deps.keepaliveIntervalMs ?? 180_000,
    circuitBreakerThreshold: deps.circuitBreakerThreshold ?? 3,
    circuitBreakerCooldownMs: deps.circuitBreakerCooldownMs ?? 60_000,
  };

  const state: McpClientManagerState = {
    connections: new Map<string, McpConnection>(),
    reconnectionAbortControllers: new Map<string, AbortController>(),
    userDisconnectedFlags: new Set<string>(),
    serverConfigs: new Map<string, McpServerConfig>(),
    generations: new Map<string, number>(),
    callQueues: new Map<string, PQueue>(),
    keepaliveQueues: new Map<string, PQueue>(),
    consecutiveErrors: new Map<string, number>(),
    keepaliveTickers: new Map<string, SystemIntervalHandle>(),
    circuitBreakers: new Map<string, CircuitState>(),
    idleEvictionTimers: new Map<string, SystemTimeoutHandle>(),
    lastActivityMs: new Map<string, number>(),
    inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
    options,
  };

  // Phase 66 OAUTH-11 (66d): resolve the OAuth seam. When the caller injects
  // `oauthDeps` (the daemon composition root supplying `openUrl`, or a test) use
  // it verbatim. Otherwise default to a process-wide singleton disk token store
  // at `~/.comis/mcp-tokens/` + the real discovery cascade — so an `auth:"oauth"`
  // server works out of the box without the daemon having to wire it. The store
  // is constructed LAZILY (first auth:"oauth" connect) so a manager that never
  // touches OAuth pays no chokidar-watch cost.
  let sharedTokenStore: TokenStore | undefined;
  const resolvedOAuthDeps: McpOAuthDeps = deps.oauthDeps ?? {
    createTokenStore: (): TokenStore => {
      if (sharedTokenStore === undefined) {
        sharedTokenStore = createTokenStore({ logger: deps.logger });
        // Best-effort start the disk-watch (OAUTH-04) so an external cron/sibling
        // rotation is picked up no-restart; failures are logged inside the store.
        void sharedTokenStore.startWatch();
      }
      return sharedTokenStore;
    },
    resolveDiscovery,
  };
  const effectiveDeps: McpClientManagerDeps = { ...deps, oauthDeps: resolvedOAuthDeps };

  return {
    connect: (config) => connectServer(state, effectiveDeps, config),
    disconnect: (name) => disconnectServer(state, effectiveDeps, name),
    disconnectAll: () => disconnectAllServers(state, effectiveDeps),
    getConnection: (name) => getConnection(state, name),
    getAllConnections: () => getAllConnections(state),
    getTools: (): McpToolDefinition[] => listAllTools(state),
    callTool: (qualifiedName, args) => callTool(state, effectiveDeps, qualifiedName, args),
    reconnect: (name) => reconnectServer(state, effectiveDeps, name),
  };
}
