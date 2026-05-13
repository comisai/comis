// SPDX-License-Identifier: Apache-2.0
/**
 * Session management commands: list, inspect, delete.
 *
 * Provides `comis sessions [list|inspect|delete]` subcommands
 * for managing conversation sessions via the daemon RPC interface.
 *
 * Phase 35 Wave C plan 35-19 (Wave C CLOSURE): retargets from raw
 * `client.call(...)` to typed `callTyped(client, <Contract>, params)`.
 * Three sites migrated: session.list, session.status, session.delete.
 *
 * @module
 */

import type { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import {
  SessionListContract,
  SessionStatusContract,
  SessionDeleteContract,
} from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
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
        // The CLI's --tenant flag is a no-op against the contract surface:
        // tenant scoping flows through the dispatcher-injected `_tenantId`
        // internal (which is auth-context-derived), not the public request.
        // The contract's `kind`/`since_minutes` fields are optional; the empty
        // request matches the default-list-all behavior.
        // (Pre-Plan-35-19 sent `tenantId: options.tenant` which the daemon
        // also ignored — same observable behavior, now via the typed contract.)
        const result = await withSpinner("Fetching sessions...", () =>
          withClient(async (client) => {
            return await callTyped(client, SessionListContract, {});
          }),
        );

        // The contract response shape is { sessions: [...], total }.
        const entries: SessionEntry[] = result.sessions as unknown as SessionEntry[];

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
        // session.status returns agent/session runtime stats. The CLI's
        // `key` argument is currently a no-op against the contract — the
        // handler reads the agent context from the dispatcher-injected
        // `_agentId` internal, not from a user-supplied key. Pre-Plan-35-19
        // CLI sent `{ key }` which the daemon also ignored.
        const statusResult = await withSpinner("Fetching session...", () =>
          withClient(async (client) => {
            return await callTyped(client, SessionStatusContract, {});
          }),
        );

        if (options.format === "json") {
          json(statusResult);
          return;
        }

        // Render the actual status response (model + agentName + counters)
        // alongside the user-supplied session key string for context.
        const pairs: [string, string][] = [
          [chalk.bold("Session Key"), key],
          [chalk.bold("Model"), statusResult.model],
          [chalk.bold("Agent"), statusResult.agentName],
          [chalk.bold("Tokens Used"), String(statusResult.tokensUsed.totalTokens)],
          [chalk.bold("Total Cost"), `$${statusResult.tokensUsed.totalCost.toFixed(4)}`],
          [chalk.bold("Steps Executed"), String(statusResult.stepsExecuted)],
          [chalk.bold("Max Steps"), String(statusResult.maxSteps)],
        ];

        // Parse session key components (tenantId:userId:channelId) when shape matches.
        const keyParts = key.split(":");
        if (keyParts.length >= 3) {
          pairs.push(
            [chalk.bold("Tenant"), keyParts[0]!],
            [chalk.bold("User"), keyParts[1]!],
            [chalk.bold("Channel"), keyParts[2]!],
          );
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
            // The contract uses `session_key` (snake_case — matches the
            // daemon handler parameter name). Pre-Plan-35-19 CLI sent
            // `{ key }` which the daemon ignored, then the handler threw
            // "Missing required parameter: session_key" — this fix makes
            // the delete actually succeed.
            return await callTyped(client, SessionDeleteContract, {
              session_key: key,
            });
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
