// SPDX-License-Identifier: Apache-2.0
// @allow-throw: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary (Phase 41 TS-HYG-07).
/**
 * Tool-call helper (Phase 43 split per FILE-SPLIT-11).
 *
 * State-first protocol: callTool(state, deps, qualifiedName, args).
 * The pure qualifyToolName + parseQualifiedName helpers live in
 * mcp-client-types.ts to keep the dependency graph acyclic (see types
 * file's "Qualified name helpers" docblock).
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { systemNowMs } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpToolCallContent,
  McpToolCallResult,
} from "./mcp-client-types.js";
import { parseQualifiedName } from "./mcp-client-types.js";
import { handleDisconnection } from "./mcp-client-reconnect.js";

// ---------------------------------------------------------------------------
// callTool (state-first)
// ---------------------------------------------------------------------------

/**
 * Call a tool by its qualified name. Routes through the per-server PQueue
 * for serialization, captures the connection generation to detect stale
 * connections after the call resolves, and converts MCP SDK errors into
 * structured Result rejections.
 *
 * Detects session-expiry errors (StreamableHTTPError 404 + McpError
 * RequestTimeout with "session"/"connection closed" messages) and
 * triggers an automatic reconnection via handleDisconnection.
 */
export async function callTool(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<Result<McpToolCallResult, Error>> {
  const { logger } = deps;
  const parsed = parseQualifiedName(qualifiedName);
  if (!parsed) {
    return err(new Error(`Invalid MCP tool qualified name: "${qualifiedName}"`));
  }

  const { serverName, toolName } = parsed;
  const conn = state.connections.get(serverName);

  if (!conn) {
    return err(new Error(`MCP server "${serverName}" not connected`));
  }

  if (conn.status !== "connected") {
    return err(
      new Error(`MCP server "${serverName}" is ${conn.status}, cannot call tool "${toolName}"`),
    );
  }

  // Serialize through per-server concurrency queue
  const queue = state.callQueues.get(serverName);
  if (!queue) {
    return err(new Error(`MCP server "${serverName}" has no call queue (not connected via connect())`));
  }

  return queue.add(async () => {
    // Re-check connection status -- may have changed while queued
    const currentConn = state.connections.get(serverName);
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
        { timeout: state.options.callToolTimeoutMs },
      );

      // Verify generation hasn't changed during the call (stale connection guard)
      const postCallConn = state.connections.get(serverName);
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
      state.consecutiveErrors.set(serverName, 0);

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
        handleDisconnection(state, deps, serverName, "client_closed");
        return err(new Error(`MCP server "${serverName}" session expired during tool call "${toolName}". Reconnection initiated -- retry shortly.`));
      }

      const isTimeout =
        (error instanceof McpError && error.code === ErrorCode.RequestTimeout) ||
        (error instanceof Error && error.message.includes("timed out"));

      if (!isTimeout) {
        const latestConn = state.connections.get(serverName);
        if (latestConn) {
          state.connections.set(serverName, {
            ...latestConn,
            status: "error",
            lastHealthCheck: systemNowMs(),
          });
        }
      } else {
        logger.debug?.({ serverName, toolName }, "Tool call timed out, connection status preserved");
      }

      return err(error instanceof Error ? error : new Error(message));
    }
  }) as Promise<Result<McpToolCallResult, Error>>;
}
