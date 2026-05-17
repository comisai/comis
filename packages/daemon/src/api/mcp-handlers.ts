// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * MCP server management RPC handler module.
 * Handles all MCP server management RPC methods:
 *   mcp.list, mcp.status, mcp.connect, mcp.disconnect, mcp.reconnect, mcp.test
 *
 * Uses the `@comis/core` contract registry. Method keys are computed-property
 * names (`[McpListContract.method]:`) so the bidirectional 1:1 architecture
 * test resolves them through `defineContract({ method, ... })` declarations
 * in `packages/core/src/api-contracts/mcp.ts`. The dispatcher-injected
 * `_X` internal fields are stripped via `stripInternalFields` BEFORE
 * `contract.request.parse(...)` — never model internals in the contract
 * schema. NO admin-trust check is performed inside the handler bodies:
 * the trust gate happens at the gateway dispatcher
 * (`packages/daemon/src/wiring/setup-gateway-api.ts` line 284-287
 * registers ALL 6 mcp.* methods with `"admin"` scope through
 * `registerRpcPassthrough(..., "admin")`); rawParams does not carry
 * `_trustLevel` into these handlers because the dispatcher rejects the
 * call before reaching the handler when the caller is not admin.
 *
 * The bespoke pre-Zod validation (missing-param messages, env-var
 * pre-spawn validation, fallback-reconnect path branching) is
 * intentionally retained for user-friendly error UX. The contract parse
 * runs AFTER the bespoke guards and serves as type-narrowing +
 * defense-in-depth. The dev-mode `Contract.response.parse(...)` gate
 * before each return doubles as a shape check — for `mcp.list` /
 * `mcp.status` it asserts the enum-typed status field stays in the
 * 5-value SDK union, and for `mcp.disconnect` it pins the success-only
 * `status: "disconnected"` literal.
 *
 * @module
 */

import type { McpServerConfig } from "@comis/skills";
import { createMcpClientManager } from "@comis/skills";
import {
  findUnresolvedEnvRefs,
  formatMissingEnvRefError,
  McpListContract,
  McpStatusContract,
  McpConnectContract,
  McpDisconnectContract,
  McpReconnectContract,
  McpTestContract,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: WorkspaceApiDeps (shared with workspace, browser,
// approval, skill, notification handlers).
import type { WorkspaceApiDeps as McpHandlerDeps } from "./types.js";
export type { McpHandlerDeps };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of MCP management RPC handlers bound to the given deps.
 */
export function createMcpHandlers(deps: McpHandlerDeps): Record<string, RpcHandler> {
  return {
    [McpListContract.method]: async (rawParams) => {
      // Strip dispatcher-injected _X internals BEFORE contract parse —
      // never let internals flow into Zod parsing. Type-narrow via the
      // contract for defense-in-depth (mcp.list takes no parameters).
      const userParams = stripInternalFields(rawParams);
      McpListContract.request.parse(userParams);

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
      const result = { servers, total: servers.length };
      // Dev-mode response validation gate. Production skips for
      // cold-start budget; the daemon side is the trust boundary.
      if (systemGetEnv("NODE_ENV") !== "production") {
        McpListContract.response.parse(result);
      }
      return result;
    },

    [McpStatusContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guard — produces the legacy "Missing required
      // parameter: server_name" UX, which is more actionable than Zod's
      // noisier `.min(1)` error. The contract's `z.string().min(1)` is
      // defense-in-depth.
      const nameRaw = rawParams.server_name as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: server_name");

      // Strip dispatcher-injected _X internals BEFORE contract parse —
      // never let internals flow into Zod parsing.
      const userParams = stripInternalFields(rawParams);
      const params = McpStatusContract.request.parse(userParams);
      const name = params.server_name;

      const manager = deps.mcpClientManager;
      const conn = manager.getConnection(name);
      if (!conn) {
        throw new Error(`MCP server not found: "${name}"`);
      }

      const result = {
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
      // Dev-mode response validation gate.
      if (systemGetEnv("NODE_ENV") !== "production") {
        McpStatusContract.response.parse(result);
      }
      return result;
    },

    [McpConnectContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guards — produce legacy "Missing required
      // parameter: ..." UX (server_name + transport). The contract's
      // `.min(1)` + enum gating is defense-in-depth.
      const nameRaw = rawParams.server_name as string | undefined;
      const transportRaw = rawParams.transport as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: server_name");
      if (!transportRaw) throw new Error("Missing required parameter: transport");

      // Strip dispatcher-injected _X internals BEFORE contract parse —
      // never let internals flow into Zod parsing. The parsed `params` provides
      // the same field names with type-narrowing.
      const userParams = stripInternalFields(rawParams);
      const params = McpConnectContract.request.parse(userParams);

      const manager = deps.mcpClientManager;

      const config: McpServerConfig = {
        name: params.server_name,
        transport: params.transport,
        command: params.command,
        args: params.args,
        url: params.url,
        env: params.env,
        headers: params.headers,
        enabled: true,
      };

      // Reject connects that reference env vars not in the secrets store.
      // mcp.connect is unconditionally enabled (config.enabled = true
      // above), so the check always applies when both env and secretManager
      // are present. Skipped only when secretManager is unwired (test
      // setups) — production always wires it via rpc-dispatch.
      if (config.env && deps.secretManager) {
        const sm = deps.secretManager;
        const unresolved = findUnresolvedEnvRefs(config.env, (key) => sm.get(key));
        if (unresolved.length > 0) {
          const missingNames = unresolved.map((u) => u.varName);
          throw new Error(formatMissingEnvRefError(params.server_name, missingNames));
        }
      }

      const result = await manager.connect(config);
      if (!result.ok) {
        throw new Error(`Failed to connect MCP server "${params.server_name}": ${result.error.message}`);
      }

      const response = {
        name: result.value.name,
        status: result.value.status,
        toolCount: result.value.tools.length,
        tools: result.value.tools.map((t) => t.name),
      };
      // Dev-mode response validation gate.
      if (systemGetEnv("NODE_ENV") !== "production") {
        McpConnectContract.response.parse(response);
      }
      return response;
    },

    [McpDisconnectContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guard — produces the legacy "Missing required
      // parameter: server_name" UX. The contract's `.min(1)` is
      // defense-in-depth.
      const nameRaw = rawParams.server_name as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: server_name");

      // Strip dispatcher-injected _X internals BEFORE contract parse —
      // never let internals flow into Zod parsing.
      const userParams = stripInternalFields(rawParams);
      const params = McpDisconnectContract.request.parse(userParams);
      const name = params.server_name;

      const manager = deps.mcpClientManager;
      const conn = manager.getConnection(name);
      if (!conn) {
        throw new Error(`MCP server not found: "${name}"`);
      }

      await manager.disconnect(name);
      const result = { name, status: "disconnected" as const };
      // Dev-mode response validation gate. The success-only
      // `status: z.literal("disconnected")` shape is asserted here.
      if (systemGetEnv("NODE_ENV") !== "production") {
        McpDisconnectContract.response.parse(result);
      }
      return result;
    },

    [McpTestContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guards — produce legacy "Missing required
      // parameter: ..." UX (note the test handler reads `name`, NOT
      // `server_name`). Contract's `.min(1)` + enum gating is
      // defense-in-depth.
      const nameRaw = rawParams.name as string | undefined;
      const transportRaw = rawParams.transport as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: name");
      if (!transportRaw) throw new Error("Missing required parameter: transport");

      // Strip dispatcher-injected _X internals BEFORE contract parse —
      // never let internals flow into Zod parsing.
      const userParams = stripInternalFields(rawParams);
      const params = McpTestContract.request.parse(userParams);

      const config: McpServerConfig = {
        name: `__test__${params.name}`,
        transport: params.transport,
        command: params.command,
        args: params.args,
        url: params.url,
        env: params.env,
        headers: params.headers,
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
          const failure = {
            success: false,
            error: result.error.message,
          };
          // Dev-mode response validation gate.
          if (systemGetEnv("NODE_ENV") !== "production") {
            McpTestContract.response.parse(failure);
          }
          return failure;
        }

        const toolNames = result.value.tools.map((t) => t.name);
        const success = {
          success: true,
          toolCount: result.value.tools.length,
          tools: toolNames,
        };
        // Dev-mode response validation gate.
        if (systemGetEnv("NODE_ENV") !== "production") {
          McpTestContract.response.parse(success);
        }
        return success;
      } catch (error: unknown) {
        const failure = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        // Dev-mode response validation gate.
        if (systemGetEnv("NODE_ENV") !== "production") {
          McpTestContract.response.parse(failure);
        }
        return failure;
      } finally {
        // Always clean up temporary connections
        await tempManager.disconnectAll();
      }
    },

    [McpReconnectContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guard — produces the legacy "Missing required
      // parameter: server_name" UX. The contract's `.min(1)` is
      // defense-in-depth.
      const nameRaw = rawParams.server_name as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: server_name");

      // Strip dispatcher-injected _X internals BEFORE contract parse —
      // never let internals flow into Zod parsing.
      const userParams = stripInternalFields(rawParams);
      const params = McpReconnectContract.request.parse(userParams);
      const name = params.server_name;

      const manager = deps.mcpClientManager;

      // Use manager's reconnect (preserves generation counter, uses stored config)
      const result = await manager.reconnect(name);
      if (!result.ok) {
        // Fallback: if no stored config, try with provided params
        if (result.error.message.includes("no stored config")) {
          if (!params.transport) {
            throw new Error(`MCP server "${name}" not found and no transport specified.`);
          }
          const config: McpServerConfig = {
            name,
            transport: params.transport,
            command: params.command,
            args: params.args,
            url: params.url,
            env: params.env,
            headers: params.headers,
            enabled: true,
          };
          const connectResult = await manager.connect(config);
          if (!connectResult.ok) {
            throw new Error(`Failed to reconnect MCP server "${name}": ${connectResult.error.message}`);
          }
          const response = {
            name: connectResult.value.name,
            status: connectResult.value.status,
            toolCount: connectResult.value.tools.length,
            tools: connectResult.value.tools.map((t) => t.name),
          };
          // Dev-mode response validation gate.
          if (systemGetEnv("NODE_ENV") !== "production") {
            McpReconnectContract.response.parse(response);
          }
          return response;
        }
        throw new Error(`Failed to reconnect MCP server "${name}": ${result.error.message}`);
      }

      const response = {
        name: result.value.name,
        status: result.value.status,
        toolCount: result.value.tools.length,
        tools: result.value.tools.map((t) => t.name),
      };
      // Dev-mode response validation gate.
      if (systemGetEnv("NODE_ENV") !== "production") {
        McpReconnectContract.response.parse(response);
      }
      return response;
    },
  };
}
