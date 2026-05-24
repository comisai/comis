// SPDX-License-Identifier: Apache-2.0
/**
 * MCP OAuth RPC contracts (Phase 66 OAUTH-10 / 66f).
 *
 * Two admin-only RPCs that operate an `auth:"oauth"` MCP server's interactive
 * login lifecycle:
 *   - `mcp.oauth_login`  — run discovery + PKCE + the loopback browser-callback
 *     server-side, exchange the authorization code, persist tokens, reconnect.
 *   - `mcp.oauth_logout` — clear the three on-disk token files so the next
 *     connect forces re-auth.
 *
 * ── Browser launch is CLI-side (resolved_scope #1 / T-66-26) ────────────────
 * `mcp.oauth_login` does NOT open a browser in the daemon (the daemon may run on
 * a remote host with no display). It coordinates the server-side half — bind the
 * loopback callback server, drive the SDK `auth()` flow to obtain the
 * authorization URL, await the callback, exchange the code — and RETURNS the
 * `authUrl` (+ a `portForwardHint` on a headless host) for the CLI to open. The
 * daemon-side `mcp-oauth-handlers.ts` never imports `open`.
 *
 * ── Response status ─────────────────────────────────────────────────────────
 *   - `authorized`    — the callback resolved, the code was exchanged, tokens
 *     are persisted, and the server reconnected.
 *   - `headless_hint` — the daemon host has no local browser; `portForwardHint`
 *     (`ssh -L <port>:localhost:<port> <vps>`) + `authUrl` are returned so the
 *     operator forwards the port and opens the URL themselves (OAUTH-07).
 *   - `failed`        — discovery, the callback (timeout / CSRF), or the
 *     exchange failed. The handler logs with `errorKind` and returns this status
 *     rather than throwing (T-66-27); no exception escapes the dispatcher.
 *
 * ── Scope (T-66-24) ─────────────────────────────────────────────────────────
 * Both contracts are `scopes: ["admin"] as const` — login/logout create and
 * destroy credentials and MUST be privileged. The gateway dispatcher enforces
 * the scope before the handler runs (the existing mechanism, matching every
 * other `mcp.*` contract).
 *
 * ── CI-01 parity (T-66-25) ──────────────────────────────────────────────────
 * Both requests have exactly one required field, `server_name`; the matching
 * handlers in `mcp-oauth-handlers.ts` reference it literally (it keys the token
 * store). `test/architecture/contract-handler-parity.test.ts` auto-discovers
 * this file (`listContractFiles`) and the handler file (`listHandlerFiles`) and
 * asserts the 1:1 field parity.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// mcp.oauth_login
// ---------------------------------------------------------------------------

/**
 * `mcp.oauth_login` — run the interactive OAuth login for one `auth:"oauth"`
 * MCP server. Admin-only.
 *
 * Request: `{ server_name: string }`. The handler reads `server_name`
 * (literal — CI-01) to key the token store + identify the server to reconnect.
 *
 * Response: `{ server_name, status, portForwardHint?, authUrl? }`.
 *   - `server_name` — echoes the request.
 *   - `status` — `"authorized" | "headless_hint" | "failed"` (see module doc).
 *   - `portForwardHint` — present on `headless_hint`: the
 *     `ssh -L <port>:localhost:<port> <vps>` hint (OAUTH-07).
 *   - `authUrl` — present on `headless_hint` (and any flow where the CLI opens
 *     the browser): the authorization URL for the CLI to launch
 *     (resolved_scope #1). NEVER opened daemon-side.
 */
export const McpOauthLoginContract = defineContract({
  method: "mcp.oauth_login",
  request: z.object({
    server_name: z.string().min(1),
  }),
  response: z.object({
    server_name: z.string(),
    status: z.enum(["authorized", "headless_hint", "failed"]),
    // OAUTH-07: "ssh -L <port>:localhost:<port> <vps>" — present on headless_hint.
    portForwardHint: z.string().optional(),
    // resolved_scope #1: the CLI opens this; the daemon NEVER calls open().
    authUrl: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// mcp.oauth_logout
// ---------------------------------------------------------------------------

/**
 * `mcp.oauth_logout` — clear the persisted OAuth credentials for one MCP server
 * (the three token files: `<server>.json` / `.client.json` / `.meta.json`).
 * Admin-only.
 *
 * Request: `{ server_name: string }`. The handler reads `server_name` (literal —
 * CI-01) to key the token-store deletion.
 *
 * Response: `{ server_name, cleared }`. `cleared` is `true` once the token files
 * are removed (idempotent — clearing an already-absent set still reports
 * `true`); the next connect re-runs the full login.
 */
export const McpOauthLogoutContract = defineContract({
  method: "mcp.oauth_logout",
  request: z.object({
    server_name: z.string().min(1),
  }),
  response: z.object({
    server_name: z.string(),
    cleared: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ---------------------------------------------------------------------------

/**
 * MCP-OAuth contract array. Kept SEPARATE from `MCP_CONTRACTS` (mcp.ts) so the
 * handlers live in a separate `mcp-oauth-handlers.ts` away from the ~800-line
 * `mcp-handlers.ts` cap. Registered into `API_CONTRACTS_ORDERED` by
 * `packages/core/src/api-contracts/index.ts`.
 */
export const MCP_OAUTH_CONTRACTS = [
  McpOauthLoginContract,
  McpOauthLogoutContract,
] as const;
