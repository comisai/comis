// SPDX-License-Identifier: Apache-2.0
/**
 * MCP server connection setup: reads integrations.mcp.servers from config,
 * creates an McpClientManager, and connects to each enabled server.
 * Non-fatal: connection failures are logged as WARN and do not prevent
 * daemon startup. Tools from successfully connected servers are still
 * available to agents.
 * @module
 */

import { mkdirSync } from "node:fs";
import { safePath } from "@comis/core";
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
  /**
   * The MCP client manager. Always defined — created unconditionally so
   * runtime `mcp.connect` RPCs work even when no servers were configured
   * at startup. The factory (`createMcpClientManager`) is a pure in-memory
   * state holder (Maps/Sets, no I/O), so constructing it is cheap and safe.
   */
  readonly mcpClientManager: McpClientManager;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Resolve the default cwd for a stdio MCP server when the config does
 * not specify `server.cwd` explicitly. Returns a per-server output
 * subdirectory `{workspaceDir}/output/{serverName}/` and ensures the
 * directory exists on disk with mode 0o700. Falls back to the
 * workspace root if directory creation fails (logged as WARN).
 *
 * `serverName` is already schema-validated against
 * `/^[a-zA-Z0-9_-]+$/` (schema-integrations.ts), so no runtime
 * sanitization is needed here.
 */
function resolveDefaultMcpCwd(
  workspaceDir: string | undefined,
  serverName: string,
  logger: ComisLogger,
): string | undefined {
  if (!workspaceDir) return undefined;
  let dir: string;
  try {
    // serverName is schema-validated to /^[a-zA-Z0-9_-]+$/ so safePath
    // won't reject it, but keep the guard for defense-in-depth.
    dir = safePath(workspaceDir, "output", serverName);
  } catch (err) {
    logger.warn(
      {
        serverName,
        err: err instanceof Error ? err.message : String(err),
        hint: "Falling back to workspace root cwd for MCP server",
        errorKind: "validation" as const,
      },
      "Rejected MCP server output dir path",
    );
    return workspaceDir;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch (err) {
    logger.warn(
      {
        serverName,
        dir,
        err: err instanceof Error ? err.message : String(err),
        hint: "Falling back to workspace root cwd for MCP server",
        errorKind: "io" as const,
      },
      "Failed to create MCP server output dir",
    );
    return workspaceDir;
  }
}

/**
 * Connect to configured MCP servers and return the client manager.
 * The manager is always returned (never undefined) so that runtime
 * `mcp.connect` / `.disconnect` / `.reconnect` / `.status` RPCs work
 * even when zero servers were configured at startup. Individual server
 * connection failures are logged but do not block the remaining servers
 * or daemon startup.
 */
export async function setupMcp(deps: McpDeps): Promise<McpResult> {
  const { servers, logger } = deps;

  // Always construct the manager. It's a pure in-memory state holder
  // (Maps/Sets + defaults, no I/O) — constructing it unconditionally lets
  // runtime `mcp.connect` RPCs succeed even when zero servers were
  // configured at startup. If this throws, it's a build/deploy defect,
  // not a runtime condition — re-raise so bootstrap surfaces the failure
  // loudly rather than masking it behind a nulled manager.
  const manager = createMcpClientManager({
    logger,
    callToolTimeoutMs: deps.callToolTimeoutMs,
    eventBus: deps.eventBus,
    stdioDefaultConcurrency: deps.stdioDefaultConcurrency,
    httpDefaultConcurrency: deps.httpDefaultConcurrency,
  });

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
      return { mcpClientManager: manager };
    }

    logger.info(
      { serverCount: enabledServers.length, serverNames: enabledServers.map((s) => s.name) },
      "Connecting to MCP servers",
    );

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
        const cwd = server.cwd ?? resolveDefaultMcpCwd(deps.defaultCwd, server.name, logger);
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

    return { mcpClientManager: manager };
  } catch (error: unknown) {
    // Top-level safety net: MCP iteration failures must NEVER crash the daemon.
    // The manager itself was constructed above the try-block, so runtime
    // `mcp.connect` RPCs still work — we just lost the pre-configured servers.
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        hint: "MCP subsystem failed mid-setup; daemon continues with the client manager but no pre-configured servers",
        errorKind: "dependency" as const,
      },
      "MCP setup failed during server iteration",
    );
    return { mcpClientManager: manager };
  }
}
