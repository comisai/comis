// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command entry point; throws are caught by each subcommand's
// try/catch which converts them to error()/process.exit(1) at the Commander.js
// boundary (CLI user-facing flows exception). ensureGatewayToken
// throws a named-env-var error that the catch converts to exit(1).
/**
 * MCP OAuth login/logout CLI subcommands.
 *
 * Provides `comis mcp login <server>` and `comis mcp logout <server>`,
 * registered onto the `mcp` command group via {@link registerMcpOauth}.
 *
 * ── Browser launch is CLI-side ───────────────────────────────────────────────
 * `mcp.oauth_login` runs the server-side half (loopback callback server,
 * discovery, PKCE, code exchange) and RETURNS the authorization URL — the
 * daemon never imports `open` because it may run on a remote/headless host.
 * The interactive host (local CLI) is where the browser actually opens — but
 * NOT from this CLI handler. The orchestrator's non-headless path
 * already opens the browser via its injected `openUrl` (login.ts:315) BEFORE
 * it awaits the callback, so by the time `mcp.oauth_login` returns
 * `status: "authorized"` the exchange has already completed and the
 * authorization URL's `state` parameter is spent. Re-opening the URL here
 * navigates the operator to a provider error page. The CLI surfaces:
 *   - `status:"headless_hint"` → PRINT `portForwardHint` + `authUrl`; do NOT
 *     open a browser (the daemon host has no display).
 *     The operator forwards the port + opens the URL themselves.
 *   - `status:"authorized"` → print success only. NEVER call `open()`: the
 *     URL is spent. The daemon-side `openUrl` injected into
 *     `runOauthLogin` is what opens the browser at the right moment.
 *
 * ── Token resolution ─────────────────────────────────────────────────────────
 * Each action calls `ensureGatewayToken(opts.token)` BEFORE `withClient` opens
 * the socket, so a missing gateway token surfaces a friendly error naming
 * `COMIS_GATEWAY_TOKEN` rather than opening an unauthenticated socket.
 *
 * ── Non-zero exit on failure ─────────────────────────────────────────────────
 * Commander does NOT set a non-zero exit code on a rejected action promise.
 * Each subcommand wraps its body in try/catch → `error(...)` + `process.exit(1)`
 * so a failed login does not silently exit 0. A
 * `status:"failed"` response is routed through the same catch.
 *
 * No token material is ever logged: the RPC responses carry only
 * `status`/`authUrl`/`portForwardHint`/`cleared` — never access/refresh tokens.
 *
 * @module
 */

import { McpOauthLoginContract, McpOauthLogoutContract } from "@comis/core";
import type { Command } from "commander";
// The `open` import is intentionally absent. The CLI must NOT open
// the authUrl returned on `status: "authorized"` — its `state` parameter is
// spent by the time the daemon-side orchestrator returns. The orchestrator
// itself opens the browser via the daemon's injected `openUrl` at the right
// moment (login.ts:315). On `headless_hint` the CLI prints the URL for the
// operator to open manually. Adding `import open from "open"` here would
// regress this fix.
import { withClient, callTyped } from "../client/rpc-client.js";
import { success, error, info } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { ensureGatewayToken } from "./mcp-token.js";

const TOKEN_FLAG_DESCRIPTION =
  "Gateway token (overrides COMIS_GATEWAY_TOKEN env var). Prefer COMIS_GATEWAY_TOKEN or ~/.comis/.env — a token on the command line is visible via ps/proc and shell history.";

/**
 * Register the `login` / `logout` OAuth subcommands onto an existing `mcp`
 * command group (`registerMcpCommand` calls this after the other
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
          // Route through the catch so the exit code is non-zero.
          throw new Error(
            `OAuth login failed for MCP server "${name}". Check the daemon logs for the cause (discovery, callback timeout, or token exchange).`,
          );
        }

        if (result.status === "headless_hint") {
          // Headless host: never open a browser — print the port-forward hint
          // + the URL for the operator to forward and open themselves.
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
        //
        // The orchestrator (runOauthLogin) finished the second auth()
        // call and persisted the tokens BEFORE returning. The authUrl in the
        // response is the URL the SDK built during the first auth() pass —
        // it carries a `state` parameter that has been consumed by the now-
        // closed loopback callback server. Opening it here:
        //   1. Navigates the operator to a provider error page
        //      ("invalid_state" / "code already used") — confusing UX.
        //   2. Leaks the spent `state` to the browser URL bar + history.
        //   3. Is redundant — the orchestrator's non-headless branch already
        //      opened the browser at the correct moment (login.ts:315).
        // Print success only; do NOT call open().
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
