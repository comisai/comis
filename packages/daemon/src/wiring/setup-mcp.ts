/**
 * MCP server connection setup: reads integrations.mcp.servers from config,
 * creates an McpClientManager, and connects to each enabled server.
 * Non-fatal: connection failures are logged as WARN and do not prevent
 * daemon startup. Tools from successfully connected servers are still
 * available to agents.
 * @module
 */

import type { McpServerEntry, TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { createMcpClientManager, type McpClientManager, type McpServerConfig } from "@comis/skills";

// ---------------------------------------------------------------------------
// Deps / Result types
// ---------------------------------------------------------------------------

/** Dependencies for MCP server setup. */
export interface McpDeps {
  /** MCP server entries from config (integrations.mcp.servers). */
  readonly servers: readonly McpServerEntry[];
  /** Logger for MCP connection lifecycle. */
  readonly logger: ComisLogger;
  /** Timeout for individual MCP tool calls in milliseconds (default: 120000). */
  readonly callToolTimeoutMs?: number;
  /** Default working directory for stdio MCP servers (typically the workspace directory). Per-server cwd in config overrides this. */
  readonly defaultCwd?: string;
  /** EventBus for MCP connection lifecycle events. */
  readonly eventBus?: TypedEventBus;
  /** Default concurrent calls for stdio MCP servers (default: 1). */
  readonly stdioDefaultConcurrency?: number;
  /** Default concurrent calls for HTTP/SSE MCP servers (default: 4). */
  readonly httpDefaultConcurrency?: number;
}

/** Result of MCP server setup. */
export interface McpResult {
  /** The MCP client manager, or undefined if no servers configured. */
  readonly mcpClientManager: McpClientManager | undefined;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Connect to configured MCP servers and return the client manager.
 * Returns `{ mcpClientManager: undefined }` when no servers are configured
 * or all are disabled. Individual server connection failures are logged
 * but do not block the remaining servers or daemon startup.
 */
export async function setupMcp(deps: McpDeps): Promise<McpResult> {
  const { servers, logger } = deps;

  try {
    // Filter to enabled servers only, dedup by name (keep first occurrence)
    const seen = new Set<string>();
    const enabledServers = servers.filter((s) => {
      if (!s.enabled) return false;
      if (seen.has(s.name)) {
        logger.warn(
          { serverName: s.name, hint: "Remove duplicate entry from integrations.mcp.servers config", errorKind: "validation" as const },
          "Skipping duplicate MCP server name",
        );
        return false;
      }
      seen.add(s.name);
      return true;
    });

    if (enabledServers.length === 0) {
      logger.debug("No MCP servers configured or all disabled");
      return { mcpClientManager: undefined };
    }

    logger.info(
      { serverCount: enabledServers.length, serverNames: enabledServers.map((s) => s.name) },
      "Connecting to MCP servers",
    );

    const manager = createMcpClientManager({
      logger,
      callToolTimeoutMs: deps.callToolTimeoutMs,
      eventBus: deps.eventBus,
      stdioDefaultConcurrency: deps.stdioDefaultConcurrency,
      httpDefaultConcurrency: deps.httpDefaultConcurrency,
    });

    // Connect to all servers in parallel — failures are isolated per-server
    const results = await Promise.allSettled(
      enabledServers.map(async (server) => {
        if (server.transport === "sse") {
          logger.warn(
            {
              serverName: server.name,
              hint: 'Consider migrating transport from "sse" to "http" for Streamable HTTP servers. '
                    + 'Use "sse" only for legacy servers that require the Server-Sent Events protocol.',
              errorKind: "validation" as const,
            },
            'MCP server uses deprecated "sse" transport',
          );
        }
        if (server.transport === "stdio" && server.headers && Object.keys(server.headers).length > 0) {
          logger.warn(
            {
              serverName: server.name,
              hint: "Custom headers are ignored for stdio transport. Headers are only used with remote transports (sse, http).",
              errorKind: "validation" as const,
            },
            "Headers configured for stdio transport (ignored)",
          );
        }
        const cwd = server.cwd ?? deps.defaultCwd;
        const config: McpServerConfig = {
          name: server.name,
          transport: server.transport,
          command: server.command,
          args: server.args,
          url: server.url,
          env: server.env,
          headers: server.headers,
          ...(cwd ? { cwd } : {}),
          ...(server.maxConcurrency ? { maxConcurrency: server.maxConcurrency } : {}),
          enabled: true,
        };
        return { server, result: await manager.connect(config) };
      }),
    );

    let connectedCount = 0;
    let failedCount = 0;

    for (const settled of results) {
      if (settled.status === "rejected") {
        // Unexpected rejection (should not happen since connect returns Result, but defensive)
        failedCount++;
        logger.warn(
          {
            err: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
            hint: "Unexpected MCP connection error; check server configuration",
            errorKind: "dependency" as const,
          },
          "MCP server connection rejected unexpectedly",
        );
        continue;
      }

      const { server, result } = settled.value;
      if (result.ok) {
        connectedCount++;
        logger.info(
          {
            serverName: server.name,
            transport: server.transport,
            toolCount: result.value.tools.length,
            toolNames: result.value.tools.map((t) => t.name),
          },
          `MCP server "${server.name}" connected with ${result.value.tools.length} tool(s)`,
        );
      } else {
        failedCount++;
        logger.warn(
          {
            serverName: server.name,
            transport: server.transport,
            err: result.error.message,
            hint: `Check MCP server "${server.name}" configuration (command, args, url)`,
            errorKind: "dependency" as const,
          },
          `MCP server "${server.name}" connection failed`,
        );
      }
    }

    const totalTools = manager.getTools().length;
    logger.info(
      { connectedCount, failedCount, totalTools },
      `MCP setup complete: ${connectedCount} connected, ${failedCount} failed, ${totalTools} tool(s) available`,
    );

    return { mcpClientManager: connectedCount > 0 ? manager : undefined };
  } catch (error: unknown) {
    // Top-level safety net: MCP failures must NEVER crash the daemon
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        hint: "MCP subsystem failed to initialize; daemon continues without MCP tools",
        errorKind: "dependency" as const,
      },
      "MCP setup failed catastrophically",
    );
    return { mcpClientManager: undefined };
  }
}
