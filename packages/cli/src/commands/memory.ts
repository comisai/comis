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
import { withClient } from "../client/rpc-client.js";
import { success, error, info, warn, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable, renderKeyValue } from "../output/table.js";

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
        const result = await withSpinner("Searching memory...", () =>
          withClient(async (client) => {
            return (await client.call("memory.search", { query, limit })) as {
              results: MemorySearchResult[];
            };
          }),
        );

        const results = result.results ?? [];

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
        const result = await withSpinner("Fetching entry...", () =>
          withClient(async (client) => {
            return (await client.call("memory.inspect", { id })) as {
              entry?: Record<string, unknown>;
            };
          }),
        );

        if (!result.entry) {
          warn(`No entry found with ID: ${id}`);
          return;
        }

        const entry = result.entry as unknown as MemoryEntry;

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

  // memory stats
  memory
    .command("stats")
    .description("Display memory statistics")
    .option("--format <format>", "Output format (detail|json)", "detail")
    .action(async (options: { format: string }) => {
      try {
        const result = await withSpinner("Fetching memory stats...", () =>
          withClient(async (client) => {
            return (await client.call("memory.inspect", {})) as {
              stats?: Record<string, unknown>;
            };
          }),
        );

        const stats = result.stats;
        if (!stats || Object.keys(stats).length === 0) {
          info("No memory statistics available");
          return;
        }

        if (options.format === "json") {
          json(stats);
          return;
        }

        const pairs: [string, string][] = Object.entries(stats).map(([key, value]) => [
          chalk.bold(formatStatsKey(key)),
          formatStatsValue(value),
        ]);

        renderKeyValue(pairs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch memory stats: ${msg}`);
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
        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const filterDesc = Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");

        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow(`Clear memory entries matching [${filterDesc}]? (y/N) `),
            (ans) => {
              rl.close();
              resolve(ans.trim().toLowerCase());
            },
          );
        });

        if (answer !== "y" && answer !== "yes") {
          info("Cancelled");
          return;
        }
      }

      try {
        await withSpinner("Clearing memory entries...", () =>
          withClient(async (client) => {
            return await client.call("config.set", {
              section: "memory",
              key: "clear",
              value: params,
            });
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
