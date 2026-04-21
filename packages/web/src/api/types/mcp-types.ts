// SPDX-License-Identifier: Apache-2.0
/**
 * MCP (Model Context Protocol) domain types.
 *
 * Interfaces for MCP server status and tool definitions
 * used in the skills/MCP management views.
 */

/** MCP server connection status (used by skills view config-level display). */
export interface McpServerStatus {
  readonly name: string;
  readonly status: "connected" | "disconnected" | "error";
  readonly uri: string;
  readonly lastConnectedAt?: number;
  readonly error?: string;
}

/** MCP tool definition (used by skills view config-level display). */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly serverId: string;
}

// ---------------------------------------------------------------------------
// MCP management view types (matching backend mcp.* RPC handler responses)
// ---------------------------------------------------------------------------

/** MCP server list entry from mcp.list RPC. */
export interface McpServerListEntry {
  readonly name: string;
  readonly status: "connected" | "disconnected" | "connecting" | "reconnecting" | "error";
  readonly toolCount: number;
  readonly lastHealthCheck?: number;
  /** Current reconnection attempt number (present when status is "reconnecting"). */
  readonly reconnectAttempt?: number;
  /** Error message (present when status is "error"). */
  readonly error?: string;
  /** Capability flags from server. */
  readonly capabilities?: Readonly<Record<string, unknown>>;
  /** Server implementation info. */
  readonly serverVersion?: {
    readonly name: string;
    readonly version: string;
  };
}

/** MCP server detail from mcp.status RPC. */
export interface McpServerDetail {
  readonly name: string;
  readonly status: "connected" | "disconnected" | "connecting" | "reconnecting" | "error";
  readonly toolCount: number;
  readonly tools: ReadonlyArray<McpToolEntry>;
  readonly lastHealthCheck?: number;
  /** Server instructions from MCP protocol. */
  readonly instructions?: string;
  /** Capability flags from server. */
  readonly capabilities?: Readonly<Record<string, unknown>>;
  /** Server implementation info. */
  readonly serverVersion?: {
    readonly name: string;
    readonly version: string;
  };
}

/** MCP tool entry from mcp.status RPC (different shape from config-level McpTool). */
export interface McpToolEntry {
  readonly name: string;
  readonly qualifiedName: string;
  readonly description?: string;
}

/** MCP connect params for runtime server connection. */
export interface McpConnectParams {
  readonly name: string;
  readonly transport: "stdio" | "sse" | "http";
  readonly command?: string;
  readonly args?: string[];
  readonly url?: string;
  readonly env?: Record<string, string>;
  readonly headers?: Record<string, string>;
}

/** MCP connect/reconnect response shape. */
export interface McpConnectResponse {
  readonly name: string;
  readonly status: string;
  readonly toolCount: number;
  readonly tools: string[];
}
