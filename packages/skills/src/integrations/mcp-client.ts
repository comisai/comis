/**
 * MCP Client Manager: Connects to external Model Context Protocol servers
 * and discovers their tools for use by the Comis agent.
 *
 * Manages connection lifecycle (connect/disconnect), tool discovery via
 * listTools(), tool invocation via callTool(), and automatic reconnection
 * with exponential backoff on involuntary disconnects. Each tool is qualified
 * with its server name ("mcp:{server}/{tool}") to avoid collisions.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { TypedEventBus } from "@comis/core";
import { ok, err, withTimeout } from "@comis/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import PQueue from "p-queue";

// ---------------------------------------------------------------------------
// Types
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
// Qualified name helpers
// ---------------------------------------------------------------------------

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
// Constants
// ---------------------------------------------------------------------------

/** Maximum character length for server instructions to prevent preamble budget issues. */
const MAX_INSTRUCTIONS_CHARS = 4096;
const INSTRUCTIONS_TRUNCATED_SUFFIX = " [truncated]";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP client manager that handles connection lifecycle,
 * tool discovery, tool invocation, and automatic reconnection for external MCP servers.
 */
export function createMcpClientManager(deps: McpClientManagerDeps): McpClientManager {
  const { logger } = deps;
  const connectTimeoutMs = deps.connectTimeoutMs ?? 30_000;
  const callToolTimeoutMs = deps.callToolTimeoutMs ?? 60_000;
  const stdioDefaultConcurrency = deps.stdioDefaultConcurrency ?? 1;
  const httpDefaultConcurrency = deps.httpDefaultConcurrency ?? 4;

  // Reconnection options with defaults
  const reconnectOpts: McpReconnectOptions = {
    maxAttempts: deps.reconnectOptions?.maxAttempts ?? 5,
    initialDelayMs: deps.reconnectOptions?.initialDelayMs ?? 1000,
    maxDelayMs: deps.reconnectOptions?.maxDelayMs ?? 30_000,
    growFactor: deps.reconnectOptions?.growFactor ?? 2,
  };

  // Mutable connection state
  const connections = new Map<string, McpConnection>();

  // Per-server reconnection state
  const reconnectionAbortControllers = new Map<string, AbortController>();
  const userDisconnectedFlags = new Set<string>();
  // Store original config for reconnection (needed to re-create transport)
  const serverConfigs = new Map<string, McpServerConfig>();
  // Generation counter per server for stale-connection detection
  const generations = new Map<string, number>();
  /** Per-server PQueue for serializing tool calls to respect server concurrency limits. */
  const callQueues = new Map<string, PQueue>();
  /** Consecutive onerror count per server — only reconnect after threshold (absorb transient parse errors). */
  const consecutiveErrors = new Map<string, number>();
  const MAX_ERRORS_BEFORE_RECONNECT = 3;

  // -----------------------------------------------------------------------
  // Backoff calculation helper
  // -----------------------------------------------------------------------

  function calculateBackoff(attempt: number): number {
    const delay = Math.min(
      reconnectOpts.initialDelayMs * Math.pow(reconnectOpts.growFactor, attempt),
      reconnectOpts.maxDelayMs,
    );
    // Add 10-30% jitter
    const jitter = delay * (0.1 + Math.random() * 0.2);
    return Math.round(delay + jitter);
  }

  // -----------------------------------------------------------------------
  // Transport creation helper
  // -----------------------------------------------------------------------

  /**
   * Wrap a stdio command so the child Node process (if any) does NOT inherit
   * the daemon's --permission flags via NODE_OPTIONS.
   *
   * Node 22's permission model propagates by setting NODE_OPTIONS on spawned
   * children, even when the caller passes an override env. Unsetting
   * NODE_OPTIONS via `env -u NODE_OPTIONS <cmd>` is the only mechanism that
   * clears it before the child Node process reads it at startup.
   *
   * Non-Node MCP servers (uvx, Python, etc.) are unaffected by NODE_OPTIONS
   * but still go through the wrapper for uniformity — `env -u` on a missing
   * var is a no-op. Linux-only production target (per CLAUDE.md); macOS and
   * WSL both have `/usr/bin/env` with `-u` support.
   *
   * See COMIS-E2E-FOLLOWUP-DESIGN.md Issue 2 for the empirical rationale.
   */
  function wrapStdioCommand(
    command: string,
    args: readonly string[] | undefined,
  ): { command: string; args: string[] } {
    return {
      command: "/usr/bin/env",
      args: ["-u", "NODE_OPTIONS", command, ...(args ?? [])],
    };
  }

  function createTransport(config: McpServerConfig) {
    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP server "${config.name}": stdio transport requires "command"`);
      }
      const wrapped = wrapStdioCommand(config.command, config.args);
      return new StdioClientTransport({
        command: wrapped.command,
        args: wrapped.args,
        stderr: "pipe",  // capture stderr for debugging
        ...(config.env ? { env: { ...process.env, ...config.env } as Record<string, string> } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
      });
    } else if (config.transport === "sse") {
      if (!config.url) {
        throw new Error(`MCP server "${config.name}": sse transport requires "url"`);
      }
      return new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers
          ? { headers: config.headers }
          : undefined,
      });
    } else if (config.transport === "http") {
      if (!config.url) {
        throw new Error(`MCP server "${config.name}": http transport requires "url"`);
      }
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers
          ? { headers: config.headers }
          : undefined,
      });
    }
    throw new Error(`MCP server "${config.name}": unsupported transport "${config.transport as string}"`);
  }

  // -----------------------------------------------------------------------
  // MCP Client creation helper (with listChanged handler)
  // -----------------------------------------------------------------------

  function createClient(serverName: string) {
    return new Client(
      { name: "comis", version: "1.0.0" },
      {
        capabilities: {},
        ...(deps.eventBus ? {
          listChanged: {
            tools: {
              onChanged: (listChangeError, newToolList) => {
                if (listChangeError) {
                  logger.warn(
                    { serverName, err: listChangeError.message, hint: "MCP server tool list refresh failed", errorKind: "dependency" as const },
                    "tools/list_changed refresh failed",
                  );
                  return;
                }
                const conn = connections.get(serverName);
                if (!conn || conn.status !== "connected") return;

                const previousTools = conn.tools;
                const newTools: McpToolDefinition[] = (newToolList ?? []).map((tool) => ({
                  name: tool.name,
                  qualifiedName: qualifyToolName(serverName, tool.name),
                  description: tool.description,
                  inputSchema: tool.inputSchema as Record<string, unknown>,
                }));

                connections.set(serverName, {
                  ...conn,
                  tools: newTools,
                  lastHealthCheck: Date.now(),
                });

                const previousNames = new Set(previousTools.map(t => t.name));
                const currentNames = new Set(newTools.map(t => t.name));
                const addedTools = newTools.filter(t => !previousNames.has(t.name)).map(t => t.name);
                const removedTools = previousTools.filter(t => !currentNames.has(t.name)).map(t => t.name);

                deps.eventBus!.emit("mcp:server:tools_changed", {
                  serverName,
                  previousToolCount: previousTools.length,
                  currentToolCount: newTools.length,
                  addedTools,
                  removedTools,
                  timestamp: Date.now(),
                });

                logger.info(
                  { serverName, previousCount: previousTools.length, currentCount: newTools.length, added: addedTools, removed: removedTools },
                  "MCP server tool list changed",
                );
              },
            },
          },
        } : {}),
      },
    );
  }

  // -----------------------------------------------------------------------
  // Server metadata extraction helper
  // -----------------------------------------------------------------------

  function extractServerMetadata(client: Client) {
    const instructions = client.getInstructions();
    const serverCaps = client.getServerCapabilities();
    const serverImpl = client.getServerVersion();

    const capabilities = serverCaps ? (serverCaps as Record<string, unknown>) : undefined;
    const serverInfo = serverImpl ? { name: serverImpl.name, version: serverImpl.version } : undefined;

    // Cap instructions to prevent preamble budget issues
    const cappedInstructions = instructions && instructions.length > MAX_INSTRUCTIONS_CHARS
      ? instructions.slice(0, MAX_INSTRUCTIONS_CHARS - INSTRUCTIONS_TRUNCATED_SUFFIX.length) + INSTRUCTIONS_TRUNCATED_SUFFIX
      : instructions;

    return { instructions: cappedInstructions, capabilities, serverInfo };
  }

  // -----------------------------------------------------------------------
  // Stdio stderr capture helper
  // -----------------------------------------------------------------------

  function wireStderrCapture(config: McpServerConfig, transport: ReturnType<typeof createTransport>): void {
    if (config.transport !== "stdio") return;
    const stdioTransport = transport as { stderr?: NodeJS.ReadableStream };
    if (!stdioTransport.stderr) return;

    const MAX_STDERR_BYTES = 64 * 1024; // 64KB cap
    let stderrBuffer = "";
    let stderrOverflowed = false;

    stdioTransport.stderr.on("data", (chunk: Buffer) => {
      if (stderrOverflowed) return;
      const text = chunk.toString("utf-8");
      if (stderrBuffer.length + text.length > MAX_STDERR_BYTES) {
        stderrBuffer += text.slice(0, MAX_STDERR_BYTES - stderrBuffer.length);
        stderrOverflowed = true;
        logger.warn(
          { serverName: config.name, hint: "MCP server stderr output exceeded 64KB cap", errorKind: "resource" as const },
          "MCP server stderr truncated at 64KB",
        );
      } else {
        stderrBuffer += text;
      }
      // Log each stderr line at DEBUG level for real-time visibility
      for (const line of text.split("\n").filter(Boolean)) {
        logger.debug?.({ serverName: config.name, stderr: line }, "MCP server stderr");
      }
    });

    // On transport close, log accumulated stderr at WARN if non-empty
    stdioTransport.stderr.on("end", () => {
      if (stderrBuffer.trim()) {
        logger.warn(
          { serverName: config.name, stderrLength: stderrBuffer.length, truncated: stderrOverflowed, hint: "Review stderr output for crash diagnostics", errorKind: "dependency" as const },
          "MCP stdio server stderr captured",
        );
        logger.info(
          { serverName: config.name, stderr: stderrBuffer.trim() },
          "MCP stdio server stderr output",
        );
      }
    });
  }

  // -----------------------------------------------------------------------
  // Reconnection handler
  // -----------------------------------------------------------------------

  function handleDisconnection(serverName: string, reason: "transport_closed" | "transport_error" | "client_closed" | "client_error"): void {
    // Emit disconnected event
    deps.eventBus?.emit("mcp:server:disconnected", {
      serverName,
      reason,
      timestamp: Date.now(),
    });

    // If user explicitly disconnected, skip reconnection
    if (userDisconnectedFlags.has(serverName)) {
      return;
    }

    // If already reconnecting, skip (prevents duplicate loops)
    const currentConn = connections.get(serverName);
    if (currentConn?.status === "reconnecting") {
      return;
    }

    // Abort any previous reconnection for this server
    const existingAc = reconnectionAbortControllers.get(serverName);
    if (existingAc) {
      existingAc.abort();
      reconnectionAbortControllers.delete(serverName);
    }

    const ac = new AbortController();
    reconnectionAbortControllers.set(serverName, ac);

    // Update status to reconnecting
    if (currentConn) {
      connections.set(serverName, {
        ...currentConn,
        status: "reconnecting",
        reconnectAttempt: 0,
      });
    }

    // Fire-and-forget reconnection loop (errors handled internally)
    void reconnectionLoop(serverName, ac.signal);
  }

  async function reconnectionLoop(serverName: string, signal: AbortSignal): Promise<void> {
    const config = serverConfigs.get(serverName);
    if (!config) return;

    let lastError = "";
    const startTime = Date.now();

    for (let attempt = 0; attempt < reconnectOpts.maxAttempts; attempt++) {
      if (signal.aborted) return;

      const delayMs = calculateBackoff(attempt);

      // Emit reconnecting event
      deps.eventBus?.emit("mcp:server:reconnecting", {
        serverName,
        attempt: attempt + 1,
        maxAttempts: reconnectOpts.maxAttempts,
        nextDelayMs: delayMs,
        timestamp: Date.now(),
      });

      // Update attempt counter on connection
      const conn = connections.get(serverName);
      if (conn) {
        connections.set(serverName, {
          ...conn,
          reconnectAttempt: attempt + 1,
        });
      }

      // Wait for backoff delay (abort-aware)
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return; }
        const timer = setTimeout(resolve, delayMs);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        signal.addEventListener("abort", onAbort, { once: true });
      });

      if (signal.aborted) return;

      try {
        // Increment generation counter
        generations.set(serverName, (generations.get(serverName) ?? 0) + 1);

        // Create new transport and client
        const transport = createTransport(config);
        // Wire stderr capture for stdio re-spawns
        wireStderrCapture(config, transport);
        const client = createClient(serverName);

        await withTimeout(
          client.connect(transport),
          connectTimeoutMs,
          `MCP server "${serverName}" reconnect`,
        );

        // Discover tools
        const listResult = await withTimeout(
          client.listTools(),
          connectTimeoutMs,
          `MCP server "${serverName}" listTools`,
        );
        const tools: McpToolDefinition[] = listResult.tools.map((tool) => ({
          name: tool.name,
          qualifiedName: qualifyToolName(serverName, tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        }));

        // Wire lifecycle callbacks for reconnection
        client.onclose = () => {
          consecutiveErrors.set(serverName, 0);
          handleDisconnection(serverName, "client_closed");
        };
        client.onerror = (error: Error) => {
          const count = (consecutiveErrors.get(serverName) ?? 0) + 1;
          consecutiveErrors.set(serverName, count);
          if (count >= MAX_ERRORS_BEFORE_RECONNECT) {
            logger.warn(
              { serverName, err: error.message, consecutiveErrors: count, hint: "MCP client reported repeated errors; reconnection will be attempted", errorKind: "dependency" as const },
              "MCP client error",
            );
            consecutiveErrors.set(serverName, 0);
            handleDisconnection(serverName, "client_error");
          } else {
            logger.debug?.(
              { serverName, err: error.message, consecutiveErrors: count, threshold: MAX_ERRORS_BEFORE_RECONNECT },
              "MCP client transient error (absorbing)",
            );
          }
        };

        // Fetch server metadata
        const metadata = extractServerMetadata(client);

        if (metadata.instructions) {
          logger.debug?.({ serverName, instructionChars: metadata.instructions.length }, "MCP server provided instructions");
        }

        // Atomically update connection
        const newConnection: McpConnection = {
          name: serverName,
          client,
          status: "connected",
          tools,
          lastHealthCheck: Date.now(),
          reconnectAttempt: 0,
          maxReconnectAttempts: reconnectOpts.maxAttempts,
          generation: generations.get(serverName) ?? 0,
          instructions: metadata.instructions,
          capabilities: metadata.capabilities,
          serverInfo: metadata.serverInfo,
        };
        connections.set(serverName, newConnection);

        // Emit reconnected event
        deps.eventBus?.emit("mcp:server:reconnected", {
          serverName,
          attempt: attempt + 1,
          toolCount: tools.length,
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
        });

        logger.info(
          { serverName, attempt: attempt + 1, toolCount: tools.length, generation: generations.get(serverName) },
          "MCP server reconnected",
        );

        // Clean up abort controller
        reconnectionAbortControllers.delete(serverName);
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
        logger.debug?.({ serverName, attempt: attempt + 1, err: lastError }, "MCP reconnection attempt failed");
      }
    }

    // All attempts exhausted
    const truncatedError = lastError.length > 500 ? lastError.slice(0, 500) : lastError;
    const conn = connections.get(serverName);
    if (conn) {
      connections.set(serverName, {
        ...conn,
        status: "error",
        reconnectAttempt: 0,
        error: truncatedError,
      });
    }

    deps.eventBus?.emit("mcp:server:reconnect_failed", {
      serverName,
      attempts: reconnectOpts.maxAttempts,
      lastError: truncatedError,
      timestamp: Date.now(),
    });

    logger.error(
      { serverName, attempts: reconnectOpts.maxAttempts, err: truncatedError, hint: "MCP server reconnection exhausted; manual intervention may be needed", errorKind: "dependency" as const },
      "MCP server reconnection failed",
    );

    reconnectionAbortControllers.delete(serverName);
  }

  // -----------------------------------------------------------------------
  // connect
  // -----------------------------------------------------------------------

  async function connect(config: McpServerConfig): Promise<Result<McpConnection, Error>> {
    if (!config.enabled) {
      return err(new Error(`MCP server "${config.name}" is disabled`));
    }

    // Clear userDisconnected flag so reconnection works for new connections
    userDisconnectedFlags.delete(config.name);

    // Update status to connecting
    const existingConn = connections.get(config.name);
    if (existingConn) {
      // Already connected -- disconnect first
      await disconnect(config.name);
    }

    try {
      // Create transport
      const transport = createTransport(config);

      // Wire stderr capture for stdio transports
      wireStderrCapture(config, transport);

      // Log transport type at INFO
      if (config.transport === "stdio") {
        logger.info(
          { serverName: config.name, command: config.command, args: config.args, cwd: config.cwd },
          "Spawning MCP server process",
        );
      } else if (config.transport === "sse") {
        logger.info(
          { serverName: config.name, url: config.url },
          "Connecting to MCP server via legacy SSE",
        );
      } else if (config.transport === "http") {
        logger.info(
          { serverName: config.name, url: config.url },
          "Connecting to MCP server via Streamable HTTP",
        );
      }

      // Log header names (never values) when headers are present
      if (config.headers && Object.keys(config.headers).length > 0) {
        logger.debug?.({ serverName: config.name, headerKeys: Object.keys(config.headers) }, "Custom headers configured");
      }

      // Create client and connect (with timeout)
      const client = createClient(config.name);
      await withTimeout(
        client.connect(transport),
        connectTimeoutMs,
        `MCP server "${config.name}" connect`,
      );

      // Wire lifecycle callbacks for reconnection
      client.onclose = () => {
        consecutiveErrors.set(config.name, 0);
        handleDisconnection(config.name, "client_closed");
      };
      client.onerror = (error: Error) => {
        const count = (consecutiveErrors.get(config.name) ?? 0) + 1;
        consecutiveErrors.set(config.name, count);
        if (count >= MAX_ERRORS_BEFORE_RECONNECT) {
          logger.warn(
            { serverName: config.name, err: error.message, consecutiveErrors: count, hint: "MCP client reported repeated errors; reconnection will be attempted", errorKind: "dependency" as const },
            "MCP client error",
          );
          consecutiveErrors.set(config.name, 0);
          handleDisconnection(config.name, "client_error");
        } else {
          logger.debug?.(
            { serverName: config.name, err: error.message, consecutiveErrors: count, threshold: MAX_ERRORS_BEFORE_RECONNECT },
            "MCP client transient error (absorbing)",
          );
        }
      };

      // Store config for reconnection
      serverConfigs.set(config.name, config);
      // Initialize generation
      generations.set(config.name, generations.get(config.name) ?? 0);

      // Extract server metadata
      const metadata = extractServerMetadata(client);

      if (metadata.instructions) {
        logger.debug?.({ serverName: config.name, instructionChars: metadata.instructions.length }, "MCP server provided instructions");
      }

      // Discover tools (with timeout)
      const listResult = await withTimeout(
        client.listTools(),
        connectTimeoutMs,
        `MCP server "${config.name}" listTools`,
      );
      const tools: McpToolDefinition[] = listResult.tools.map((tool) => ({
        name: tool.name,
        qualifiedName: qualifyToolName(config.name, tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));

      const connection: McpConnection = {
        name: config.name,
        client,
        status: "connected",
        tools,
        lastHealthCheck: Date.now(),
        reconnectAttempt: 0,
        maxReconnectAttempts: reconnectOpts.maxAttempts,
        generation: generations.get(config.name) ?? 0,
        instructions: metadata.instructions,
        capabilities: metadata.capabilities,
        serverInfo: metadata.serverInfo,
      };

      connections.set(config.name, connection);

      // Create per-server call concurrency queue
      const maxConcurrency = config.maxConcurrency
        ?? (config.transport === "stdio" ? stdioDefaultConcurrency : httpDefaultConcurrency);
      callQueues.set(config.name, new PQueue({ concurrency: maxConcurrency }));

      logger.info(`MCP server "${config.name}" connected: ${tools.length} tool(s) discovered`);

      return ok(connection);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      // Store error state
      connections.set(config.name, {
        name: config.name,
        client: null as unknown as Client,
        status: "error",
        tools: [],
        lastHealthCheck: Date.now(),
        reconnectAttempt: 0,
        maxReconnectAttempts: reconnectOpts.maxAttempts,
        error: message,
        generation: generations.get(config.name) ?? 0,
      });

      logger.error({ serverName: config.name, err: message, hint: "Check MCP server configuration and ensure the server process is running", errorKind: "dependency" as const }, "MCP server connection failed");

      return err(error instanceof Error ? error : new Error(message));
    }
  }

  // -----------------------------------------------------------------------
  // disconnect
  // -----------------------------------------------------------------------

  async function disconnect(name: string): Promise<void> {
    // Set user-disconnected flag to prevent reconnection
    userDisconnectedFlags.add(name);

    // Abort any in-flight reconnection
    const ac = reconnectionAbortControllers.get(name);
    if (ac) {
      ac.abort();
      reconnectionAbortControllers.delete(name);
    }

    const conn = connections.get(name);
    if (!conn) return;

    try {
      if (conn.client && conn.status === "connected") {
        await conn.client.close();
      }
    } catch (error: unknown) {
      logger.warn({ serverName: name, err: error instanceof Error ? error.message : String(error), hint: "MCP server disconnect failed; connection may be stale", errorKind: "dependency" as const }, "MCP server disconnect failed");
    }

    // Clear and remove call queue -- pending .add() callers get no resolution
    // but that's acceptable since the connection is gone anyway
    const callQueue = callQueues.get(name);
    if (callQueue) {
      callQueue.clear();
      callQueues.delete(name);
    }

    connections.delete(name);
    serverConfigs.delete(name);
    // Keep generations (in case user reconnects later, generation keeps incrementing)
    logger.info(`MCP server "${name}" disconnected`);
  }

  // -----------------------------------------------------------------------
  // disconnectAll
  // -----------------------------------------------------------------------

  async function disconnectAll(): Promise<void> {
    const names = [...connections.keys()];
    for (const name of names) {
      await disconnect(name);
    }
    // Clear any remaining abort controllers
    for (const [, ac] of reconnectionAbortControllers) {
      ac.abort();
    }
    reconnectionAbortControllers.clear();
  }

  // -----------------------------------------------------------------------
  // getters
  // -----------------------------------------------------------------------

  function getConnection(name: string): McpConnection | undefined {
    return connections.get(name);
  }

  function getAllConnections(): McpConnection[] {
    return [...connections.values()];
  }

  function getTools(): McpToolDefinition[] {
    const allTools: McpToolDefinition[] = [];
    for (const conn of connections.values()) {
      if (conn.status === "connected") {
        allTools.push(...conn.tools);
      }
    }
    return allTools;
  }

  // -----------------------------------------------------------------------
  // callTool
  // -----------------------------------------------------------------------

  async function callTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<Result<McpToolCallResult, Error>> {
    const parsed = parseQualifiedName(qualifiedName);
    if (!parsed) {
      return err(new Error(`Invalid MCP tool qualified name: "${qualifiedName}"`));
    }

    const { serverName, toolName } = parsed;
    const conn = connections.get(serverName);

    if (!conn) {
      return err(new Error(`MCP server "${serverName}" not connected`));
    }

    if (conn.status !== "connected") {
      return err(
        new Error(`MCP server "${serverName}" is ${conn.status}, cannot call tool "${toolName}"`),
      );
    }

    // Serialize through per-server concurrency queue
    const queue = callQueues.get(serverName);
    if (!queue) {
      return err(new Error(`MCP server "${serverName}" has no call queue (not connected via connect())`));
    }

    return queue.add(async () => {
      // Re-check connection status -- may have changed while queued
      const currentConn = connections.get(serverName);
      if (!currentConn || currentConn.status !== "connected") {
        return err(new Error(
          `MCP server "${serverName}" disconnected while call to "${toolName}" was queued`,
        ));
      }

      // Capture generation before call for stale-connection detection
      const callGeneration = currentConn.generation;

      try {
        const result = await currentConn.client.callTool(
          { name: toolName, arguments: args },
          undefined,
          { timeout: callToolTimeoutMs },
        );

        // Verify generation hasn't changed during the call (stale connection guard)
        const postCallConn = connections.get(serverName);
        if (!postCallConn || postCallConn.generation !== callGeneration) {
          return err(new Error(
            `MCP server "${serverName}" connection recycled during tool call (gen ${callGeneration} -> ${postCallConn?.generation ?? "gone"}). Retry safely.`,
          ));
        }

        // Map MCP SDK result to our McpToolCallResult
        const content: McpToolCallContent[] = [];
        if ("content" in result && Array.isArray(result.content)) {
          for (const item of result.content) {
            content.push({
              type: item.type,
              text: "text" in item ? (item.text as string) : undefined,
              data: "data" in item ? (item.data as string) : undefined,
              mimeType: "mimeType" in item ? (item.mimeType as string) : undefined,
            });
          }
        }

        // Successful tool call resets consecutive error counter
        consecutiveErrors.set(serverName, 0);

        return ok({
          content,
          isError: "isError" in result ? (result.isError as boolean) === true : false,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        // Detect session expiry BEFORE timeout check
        const isSessionExpired =
          (error instanceof StreamableHTTPError && error.code === 404) ||
          (error instanceof McpError && error.code === ErrorCode.RequestTimeout &&
           (error.message.toLowerCase().includes("session") || error.message.toLowerCase().includes("connection closed")));

        if (isSessionExpired) {
          logger.info(
            { serverName, toolName, err: message, hint: "Session expired; automatic reconnection will be attempted", errorKind: "dependency" as const },
            "MCP session expired, triggering reconnection",
          );
          handleDisconnection(serverName, "client_closed");
          return err(new Error(`MCP server "${serverName}" session expired during tool call "${toolName}". Reconnection initiated -- retry shortly.`));
        }

        const isTimeout =
          (error instanceof McpError && error.code === ErrorCode.RequestTimeout) ||
          (error instanceof Error && error.message.includes("timed out"));

        if (!isTimeout) {
          const latestConn = connections.get(serverName);
          if (latestConn) {
            connections.set(serverName, {
              ...latestConn,
              status: "error",
              lastHealthCheck: Date.now(),
            });
          }
        } else {
          logger.debug?.({ serverName, toolName }, "Tool call timed out, connection status preserved");
        }

        return err(error instanceof Error ? error : new Error(message));
      }
    }) as Promise<Result<McpToolCallResult, Error>>;
  }

  // -----------------------------------------------------------------------
  // reconnect (uses stored config)
  // -----------------------------------------------------------------------

  async function reconnect(name: string): Promise<Result<McpConnection, Error>> {
    const storedConfig = serverConfigs.get(name);
    if (!storedConfig) {
      return err(new Error(`MCP server "${name}" has no stored config -- use connect() instead`));
    }
    await disconnect(name);
    return connect(storedConfig);
  }

  // -----------------------------------------------------------------------
  // Return public interface
  // -----------------------------------------------------------------------

  return {
    connect,
    disconnect,
    disconnectAll,
    getConnection,
    getAllConnections,
    getTools,
    callTool,
    reconnect,
  };
}
