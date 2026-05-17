// SPDX-License-Identifier: Apache-2.0
// @allow-throw: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.
/**
 * Server discovery + tool listing helpers.
 *
 * Transport construction, MCP client construction (with listChanged
 * handler), server metadata extraction, stdio stderr capture, and the
 * cross-server tool aggregation getter. Used by mcp-client-connect.ts
 * during the connect/reconnect lifecycle.
 *
 * State-first protocol: helpers that touch closure state take
 * `state: McpClientManagerState` as their first parameter; pure helpers
 * (createTransport, extractServerMetadata, wireStderrCapture) take only
 * the inputs they need.
 *
 * @module
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { systemEnvSnapshot, systemNowMs } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpServerConfig,
  McpToolDefinition,
} from "./mcp-client-types.js";
import { qualifyToolName } from "./mcp-client-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum character length for server instructions to prevent preamble budget issues. */
const MAX_INSTRUCTIONS_CHARS = 4096;
const INSTRUCTIONS_TRUNCATED_SUFFIX = " [truncated]";

// ---------------------------------------------------------------------------
// Transport creation helpers
// ---------------------------------------------------------------------------

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

export function createTransport(config: McpServerConfig) {
  if (config.transport === "stdio") {
    if (!config.command) {
      throw new Error(`MCP server "${config.name}": stdio transport requires "command"`);
    }
    const wrapped = wrapStdioCommand(config.command, config.args);
    return new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      stderr: "pipe",  // capture stderr for debugging
      ...(config.env ? { env: { ...systemEnvSnapshot(), ...config.env } as Record<string, string> } : {}),
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

// ---------------------------------------------------------------------------
// MCP Client creation helper (with listChanged handler)
// ---------------------------------------------------------------------------

/**
 * Create an MCP SDK Client wired with a tools/list_changed handler that
 * refreshes the cached tool definitions for the given server. Touches
 * state.connections to swap in the new tool list and emits a
 * mcp:server:tools_changed event when eventBus is configured.
 */
export function createClient(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  serverName: string,
) {
  const { logger } = deps;
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
              const conn = state.connections.get(serverName);
              if (!conn || conn.status !== "connected") return;

              const previousTools = conn.tools;
              const newTools: McpToolDefinition[] = (newToolList ?? []).map((tool) => ({
                name: tool.name,
                qualifiedName: qualifyToolName(serverName, tool.name),
                description: tool.description,
                inputSchema: tool.inputSchema as Record<string, unknown>,
              }));

              state.connections.set(serverName, {
                ...conn,
                tools: newTools,
                lastHealthCheck: systemNowMs(),
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
                timestamp: systemNowMs(),
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

// ---------------------------------------------------------------------------
// Server metadata extraction helper (pure)
// ---------------------------------------------------------------------------

export function extractServerMetadata(client: Client) {
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

// ---------------------------------------------------------------------------
// Stdio stderr capture helper
// ---------------------------------------------------------------------------

export function wireStderrCapture(
  deps: McpClientManagerDeps,
  config: McpServerConfig,
  transport: ReturnType<typeof createTransport>,
): void {
  if (config.transport !== "stdio") return;
  const stdioTransport = transport as { stderr?: NodeJS.ReadableStream };
  if (!stdioTransport.stderr) return;

  const { logger } = deps;
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

// ---------------------------------------------------------------------------
// Cross-server tool aggregation getter (state-first)
// ---------------------------------------------------------------------------

/**
 * Aggregate tool definitions from every currently-connected server.
 * Disconnected servers (status !== "connected") contribute zero tools.
 */
export function listAllTools(state: McpClientManagerState): McpToolDefinition[] {
  const allTools: McpToolDefinition[] = [];
  for (const conn of state.connections.values()) {
    if (conn.status === "connected") {
      allTools.push(...conn.tools);
    }
  }
  return allTools;
}
