// SPDX-License-Identifier: Apache-2.0
/**
 * MCP management controller (Phase 44 / WEB-DECOMP-01 / Wave 5 / Task 1).
 *
 * Thin RPC façade — the mcp-management view retains @state for its server
 * list, config-only list, expansion state, add-form fields, confirm-dialog
 * targets, test results, and instructions toggle because the existing
 * render + interaction flows keep state on the view. The controller's job
 * is to keep `rpcClient.call(...)` out of `mcp-management.ts` so the
 * WEB-DECOMP-03 boundary test passes. Each method mirrors a source view
 * RPC invocation 1:1 (same method name, same args, same response shape).
 *
 * Errors propagate verbatim to the caller (the view's existing try/catch
 * + IcToast.show pattern handles user-facing error messaging at the call
 * site — controllers never surface toasts).
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import type {
  McpServerListEntry,
  McpServerDetail,
} from "../api/types/mcp-types.js";

/* ------------------------------------------------------------------ */
/*  RPC response + arg shapes                                          */
/* ------------------------------------------------------------------ */

/** Shape of MCP server entries from config.read. Mirrors the view-local
 *  interface to avoid a cross-package coupling; intentional 1:1. */
export interface McpServerConfigEntry {
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface McpListResult {
  servers: McpServerListEntry[];
  total: number;
}

export interface ConfigReadResult {
  config: {
    integrations?: {
      mcp?: {
        servers?: McpServerConfigEntry[];
      };
    };
  };
}

export interface McpTestResult {
  success: boolean;
  toolCount?: number;
  tools?: string[];
  message?: string;
  error?: string;
}

export interface McpTestParams {
  name: string;
  transport?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface McpManagementController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** List runtime MCP servers + their connection state (mcp.list). */
  listServers(): Promise<McpListResult>;
  /** Read the full config block (config.read) — used to pull
   *  config.integrations.mcp.servers for config-only entries. */
  readConfig(): Promise<ConfigReadResult>;
  /** Get one server's detail incl. tools + instructions (mcp.status). */
  getServerStatus(serverName: string): Promise<McpServerDetail>;
  /** Patch a config section (config.patch). Used for enable/disable/add/remove. */
  patchConfig(section: string, key: string, value: unknown): Promise<void>;
  /** Disconnect a running MCP server (mcp.disconnect). */
  disconnectServer(serverName: string): Promise<void>;
  /** Reconnect a disconnected MCP server (mcp.reconnect). */
  reconnectServer(serverName: string): Promise<void>;
  /** Test a server's connection (mcp.test) — accepts either name-only
   *  (existing config-bound run) or full transport params (config-only
   *  dry-run before saving). */
  testServer(params: McpTestParams): Promise<McpTestResult>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createMcpManagementController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): McpManagementController {
  const controller: McpManagementController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own willUpdate gate */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own RPC-status listener */
    },

    listServers(): Promise<McpListResult> {
      return rpcClient.call<McpListResult>("mcp.list");
    },

    readConfig(): Promise<ConfigReadResult> {
      return rpcClient.call<ConfigReadResult>("config.read");
    },

    getServerStatus(serverName: string): Promise<McpServerDetail> {
      return rpcClient.call<McpServerDetail>("mcp.status", {
        server_name: serverName,
      });
    },

    async patchConfig(
      section: string,
      key: string,
      value: unknown,
    ): Promise<void> {
      await rpcClient.call("config.patch", { section, key, value });
    },

    async disconnectServer(serverName: string): Promise<void> {
      await rpcClient.call("mcp.disconnect", { server_name: serverName });
    },

    async reconnectServer(serverName: string): Promise<void> {
      await rpcClient.call("mcp.reconnect", { server_name: serverName });
    },

    testServer(params: McpTestParams): Promise<McpTestResult> {
      return rpcClient.call<McpTestResult>("mcp.test", params);
    },
  };

  host.addController(controller);
  return controller;
}
