// SPDX-License-Identifier: Apache-2.0
/**
 * mcp-client public types + closure-state interface.
 *
 * The canonical public-API contract is preserved byte-identical so the
 * @comis/skills barrel re-exports stay byte-identical.
 *
 * Defines the closure-state shape (McpClientManagerState) used by the
 * state-first protocol across the mcp-client leaves.
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
// graph acyclic.

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
  /**
   * Operator-extension allowlist for the stdio child env scrub. Copied
   * verbatim from `config.integrations.mcp.safetyAllowedEnvKeys` by the
   * daemon RPC handler (`mcp-handlers.ts:McpConnect`); the field is
   * additive over the built-in `MCP_STDIO_BUILTIN_ENV_ALLOWLIST` and only
   * applies to the stdio transport. Undefined ⇒ built-in allowlist only.
   */
  readonly safetyAllowedEnvKeys?: readonly string[];
  /**
   * OSV malware check toggle. Copied from
   * `config.integrations.mcp.osvCheckEnabled` (default `true`) by the
   * daemon RPC handler. Set `false` in air-gapped deployments to skip
   * the pre-spawn api.osv.dev check entirely. Undefined ⇒ default `true`
   * applies at the call site.
   */
  readonly osvCheckEnabled?: boolean;
  /**
   * OSV cache TTL (ms). Copied from
   * `config.integrations.mcp.osvCacheTtlMs` (default 86_400_000 = 24h)
   * by the daemon RPC handler. Undefined ⇒ caller falls back to the 24h
   * default at the call site.
   */
  readonly osvCacheTtlMs?: number;
  /**
   * Per-server stdio rlimits override. Copied from the persisted
   * `McpServerEntrySchema.rlimits` by the daemon RPC handler. Applied
   * via `prlimit(1)` wrap on Linux when set; partial overrides accepted
   * (`{ cpu: 600 }` emits only `--cpu=600`). When unset → NO prlimit
   * wrap (existing env-only wrap retained). On macOS dev (prlimit
   * absent) → WARN once per daemon process + skip. Only applies to the
   * stdio transport. See mcp-client-discover.ts:wrapStdioCommand.
   */
  readonly rlimits?: {
    readonly as?: number;
    readonly nofile?: number;
    readonly cpu?: number;
  };
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
// Closure-state interface
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
 * Closure-captured state shape for the mcp-client manager. The
 * createMcpClientManager factory closure body is split into per-concern
 * leaves; each leaf takes `state: McpClientManagerState` as its first
 * parameter (state-first protocol).
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
