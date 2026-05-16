// SPDX-License-Identifier: Apache-2.0
/**
 * mcp-client public types + closure-state interface (Phase 43 split per
 * FILE-SPLIT-11).
 *
 * Types extracted verbatim from the pre-split mcp-client.ts. The
 * canonical public-API contract is preserved byte-identical so the
 * @comis/skills barrel re-exports stay byte-identical.
 *
 * Adds the closure-state shape (McpClientManagerState) used by the
 * state-first protocol per Phase 42 pi-executor and Phase 43
 * telegram-adapter conventions (WARNING ISSUE-06 fix).
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TypedEventBus } from "@comis/core";
import type PQueue from "p-queue";

// ---------------------------------------------------------------------------
// Qualified name helpers (pure; co-located with types to break no-cycles)
// ---------------------------------------------------------------------------
//
// qualifyToolName + parseQualifiedName live here (instead of in the call
// leaf where they were originally placed) to break a no-cycles
// regression: callTool imports handleDisconnection from
// mcp-client-reconnect.ts, which in turn must qualify tool names —
// putting the qualify helpers in call.ts would close a 3-way cycle
// (call -> reconnect -> discover -> call). Hosting them in types.ts
// (the leaf with zero internal sibling imports) keeps the dependency
// graph acyclic. (Same pattern as Phase 43 plan 02b's SearchProviderName
// fix per 43-02b-SUMMARY.md Decision 1.)

const MCP_PREFIX = "mcp:";

/** Build a qualified tool name: "mcp:{server}/{tool}". */
export function qualifyToolName(serverName: string, toolName: string): string {
  return `${MCP_PREFIX}${serverName}/${toolName}`;
}

/** Parse a qualified name into server and tool parts. Returns undefined on invalid format. */
export function parseQualifiedName(
  qualifiedName: string,
): { serverName: string; toolName: string } | undefined {
  if (!qualifiedName.startsWith(MCP_PREFIX)) return undefined;
  const rest = qualifiedName.slice(MCP_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx < 1 || slashIdx === rest.length - 1) return undefined;
  return {
    serverName: rest.slice(0, slashIdx),
    toolName: rest.slice(slashIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for a single MCP server connection. */
export interface McpServerConfig {
  /** Unique name identifying this server. */
  readonly name: string;
  /** Transport protocol: stdio (local process), sse (legacy SSE), or http (Streamable HTTP). */
  readonly transport: "stdio" | "sse" | "http";
  /** Executable command for stdio transport. */
  readonly command?: string;
  /** Command-line arguments for stdio transport. */
  readonly args?: string[];
  /** Server URL for remote transports (sse, http). */
  readonly url?: string;
  /** Environment variables to pass to the stdio process (e.g. API keys). */
  readonly env?: Record<string, string>;
  /** Working directory for stdio transport. Overrides the default workspace CWD. */
  readonly cwd?: string;
  /** Whether the server is enabled. */
  readonly enabled: boolean;
  /** Custom HTTP headers for remote transports. Plumbed to requestInit.headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Maximum concurrent tool calls. Undefined = transport-based default. */
  readonly maxConcurrency?: number;
}

/** Connection status for an MCP server. */
export type McpConnectionStatus = "connected" | "disconnected" | "connecting" | "reconnecting" | "error";

/** Configuration for automatic reconnection behavior. */
export interface McpReconnectOptions {
  /** Maximum number of reconnection attempts (default: 5). */
  readonly maxAttempts: number;
  /** Initial backoff delay in milliseconds (default: 1000). */
  readonly initialDelayMs: number;
  /** Maximum backoff delay in milliseconds (default: 30000). */
  readonly maxDelayMs: number;
  /** Backoff growth factor (default: 2). */
  readonly growFactor: number;
}

/** A live connection to an MCP server. */
export interface McpConnection {
  /** Server name matching McpServerConfig.name. */
  readonly name: string;
  /** The underlying MCP SDK client instance. */
  readonly client: Client;
  /** Current connection status. */
  readonly status: McpConnectionStatus;
  /** Tools discovered from this server. */
  readonly tools: McpToolDefinition[];
  /** Timestamp of last successful health check (ms since epoch). */
  readonly lastHealthCheck: number;
  /** Current reconnection attempt number (0 when not reconnecting). */
  readonly reconnectAttempt: number;
  /** Maximum reconnection attempts configured. */
  readonly maxReconnectAttempts: number;
  /** Last error message, if status is "error" or "reconnecting". */
  readonly error?: string;
  /** Server-provided instructions (from client.getInstructions() after connect). */
  readonly instructions?: string;
  /** Server capabilities object (from client.getServerCapabilities() after connect). */
  readonly capabilities?: Record<string, unknown>;
  /** Server info object (from client.getServerVersion() after connect). */
  readonly serverInfo?: { name: string; version: string };
  /** Connection generation counter -- increments on each reconnection. */
  readonly generation: number;
}

/** A tool definition discovered from an MCP server. */
export interface McpToolDefinition {
  /** Original tool name as reported by the server. */
  readonly name: string;
  /** Qualified name: "mcp:{serverName}/{toolName}" to avoid collisions. */
  readonly qualifiedName: string;
  /** Human-readable description, if provided. */
  readonly description?: string;
  /** JSON Schema describing input parameters. */
  readonly inputSchema: Record<string, unknown>;
}

/** Result of calling an MCP tool. */
export interface McpToolCallResult {
  /** Content items returned by the tool. */
  readonly content: McpToolCallContent[];
  /** Whether the tool call resulted in an error. */
  readonly isError: boolean;
}

/** A content item from an MCP tool call result. */
export interface McpToolCallContent {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

/** Dependencies for the MCP client manager. */
export interface McpClientManagerDeps {
  readonly logger: {
    info(msg: string, ...args: unknown[]): void;
    info(obj: Record<string, unknown>, msg: string): void;
    warn(msg: string, ...args: unknown[]): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(msg: string, ...args: unknown[]): void;
    error(obj: Record<string, unknown>, msg: string): void;
    debug?(msg: string, ...args: unknown[]): void;
    debug?(obj: Record<string, unknown>, msg: string): void;
  };
  /** Interval for health checks in milliseconds. 0 disables health checks. */
  readonly healthCheckIntervalMs?: number;
  /** Timeout for connect + listTools in milliseconds (default: 30000). */
  readonly connectTimeoutMs?: number;
  /** Timeout for individual callTool invocations in milliseconds (default: 60000). */
  readonly callToolTimeoutMs?: number;
  /** Optional EventBus for emitting connection lifecycle events. */
  readonly eventBus?: TypedEventBus;
  /** Reconnection options (default: 5 attempts, 1s-30s backoff). */
  readonly reconnectOptions?: Partial<McpReconnectOptions>;
  /** Default max concurrent tool calls for stdio servers (default: 1). */
  readonly stdioDefaultConcurrency?: number;
  /** Default max concurrent tool calls for HTTP/SSE servers (default: 4). */
  readonly httpDefaultConcurrency?: number;
}

/** MCP Client Manager: manages connections to MCP servers and their tools. */
export interface McpClientManager {
  /** Connect to an MCP server and discover its tools. */
  connect(config: McpServerConfig): Promise<Result<McpConnection, Error>>;
  /** Disconnect a named server. */
  disconnect(name: string): Promise<void>;
  /** Disconnect all servers. */
  disconnectAll(): Promise<void>;
  /** Get a connection by server name. */
  getConnection(name: string): McpConnection | undefined;
  /** Get all active connections. */
  getAllConnections(): McpConnection[];
  /** Get all tools from all connected servers. */
  getTools(): McpToolDefinition[];
  /** Call a tool by its qualified name ("mcp:{server}/{tool}"). */
  callTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<Result<McpToolCallResult, Error>>;
  /** Reconnect a named server using its stored config. */
  reconnect(name: string): Promise<Result<McpConnection, Error>>;
}

// ---------------------------------------------------------------------------
// Closure-state interface (Phase 43 split per FILE-SPLIT-11 + WARNING ISSUE-06)
// ---------------------------------------------------------------------------

/**
 * Resolved options shape — defaults applied at factory construction.
 *
 * The factory body resolves all McpClientManagerDeps defaults (connect
 * timeout, callTool timeout, concurrency caps, reconnect options) ONCE
 * at construction time. Helpers read these via state.options instead of
 * re-resolving deps.* each call (matches pre-split behavior).
 */
export interface McpClientManagerOptions {
  readonly connectTimeoutMs: number;
  readonly callToolTimeoutMs: number;
  readonly stdioDefaultConcurrency: number;
  readonly httpDefaultConcurrency: number;
  readonly reconnectOpts: McpReconnectOptions;
}

/**
 * Closure-captured state shape for the mcp-client manager. Phase 43 split
 * (FILE-SPLIT-11) extracts the createMcpClientManager factory closure body
 * into per-concern leaves; each leaf takes `state: McpClientManagerState`
 * as its first parameter (state-first protocol; matches Phase 42
 * pi-executor and Phase 43 telegram-adapter).
 *
 * The 7-Map/Set surface area (vs RESEARCH's 3-variable estimate) was
 * discovered when reading the live createMcpClientManager body (lines
 * 217-1047 of the pre-split mcp-client.ts) per Task 2 Step 1 of
 * 43-02c-PLAN.md — the closure scales beyond RESEARCH's initial estimate
 * but the state-first protocol scales identically.
 *
 * @internal — not exported from the package barrel; only consumed by
 * sibling leaves within mcp-client/.
 */
export interface McpClientManagerState {
  /** server-name -> live connection (mutated by connect/disconnect/reconnect/handleDisconnection/reconnectionLoop/callTool). */
  readonly connections: Map<string, McpConnection>;
  /** server-name -> AbortController for in-flight reconnection loops. */
  readonly reconnectionAbortControllers: Map<string, AbortController>;
  /** server-name set marking user-initiated disconnects (suppresses auto-reconnect). */
  readonly userDisconnectedFlags: Set<string>;
  /** server-name -> original McpServerConfig (needed to re-create transport on reconnect). */
  readonly serverConfigs: Map<string, McpServerConfig>;
  /** server-name -> generation counter (increments on each reconnect; used for stale-call detection). */
  readonly generations: Map<string, number>;
  /** server-name -> PQueue serializing tool calls to respect server concurrency limits. */
  readonly callQueues: Map<string, PQueue>;
  /** server-name -> consecutive onerror count (absorbed below threshold, triggers reconnect at threshold). */
  readonly consecutiveErrors: Map<string, number>;
  /** Resolved options (timeouts, defaults, reconnect opts) computed once at construction time. */
  readonly options: McpClientManagerOptions;
}
