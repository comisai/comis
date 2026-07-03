// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * MCP OAuth RPC handler module.
 *
 * Two admin-only handlers, 1:1 with `mcp-oauth.ts` contracts (field parity):
 *   - `mcp.oauth_login`  — coordinate the server-side OAuth login (discovery +
 *     PKCE + the loopback browser-callback), persist tokens, reconnect, and
 *     RETURN the authorization URL for the CLI to open.
 *   - `mcp.oauth_logout` — clear the three on-disk token files so the next
 *     connect forces re-auth.
 *
 * ── Browser launch is CLI-side ──────────────────────────────────────────────
 * This module NEVER imports `open` and the daemon NEVER launches a browser (it
 * may run on a remote host). `mcp.oauth_login` runs the loopback callback server
 * + the SDK `auth()` flow server-side (via the `runOauthLogin` orchestrator in
 * `@comis/skills`, which owns the SDK dependency) and returns `authUrl` (+ a
 * `portForwardHint` on a headless host) for the CLI to act on. The injected
 * `openUrl` is a daemon-side NO-OP.
 *
 * ── No throw escapes the login handler ──────────────────────────────────────
 * Login failures (discovery cascade fail, callback timeout / CSRF, exchange
 * error) return `status: "failed"` — the orchestrator catches and reports rather
 * than throwing. The handler's own pre-flight guards (missing server, not an
 * `auth:"oauth"` server) DO throw for the actionable "Missing required
 * parameter" / "not configured for OAuth" UX (the dispatcher converts to a
 * JSON-RPC error), matching the `mcp-handlers.ts` convention.
 *
 * ── Field parity ─────────────────────────────────────────────────────────────
 * Both handlers reference `server_name` literally (it keys the token store +
 * the reconnect target). `test/architecture/contract-handler-parity.test.ts`
 * auto-discovers this `-handlers.ts` file and asserts the 1:1 field parity.
 *
 * SECURITY: tokens, the PKCE `code_verifier`, the CSRF `state`, and the
 * authorization `code` are NEVER logged. The orchestrator owns the secret
 * lifecycle; this handler only logs the server name + the login status.
 *
 * @module
 */

import {
  McpOauthLoginContract,
  McpOauthLogoutContract,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";
import type { McpServerEntry } from "@comis/core";
import {
  runOauthLogin as defaultRunOauthLogin,
  type OAuthLoginResult,
  type RunOauthLoginDeps,
  type TokenStore,
  type McpServerConfig,
} from "@comis/skills";

import type { WorkspaceApiDeps, RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Deps for the MCP OAuth handlers. Reuses the {@link WorkspaceApiDeps} slice
 * (already carries `mcpClientManager`, `logger`, `container` for the persisted
 * server config). The login orchestrator + token-store factory are injectable so
 * unit tests supply a fake login runner + a tmpdir-backed store; production
 * defaults to the real `@comis/skills` exports.
 */
export interface McpOauthHandlerDeps extends WorkspaceApiDeps {
  /**
   * The interactive OAuth login orchestrator (server-side discovery + callback +
   * SDK auth() + saveTokens). Defaults to the real `@comis/skills` `runOauthLogin`.
   */
  readonly runOauthLogin?: (deps: RunOauthLoginDeps) => Promise<OAuthLoginResult>;
  /**
   * The mode-selected MCP OAuth token-store factory (selectMcpTokenStore via the
   * daemon's pass-through). Returns the SAME instance the manager wiring uses.
   * MAY return undefined in `env` storage mode (no writable store) — the login
   * handler guards on that and fails loudly rather than falling back to a
   * plaintext disk store. Used by `oauth_logout` to clear credentials and
   * threaded into the login orchestrator so the exchange persists to the
   * mode-selected backend.
   */
  readonly createTokenStore?: () => TokenStore | undefined;
  /**
   * Browser-launch side effect. ALWAYS a daemon-side NO-OP — the daemon never
   * opens a browser; the CLI opens the returned `authUrl`. Injectable so tests
   * can assert it is never a real `open` import.
   */
  readonly openUrl?: (url: string) => void;
  /**
   * Push a short completion message back to the operator's channel after a
   * headless OAuth login successfully connects the MCP server. The headless
   * login flow lands the connection asynchronously: the RPC returns
   * `headless_hint` immediately, the operator authorizes in their browser,
   * and the daemon-side background task completes the token exchange + the
   * `manager.connect`. There is no path that wakes the agent at the moment
   * of completion, so without this hook the agent stays silent until the
   * operator explicitly asks "is it connected?" (observed against a live
   * install — 27 tools discovered, agent silent).
   *
   * Wired by `rpc-dispatch.ts` to
   * `deliveryService.deliverToChannel(adaptersByType[channelType], …)` —
   * the same chokepoint `message.send` uses. The target is captured from
   * the RPC's `_deliveryTarget` (`setup-tools.ts:289-303` injects this
   * onto every agent-initiated call). Optional — undefined skips the
   * notification cleanly (e.g., CLI-initiated logins where there is no
   * channel to address; the operator sees the result in their terminal).
   */
  readonly notifyOperatorChannel?: (
    target: { channelType: string; channelId: string; userId?: string; tenantId?: string },
    text: string,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the persisted MCP server entry by name (or undefined). */
function findServerEntry(
  deps: McpOauthHandlerDeps,
  serverName: string,
): McpServerEntry | undefined {
  const servers = (deps.container?.config?.integrations?.mcp?.servers ?? []) as McpServerEntry[];
  return servers.find((s) => s.name === serverName);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the MCP OAuth RPC handlers bound to the given deps. Returns exactly the
 * two keys `[McpOauthLoginContract.method, McpOauthLogoutContract.method]`.
 */
export function createMcpOauthHandlers(
  deps: McpOauthHandlerDeps,
): Record<string, RpcHandler> {
  // The daemon NEVER opens a browser. A no-op is the default
  // (the CLI opens the returned authUrl). Injectable only so tests can assert it.
  const openUrl = deps.openUrl ?? ((): void => undefined);
  const runOauthLogin = deps.runOauthLogin ?? defaultRunOauthLogin;

  // Fail loudly — never fall back to a plaintext disk store. The token store is
  // the ONE mode-selected instance (selectMcpTokenStore) threaded via the
  // daemon pass-through `() => boot.mcpTokenStore`. In `env` storage mode that
  // factory is absent OR returns undefined (no writable MCP OAuth store); both
  // shapes mean "no place to persist MCP OAuth credentials". Surface an
  // actionable storage-mode error (this module is `// @allow-throw:` —
  // rpc-dispatch.ts:306-321 converts it to a JSON-RPC error) instead of silently
  // downgrading to a plaintext `mcp-tokens/` write that the mode-selected
  // manager would never read back (a writer/reader split-brain).
  const resolveTokenStore = (): TokenStore => {
    const store = deps.createTokenStore?.();
    if (store === undefined) {
      throw new Error(
        'MCP OAuth login requires security.storage "file" or "encrypted" ' +
          "(current mode has no credential store).",
      );
    }
    return store;
  };

  return {
    [McpOauthLoginContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guard — produces the user-friendly "Missing required parameter:
      // server_name" UX. The contract's `.min(1)` is defense-in-depth.
      const nameRaw = rawParams.server_name as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: server_name");

      // Capture the operator's channel target BEFORE stripping internals so
      // the headless background completion can push a notification
      // back to the same chat that initiated this login. The dispatcher
      // injects `_deliveryTarget` on every agent-initiated RPC at
      // `setup-tools.ts:289-303`; CLI-initiated `comis mcp login` calls
      // omit it (operator sees the result in their terminal).
      const deliveryTarget = rawParams._deliveryTarget as
        | { channelType: string; channelId: string; userId?: string; tenantId?: string }
        | undefined;

      // Strip dispatcher-injected _X internals BEFORE contract parse.
      const userParams = stripInternalFields(rawParams);
      const params = McpOauthLoginContract.request.parse(userParams);
      // Field parity: reference server_name literally (it keys the token store + reconnect).
      const server_name = params.server_name;

      // Resolve the persisted server config. Login requires an `auth:"oauth"`
      // server with a URL (the SDK needs the resource-server URL for discovery).
      const entry = findServerEntry(deps, server_name);
      if (!entry) {
        throw new Error(`MCP server not found: "${server_name}"`);
      }
      if (entry.auth !== "oauth") {
        throw new Error(
          `MCP server "${server_name}" is not configured for OAuth (auth: "oauth" required).`,
        );
      }
      if (!entry.url) {
        throw new Error(
          `MCP server "${server_name}" has no url; OAuth discovery requires a remote (sse/http) server URL.`,
        );
      }

      // Resolve the mode-selected token store BEFORE driving the login. Fail
      // loudly here (at the handler boundary, so the dispatcher returns a clear
      // JSON-RPC error) rather than inside runOauthLogin — the orchestrator
      // catches its own errors and would mask the storage-mode signal as a
      // generic status:"failed". In env mode there is no writable store; we must
      // never fall back to a plaintext mcp-tokens/ write.
      const tokenStore = resolveTokenStore();

      // Run the server-side login. The orchestrator owns the SDK auth() call +
      // the loopback callback + saveTokens; it NEVER throws. The daemon
      // openUrl is a no-op — the CLI opens the returned authUrl.
      //
      // On the headless path, runOauthLogin returns immediately with
      // status:"headless_hint" while a background task keeps the loopback
      // alive and awaits the operator's redirect. When the redirect arrives
      // and tokens are persisted, that background task fires `onAuthorized`
      // so the live connection upgrades to the new bearer without an
      // additional RPC. The non-headless path still returns "authorized"
      // synchronously and the post-call branch below handles the reconnect.
      //
      // The hook calls manager.connect (NOT reconnect). The connect handler in
      // mcp-handlers.ts short-circuits the initial manager.connect when
      // params.auth==="oauth" AND no token exists yet, so state.serverConfigs
      // is empty at the moment OAuth completes. manager.reconnect throws
      // "no stored config -- use connect() instead" against an empty map;
      // we build the McpServerConfig from the persisted entry (the short-circuit
      // wrote it to container.config.integrations.mcp.servers + disk) and
      // hand it straight to manager.connect, which threads through
      // prepareOAuthProvider and reads the now-valid tokens from the store.
      const result = await runOauthLogin({
        serverName: server_name,
        serverUrl: entry.url,
        oauthConfig: entry.oauth ?? {},
        // Hand the already-resolved (guaranteed non-undefined) store to the
        // orchestrator. The guard above already failed loudly if none exists.
        createTokenStore: () => tokenStore,
        openUrl,
        onAuthorized: async (name) => {
          const persistedServers =
            (deps.container?.config?.integrations?.mcp?.servers ?? []) as McpServerEntry[];
          const persistedEntry = persistedServers.find((s) => s.name === name);
          if (persistedEntry === undefined) {
            throw new Error(
              `Persisted entry for "${name}" not found after OAuth — config out of sync; ` +
                `retry mcp_manage(action:"connect", server_name:"${name}").`,
            );
          }
          const mcpConfigRoot = deps.container?.config?.integrations?.mcp as
            | {
                safetyAllowedEnvKeys?: readonly string[];
                osvCheckEnabled?: boolean;
                osvCacheTtlMs?: number;
              }
            | undefined;
          // Map the persisted entry to an McpServerConfig. The shapes overlap
          // by design (McpServerEntrySchema is the persistence projection of
          // McpServerConfig minus runtime-only fields like `oauthProvider`),
          // so this is a field-by-field copy. The integrations.mcp root
          // settings (safety/OSV) are merged in last — they live above the
          // per-entry shape and the manager reads them from the config root.
          const reconnectConfig: McpServerConfig = {
            name: persistedEntry.name,
            transport: persistedEntry.transport,
            enabled: true,
            ...(persistedEntry.command !== undefined && { command: persistedEntry.command }),
            ...(persistedEntry.args !== undefined && { args: persistedEntry.args }),
            ...(persistedEntry.url !== undefined && { url: persistedEntry.url }),
            ...(persistedEntry.env !== undefined && { env: persistedEntry.env }),
            ...(persistedEntry.cwd !== undefined && { cwd: persistedEntry.cwd }),
            ...(persistedEntry.headers !== undefined && { headers: persistedEntry.headers }),
            ...(persistedEntry.maxConcurrency !== undefined && { maxConcurrency: persistedEntry.maxConcurrency }),
            ...(persistedEntry.rlimits !== undefined && { rlimits: persistedEntry.rlimits }),
            ...(persistedEntry.keepaliveIntervalMs !== undefined && { keepaliveIntervalMs: persistedEntry.keepaliveIntervalMs }),
            ...(persistedEntry.circuitBreakerThreshold !== undefined && { circuitBreakerThreshold: persistedEntry.circuitBreakerThreshold }),
            ...(persistedEntry.circuitBreakerCooldownMs !== undefined && { circuitBreakerCooldownMs: persistedEntry.circuitBreakerCooldownMs }),
            ...(persistedEntry.toolAllowlist !== undefined && { toolAllowlist: persistedEntry.toolAllowlist }),
            ...(persistedEntry.toolBlocklist !== undefined && { toolBlocklist: persistedEntry.toolBlocklist }),
            ...(persistedEntry.idleTtlMs !== undefined && persistedEntry.idleTtlMs > 0 && { idleTtlMs: persistedEntry.idleTtlMs }),
            ...(persistedEntry.enableResources !== undefined && { enableResources: persistedEntry.enableResources }),
            ...(persistedEntry.enablePrompts !== undefined && { enablePrompts: persistedEntry.enablePrompts }),
            ...(persistedEntry.supportsParallelToolCalls !== undefined && { supportsParallelToolCalls: persistedEntry.supportsParallelToolCalls }),
            ...(persistedEntry.auth !== undefined && { auth: persistedEntry.auth }),
            ...(persistedEntry.oauth !== undefined && { oauth: persistedEntry.oauth }),
            ...(mcpConfigRoot?.safetyAllowedEnvKeys !== undefined && { safetyAllowedEnvKeys: mcpConfigRoot.safetyAllowedEnvKeys }),
            ...(mcpConfigRoot?.osvCheckEnabled !== undefined && { osvCheckEnabled: mcpConfigRoot.osvCheckEnabled }),
            ...(mcpConfigRoot?.osvCacheTtlMs !== undefined && { osvCacheTtlMs: mcpConfigRoot.osvCacheTtlMs }),
          };
          const connectResult = await deps.mcpClientManager.connect(reconnectConfig);
          if (!connectResult.ok) {
            // Tokens persisted but connect failed — surface a WARN so the
            // operator knows to retry. Throwing propagates to runOauthLogin's
            // background try/catch which logs a fallback WARN.
            throw new Error(connectResult.error.message);
          }
          // Push a short completion message back to the operator's
          // channel. Without this the agent stays silent until the operator
          // asks "is X connected?" (observed live: 27 tools discovered,
          // agent silent). Skip cleanly when the login
          // came in without a channel target (CLI-initiated) OR when the
          // notify hook is unwired (test harnesses). A notification failure
          // does NOT roll back the persisted tokens or the live connection
          // — it is purely a UX side-effect, logged at WARN if it throws.
          if (deliveryTarget !== undefined && deps.notifyOperatorChannel !== undefined) {
            const toolCount = connectResult.value.tools.length;
            try {
              await deps.notifyOperatorChannel(
                deliveryTarget,
                `✓ MCP server "${name}" connected — ${toolCount} tool${toolCount === 1 ? "" : "s"} available.`,
              );
            } catch (notifyErr) {
              deps.logger.warn(
                {
                  method: "mcp.oauth_login",
                  entityId: name,
                  err: notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
                  hint: "Headless OAuth + connect succeeded; only the operator notification failed. The connection is live; tools are registered.",
                  errorKind: "platform" as const,
                },
                "Headless-OAuth completion notification failed",
              );
            }
          }
        },
        logger: deps.logger,
      });

      // On authorized: reconnect so the now-valid provider attaches and tools load.
      if (result.status === "authorized") {
        const reconnectResult = await deps.mcpClientManager.reconnect(server_name);
        if (!reconnectResult.ok) {
          // Tokens persisted but reconnect failed — surface as failed so the
          // operator retries the connect; do NOT claim authorized.
          deps.logger.warn(
            {
              method: "mcp.oauth_login",
              entityId: server_name,
              err: reconnectResult.error.message,
              hint: "OAuth tokens persisted but the server failed to reconnect; retry mcp.reconnect",
              errorKind: "config" as const,
            },
            "OAuth login persisted tokens but reconnect failed",
          );
          const failedReconnect = {
            server_name,
            status: "failed" as const,
            ...(result.authUrl !== undefined ? { authUrl: result.authUrl } : {}),
          };
          if (systemGetEnv("NODE_ENV") !== "production") {
            McpOauthLoginContract.response.parse(failedReconnect);
          }
          return failedReconnect;
        }
      }

      const response = {
        server_name,
        status: result.status,
        ...(result.portForwardHint !== undefined
          ? { portForwardHint: result.portForwardHint }
          : {}),
        ...(result.authUrl !== undefined ? { authUrl: result.authUrl } : {}),
        // Device-flow path surfaces verification fields. Non-
        // secret per RFC 8628 §6.1 (userCode is one-shot + time-bound;
        // verificationUri is the provider's public endpoint). Conditional-
        // spread keeps the PKCE path's response shape unchanged.
        ...(result.verificationUri !== undefined
          ? { verificationUri: result.verificationUri }
          : {}),
        ...(result.userCode !== undefined ? { userCode: result.userCode } : {}),
        ...(result.expiresIn !== undefined ? { expiresIn: result.expiresIn } : {}),
      };
      // Dev-mode response validation gate.
      if (systemGetEnv("NODE_ENV") !== "production") {
        McpOauthLoginContract.response.parse(response);
      }
      return response;
    },

    [McpOauthLogoutContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guard — produces the user-friendly "Missing required parameter:
      // server_name" UX. The contract's `.min(1)` is defense-in-depth.
      const nameRaw = rawParams.server_name as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: server_name");

      // Strip dispatcher-injected _X internals BEFORE contract parse.
      const userParams = stripInternalFields(rawParams);
      const params = McpOauthLogoutContract.request.parse(userParams);
      // Field parity: reference server_name literally (it keys the token-store deletion).
      const server_name = params.server_name;

      // Gate the destructive deleteAll() on the same persisted-server
      // existence check the login handler uses. Without this guard an
      // admin-scope caller could clear token files for ANY string the
      // `safePath` substrate accepts under mcp-tokens/ — including names that
      // were never configured (a typo, or another daemon's tokens in a shared
      // directory). The schema-level `/^[a-zA-Z0-9_-]+$/` constraint lives on
      // McpServerEntrySchema, NOT on the RPC contract, so the contract alone
      // does not stop arbitrary names. Mirror the login handler's guard.
      const entry = findServerEntry(deps, server_name);
      if (!entry) {
        throw new Error(`MCP server not found: "${server_name}"`);
      }

      // Clear the stored MCP OAuth credentials for the server. deleteAll is
      // idempotent — clearing an already-absent set still succeeds, so
      // cleared:true reflects "no credentials remain". A close() releases the
      // store's disk-watch (no-op for the encrypted store). resolveTokenStore
      // fails loudly in env mode (no writable store) rather than constructing a
      // plaintext disk store just to delete from it.
      const tokenStore = resolveTokenStore();
      await tokenStore.deleteAll(server_name);
      await tokenStore.close();

      deps.logger.info(
        { method: "mcp.oauth_logout", entityId: server_name },
        "OAuth credentials cleared; next connect forces re-auth",
      );

      const response = { server_name, cleared: true };
      // Dev-mode response validation gate.
      if (systemGetEnv("NODE_ENV") !== "production") {
        McpOauthLogoutContract.response.parse(response);
      }
      return response;
    },
  };
}
