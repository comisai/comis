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
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: WorkspaceApiDeps (shared with workspace, browser,
// approval, skill, notification handlers).
import type { WorkspaceApiDeps as McpHandlerDeps } from "./types.js";
export type { McpHandlerDeps };

// Plaintext-secret heuristic. Extracted to
// `./mcp-plaintext-secret.ts` (keeps this leaf under the 800-line cap).
// Re-exported so the architecture-tier negative-control test
// (`mcp-plaintext-secret-false-positives.test.ts`) reaches it via the
// `@comis/daemon` barrel.
export { looksLikePlaintextSecret } from "./mcp-plaintext-secret.js";
import { looksLikePlaintextSecret } from "./mcp-plaintext-secret.js";
// Persisted-entry construction extracted (single source of
// truth for the config-only field set; see mcp-persisted-entry.ts docblock).
import { buildPersistedMcpEntry } from "./mcp-persisted-entry.js";

// persistMcpServers helper extracted to a sibling module to keep
// mcp-handlers.ts under the 800-line cap. The helper is the single
// sanctioned writer to integrations.mcp.servers; see
// shared/persist-mcp-servers.ts for the full docblock.
import { persistMcpServers } from "./shared/persist-mcp-servers.js";

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
      // Bespoke pre-Zod guard for legacy "Missing required parameter:
      // server_name" UX. Contract's .min(1) + enum gating is defense-in-depth.
      const nameRaw = rawParams.server_name as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: server_name");

      // Strip dispatcher-injected _X internals before contract parse.
      const userParams = stripInternalFields(rawParams);

      // Plaintext-secret reject (pre-Zod). Reads userParams.env raw;
      // per-server opt-out via disablePlaintextSecretCheck logs WARN and
      // allows. Bracketed [plaintext_secret_in_env] is LLM-readable; the
      // hint routes the operator to secrets_manage.
      const envBlock = userParams.env as Record<string, string> | undefined;
      const plaintextOptOut = userParams.disablePlaintextSecretCheck === true;
      if (envBlock && !plaintextOptOut) {
        for (const [key, value] of Object.entries(envBlock)) {
          if (typeof value !== "string") continue;
          if (looksLikePlaintextSecret(value)) {
            throw new Error(
              `[plaintext_secret_in_env] env.${key} (server "${userParams.server_name as string}") ` +
              `looks like a plaintext credential. ` +
              `Hint: store it via secrets_manage and reference as "\${${key}}".`,
            );
          }
        }
      } else if (envBlock && plaintextOptOut) {
        deps.logger.warn(
          {
            method: "mcp.connect",
            entityId: userParams.server_name as string,
            hint: "disablePlaintextSecretCheck=true — server bypasses plaintext-secret scan",
            errorKind: "config" as const,
          },
          "MCP plaintext-secret check disabled per-server",
        );
      }

      const params = McpConnectContract.request.parse(userParams);

      const manager = deps.mcpClientManager;

      // Copy operator-extension allowlist + OSV check toggles from the config
      // root so spawn-time helpers (scrubStdioEnv + osvMalwareCheck) see them.
      // Optional-chain matches the persist site below — test fixtures may
      // construct deps without a container; built-in allowlist + OSV defaults
      // apply then.
      const mcpConfigRoot = deps.container?.config?.integrations?.mcp as
        | {
            safetyAllowedEnvKeys?: readonly string[];
            osvCheckEnabled?: boolean;
            osvCacheTtlMs?: number;
          }
        | undefined;

      // Per-server rlimits resolution.
      // Resolution order: caller-supplied params.rlimits > persisted-entry
      // rlimits > undefined (env-only wrap, no prlimit).
      // Typed as McpServerEntry[] (Zod-inferred schema type) so every
      // persisted field — rlimits, reliability config, etc. — is readable.
      const persistedServers = (deps.container?.config?.integrations?.mcp?.servers ?? []) as McpServerEntry[];
      const persistedEntry = persistedServers.find((s) => s.name === params.server_name);
      const resolvedRlimits = params.rlimits ?? persistedEntry?.rlimits;

      // Per-server reliability overrides. Same resolution order as
      // resolvedRlimits — current intent > persisted > undefined.
      const resolvedKeepaliveIntervalMs = params.keepaliveIntervalMs ?? persistedEntry?.keepaliveIntervalMs;
      const resolvedCircuitBreakerThreshold = params.circuitBreakerThreshold ?? persistedEntry?.circuitBreakerThreshold;
      const resolvedCircuitBreakerCooldownMs = params.circuitBreakerCooldownMs ?? persistedEntry?.circuitBreakerCooldownMs;

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
        osvCheckEnabled: mcpConfigRoot?.osvCheckEnabled,
        osvCacheTtlMs: mcpConfigRoot?.osvCacheTtlMs,
        rlimits: resolvedRlimits,
        keepaliveIntervalMs: resolvedKeepaliveIntervalMs,
        circuitBreakerThreshold: resolvedCircuitBreakerThreshold,
        circuitBreakerCooldownMs: resolvedCircuitBreakerCooldownMs,
        // Forward config-only fields from the persisted entry (mcp.connect has
        // no CLI params for them) — else a reconnect drops idle eviction /
        // tool filtering / resources-prompts / parallel-calls opt-ins.
        // idleTtlMs only when >0 (0 ⇒ disabled, per startIdleTicker opt-in).
        ...(persistedEntry?.idleTtlMs !== undefined && persistedEntry.idleTtlMs > 0 && { idleTtlMs: persistedEntry.idleTtlMs }),
        ...(persistedEntry?.toolAllowlist !== undefined && { toolAllowlist: persistedEntry.toolAllowlist }),
        ...(persistedEntry?.toolBlocklist !== undefined && { toolBlocklist: persistedEntry.toolBlocklist }),
        ...(persistedEntry?.enableResources !== undefined && { enableResources: persistedEntry.enableResources }),
        ...(persistedEntry?.enablePrompts !== undefined && { enablePrompts: persistedEntry.enablePrompts }),
        ...(persistedEntry?.supportsParallelToolCalls !== undefined && { supportsParallelToolCalls: persistedEntry.supportsParallelToolCalls }),
        // Forward auth/oauth from the persisted entry (no RPC param) so
        // createTransport wires the OAuthClientProvider on reconnect — else
        // the server downgrades to no-auth.
        ...(persistedEntry?.auth !== undefined && { auth: persistedEntry.auth }),
        ...(persistedEntry?.oauth !== undefined && { oauth: persistedEntry.oauth }),
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

      // Compute the full new servers array.
      // Read-current + filter-by-name + append. deepMerge replaces arrays
      // wholesale, so we MUST pass the full array, not a partial. The
      // optional chain on `deps.container` keeps existing test fixtures
      // green — they construct deps without a container, in which case
      // the in-memory baseline is treated as empty (and the subsequent
      // persistMcpServers call short-circuits to "skipped" anyway when
      // persistDeps is also absent).
      const currentServers = (deps.container?.config?.integrations?.mcp?.servers ?? []) as McpServerEntry[];
      // Shared helper preserves config-only fields from the prior persisted
      // entry (else the tool filter is dropped on reconnect — a security
      // regression). See mcp-persisted-entry.ts.
      const newEntry: McpServerEntry = buildPersistedMcpEntry({
        serverName: params.server_name,
        transport: params.transport,
        command: params.command,
        args: params.args,
        url: params.url,
        env: params.env,
        headers: params.headers,
        disablePlaintextSecretCheck: userParams.disablePlaintextSecretCheck === true,
        resolvedRlimits,
        resolvedKeepaliveIntervalMs,
        resolvedCircuitBreakerThreshold,
        resolvedCircuitBreakerCooldownMs,
        // auth/oauth have no RPC param — buildPersistedMcpEntry resolves them
        // from persistedEntry so the persist keeps them. No explicit
        // pass-through needed.
        persistedEntry,
      });
      const newServers: McpServerEntry[] = [
        ...currentServers.filter((s) => s.name !== params.server_name),
        newEntry,
      ];

      // Persist + audit JSONL + response-augment.
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

      // Compute the filtered servers array. Removed entry is named; remaining
      // entries preserved in pre-call order. Empty result array is intentional
      // — the array slot remains so subsequent persists repopulate it without
      // recreating the path. Optional-chain on `deps.container` parallels the
      // McpConnect site and preserves existing test fixtures that omit
      // container.
      const currentServers = (deps.container?.config?.integrations?.mcp?.servers ?? []) as McpServerEntry[];
      const newServers: McpServerEntry[] = currentServers.filter((s) => s.name !== params.server_name);

      // Persist + audit JSONL + response-augment.
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

      // Apply the same pre-spawn safety controls as mcp.connect. mcp.test IS
      // a pre-spawn surface (it actually spawns the child to probe it) — an
      // admin (or any code path that landed at this RPC) could pass a raw
      // `ghp_...` PAT in env or spawn `npx <malicious-pkg>` without these
      // guards. Mirror the mcp.connect plaintext-secret guard here. Read from
      // userParams (raw, pre-parse). Per-server opt-out via
      // userParams.disablePlaintextSecretCheck = true logs WARN and allows.
      // Bracketed error code is LLM-readable for self-correction.
      const envBlock = userParams.env as Record<string, string> | undefined;
      const plaintextOptOut = userParams.disablePlaintextSecretCheck === true;
      if (envBlock && !plaintextOptOut) {
        for (const [key, value] of Object.entries(envBlock)) {
          if (typeof value !== "string") continue;
          if (looksLikePlaintextSecret(value)) {
            throw new Error(
              `[plaintext_secret_in_env] env.${key} (test for "${userParams.name as string}") ` +
                `looks like a plaintext credential. ` +
                `Hint: store it via secrets_manage and reference as "\${${key}}".`,
            );
          }
        }
      } else if (envBlock && plaintextOptOut) {
        deps.logger.warn(
          {
            method: "mcp.test",
            entityId: userParams.name as string,
            hint: "disablePlaintextSecretCheck=true — server bypasses plaintext-secret scan",
            errorKind: "config" as const,
          },
          "MCP plaintext-secret check disabled per-server",
        );
      }

      const params = McpTestContract.request.parse(userParams);

      // Plumb operator-extension allowlist + OSV toggles + persisted rlimits
      // from the config root, same as mcp.connect. The optional chain mirrors
      // mcp.connect — test fixtures construct deps without a `container`, in
      // which case the built-in allowlist is the only protection and
      // OSV/rlimits fall back to defaults.
      const mcpConfigRoot = deps.container?.config?.integrations?.mcp as
        | {
            safetyAllowedEnvKeys?: readonly string[];
            osvCheckEnabled?: boolean;
            osvCacheTtlMs?: number;
          }
        | undefined;

      // Rlimits resolution — caller-supplied wins, otherwise read the
      // persisted entry by the user-supplied `name` (NOT the
      // internally-namespaced `__test__<name>` — the persisted entry uses
      // the operator-visible identifier). The handler reads params.rlimits
      // OR persistedEntry.rlimits OR undefined (no wrap).
      // Typed as McpServerEntry[] (Zod-inferred schema type) — see mcp.connect.
      const persistedServers = (deps.container?.config?.integrations?.mcp?.servers ?? []) as McpServerEntry[];
      const persistedEntry = persistedServers.find((s) => s.name === params.name);
      const resolvedRlimits = params.rlimits ?? persistedEntry?.rlimits;

      const config: McpServerConfig = {
        name: `__test__${params.name}`,
        transport: params.transport,
        command: params.command,
        args: params.args,
        url: params.url,
        env: params.env,
        headers: params.headers,
        enabled: true,
        // Plumb the same protections as mcp.connect.
        safetyAllowedEnvKeys: mcpConfigRoot?.safetyAllowedEnvKeys,
        osvCheckEnabled: mcpConfigRoot?.osvCheckEnabled,
        osvCacheTtlMs: mcpConfigRoot?.osvCacheTtlMs,
        rlimits: resolvedRlimits,
        // Source auth/oauth from the persisted entry so a test connection of
        // an oauth server wires the provider too.
        ...(persistedEntry?.auth !== undefined && { auth: persistedEntry.auth }),
        ...(persistedEntry?.oauth !== undefined && { oauth: persistedEntry.oauth }),
      };

      // Pre-spawn env-ref validation. Mirrors the mcp.connect site — reject
      // when any env value references a key not present in the secrets store.
      // Skipped only when secretManager is unwired (test setups).
      if (config.env && deps.secretManager) {
        const sm = deps.secretManager;
        const unresolved = findUnresolvedEnvRefs(config.env, (key) => sm.get(key));
        if (unresolved.length > 0) {
          const missingNames = unresolved.map((u) => u.varName);
          throw new Error(formatMissingEnvRefError(params.name, missingNames));
        }
      }

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

      // Override-rejection guard. reconnect MUST NOT accept
      // transport/command/args/url/headers/env when stored runtime config exists
      // (contract: reconnect re-uses stored config; to change params, disconnect
      // then connect). Throw a raw Error with a bracketed error-code prefix (NOT
      // throwToolError — that lives in @comis/skills, a cross-package boundary).
      // Stored-config presence is proxied by manager.getConnection(name): config
      // and connection are stored/deleted together (mcp-client-connect.ts:108/219).
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
          // Fallback builds from RPC params (no auth/oauth) — source them
          // from the persisted entry so a reconnect-with-params still wires
          // the provider.
          const reconnectPersisted = (
            (deps.container?.config?.integrations?.mcp?.servers ?? []) as McpServerEntry[]
          ).find((s) => s.name === name);
          const config: McpServerConfig = {
            name,
            transport: params.transport,
            command: params.command,
            args: params.args,
            url: params.url,
            env: params.env,
            headers: params.headers,
            enabled: true,
            ...(reconnectPersisted?.auth !== undefined && { auth: reconnectPersisted.auth }),
            ...(reconnectPersisted?.oauth !== undefined && { oauth: reconnectPersisted.oauth }),
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
