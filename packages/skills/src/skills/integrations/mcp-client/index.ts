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

import type PQueue from "p-queue";
import type {
  McpClientManager,
  McpClientManagerDeps,
  McpClientManagerOptions,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
  McpToolDefinition,
} from "./mcp-client-types.js";
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
  McpClientManager,
} from "./mcp-client-types.js";

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
  };

  const state: McpClientManagerState = {
    connections: new Map<string, McpConnection>(),
    reconnectionAbortControllers: new Map<string, AbortController>(),
    userDisconnectedFlags: new Set<string>(),
    serverConfigs: new Map<string, McpServerConfig>(),
    generations: new Map<string, number>(),
    callQueues: new Map<string, PQueue>(),
    consecutiveErrors: new Map<string, number>(),
    options,
  };

  return {
    connect: (config) => connectServer(state, deps, config),
    disconnect: (name) => disconnectServer(state, deps, name),
    disconnectAll: () => disconnectAllServers(state, deps),
    getConnection: (name) => getConnection(state, name),
    getAllConnections: () => getAllConnections(state),
    getTools: (): McpToolDefinition[] => listAllTools(state),
    callTool: (qualifiedName, args) => callTool(state, deps, qualifiedName, args),
    reconnect: (name) => reconnectServer(state, deps, name),
  };
}
