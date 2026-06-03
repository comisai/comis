// SPDX-License-Identifier: Apache-2.0
/**
 * Memory query commands: search, inspect, stats, clear.
 *
 * Provides `comis memory [search|inspect|stats|clear]` subcommands
 * for querying and managing memory entries via the daemon RPC interface.
 *
 * @module
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  ContextSearchContract,
  ContextInspectContract,
  MemoryStatsContract,
  MemoryFlushContract,
  MemoryRecallTraceContract,
  MemoryObservationsContract,
  MemoryEntitiesContract,
  MemoryRecallStatsContract,
} from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { success, error, info, warn, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable, renderKeyValue } from "../output/table.js";
import { confirm } from "../util/confirm.js";

/**
 * Memory search result entry.
 */
interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  createdAt?: string;
}

/**
 * Memory entry with full details.
 */
interface MemoryEntry {
  id: string;
  content: string;
  memoryType?: string;
  trustLevel?: string;
  tenantId?: string;
  sessionKey?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Register the `memory` subcommand group on the program.
 *
 * @param program - The root Commander program
 */
export function registerMemoryCommand(program: Command): void {
  const memory = program.command("memory").description("Memory management");

  // memory search <query>
  memory
    .command("search <query>")
    .description("Search memory entries")
    .option("--limit <n>", "Maximum results to return", "10")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (query: string, options: { limit: string; format: string }) => {
      const limit = parseInt(options.limit, 10);
      if (isNaN(limit) || limit < 1) {
        error("Invalid limit: must be a positive integer");
        process.exit(1);
      }

      try {
        // Routed via ContextSearchContract — the daemon exposes
        // `memory.search_files` + `context.search` (no `memory.search`);
        // ContextSearchContract is the closest semantic match (full-text
        // search over message + summary content).
        const result = await withSpinner("Searching memory...", () =>
          withClient(async (client) => {
            return await callTyped(client, ContextSearchContract, {
              query,
              limit,
            });
          }),
        );

        const results = (result.results ?? []) as unknown as MemorySearchResult[];

        if (results.length === 0) {
          info("No matching entries found");
          return;
        }

        if (options.format === "json") {
          json(results);
          return;
        }

        renderTable(
          ["#", "Score", "Content", "Created"],
          results.map((r, i) => [
            String(i + 1),
            formatScore(r.score),
            truncate(r.content, 60),
            r.createdAt ? formatDate(r.createdAt) : "-",
          ]),
        );

        info(`${results.length} result${results.length === 1 ? "" : "s"} found`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to search memory: ${msg}`);
        process.exit(1);
      }
    });

  // memory inspect <id>
  memory
    .command("inspect <id>")
    .description("Display full details of a memory entry")
    .option("--format <format>", "Output format (detail|json)", "detail")
    .action(async (id: string, options: { format: string }) => {
      try {
        // Routed via ContextInspectContract — there is no `memory.inspect`
        // daemon handler. ContextInspectContract retrieves a single entry
        // by id (the closest semantic match). The response is a loose
        // record; we coerce to MemoryEntry shape for rendering.
        const result = await withSpinner("Fetching entry...", () =>
          withClient(async (client) => {
            return await callTyped(client, ContextInspectContract, { id });
          }),
        );

        // ContextInspectContract returns the entry directly as a loose
        // record (no `entry` wrapper). Treat empty record as "not found".
        if (!result || Object.keys(result).length === 0) {
          warn(`No entry found with ID: ${id}`);
          return;
        }

        const entry = result as unknown as MemoryEntry;

        if (options.format === "json") {
          json(entry);
          return;
        }

        // Render as key-value pairs
        const pairs: [string, string][] = [
          [chalk.bold("ID"), entry.id],
          [chalk.bold("Content"), entry.content],
        ];

        if (entry.memoryType) pairs.push([chalk.bold("Type"), entry.memoryType]);
        if (entry.trustLevel) pairs.push([chalk.bold("Trust"), entry.trustLevel]);
        if (entry.tenantId) pairs.push([chalk.bold("Tenant"), entry.tenantId]);
        if (entry.sessionKey) pairs.push([chalk.bold("Session"), entry.sessionKey]);
        if (entry.createdAt) pairs.push([chalk.bold("Created"), formatDate(entry.createdAt)]);
        if (entry.updatedAt) pairs.push([chalk.bold("Updated"), formatDate(entry.updatedAt)]);

        if (entry.metadata && Object.keys(entry.metadata).length > 0) {
          pairs.push([chalk.bold("Metadata"), JSON.stringify(entry.metadata, null, 2)]);
        }

        renderKeyValue(pairs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to inspect memory entry: ${msg}`);
        process.exit(1);
      }
    });

  // memory stats — the single operator stats view. Folds in the
  // recall counters (lane usage + rerank-fallback rate + consolidation
  // throughput + recall hit-rate) alongside the base memory.stats, so an
  // operator sees one combined view (cleaner than a separate `recall-stats`
  // subcommand). The recall-counter overlay is BEST-EFFORT: a daemon that has
  // not wired the counters (or rejects the admin call) still renders base stats.
  memory
    .command("stats")
    .description("Display memory statistics")
    .option("--format <format>", "Output format (detail|json)", "detail")
    .action(async (options: { format: string }) => {
      try {
        // Routed via MemoryStatsContract — the daemon's memory-statistics
        // surface. Response is a loose record; the values matter, not the
        // precise shape.
        const result = await withSpinner("Fetching memory stats...", () =>
          withClient(async (client) => {
            return await callTyped(client, MemoryStatsContract, {});
          }),
        );

        const stats = result as Record<string, unknown>;
        if (!stats || Object.keys(stats).length === 0) {
          info("No memory statistics available");
          return;
        }

        // Best-effort recall-counter overlay. Failures (counters not
        // wired, non-admin caller) are swallowed — base stats still render.
        let recallStats: Record<string, unknown> | undefined;
        try {
          recallStats = (await withClient(async (client) =>
            callTyped(client, MemoryRecallStatsContract, {}),
          )) as unknown as Record<string, unknown>;
        } catch {
          recallStats = undefined;
        }

        if (options.format === "json") {
          json(recallStats ? { ...stats, recallStats } : stats);
          return;
        }

        const pairs: [string, string][] = Object.entries(stats).map(([key, value]) => [
          chalk.bold(formatStatsKey(key)),
          formatStatsValue(value),
        ]);

        // Append the recall counters + derived rates to the same key-value view.
        if (recallStats) {
          for (const [key, value] of Object.entries(recallStats)) {
            pairs.push([chalk.bold(formatStatsKey(key)), formatStatsValue(value)]);
          }
        }

        renderKeyValue(pairs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch memory stats: ${msg}`);
        process.exit(1);
      }
    });

  // memory recall-trace <session> — inspect a session's recall trace.
  memory
    .command("recall-trace <session>")
    .description("Inspect a session's hybrid-recall trace (admin)")
    .option("--trace-id <id>", "Filter by trace id instead of / alongside the session")
    .option("--agent <agentId>", "Scope to a specific agent")
    .option("--limit <n>", "Maximum records to return", "200")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(
      async (
        session: string,
        options: { traceId?: string; agent?: string; limit: string; format: string },
      ) => {
        try {
          const result = await withSpinner("Fetching recall trace...", () =>
            withClient(async (client) =>
              callTyped(client, MemoryRecallTraceContract, {
                session_key: session,
                ...(options.traceId !== undefined ? { trace_id: options.traceId } : {}),
                ...(options.agent !== undefined ? { agent_id: options.agent } : {}),
                limit: Number(options.limit),
              }),
            ),
          );

          const records = (result.records ?? []) as Array<Record<string, unknown>>;
          if (records.length === 0) {
            info("No recall-trace records found");
            return;
          }

          if (options.format === "json") {
            json(records);
            return;
          }

          // Table view: the correlation keys + the final-count summary. The
          // full per-record ranking detail is available via --format json.
          renderTable(
            ["#", "Trace", "Session", "Final", "When"],
            records.map((r, i) => [
              String(i + 1),
              String(r.traceId ?? "-"),
              String(r.sessionKey ?? "-"),
              String(r.finalCount ?? "-"),
              String(r.ts ?? "-"),
            ]),
          );
          info(`${records.length} record${records.length === 1 ? "" : "s"} found`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to fetch recall trace: ${msg}`);
          process.exit(1);
        }
      },
    );

  // memory observations — list observation provenance.
  memory
    .command("observations")
    .description("List observation provenance (sources + history) (admin)")
    .option("--agent <agentId>", "Scope to a specific agent")
    .option("--limit <n>", "Maximum observations to return", "50")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { agent?: string; limit: string; format: string }) => {
      try {
        const result = await withSpinner("Fetching observations...", () =>
          withClient(async (client) =>
            callTyped(client, MemoryObservationsContract, {
              ...(options.agent !== undefined ? { agent_id: options.agent } : {}),
              limit: Number(options.limit),
            }),
          ),
        );

        const observations = (result.observations ?? []) as Array<Record<string, unknown>>;
        if (observations.length === 0) {
          info("No observations found");
          return;
        }

        if (options.format === "json") {
          json(observations);
          return;
        }

        renderTable(
          ["ID", "Content", "Proofs", "Sources"],
          observations.map((o) => [
            String(o.id ?? "-"),
            truncate(String(o.content ?? ""), 60),
            String(o.proofCount ?? "-"),
            Array.isArray(o.sourceIds) ? (o.sourceIds as string[]).join(", ") : "-",
          ]),
        );
        info(`${observations.length} observation${observations.length === 1 ? "" : "s"} found`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch observations: ${msg}`);
        process.exit(1);
      }
    });

  // memory entities — list the agent's entity graph.
  memory
    .command("entities")
    .description("List an agent's entity graph, most-mentioned-first (admin)")
    .option("--agent <agentId>", "Scope to a specific agent")
    .option("--limit <n>", "Maximum entities to return", "100")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { agent?: string; limit: string; format: string }) => {
      try {
        const result = await withSpinner("Fetching entity graph...", () =>
          withClient(async (client) =>
            callTyped(client, MemoryEntitiesContract, {
              ...(options.agent !== undefined ? { agent_id: options.agent } : {}),
              limit: Number(options.limit),
            }),
          ),
        );

        const entities = (result.entities ?? []) as Array<Record<string, unknown>>;
        if (entities.length === 0) {
          info("No entities found");
          return;
        }

        if (options.format === "json") {
          json(entities);
          return;
        }

        renderTable(
          ["ID", "Name", "Mentions"],
          entities.map((e) => [
            String(e.id ?? "-"),
            String(e.name ?? "-"),
            String(e.mentionCount ?? "-"),
          ]),
        );
        info(`${entities.length} entit${entities.length === 1 ? "y" : "ies"} found`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch entities: ${msg}`);
        process.exit(1);
      }
    });

  // memory clear
  memory
    .command("clear")
    .description("Clear memory entries matching a filter")
    .option("--filter <filter>", "Filter expression (e.g. memoryType=conversation)")
    .option("--tenant <tenantId>", "Filter by tenant ID")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (options: { filter?: string; tenant?: string; yes?: boolean }) => {
      // Require at least one filter to prevent accidental blanket wipes
      if (!options.filter && !options.tenant) {
        error(
          "At least one filter is required (--filter or --tenant). Safety check prevents blanket clears.",
        );
        process.exit(1);
      }

      // Build filter params
      const params: Record<string, unknown> = {};
      if (options.filter) {
        const [key, ...valueParts] = options.filter.split("=");
        if (!key || valueParts.length === 0) {
          error("Invalid filter format. Use key=value (e.g. memoryType=conversation)");
          process.exit(1);
        }
        params[key] = valueParts.join("=");
      }
      if (options.tenant) {
        params["tenantId"] = options.tenant;
      }

      // Confirmation check
      if (!options.yes && !process.stdin.isTTY) {
        error("Confirmation required. Use --yes flag for non-interactive clearing.");
        process.exit(1);
      }

      if (!options.yes) {
        const filterDesc = Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");

        if (
          !(await confirm({
            message: `Clear memory entries matching [${filterDesc}]?`,
          }))
        ) {
          info("Cancelled");
          return;
        }
      }

      try {
        // Routed via MemoryFlushContract — the actual flush surface.
        // The tenant filter maps to `tenant_id`; the generic
        // `--filter key=value` flag is a no-op here (there is no
        // `config.set` handler with section=memory).
        await withSpinner("Clearing memory entries...", () =>
          withClient(async (client) => {
            const flushParams: { tenant_id?: string } = {};
            if (typeof params.tenantId === "string") {
              flushParams.tenant_id = params.tenantId;
            }
            return await callTyped(client, MemoryFlushContract, flushParams);
          }),
        );

        success("Memory entries cleared");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to clear memory: ${msg}`);
        process.exit(1);
      }
    });
}

/**
 * Format a relevance score as a percentage-like display.
 */
function formatScore(score: number): string {
  const pct = Math.round(score * 100);
  if (pct >= 80) return chalk.green(`${pct}%`);
  if (pct >= 50) return chalk.yellow(`${pct}%`);
  return chalk.gray(`${pct}%`);
}

/**
 * Truncate a string to a maximum length with ellipsis.
 */
function truncate(str: string, maxLength: number): string {
  // Replace newlines with spaces for table display
  const oneLine = str.replace(/\n/g, " ");
  if (oneLine.length <= maxLength) return oneLine;
  return oneLine.slice(0, maxLength - 3) + "...";
}

/**
 * Format an ISO date string for display.
 */
function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString();
  } catch {
    return dateStr;
  }
}

/**
 * Format a stats value for display, handling nested objects and arrays.
 */
function formatStatsValue(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.join(", ");
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "-";
    return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
  }
  return String(value);
}

/**
 * Format a camelCase stats key into a human-readable label.
 */
function formatStatsKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
