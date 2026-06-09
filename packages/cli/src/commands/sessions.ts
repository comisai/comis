// SPDX-License-Identifier: Apache-2.0
/**
 * Session management commands: list, inspect, delete.
 *
 * Provides `comis sessions [list|inspect|delete]` subcommands
 * for managing conversation sessions via the daemon RPC interface.
 *
 * Uses typed `callTyped(client, <Contract>, params)` for the three
 * surfaces: session.list, session.status, session.delete.
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
  SessionResetConversationContract,
  ObsSystemPromptReportLatestContract,
  ObsSystemPromptReportListContract,
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
        // `_agentId` internal, not from a user-supplied key.
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
            // daemon handler parameter name).
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

  // sessions reset — Phase 164-06: complete cross-mode conversation reset.
  // Supersedes Phase 164-03 sessions reset-lcd (LCD-only).
  // Admin-gated destructive operation: clears BOTH the LCD durable history
  // AND the daemon sessionStore working transcript for the given session.
  // After this reset, a follow-up turn has NO prior context in both dag mode
  // (LCD empty) and pipeline mode (sessionStore empty → rehydrates empty).
  // --memory also clears RAG memories (GDPR / full-forget path, deferred).
  // --yes skips confirmation (required for scripted/automated use).
  sessions
    .command("reset <sessionKey>")
    .description("Reset a conversation to a clean slate: clears LCD history + working session transcript (admin). Use --memory to also clear RAG memories.")
    .option("--memory", "Also clear RAG memories for this session")
    .option("--yes", "Skip confirmation prompt")
    .action(async (sessionKeyArg: string, opts: { memory?: boolean; yes?: boolean }) => {
      if (!opts.yes) {
        // Destructive and admin-only: require --yes to avoid accidental wipes.
        error("Conversation reset is irreversible. Pass --yes to confirm.");
        process.exit(1);
      }
      try {
        const result = await withClient(async (client) => {
          return await callTyped(client, SessionResetConversationContract, {
            session_key: sessionKeyArg,
            memory: opts.memory ?? false,
          });
        });
        console.log(`Conversation reset: ${result.lcdRowsDeleted} LCD rows deleted, ${result.sessionMessagesCleared} session messages cleared.`);
        if (opts.memory) {
          if (result.memoriesDeleted !== undefined) {
            // RAG memory clear was implemented and ran — surface the count.
            console.log(`RAG memories cleared: ${result.memoriesDeleted} memories deleted.`);
          } else {
            // Handler omitted memoriesDeleted → not yet implemented (deferred).
            process.stderr.write(
              "⚠ --memory is not yet implemented — RAG memory was NOT cleared (only LCD history and session transcript were cleared).\n",
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to reset conversation: ${msg}`);
        process.exit(1);
      }
    });

  // sessions report — SystemPromptReport surfacing
  const report = sessions
    .command("report")
    .description("Inspect SystemPromptReport");

  // sessions report show <sessionId>
  report
    .command("show <sessionId>")
    .description("Display the latest SystemPromptReport for a session")
    .requiredOption("--agent <agentId>", "Agent ID owning the session")
    .option("--runId <runId>", "Optional runId narrow")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(
      async (
        sessionId: string,
        options: { agent: string; runId?: string; format: string },
      ) => {
        try {
          const result = await withSpinner(
            "Fetching SystemPromptReport...",
            () =>
              withClient(async (client) => {
                return await callTyped(client, ObsSystemPromptReportLatestContract, {
                  agentId: options.agent,
                  sessionId,
                  runId: options.runId,
                });
              }),
          );

          if (result.report === null) {
            info(`No SystemPromptReport found for session ${sessionId}`);
            return;
          }

          if (options.format === "json") {
            json(result.report);
            return;
          }

          renderSystemPromptReport(sessionId, result.report);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to fetch SystemPromptReport: ${msg}`);
          process.exit(1);
        }
      },
    );

  // sessions report list <sessionId>
  report
    .command("list <sessionId>")
    .description("List recent SystemPromptReports for a session")
    .option("--limit <n>", "Max reports to return (default 10, max 100)", "10")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(
      async (sessionId: string, options: { limit: string; format: string }) => {
        try {
          const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 10));
          const result = await withSpinner(
            "Fetching SystemPromptReports...",
            () =>
              withClient(async (client) => {
                return await callTyped(client, ObsSystemPromptReportListContract, {
                  sessionId,
                  limit,
                });
              }),
          );

          if (result.reports.length === 0) {
            info(`No SystemPromptReports found for session ${sessionId}`);
            return;
          }

          if (options.format === "json") {
            json(result.reports);
            return;
          }

          // Render as a compact table: generatedAt | runId | provider/model | chars
          renderTable(
            ["Generated", "RunId", "Provider/Model", "Chars"],
            result.reports.map((r) => {
              const generated = typeof r.generatedAt === "number"
                ? formatRelativeTime(r.generatedAt)
                : "-";
              const runId = (r.runId as string | undefined) ?? "-";
              const provider = (r.provider as string | undefined) ?? "-";
              const model = (r.model as string | undefined) ?? "-";
              const sp = r.systemPrompt as { chars?: number } | undefined;
              const chars = sp?.chars != null ? String(sp.chars) : "-";
              return [generated, runId, `${provider}/${model}`, chars];
            }),
          );

          info(`${result.reports.length} report${result.reports.length !== 1 ? "s" : ""}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to list SystemPromptReports: ${msg}`);
          process.exit(1);
        }
      },
    );
}

/**
 * Pretty-print a SystemPromptReport for the
 * `sessions report show` table view.
 *
 * Renders a header + per-file table for `injectedWorkspaceFiles[]`,
 * plus an overall summary. Each loose-modeled record carries the
 * report shape from @comis/observability#SystemPromptReportSchema.
 *
 * @param sessionId - Session identifier (for the header).
 * @param report    - Loose-shaped SystemPromptReport record.
 */
export function renderSystemPromptReport(sessionId: string, report: Record<string, unknown>): void {
  // Header
  console.log(chalk.bold(`System prompt — session ${sessionId}`));
  console.log("");

  const sp = report.systemPrompt as
    | { sha256?: string; chars?: number; projectContextChars?: number }
    | undefined;
  const tools = report.tools as
    | { entries?: Array<{ name?: string; callable?: boolean; schemaChars?: number }>; totalSchemaChars?: number }
    | undefined;
  const skills = report.skills as { promptChars?: number; entries?: unknown[] } | undefined;
  const files = (report.injectedWorkspaceFiles as Array<{
    name?: string;
    missing?: boolean;
    truncated?: boolean;
    rawChars?: number;
    injectedChars?: number;
  }> | undefined) ?? [];

  // Summary panel
  const summaryPairs: [string, string][] = [
    [chalk.bold("Agent"), String(report.agentId ?? "-")],
    [chalk.bold("Model"), `${String(report.provider ?? "-")}/${String(report.model ?? "-")}`],
    [chalk.bold("Source"), String(report.source ?? "-")],
    [chalk.bold("Generated"), typeof report.generatedAt === "number"
      ? `${formatRelativeTime(report.generatedAt)} (epoch ${report.generatedAt})`
      : "-"],
    [chalk.bold("System chars"), String(sp?.chars ?? "-")],
    [chalk.bold("Project context chars"), String(sp?.projectContextChars ?? "-")],
    [chalk.bold("SHA-256"), sp?.sha256 ? String(sp.sha256).slice(0, 16) + "..." : "-"],
    // Use Array.isArray guard, not a truthy check. The schema invariant
    // says `entries` is an array; if it isn't, the data is malformed and
    // `?` is the honest signal (we know the shape is wrong but we know
    // the totalSchemaChars/promptChars value). The truthy-check we
    // replaced rendered the literal "undefined entries" for non-array
    // truthy values.
    [chalk.bold("Tools"),
      Array.isArray(tools?.entries)
        ? `${tools.entries.length} entries / ${tools.totalSchemaChars ?? "-"} schema chars`
        : (tools !== undefined
            ? `? entries / ${tools.totalSchemaChars ?? "-"} schema chars`
            : "-")],
    [chalk.bold("Skills"),
      Array.isArray(skills?.entries)
        ? `${skills.entries.length} entries / ${skills.promptChars ?? "-"} chars`
        : (skills !== undefined
            ? `? entries / ${skills.promptChars ?? "-"} chars`
            : "-")],
  ];
  renderKeyValue(summaryPairs);

  console.log("");
  console.log(chalk.bold("Injected workspace files:"));
  if (files.length === 0) {
    console.log("  (none)");
    return;
  }
  renderTable(
    ["File", "Missing", "Truncated", "Raw chars", "Injected chars"],
    files.map((f) => [
      f.name ?? "-",
      f.missing ? "yes" : "no",
      f.truncated ? "yes" : "no",
      String(f.rawChars ?? "-"),
      String(f.injectedChars ?? "-"),
    ]),
  );
}
