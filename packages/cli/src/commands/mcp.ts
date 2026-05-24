// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command entry point; throws caught by Commander.js error handler boundary per AGENTS.md §2.1 CLI user-facing flows exception. ensureGatewayToken throws a named-env-var error that each subcommand's catch converts to error()/process.exit(1).
/**
 * MCP server management commands: list, status, connect, disconnect, reconnect, test.
 *
 * Provides `comis mcp [list|status|connect|disconnect|reconnect|test]`
 * subcommands for managing MCP server connections via the daemon RPC
 * interface. Every subcommand dispatches the matching `mcp.*` RPC through
 * the architecture-mandated typed dispatcher `callTyped(client, Contract,
 * params)` (enforced by test/architecture/cli-uses-typed-rpc.test.ts) inside
 * a `withClient` socket lifetime.
 *
 * Token resolution (OPUX-07 / 65-P1): each subcommand calls
 * `ensureGatewayToken(opts.token)` BEFORE the socket opens so a missing
 * gateway token surfaces a friendly error naming `COMIS_GATEWAY_TOKEN`
 * rather than a generic 401 from the daemon handshake. The `--token` flag
 * overrides the env var (read from `~/.comis/.env`).
 *
 * @module
 */

import {
  McpListContract,
  McpStatusContract,
  McpConnectContract,
  McpDisconnectContract,
  McpReconnectContract,
  McpTestContract,
} from "@comis/core";
import type { Command } from "commander";
import chalk from "chalk";
import { withClient, callTyped } from "../client/rpc-client.js";
import { success, error, info, warn, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable } from "../output/table.js";
import { ensureGatewayToken } from "./mcp-token.js";
import { registerMcpOauth } from "./mcp-oauth.js";

// Re-export ensureGatewayToken so existing external consumers that import it
// from "./mcp.js" (or "@comis/cli/commands/mcp") see no API surface change.
// The actual implementation lives in mcp-token.ts to break the intra-package
// `mcp.ts` ↔ `mcp-oauth.ts` cycle (66-09 final-gate Rule 1 fix).
export { ensureGatewayToken } from "./mcp-token.js";

/**
 * Color-code an MCP connection status string for table/detail output.
 */
function colorStatus(status: string): string {
  switch (status) {
    case "connected":
      return chalk.green(status);
    case "disconnected":
      return chalk.gray(status);
    case "connecting":
    case "reconnecting":
      return chalk.yellow(status);
    case "error":
      return chalk.red(status);
    default:
      return chalk.white(status);
  }
}

/**
 * Format an epoch-ms health-check timestamp. The `mcp.list` row carries
 * `lastHealthCheck` as a required number; `0` means "never checked".
 */
function formatHealthCheck(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString() : "—";
}

/**
 * Register the `mcp` subcommand group on the program.
 *
 * @param program - The root Commander program
 */
export function registerMcpCommand(program: Command): void {
  const mcp = program.command("mcp").description("MCP server management");

  // mcp list
  mcp
    .command("list")
    .description("List all MCP server connections (name, transport, status, tool count)")
    .option("--format <format>", "Output format (table|json)", "table")
    .option("--token <token>", "Gateway token (overrides COMIS_GATEWAY_TOKEN env var). Prefer COMIS_GATEWAY_TOKEN or ~/.comis/.env — a token on the command line is visible via ps/proc and shell history (WR-02).")
    .action(async (options: { format: string; token?: string }) => {
      try {
        ensureGatewayToken(options.token);
        const result = await withSpinner("Fetching MCP servers...", () =>
          withClient(async (client) => {
            return await callTyped(client, McpListContract, {});
          }),
        );

        // --format json must ALWAYS emit machine-parseable JSON, including the
        // empty-list case ({ servers: [], total: 0 }) — operators and tooling
        // pipe `mcp list --format json` and a human-readable "No MCP servers"
        // line would break the parse. The empty-list friendly message is for
        // the default (table) format only.
        if (options.format === "json") {
          json(result);
          return;
        }

        if (result.servers.length === 0) {
          info("No MCP servers configured");
          return;
        }

        renderTable(
          ["Name", "Transport", "Status", "Tools", "Last Check", "Reconnect Attempt"],
          result.servers.map((s) => [
            s.name,
            // The mcp.list response does NOT carry the transport field —
            // display a placeholder (see api-contracts/mcp.ts McpListServerEntrySchema).
            "—",
            colorStatus(s.status),
            String(s.toolCount),
            formatHealthCheck(s.lastHealthCheck),
            String(s.reconnectAttempt),
          ]),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to list MCP servers: ${msg}`);
        process.exit(1);
      }
    });

  // mcp status <name>
  mcp
    .command("status <name>")
    .description("Show detailed status for one MCP server (tools, capabilities, serverInfo)")
    .option("--format <format>", "Output format (table|json)", "table")
    .option("--token <token>", "Gateway token (overrides COMIS_GATEWAY_TOKEN env var). Prefer COMIS_GATEWAY_TOKEN or ~/.comis/.env — a token on the command line is visible via ps/proc and shell history (WR-02).")
    .action(async (name: string, options: { format: string; token?: string }) => {
      try {
        ensureGatewayToken(options.token);
        const result = await withSpinner(`Fetching status for "${name}"...`, () =>
          withClient(async (client) => {
            return await callTyped(client, McpStatusContract, { server_name: name });
          }),
        );

        if (options.format === "json") {
          json(result);
          return;
        }

        info(`Server: ${chalk.bold(result.name)}`);
        info(`Status: ${colorStatus(result.status)}`);
        info(`Tools: ${result.toolCount}`);
        if (result.tools.length > 0) {
          for (const tool of result.tools) {
            info(`  - ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`);
          }
        }
        info(
          `Capabilities: ${
            result.capabilities ? JSON.stringify(result.capabilities) : "—"
          }`,
        );
        info(
          `Server Info: ${
            result.serverInfo ? `${result.serverInfo.name} v${result.serverInfo.version}` : "—"
          }`,
        );
        if (result.error) {
          warn(`Error: ${result.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch MCP server status: ${msg}`);
        process.exit(1);
      }
    });

  // mcp test <name>
  mcp
    .command("test <name>")
    .description("Probe an MCP server config WITHOUT persisting it")
    .requiredOption("--transport <transport>", "Transport protocol (stdio|sse|http)")
    .option("--command <command>", "Executable path (stdio only)")
    .option("--args <args...>", "Command-line arguments (stdio only; variadic)")
    .option("--url <url>", "Server URL (sse/http only)")
    .option("--format <format>", "Output format (table|json)", "table")
    .option("--token <token>", "Gateway token (overrides COMIS_GATEWAY_TOKEN env var). Prefer COMIS_GATEWAY_TOKEN or ~/.comis/.env — a token on the command line is visible via ps/proc and shell history (WR-02).")
    .action(
      async (
        name: string,
        options: {
          transport: string;
          command?: string;
          args?: string[];
          url?: string;
          format: string;
          token?: string;
        },
      ) => {
        // Pre-RPC transport-required-field validation (mirrors connect).
        if (options.transport === "stdio" && !options.command) {
          error("stdio transport requires --command");
          process.exit(2);
        }
        if (
          (options.transport === "sse" || options.transport === "http") &&
          !options.url
        ) {
          error(`${options.transport} transport requires --url`);
          process.exit(2);
        }

        try {
          ensureGatewayToken(options.token);
          const result = await withSpinner(`Testing MCP server "${name}"...`, () =>
            withClient(async (client) => {
              // NOTE: mcp.test reads `name`, NOT `server_name`.
              return await callTyped(client, McpTestContract, {
                name,
                transport: options.transport as "stdio" | "sse" | "http",
                ...(options.command !== undefined && { command: options.command }),
                ...(options.args !== undefined && { args: options.args }),
                ...(options.url !== undefined && { url: options.url }),
              });
            }),
          );

          if (options.format === "json") {
            json(result);
            return;
          }

          if (result.success) {
            success(`MCP server "${name}" reachable (${result.toolCount ?? 0} tools)`);
            for (const tool of result.tools ?? []) {
              info(`  - ${tool}`);
            }
          } else {
            error(`MCP server "${name}" probe failed: ${result.error ?? "unknown error"}`);
            process.exit(1);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to test MCP server: ${msg}`);
          process.exit(1);
        }
      },
    );

  // mcp connect <name>
  mcp
    .command("connect <name>")
    .description("Connect a new MCP server via the daemon (persists to config)")
    .requiredOption("--transport <transport>", "Transport protocol (stdio|sse|http)")
    .option("--command <command>", "Executable path (stdio only)")
    .option("--args <args...>", "Command-line arguments (stdio only; variadic)")
    .option("--url <url>", "Server URL (sse/http only)")
    .option("--format <format>", "Output format (table|json)", "table")
    .option("--token <token>", "Gateway token (overrides COMIS_GATEWAY_TOKEN env var). Prefer COMIS_GATEWAY_TOKEN or ~/.comis/.env — a token on the command line is visible via ps/proc and shell history (WR-02).")
    .action(
      async (
        name: string,
        options: {
          transport: string;
          command?: string;
          args?: string[];
          url?: string;
          format: string;
          token?: string;
        },
      ) => {
        // Pre-RPC transport-required-field validation (BEFORE the socket opens).
        if (options.transport === "stdio" && !options.command) {
          error("stdio transport requires --command");
          process.exit(2);
        }
        if (
          (options.transport === "sse" || options.transport === "http") &&
          !options.url
        ) {
          error(`${options.transport} transport requires --url`);
          process.exit(2);
        }

        try {
          ensureGatewayToken(options.token);
          const result = await withSpinner(`Connecting MCP server "${name}"...`, () =>
            withClient(async (client) => {
              return await callTyped(client, McpConnectContract, {
                server_name: name,
                transport: options.transport as "stdio" | "sse" | "http",
                ...(options.command !== undefined && { command: options.command }),
                ...(options.args !== undefined && { args: options.args }),
                ...(options.url !== undefined && { url: options.url }),
              });
            }),
          );

          if (options.format === "json") {
            json(result);
            return;
          }

          success(`MCP server "${name}" connected (${result.toolCount} tools)`);
          info(`Status: ${colorStatus(result.status)}`);
          info(`Persistence: ${result.persistence ?? "—"}`);
          if (result.warning) {
            warn(`Warning: ${result.warning}`);
          }
          for (const tool of result.tools) {
            info(`  - ${tool}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to connect MCP server: ${msg}`);
          process.exit(1);
        }
      },
    );

  // mcp disconnect <name>
  mcp
    .command("disconnect <name>")
    .description("Disconnect a named MCP server")
    .option("--format <format>", "Output format (table|json)", "table")
    .option("--token <token>", "Gateway token (overrides COMIS_GATEWAY_TOKEN env var). Prefer COMIS_GATEWAY_TOKEN or ~/.comis/.env — a token on the command line is visible via ps/proc and shell history (WR-02).")
    .action(async (name: string, options: { format: string; token?: string }) => {
      try {
        ensureGatewayToken(options.token);
        const result = await withSpinner(`Disconnecting MCP server "${name}"...`, () =>
          withClient(async (client) => {
            return await callTyped(client, McpDisconnectContract, { server_name: name });
          }),
        );

        if (options.format === "json") {
          json(result);
          return;
        }

        success(`MCP server "${name}" disconnected`);
        info(`Persistence: ${result.persistence ?? "—"}`);
        if (result.warning) {
          warn(`Warning: ${result.warning}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to disconnect MCP server: ${msg}`);
        process.exit(1);
      }
    });

  // mcp reconnect <name>
  mcp
    .command("reconnect <name>")
    .description("Reconnect a named MCP server using its stored config")
    .option("--format <format>", "Output format (table|json)", "table")
    .option("--token <token>", "Gateway token (overrides COMIS_GATEWAY_TOKEN env var). Prefer COMIS_GATEWAY_TOKEN or ~/.comis/.env — a token on the command line is visible via ps/proc and shell history (WR-02).")
    .action(async (name: string, options: { format: string; token?: string }) => {
      try {
        ensureGatewayToken(options.token);
        // Send ONLY server_name — the D-02 guard rejects override params when
        // a stored config exists (OPUX-05: the CLI never re-specifies transport).
        const result = await withSpinner(`Reconnecting MCP server "${name}"...`, () =>
          withClient(async (client) => {
            return await callTyped(client, McpReconnectContract, { server_name: name });
          }),
        );

        if (options.format === "json") {
          json(result);
          return;
        }

        success(`MCP server "${name}" reconnected (${result.toolCount} tools)`);
        info(`Status: ${colorStatus(result.status)}`);
        for (const tool of result.tools) {
          info(`  - ${tool}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to reconnect MCP server: ${msg}`);
        process.exit(1);
      }
    });

  // mcp login <name> / mcp logout <name> — Phase 66 OAUTH-10. Registered in a
  // separate module so the daemon-never-imports-`open` boundary + the OAuth
  // open-vs-hint branching live away from this file (which stays focused on the
  // Phase 65 connection-management subcommands).
  registerMcpOauth(mcp);
}
