// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command entry point; throws are caught by each subcommand's
// try/catch which converts them to error()/process.exit(1) at the Commander.js
// boundary per AGENTS.md §2.1 CLI user-facing flows exception. ensureGatewayToken
// throws a named-env-var error that the catch converts to exit(1).
/**
 * MCP OAuth login/logout CLI subcommands (Phase 66 OAUTH-10 / 66g).
 *
 * Provides `comis mcp login <server>` and `comis mcp logout <server>`,
 * registered onto Phase 65's `mcp` command group via {@link registerMcpOauth}.
 *
 * ── Browser launch is CLI-side (resolved_scope #1 / T-66-26) ────────────────
 * `mcp.oauth_login` runs the server-side half (loopback callback server,
 * discovery, PKCE, code exchange) and RETURNS the authorization URL — the
 * daemon never imports `open` because it may run on a remote/headless host.
 * This CLI is the interactive host, so it is where the browser actually opens:
 *   - `status:"headless_hint"` → PRINT `portForwardHint` + `authUrl`; do NOT
 *     open a browser (the daemon host has no display — T-66-30 / OAUTH-07).
 *   - otherwise, when an `authUrl` is returned → `open(authUrl)` locally.
 *   - `status:"authorized"` with no `authUrl` (already-authorized fast path) →
 *     print success only.
 *
 * ── Token resolution (OPUX-07 / 65-P1, T-66-28) ─────────────────────────────
 * Each action calls `ensureGatewayToken(opts.token)` BEFORE `withClient` opens
 * the socket, so a missing gateway token surfaces a friendly error naming
 * `COMIS_GATEWAY_TOKEN` rather than opening an unauthenticated socket.
 *
 * ── Non-zero exit on failure (T-66-29) ──────────────────────────────────────
 * Commander does NOT set a non-zero exit code on a rejected action promise.
 * Each subcommand wraps its body in try/catch → `error(...)` + `process.exit(1)`
 * (the Phase 65 pattern) so a failed login does not silently exit 0. A
 * `status:"failed"` response is routed through the same catch.
 *
 * No token material is ever logged: the RPC responses carry only
 * `status`/`authUrl`/`portForwardHint`/`cleared` — never access/refresh tokens.
 *
 * @module
 */

import { McpOauthLoginContract, McpOauthLogoutContract } from "@comis/core";
import type { Command } from "commander";
import open from "open";
import { withClient, callTyped } from "../client/rpc-client.js";
import { success, error, info } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { ensureGatewayToken } from "./mcp.js";

const TOKEN_FLAG_DESCRIPTION =
  "Gateway token (overrides COMIS_GATEWAY_TOKEN env var). Prefer COMIS_GATEWAY_TOKEN or ~/.comis/.env — a token on the command line is visible via ps/proc and shell history (WR-02).";

/**
 * Register the `login` / `logout` OAuth subcommands onto an existing `mcp`
 * command group (Phase 65's `registerMcpCommand` calls this after the other
 * subcommands). Kept in its own module so `mcp.ts` stays focused.
 *
 * @param mcp - The `mcp` Commander command created by `registerMcpCommand`.
 */
export function registerMcpOauth(mcp: Command): void {
  // mcp login <name>
  mcp
    .command("login <name>")
    .description(
      "Run the interactive OAuth login for an auth:\"oauth\" MCP server (opens a browser locally; prints a port-forward hint on a headless host)",
    )
    .option("--token <token>", TOKEN_FLAG_DESCRIPTION)
    .action(async (name: string, options: { token?: string }) => {
      try {
        ensureGatewayToken(options.token);
        const result = await withSpinner(
          `Starting OAuth login for "${name}"...`,
          () =>
            withClient(async (client) =>
              callTyped(client, McpOauthLoginContract, { server_name: name }),
            ),
        );

        if (result.status === "failed") {
          // Route through the catch so the exit code is non-zero (T-66-29).
          throw new Error(
            `OAuth login failed for MCP server "${name}". Check the daemon logs for the cause (discovery, callback timeout, or token exchange).`,
          );
        }

        if (result.status === "headless_hint") {
          // Headless host: never open a browser — print the port-forward hint
          // + the URL for the operator to forward and open themselves
          // (T-66-30 / OAUTH-07).
          info(
            `Headless host detected — no local browser. Forward the callback port, then open the URL below:`,
          );
          if (result.portForwardHint) {
            info(`  ${result.portForwardHint}`);
          }
          if (result.authUrl) {
            info(`  ${result.authUrl}`);
          }
          return;
        }

        // status === "authorized".
        if (result.authUrl) {
          // CLI-side browser launch (resolved_scope #1) — the daemon returned
          // a URL for THIS interactive host to open.
          await open(result.authUrl);
          success(
            `Opened your browser to authorize MCP server "${name}". Complete the login in the browser; the daemon finishes the exchange and reconnects.`,
          );
          return;
        }

        // Already-authorized fast path (no browser needed).
        success(`MCP server "${name}" authorized.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to log in to MCP server: ${msg}`);
        process.exit(1);
      }
    });

  // mcp logout <name>
  mcp
    .command("logout <name>")
    .description(
      "Clear the stored OAuth credentials for an MCP server (forces re-auth on the next connect)",
    )
    .option("--token <token>", TOKEN_FLAG_DESCRIPTION)
    .action(async (name: string, options: { token?: string }) => {
      try {
        ensureGatewayToken(options.token);
        const result = await withSpinner(
          `Clearing OAuth credentials for "${name}"...`,
          () =>
            withClient(async (client) =>
              callTyped(client, McpOauthLogoutContract, { server_name: name }),
            ),
        );

        if (result.cleared) {
          success(`Cleared OAuth credentials for MCP server "${name}".`);
        } else {
          // Idempotent: nothing to clear is not an error — report it and exit 0.
          info(`No OAuth credentials were stored for MCP server "${name}".`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to clear OAuth credentials: ${msg}`);
        process.exit(1);
      }
    });
}
