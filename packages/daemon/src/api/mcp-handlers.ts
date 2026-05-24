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
// `McpServerEntry` — the Zod-inferred shape of a persisted MCP server
// entry (integrations.mcp.servers[i]) — is the canonical type for the
// persistMcpServers helper's new-array computation. Already re-exported
// from `@comis/core` (packages/core/src/exports/config.ts:188), so a
// direct named import is the correct path here (no deep-path subpath).
import type { McpServerEntry } from "@comis/core";
import { persistToConfig } from "./shared/persist-to-config.js";
import {
  buildConfigAuditBase,
  appendConfigAuditWithOutcome,
} from "../config/audit-hook.js";
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
// Phase 47-02: persistMcpServers helper
// ---------------------------------------------------------------------------

/**
 * D-04 outcome shape — the persistMcpServers result spliced into
 * McpConnect/McpDisconnect responses.
 */
interface PersistMcpResult {
  persistence: "persisted" | "runtime_only" | "skipped";
  warning?: string;
}

/**
 * Phase 47: Persist the full integrations.mcp.servers array to config.yaml
 * + emit one config-audit JSONL record. Idempotent — re-calling with the
 * same actionType/entityId produces multiple JSONL records but converges
 * the YAML to the desired state.
 *
 * Mirrors the channels.enable persist call (channel-handlers.ts:232-248)
 * with three deviations:
 *   1. Full-array patch (deepMerge replaces arrays; caller computes it).
 *   2. Direct appendConfigAuditWithOutcome call after persistToConfig
 *      because persistToConfig's audit:event has no JSONL subscriber
 *      (RESEARCH.md §"R8 Audit JSONL Field-Name Verification").
 *   3. Returns D-04 outcome for the caller to splice into the response.
 *
 * @param deps - Mcp handler deps slice (must contain persistDeps for the
 *   persist path to fire; otherwise short-circuits to "skipped").
 * @param servers - The FULL new integrations.mcp.servers array. Caller is
 *   responsible for the read-current + filter-by-name + append/remove
 *   computation (deepMerge replaces arrays wholesale).
 * @param actionType - "mcp.connect" or "mcp.disconnect". Becomes the
 *   JSONL record's callerSource and the persistToConfig actionType.
 * @param entityId - The server_name; surfaced in audit:event provenance.
 * @param ctx - Internal _context bag with optional userId + traceId.
 */
async function persistMcpServers(
  deps: McpHandlerDeps,
  servers: McpServerEntry[],
  actionType: "mcp.connect" | "mcp.disconnect",
  entityId: string,
  ctx: { userId?: string; traceId?: string } | undefined,
): Promise<PersistMcpResult> {
  if (!deps.persistDeps) {
    return { persistence: "skipped" };
  }

  // Local config path: LAST entry of configPaths if non-empty, else LAST
  // of defaultConfigPaths. Mirrors persist-to-config's own resolution.
  const localPath = deps.persistDeps.configPaths.length > 0
    ? deps.persistDeps.configPaths[deps.persistDeps.configPaths.length - 1]!
    : deps.persistDeps.defaultConfigPaths[deps.persistDeps.defaultConfigPaths.length - 1]!;

  // PHASE 1: capture pre-write state (previousHash, stat snapshot).
  const auditBase = buildConfigAuditBase(localPath, actionType);

  // PHASE 2: write.
  const persistResult = await persistToConfig(deps.persistDeps, {
    patch: { integrations: { mcp: { servers } } },
    skipRestart: true,
    actionType,
    entityId,
    ...(ctx?.userId !== undefined && { actingUser: ctx.userId }),
    ...(ctx?.traceId !== undefined && { traceId: ctx.traceId }),
  });

  // PHASE 3: finalize audit JSONL + return outcome.
  if (persistResult.ok) {
    appendConfigAuditWithOutcome(auditBase, { kind: "rename" }, deps.persistDeps.logger);

    // D-07/D-08/PERSIST-08: in-memory atomic swap. The disk write
    // succeeded; now refresh `container.config.integrations` so concurrent
    // readers (obs_query, mcp.list RPC, observability dashboards) see the
    // new entry without waiting for a daemon restart. Per D-08, clone the
    // FULL integrations subtree (NOT just .mcp.servers) so mid-update
    // readers observe either the pre-state OR the post-state, never a
    // partial array. Per RESEARCH.md Plan-time risk #7, optional-chain on
    // `deps.container?.config` — existing test fixtures construct deps
    // without a container field. Node 22 ships `structuredClone`
    // built-in; no polyfill required.
    if (deps.container?.config) {
      // Treat the subtree as a mutable record shape — IntegrationsConfigSchema
      // applies its strict-object defaults at config-load time, so by the
      // time this code runs in production `integrations.mcp` is always
      // present. Tests that pass through this path provide at least
      // `{ integrations: { mcp: { servers } } }`. We use a record shape
      // (not the IntegrationsConfig type) so the structuredClone result is
      // freely reassignable through the same key paths.
      type MutableIntegrations = Record<string, Record<string, unknown>>;
      const cloned = structuredClone(
        (deps.container.config.integrations ?? {}) as MutableIntegrations,
      );
      if (!cloned.mcp) cloned.mcp = {};
      cloned.mcp.servers = servers;
      // Atomic single-property write. Readers reach `.integrations` via a
      // single property access on `container.config`; this assignment is
      // a single write, so JS's single-threaded execution model guarantees
      // observers see pre-OR-post, never partial.
      (deps.container.config as { integrations: unknown }).integrations = cloned;
    }

    return { persistence: "persisted" };
  } else {
    appendConfigAuditWithOutcome(
      auditBase,
      { kind: "failed", message: persistResult.error },
      deps.persistDeps.logger,
    );
    deps.persistDeps.logger.warn(
      {
        method: actionType,
        entityId,
        err: persistResult.error,
        hint: "MCP server runtime-mutated but config.yaml write failed",
        errorKind: "config" as const,
      },
      "MCP config persistence failed",
    );
    return { persistence: "runtime_only", warning: persistResult.error };
  }
}

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
      // Bespoke pre-Zod guard — produces the legacy "Missing required
      // parameter: server_name" UX. The contract's `.min(1)` + enum
      // gating is defense-in-depth. Transport inference is handled
      // at the schema layer (McpServerEntrySchema z.preprocess) on
      // the config-load path; on the RPC path it is inlined at the
      // mcp_manage tool layer for LLM UX.
      const nameRaw = rawParams.server_name as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: server_name");

      // Strip dispatcher-injected _X internals BEFORE contract parse —
      // never let internals flow into Zod parsing. The parsed `params` provides
      // the same field names with type-narrowing.
      const userParams = stripInternalFields(rawParams);
      const params = McpConnectContract.request.parse(userParams);

      const manager = deps.mcpClientManager;

      // Phase 63 SAFETY-02: copy the operator-extension allowlist from
      // the config root so it reaches `scrubStdioEnv` at spawn time
      // (packages/skills/src/skills/integrations/mcp-client/mcp-client-discover.ts).
      // The optional chain mirrors the McpConnect persist site below —
      // test fixtures construct deps without a `container`, in which case
      // the built-in `MCP_STDIO_BUILTIN_ENV_ALLOWLIST` is the only
      // protection in effect for that spawn.
      const mcpConfigRoot = deps.container?.config?.integrations?.mcp as
        | { safetyAllowedEnvKeys?: readonly string[] }
        | undefined;

      const config: McpServerConfig = {
        name: params.server_name,
        transport: params.transport,
        command: params.command,
        args: params.args,
        url: params.url,
        env: params.env,
        headers: params.headers,
        enabled: true,
        safetyAllowedEnvKeys: mcpConfigRoot?.safetyAllowedEnvKeys,
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

      // Phase 47 (R1, R6): compute the full new servers array.
      // Read-current + filter-by-name + append. deepMerge replaces arrays
      // wholesale, so we MUST pass the full array, not a partial. The
      // optional chain on `deps.container` keeps existing test fixtures
      // green — they construct deps without a container, in which case
      // the in-memory baseline is treated as empty (and the subsequent
      // persistMcpServers call short-circuits to "skipped" anyway when
      // persistDeps is also absent).
      const currentServers = (deps.container?.config?.integrations?.mcp?.servers ?? []) as McpServerEntry[];
      const newEntry: McpServerEntry = {
        name: params.server_name,
        transport: params.transport,
        ...(params.command !== undefined && { command: params.command }),
        ...(params.args !== undefined && { args: params.args }),
        ...(params.url !== undefined && { url: params.url }),
        // Phase 47 (R5): pass params.env (unresolved `${KEY}` references),
        // NOT the resolved values used for spawn. deepMerge does not
        // transform string values.
        ...(params.env !== undefined && { env: params.env }),
        ...(params.headers !== undefined && { headers: params.headers }),
        enabled: true,
      };
      const newServers: McpServerEntry[] = [
        ...currentServers.filter((s) => s.name !== params.server_name),
        newEntry,
      ];

      // Phase 47 (R1, R8, D-04): persist + audit JSONL + response-augment.
      const ctx = rawParams._context as { userId?: string; traceId?: string } | undefined;
      const persistOutcome = await persistMcpServers(
        deps,
        newServers,
        "mcp.connect",
        params.server_name,
        ctx,
      );

      const response = {
        name: result.value.name,
        status: result.value.status,
        toolCount: result.value.tools.length,
        tools: result.value.tools.map((t) => t.name),
        persistence: persistOutcome.persistence,
        ...(persistOutcome.warning !== undefined && { warning: persistOutcome.warning }),
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

      // Phase 47 (R2, R6): compute the filtered servers array.
      // Removed entry is named; remaining entries preserved in pre-call
      // order. Empty result array is intentional — the array slot remains
      // so subsequent persists repopulate it without recreating the path.
      // Optional-chain on `deps.container` parallels the McpConnect site
      // and preserves existing test fixtures that omit container.
      const currentServers = (deps.container?.config?.integrations?.mcp?.servers ?? []) as McpServerEntry[];
      const newServers: McpServerEntry[] = currentServers.filter((s) => s.name !== params.server_name);

      // Phase 47 (R2, R8, D-04): persist + audit JSONL + response-augment.
      const ctx = rawParams._context as { userId?: string; traceId?: string } | undefined;
      const persistOutcome = await persistMcpServers(
        deps,
        newServers,
        "mcp.disconnect",
        params.server_name,
        ctx,
      );

      const result = {
        name,
        status: "disconnected" as const,
        persistence: persistOutcome.persistence,
        ...(persistOutcome.warning !== undefined && { warning: persistOutcome.warning }),
      };
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

      const manager = deps.mcpClientManager;

      // Phase 47 (D-02 / R7 SPEC numbering): override-rejection guard.
      // mcp_manage(reconnect) MUST NOT accept transport/command/args/url/
      // headers/env when the server has stored runtime config — the contract
      // is "reconnect re-uses the stored config; to change params, disconnect
      // then connect". Per RESEARCH.md §"D-02 Error-Key Convention Verification",
      // throw a raw Error (NOT throwToolError — that lives in @comis/skills,
      // not @comis/daemon — cross-package boundary) with the bracketed
      // error-code prefix so the LLM can self-correct.
      //
      // Stored-config existence is signalled by manager.getConnection(name)
      // returning a McpConnection: the client manager stores config and
      // connection together at connect time (mcp-client-connect.ts:108) and
      // deletes them together at disconnect time (mcp-client-connect.ts:219),
      // so the live-connection presence is a sound proxy for "has stored
      // config". (The plan text used `storedConn?.config != null`, but
      // McpConnection has no `.config` field — that check is replaced here
      // with the connection-presence test, preserving the same semantics.)
      const hasOverride =
        rawParams.transport !== undefined ||
        rawParams.command !== undefined ||
        rawParams.args !== undefined ||
        rawParams.url !== undefined ||
        rawParams.headers !== undefined ||
        rawParams.env !== undefined;
      const hasStoredConfig = manager.getConnection(nameRaw) !== undefined;
      if (hasOverride && hasStoredConfig) {
        throw new Error(
          "[reconnect_with_overrides_not_allowed] Cannot override transport/command/args/url/headers/env on reconnect when stored config exists. " +
          "Hint: To change MCP server parameters, disconnect then connect with the new params.",
        );
      }

      // Strip dispatcher-injected _X internals BEFORE contract parse —
      // never let internals flow into Zod parsing.
      const userParams = stripInternalFields(rawParams);
      const params = McpReconnectContract.request.parse(userParams);
      const name = params.server_name;

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
