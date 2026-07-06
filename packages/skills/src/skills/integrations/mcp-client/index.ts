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

// The connect-time needs_oauth_login signal guard.
// Re-exported so the daemon RPC layer can distinguish an auth-needed connect
// failure (→ tell the operator to run `comis mcp login`) from a generic failure.
export { isNeedsOAuthLoginError } from "./mcp-client-connect.js";

// The interactive OAuth login orchestrator + the disk token-store factory.
// Re-exported so the daemon RPC handler (`mcp-oauth-handlers.ts`) can run
// `mcp.oauth_login` (server-side discovery + callback + SDK auth() + saveTokens)
// and `mcp.oauth_logout` (token-store deleteAll) WITHOUT importing the MCP SDK
// directly (the daemon depends on @comis/skills, not the SDK). The login
// orchestrator owns the SDK auth() call.
export { runOauthLogin } from "./oauth/login.js";
export type {
  OAuthLoginResult,
  RunOauthLoginDeps,
  OAuthLoginConfig,
  OAuthLoginLogger,
} from "./oauth/login.js";
// RFC 8628 device-authorization grant orchestrator. Companion to
// runOauthLogin for headless / VPS deployments. runOauthLogin dispatches into
// runDeviceFlow when the selection heuristic (headless ∧
// device-code advertised) or the oauth.flow operator override picks device-code.
export { runDeviceFlow } from "./oauth/device-flow.js";
export type {
  RunDeviceFlowDeps,
  DeviceFlowLogger,
  DeviceFlowOAuthConfig,
} from "./oauth/device-flow.js";
export { createTokenStore } from "./oauth/token-store.js";
export type { TokenStore, TokenStoreDeps } from "./oauth/token-store.js";
// Re-exported so the daemon port-backed adapter can supply it as the default
// resolveDiscovery in oauthDeps without importing skills internals directly.
export { resolveDiscovery } from "./oauth/discovery.js";

// The 401 refresh-deduper. Re-exported so the full-cycle integration test
// (test/integration/mcp-oauth-roundtrip.test.ts) can drive rotation +
// Stripe-Account + 100-concurrent dedup against the mock authorization server
// through the PUBLIC package barrel (not src internals). Internally the deduper
// is wired to per-server callQueues by connectServer; the public re-export is
// purely for the integration gate's mock coverage.
export { createRefreshDeduper } from "./oauth/refresh-deduper.js";
export type {
  RefreshDeduper,
  RefreshDeduperDeps,
  RefreshResult,
  DedupedRefreshArgs,
  RefreshFn,
} from "./oauth/refresh-deduper.js";

// The deduped-refresh fetch wrapper that wires the deduper into the production
// 401 path on the SSE/HTTP transport. Re-exported so the production-path
// integration test (test/integration/mcp-oauth-deduped-fetch.test.ts) can prove
// 100 concurrent in-flight tool calls hitting a 401 collapse to ONE refresh POST
// WITHOUT calling dedupedRefresh directly. Internally the wrapper is composed
// onto `effectiveConfig.oauthFetch` by `prepareOAuthProvider`
// (mcp-client-oauth-connect.ts) and the SSE/HTTP transport's `fetch` option in
// `createTransport`.
export { createDedupedRefreshFetch } from "./oauth/deduped-fetch.js";
export type { DedupedRefreshFetchDeps } from "./oauth/deduped-fetch.js";

export { qualifyToolName, parseQualifiedName } from "./mcp-client-types.js";

// stdio env-scrub primitives re-exported so the daemon RPC handler +
// architecture / integration tests can consume them via @comis/skills.
export { MCP_STDIO_BUILTIN_ENV_ALLOWLIST, scrubStdioEnv } from "./mcp-client-discover.js";

// Pre-spawn OSV malware check + package-name extraction for stdio MCP commands.
// Re-exported so the daemon RPC handler + architecture / integration tests can
// consume them via @comis/skills.
export {
  osvMalwareCheck,
  extractMcpPackageName,
  DEFAULT_OSV_CACHE_DIR,
} from "./mcp-client-osv-check.js";
export type { OsvCheckResult, OsvCheckOptions } from "./mcp-client-osv-check.js";

// Custom FetchLike with cross-host redirect header scrub for SSE + Streamable
// HTTP MCP transports. Re-exported so the integration test under
// test/integration/ can consume it via @comis/skills.
export { createRedirectPolicyFetch } from "./mcp-client-redirect-policy.js";
export type { RedirectPolicyOptions } from "./mcp-client-redirect-policy.js";

// Capability-gate helpers re-exported so the platform-tool registry
// (../../platform-tools/registry.ts) can gate the resources/prompts descriptors
// on a connected server advertising the matching capability. The 4 RPC adapters
// are consumed by the tool factories via the relative mcp-client-resources.js
// path (same package) and so are not surfaced here.
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
    lastStderr: new Map<string, string>(),
    keepaliveTickers: new Map<string, SystemIntervalHandle>(),
    circuitBreakers: new Map<string, CircuitState>(),
    idleEvictionTimers: new Map<string, SystemTimeoutHandle>(),
    lastActivityMs: new Map<string, number>(),
    inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
    options,
  };

  // Resolve the OAuth seam. When the caller injects `oauthDeps` (the daemon
  // composition root supplying `openUrl`, or a test) use it verbatim. Otherwise
  // default to a process-wide singleton disk token store at
  // `~/.comis/mcp-tokens/` + the real discovery cascade — so an `auth:"oauth"`
  // server works out of the box without the daemon having to wire it. The store
  // is constructed LAZILY (first auth:"oauth" connect) so a manager that never
  // touches OAuth pays no chokidar-watch cost.
  let sharedTokenStore: TokenStore | undefined;
  const resolvedOAuthDeps: McpOAuthDeps = deps.oauthDeps ?? {
    createTokenStore: (): TokenStore => {
      if (sharedTokenStore === undefined) {
        sharedTokenStore = createTokenStore({ logger: deps.logger });
        // Best-effort start the disk-watch so an external cron/sibling rotation
        // is picked up no-restart; failures are logged inside the store.
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
