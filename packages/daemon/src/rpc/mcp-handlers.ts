// SPDX-License-Identifier: Apache-2.0
/**
 * MCP server management RPC handler module.
 * Handles all MCP server management RPC methods:
 *   mcp.list, mcp.status, mcp.connect, mcp.disconnect, mcp.reconnect
 * @module
 */

import type { McpClientManager, McpServerConfig } from "@comis/skills";
import { createMcpClientManager } from "@comis/skills";
import type { ComisLogger } from "@comis/infra";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by MCP management RPC handlers. */
export interface McpHandlerDeps {
  /**
   * The MCP client manager instance. Always defined — `setupMcp` constructs
   * it unconditionally so runtime `mcp.connect` RPCs work even when no servers
   * were configured at startup.
   */
  mcpClientManager: McpClientManager;
  /** Logger for MCP test connection (used by temporary manager). */
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of MCP management RPC handlers bound to the given deps.
 */
export function createMcpHandlers(deps: McpHandlerDeps): Record<string, RpcHandler> {
  return {
    "mcp.list": async () => {
      const connections = deps.mcpClientManager.getAllConnections();
      const servers = connections.map((conn) => ({
        name: conn.name,
        status: conn.status,
        toolCount: conn.tools.length,
        lastHealthCheck: conn.lastHealthCheck,
        reconnectAttempt: conn.reconnectAttempt,
        error: conn.error,
        // capability flags and server version for list-level display
        capabilities: conn.capabilities,
        serverVersion: conn.serverInfo,
      }));
      return { servers, total: servers.length };
    },

    "mcp.status": async (params) => {
      const name = params.name as string;
      if (!name) throw new Error("Missing required parameter: name");

      const manager = deps.mcpClientManager;
      const conn = manager.getConnection(name);
      if (!conn) {
        throw new Error(`MCP server not found: "${name}"`);
      }

      return {
        name: conn.name,
        status: conn.status,
        toolCount: conn.tools.length,
        tools: conn.tools.map((t) => ({
          name: t.name,
          qualifiedName: t.qualifiedName,
          description: t.description,
        })),
        lastHealthCheck: conn.lastHealthCheck,
        reconnectAttempt: conn.reconnectAttempt,
        maxReconnectAttempts: conn.maxReconnectAttempts,
        error: conn.error,
        generation: conn.generation,
        serverInfo: conn.serverInfo,
        instructions: conn.instructions,
        capabilities: conn.capabilities,
        serverVersion: conn.serverInfo,
      };
    },

    "mcp.connect": async (params) => {
      const name = params.name as string;
      const transport = params.transport as string;
      if (!name) throw new Error("Missing required parameter: name");
      if (!transport) throw new Error("Missing required parameter: transport");

      const manager = deps.mcpClientManager;

      const config: McpServerConfig = {
        name,
        transport: transport as "stdio" | "sse" | "http",
        command: params.command as string | undefined,
        args: params.args as string[] | undefined,
        url: params.url as string | undefined,
        env: params.env as Record<string, string> | undefined,
        headers: params.headers as Record<string, string> | undefined,
        enabled: true,
      };

      const result = await manager.connect(config);
      if (!result.ok) {
        throw new Error(`Failed to connect MCP server "${name}": ${result.error.message}`);
      }

      return {
        name: result.value.name,
        status: result.value.status,
        toolCount: result.value.tools.length,
        tools: result.value.tools.map((t) => t.name),
      };
    },

    "mcp.disconnect": async (params) => {
      const name = params.name as string;
      if (!name) throw new Error("Missing required parameter: name");

      const manager = deps.mcpClientManager;
      const conn = manager.getConnection(name);
      if (!conn) {
        throw new Error(`MCP server not found: "${name}"`);
      }

      await manager.disconnect(name);
      return { name, status: "disconnected" };
    },

    "mcp.test": async (params) => {
      const name = params.name as string;
      const transport = params.transport as string;
      if (!name) throw new Error("Missing required parameter: name");
      if (!transport) throw new Error("Missing required parameter: transport");

      const config: McpServerConfig = {
        name: `__test__${name}`,
        transport: transport as "stdio" | "sse" | "http",
        command: params.command as string | undefined,
        args: params.args as string[] | undefined,
        url: params.url as string | undefined,
        env: params.env as Record<string, string> | undefined,
        headers: params.headers as Record<string, string> | undefined,
        enabled: true,
      };

      // Create a temporary manager with short timeout for test
      const tempManager = createMcpClientManager({
        logger: deps.logger,
        connectTimeoutMs: 15_000,
      });

      try {
        const result = await tempManager.connect(config);
        if (!result.ok) {
          return {
            success: false,
            error: result.error.message,
          };
        }

        const toolNames = result.value.tools.map((t) => t.name);
        return {
          success: true,
          toolCount: result.value.tools.length,
          tools: toolNames,
        };
      } catch (error: unknown) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        // Always clean up temporary connections
        await tempManager.disconnectAll();
      }
    },

    "mcp.reconnect": async (params) => {
      const name = params.name as string;
      if (!name) throw new Error("Missing required parameter: name");

      const manager = deps.mcpClientManager;

      // Use manager's reconnect (preserves generation counter, uses stored config)
      const result = await manager.reconnect(name);
      if (!result.ok) {
        // Fallback: if no stored config, try with provided params
        if (result.error.message.includes("no stored config")) {
          const transport = params.transport as string;
          if (!transport) {
            throw new Error(`MCP server "${name}" not found and no transport specified.`);
          }
          const config: McpServerConfig = {
            name,
            transport: transport as "stdio" | "sse" | "http",
            command: params.command as string | undefined,
            args: params.args as string[] | undefined,
            url: params.url as string | undefined,
            env: params.env as Record<string, string> | undefined,
            headers: params.headers as Record<string, string> | undefined,
            enabled: true,
          };
          const connectResult = await manager.connect(config);
          if (!connectResult.ok) {
            throw new Error(`Failed to reconnect MCP server "${name}": ${connectResult.error.message}`);
          }
          return {
            name: connectResult.value.name,
            status: connectResult.value.status,
            toolCount: connectResult.value.tools.length,
            tools: connectResult.value.tools.map((t) => t.name),
          };
        }
        throw new Error(`Failed to reconnect MCP server "${name}": ${result.error.message}`);
      }

      return {
        name: result.value.name,
        status: result.value.status,
        toolCount: result.value.tools.length,
        tools: result.value.tools.map((t) => t.name),
      };
    },
  };
}
