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
  createTokenStore as defaultCreateTokenStore,
  type OAuthLoginResult,
  type RunOauthLoginDeps,
  type TokenStore,
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
   * Disk token-store factory keyed by the tokens dir. Defaults to the real
   * `~/.comis/mcp-tokens/` store. Used by `oauth_logout` to clear the three
   * files; threaded into the login orchestrator so the exchange persists there.
   */
  readonly createTokenStore?: () => TokenStore;
  /**
   * Browser-launch side effect. ALWAYS a daemon-side NO-OP — the daemon never
   * opens a browser; the CLI opens the returned `authUrl`. Injectable so tests
   * can assert it is never a real `open` import.
   */
  readonly openUrl?: (url: string) => void;
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
  const makeTokenStore =
    deps.createTokenStore ?? ((): TokenStore => defaultCreateTokenStore({ logger: deps.logger }));

  return {
    [McpOauthLoginContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guard — produces the legacy "Missing required parameter:
      // server_name" UX. The contract's `.min(1)` is defense-in-depth.
      const nameRaw = rawParams.server_name as string | undefined;
      if (!nameRaw) throw new Error("Missing required parameter: server_name");

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

      // Run the server-side login. The orchestrator owns the SDK auth() call +
      // the loopback callback + saveTokens; it NEVER throws. The daemon
      // openUrl is a no-op — the CLI opens the returned authUrl.
      //
      // Fix 6: on the headless path, runOauthLogin returns immediately with
      // status:"headless_hint" while a background task keeps the loopback
      // alive and awaits the operator's redirect. When the redirect arrives
      // and tokens are persisted, that background task fires `onAuthorized`
      // so the live connection upgrades to the new bearer without an
      // additional RPC. The non-headless path still returns "authorized"
      // synchronously and the post-call branch below handles the reconnect.
      const result = await runOauthLogin({
        serverName: server_name,
        serverUrl: entry.url,
        oauthConfig: entry.oauth ?? {},
        createTokenStore: makeTokenStore,
        openUrl,
        onAuthorized: async (name) => {
          const reconnectResult = await deps.mcpClientManager.reconnect(name);
          if (!reconnectResult.ok) {
            // Tokens persisted but reconnect failed — surface a WARN so the
            // operator knows to retry mcp.reconnect. Throwing here would
            // propagate to runOauthLogin's background try/catch which
            // already logs a fallback WARN; throwing communicates the same
            // diagnostic upstream without duplicating the failure log.
            throw new Error(reconnectResult.error.message);
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
      };
      // Dev-mode response validation gate.
      if (systemGetEnv("NODE_ENV") !== "production") {
        McpOauthLoginContract.response.parse(response);
      }
      return response;
    },

    [McpOauthLogoutContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guard — produces the legacy "Missing required parameter:
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

      // Clear the three token files (<server>.json / .client.json / .meta.json).
      // deleteAll is idempotent — clearing an already-absent set still succeeds,
      // so cleared:true reflects "no credentials remain". A close()
      // releases the store's disk-watch when the default store was constructed.
      const tokenStore = makeTokenStore();
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
