// SPDX-License-Identifier: Apache-2.0
// @allow-throw: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.
/**
 * Connection lifecycle helpers.
 *
 * State-first protocol: every helper that touches closure state takes
 * `state: McpClientManagerState` as its first parameter, followed by
 * `deps: McpClientManagerDeps`. Matches the pi-executor and
 * telegram-adapter conventions.
 *
 * Owns: connectServer, disconnectServer, disconnectAllServers,
 * reconnectServer, getConnection, getAllConnections. Tool discovery
 * helpers live in mcp-client-discover.ts; the reconnect engine
 * (handleDisconnection + reconnectionLoop) lives in
 * mcp-client-reconnect.ts.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err, withTimeout } from "@comis/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import PQueue from "p-queue";
import { systemNowMs, systemScheduleTimeout } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
  McpToolDefinition,
} from "./mcp-client-types.js";
import {
  createClient,
  createTransport,
  extractServerMetadata,
  wireStderrCapture,
} from "./mcp-client-discover.js";
import { qualifyToolName } from "./mcp-client-types.js";
import { wireClientLifecycleCallbacks } from "./mcp-client-reconnect.js";
import {
  osvMalwareCheck,
  extractMcpPackageName,
  DEFAULT_OSV_CACHE_DIR,
} from "./mcp-client-osv-check.js";

// ---------------------------------------------------------------------------
// connect (state-first)
// ---------------------------------------------------------------------------

export async function connectServer(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  config: McpServerConfig,
): Promise<Result<McpConnection, Error>> {
  const { logger } = deps;
  if (!config.enabled) {
    return err(new Error(`MCP server "${config.name}" is disabled`));
  }

  // Clear userDisconnected flag so reconnection works for new connections
  state.userDisconnectedFlags.delete(config.name);

  // Update status to connecting
  const existingConn = state.connections.get(config.name);
  if (existingConn) {
    // Already connected -- disconnect first
    await disconnectServer(state, deps, config.name);
  }

  try {
    // Phase 63 SAFETY-05/06: pre-spawn OSV malware check (stdio only).
    // Fires BEFORE createTransport so a malicious package's code never
    // runs. Per-server osvCheckEnabled defaults to Plan 01's `true`;
    // operators set `false` in air-gapped deployments. Unrecognized
    // commands (node /path/server.js, python3, /bin/sh) skip the check
    // with INFO log — no registry name to query. Per RESEARCH.md
    // §"Pattern 4" + Pitfall 4. The throw on malicious-verdict carries
    // a bracketed [osv_malware_detected] token for LLM self-correction;
    // the existing catch at line ~157 already maps to error-state via
    // errorKind: "dependency".
    if (
      config.transport === "stdio" &&
      config.command &&
      (config.osvCheckEnabled ?? true)
    ) {
      const pkg = extractMcpPackageName(config.command, config.args);
      if (pkg !== null) {
        const osvResult = await osvMalwareCheck(pkg.name, pkg.ecosystem, {
          cacheDir: DEFAULT_OSV_CACHE_DIR,
          ttlMs: config.osvCacheTtlMs ?? 86_400_000,
          logger,
        });
        if (osvResult.verdict === "malicious") {
          throw new Error(
            `[osv_malware_detected] MCP package "${pkg.name}" (ecosystem: ${pkg.ecosystem}) ` +
              `matches OSV malicious-packages advisory: ${osvResult.advisoryIds.join(", ")}. ` +
              `Hint: do NOT install this package; verify the server name with the publisher.`,
          );
        }
      } else {
        logger.info(
          {
            serverName: config.name,
            command: config.command,
            hint: "OSV check skipped — no known package manager detected (npx/uvx/pnpm)",
          },
          "MCP OSV malware check skipped (unknown command)",
        );
      }
    }

    // Create transport
    const transport = createTransport(config);

    // Wire stderr capture for stdio transports
    wireStderrCapture(deps, config, transport);

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
    const client = createClient(state, deps, config.name);
    await withTimeout(
      client.connect(transport),
      state.options.connectTimeoutMs,
      systemScheduleTimeout,
      `MCP server "${config.name}" connect`,
    );

    // Wire lifecycle callbacks for reconnection
    wireClientLifecycleCallbacks(state, deps, client, config.name);

    // Store config for reconnection
    state.serverConfigs.set(config.name, config);
    // Initialize generation
    state.generations.set(config.name, state.generations.get(config.name) ?? 0);

    // Extract server metadata
    const metadata = extractServerMetadata(client);

    if (metadata.instructions) {
      logger.debug?.({ serverName: config.name, instructionChars: metadata.instructions.length }, "MCP server provided instructions");
    }

    // Discover tools (with timeout)
    const listResult = await withTimeout(
      client.listTools(),
      state.options.connectTimeoutMs,
      systemScheduleTimeout,
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
      lastHealthCheck: systemNowMs(),
      reconnectAttempt: 0,
      maxReconnectAttempts: state.options.reconnectOpts.maxAttempts,
      generation: state.generations.get(config.name) ?? 0,
      instructions: metadata.instructions,
      capabilities: metadata.capabilities,
      serverInfo: metadata.serverInfo,
    };

    state.connections.set(config.name, connection);

    // Create per-server call concurrency queue
    const maxConcurrency = config.maxConcurrency
      ?? (config.transport === "stdio" ? state.options.stdioDefaultConcurrency : state.options.httpDefaultConcurrency);
    state.callQueues.set(config.name, new PQueue({ concurrency: maxConcurrency }));

    logger.info(`MCP server "${config.name}" connected: ${tools.length} tool(s) discovered`);

    return ok(connection);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    // Store error state
    state.connections.set(config.name, {
      name: config.name,
      client: null as unknown as Client,
      status: "error",
      tools: [],
      lastHealthCheck: systemNowMs(),
      reconnectAttempt: 0,
      maxReconnectAttempts: state.options.reconnectOpts.maxAttempts,
      error: message,
      generation: state.generations.get(config.name) ?? 0,
    });

    logger.error({ serverName: config.name, err: message, hint: "Check MCP server configuration and ensure the server process is running", errorKind: "dependency" as const }, "MCP server connection failed");

    return err(error instanceof Error ? error : new Error(message));
  }
}

// ---------------------------------------------------------------------------
// disconnect (state-first)
// ---------------------------------------------------------------------------

export async function disconnectServer(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  name: string,
): Promise<void> {
  const { logger } = deps;
  // Set user-disconnected flag to prevent reconnection
  state.userDisconnectedFlags.add(name);

  // Abort any in-flight reconnection
  const ac = state.reconnectionAbortControllers.get(name);
  if (ac) {
    ac.abort();
    state.reconnectionAbortControllers.delete(name);
  }

  const conn = state.connections.get(name);
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
  const callQueue = state.callQueues.get(name);
  if (callQueue) {
    callQueue.clear();
    state.callQueues.delete(name);
  }

  state.connections.delete(name);
  state.serverConfigs.delete(name);
  // Keep generations (in case user reconnects later, generation keeps incrementing)
  logger.info(`MCP server "${name}" disconnected`);
}

// ---------------------------------------------------------------------------
// disconnectAll (state-first)
// ---------------------------------------------------------------------------

export async function disconnectAllServers(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
): Promise<void> {
  const names = [...state.connections.keys()];
  for (const name of names) {
    await disconnectServer(state, deps, name);
  }
  // Clear any remaining abort controllers
  for (const [, ac] of state.reconnectionAbortControllers) {
    ac.abort();
  }
  state.reconnectionAbortControllers.clear();
}

// ---------------------------------------------------------------------------
// Connection getters (state-first)
// ---------------------------------------------------------------------------

export function getConnection(
  state: McpClientManagerState,
  name: string,
): McpConnection | undefined {
  return state.connections.get(name);
}

export function getAllConnections(state: McpClientManagerState): McpConnection[] {
  return [...state.connections.values()];
}

// ---------------------------------------------------------------------------
// reconnect (state-first; uses stored config)
// ---------------------------------------------------------------------------

export async function reconnectServer(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  name: string,
): Promise<Result<McpConnection, Error>> {
  const storedConfig = state.serverConfigs.get(name);
  if (!storedConfig) {
    return err(new Error(`MCP server "${name}" has no stored config -- use connect() instead`));
  }
  await disconnectServer(state, deps, name);
  return connectServer(state, deps, storedConfig);
}
