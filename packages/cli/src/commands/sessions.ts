/**
 * Session management commands: list, inspect, delete.
 *
 * Provides `comis sessions [list|inspect|delete]` subcommands
 * for managing conversation sessions via the daemon RPC interface.
 *
 * @module
 */

import type { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { withClient } from "../client/rpc-client.js";
import { success, error, info, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable, renderKeyValue } from "../output/table.js";

/**
 * Session list entry returned from the daemon.
 * Supports both canonical field names and daemon RPC field names.
 */
interface SessionEntry {
  key?: string;
  sessionKey?: string;
  channel?: string;
  channelId?: string;
  user?: string;
  userId?: string;
  lastActive?: number;
  updatedAt?: number;
  createdAt?: number;
  messageCount?: number;
  agentId?: string;
  kind?: string;
  totalTokens?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Format an epoch millisecond timestamp into a relative time string.
 *
 * @param timestamp - Epoch milliseconds
 * @returns Relative time string like "5m ago", "2h ago", "3d ago"
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Register the `sessions` subcommand group on the program.
 *
 * Provides list, inspect, and delete subcommands for managing
 * conversation sessions via the daemon RPC interface.
 *
 * @param program - The root Commander program
 */
export function registerSessionsCommand(program: Command): void {
  const sessions = program.command("sessions").description("Session management");

  // sessions list
  sessions
    .command("list")
    .description("List all sessions")
    .option("--tenant <tenantId>", "Filter by tenant ID")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { tenant?: string; format: string }) => {
      try {
        const result = await withSpinner("Fetching sessions...", () =>
          withClient(async (client) => {
            return await client.call("session.list", {
              tenantId: options.tenant,
            });
          }),
        );

        // RPC may return { sessions: [...] } or a bare array
        const raw = result as SessionEntry[] | { sessions: SessionEntry[] } | null;
        const entries: SessionEntry[] = Array.isArray(raw)
          ? raw
          : (raw as { sessions: SessionEntry[] })?.sessions ?? [];

        if (entries.length === 0) {
          info("No sessions found");
          return;
        }

        if (options.format === "json") {
          json(entries);
          return;
        }

        renderTable(
          ["Session Key", "Agent", "User", "Last Active", "Messages"],
          entries.map((s) => {
            const key = s.sessionKey ?? s.key ?? "-";
            const user = s.userId ?? s.user ?? "-";
            const active = s.updatedAt ?? s.lastActive;
            return [
              key.length > 40 ? key.slice(0, 37) + "..." : key,
              s.agentId ?? "-",
              user,
              active ? formatRelativeTime(active) : "-",
              s.messageCount != null ? String(s.messageCount) : "-",
            ];
          }),
        );

        info(`${entries.length} session${entries.length !== 1 ? "s" : ""}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to list sessions: ${msg}`);
        process.exit(1);
      }
    });

  // sessions inspect <key>
  sessions
    .command("inspect <key>")
    .description("Display full details of a session")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (key: string, options: { format: string }) => {
      try {
        const result = await withSpinner("Fetching session...", () =>
          withClient(async (client) => {
            return (await client.call("session.status", { key })) as {
              session?: SessionEntry;
            };
          }),
        );

        if (!result.session) {
          error(`Session not found: ${key}`);
          return;
        }

        const session = result.session;

        if (options.format === "json") {
          json(session);
          return;
        }

        // Parse session key components (tenantId:userId:channelId)
        const sKey = session.sessionKey ?? session.key ?? "-";
        const keyParts = sKey.split(":");
        const tenant = keyParts.length >= 3 ? keyParts[0]! : "-";
        const user = keyParts.length >= 3 ? keyParts[1]! : session.userId ?? session.user ?? "-";
        const channel = keyParts.length >= 3 ? keyParts[2]! : session.channelId ?? session.channel ?? "-";

        const pairs: [string, string][] = [
          [chalk.bold("Session Key"), sKey],
          [chalk.bold("Tenant"), tenant],
          [chalk.bold("User"), user],
          [chalk.bold("Channel"), channel],
        ];

        if (session.createdAt) {
          pairs.push([chalk.bold("Created"), new Date(session.createdAt).toLocaleString()]);
        }
        if (session.lastActive) {
          pairs.push([
            chalk.bold("Last Active"),
            `${new Date(session.lastActive).toLocaleString()} (${formatRelativeTime(session.lastActive)})`,
          ]);
        }
        if (session.messageCount != null) {
          pairs.push([chalk.bold("Message Count"), String(session.messageCount)]);
        }
        if (session.metadata && Object.keys(session.metadata).length > 0) {
          pairs.push([chalk.bold("Metadata"), JSON.stringify(session.metadata, null, 2)]);
        }

        renderKeyValue(pairs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to inspect session: ${msg}`);
        process.exit(1);
      }
    });

  // sessions delete <key>
  sessions
    .command("delete <key>")
    .description("Delete a session")
    .option("--yes", "Skip confirmation prompt")
    .action(async (key: string, options: { yes?: boolean }) => {
      if (!options.yes) {
        const confirmed = await p.confirm({
          message: `Delete session ${key}? This cannot be undone.`,
        });

        if (p.isCancel(confirmed) || !confirmed) {
          p.cancel("Delete cancelled.");
          return;
        }
      }

      try {
        await withSpinner("Deleting session...", () =>
          withClient(async (client) => {
            return await client.call("session.delete", { key });
          }),
        );

        success(`Session ${key} deleted`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to delete session: ${msg}`);
        process.exit(1);
      }
    });
}
