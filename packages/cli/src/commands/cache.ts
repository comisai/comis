// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command module — Commander.js boundary catches throws and surfaces user-readable messages. The catch block below converts them to error()/process.exit(1) directly.
/**
 * `comis cache stats` subcommand.
 *
 * Dispatches the `obs.cacheStats.window` RPC and renders the response
 * in table (default), JSON, or Markdown format. The user-facing
 * command is `comis cache stats` — independent of the RPC method
 * name (`obs.cacheStats.window`).
 *
 * Window shorthands (`--since 1h|24h|7d|30d|...`) are parsed via
 * `parseSince` from `@comis/observability` (the helper that owns the
 * bounded-regex / unit-table convention; CLI already depends on
 * `@comis/observability` via `packages/cli/package.json`).
 *
 * Tenant scope: the `--tenant` flag is intentionally absent.
 * `obs_token_usage` lacks a `tenant_id` column, so the filter would
 * silently no-op. Adding tenant filtering requires extending the write
 * path (event payload + token-tracker + schema migration) and is
 * deferred.
 *
 * @module
 */
import type { Command } from "commander";
import { ObsCacheStatsWindowContract } from "@comis/core";
import { parseSince } from "@comis/observability";
import { callTyped, withClient } from "../client/rpc-client.js";
import { withSpinner } from "../output/spinner.js";
import { error, info, json } from "../output/format.js";
import { renderTable, renderKeyValue } from "../output/table.js";

/**
 * Shape of the `window` field returned by `obs.cacheStats.window`. The
 * contract uses `ObsRecord` (loose-modeled) for forward-compat; the
 * authoritative shape lives in `@comis/observability#CacheStatsWindow`.
 * The CLI narrows here for the render helpers.
 */
interface BreakdownBase {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  nonCachedInputTokens: number;
  outputTokens: number;
  turns: number;
  cacheHitRate: number;
  cacheWriteRate: number;
}
interface CacheStatsWindowDisplay extends BreakdownBase {
  sinceMs: number;
  untilMs: number;
  byProvider: Array<BreakdownBase & { provider: string }>;
  byModel: Array<BreakdownBase & { provider: string; model: string }>;
  byAgent: Array<BreakdownBase & { agentId: string }>;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function num(n: number): string {
  return n.toLocaleString();
}

/**
 * Render Markdown — inline helper because the CLI's output/ directory
 * has table.ts + format.ts but no Markdown helper. Adding a separate
 * file would be over-scoped for this single use site.
 */
function renderMarkdown(window: CacheStatsWindowDisplay): void {
  const lines: string[] = [];
  lines.push("# Cache Stats");
  lines.push("");
  lines.push("## Window");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| cacheHitRate | ${pct(window.cacheHitRate)} |`);
  lines.push(`| cacheWriteRate | ${pct(window.cacheWriteRate)} |`);
  lines.push(`| cacheReadTokens | ${num(window.cacheReadTokens)} |`);
  lines.push(`| cacheCreationTokens | ${num(window.cacheCreationTokens)} |`);
  lines.push(`| nonCachedInputTokens | ${num(window.nonCachedInputTokens)} |`);
  lines.push(`| outputTokens | ${num(window.outputTokens)} |`);
  lines.push(`| turns | ${num(window.turns)} |`);

  if (window.byProvider.length > 0) {
    lines.push("");
    lines.push("## By Provider");
    lines.push("");
    lines.push("| Provider | Hit Rate | Read | Create | Non-cached | Turns |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of window.byProvider) {
      lines.push(
        `| ${r.provider} | ${pct(r.cacheHitRate)} | ${num(r.cacheReadTokens)} | ${num(r.cacheCreationTokens)} | ${num(r.nonCachedInputTokens)} | ${num(r.turns)} |`,
      );
    }
  }

  if (window.byModel.length > 0) {
    lines.push("");
    lines.push("## By Model");
    lines.push("");
    lines.push("| Provider | Model | Hit Rate | Read | Create | Non-cached | Turns |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of window.byModel) {
      lines.push(
        `| ${r.provider} | ${r.model} | ${pct(r.cacheHitRate)} | ${num(r.cacheReadTokens)} | ${num(r.cacheCreationTokens)} | ${num(r.nonCachedInputTokens)} | ${num(r.turns)} |`,
      );
    }
  }

  if (window.byAgent.length > 0) {
    lines.push("");
    lines.push("## By Agent");
    lines.push("");
    lines.push("| Agent | Hit Rate | Read | Create | Non-cached | Turns |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of window.byAgent) {
      lines.push(
        `| ${r.agentId} | ${pct(r.cacheHitRate)} | ${num(r.cacheReadTokens)} | ${num(r.cacheCreationTokens)} | ${num(r.nonCachedInputTokens)} | ${num(r.turns)} |`,
      );
    }
  }

  console.log(lines.join("\n"));
}

function renderTableFormat(window: CacheStatsWindowDisplay): void {
  renderKeyValue([
    ["cacheHitRate", pct(window.cacheHitRate)],
    ["cacheWriteRate", pct(window.cacheWriteRate)],
    ["cacheReadTokens", num(window.cacheReadTokens)],
    ["cacheCreationTokens", num(window.cacheCreationTokens)],
    ["nonCachedInputTokens", num(window.nonCachedInputTokens)],
    ["outputTokens", num(window.outputTokens)],
    ["turns", num(window.turns)],
  ]);

  if (window.byProvider.length > 0) {
    console.log("\nBy Provider:");
    renderTable(
      ["Provider", "Hit Rate", "Read", "Create", "Non-cached", "Turns"],
      window.byProvider.map((r) => [
        r.provider,
        pct(r.cacheHitRate),
        num(r.cacheReadTokens),
        num(r.cacheCreationTokens),
        num(r.nonCachedInputTokens),
        num(r.turns),
      ]),
    );
  }

  if (window.byModel.length > 0) {
    console.log("\nBy Model:");
    renderTable(
      ["Provider", "Model", "Hit Rate", "Read", "Create", "Non-cached", "Turns"],
      window.byModel.map((r) => [
        r.provider,
        r.model,
        pct(r.cacheHitRate),
        num(r.cacheReadTokens),
        num(r.cacheCreationTokens),
        num(r.nonCachedInputTokens),
        num(r.turns),
      ]),
    );
  }

  if (window.byAgent.length > 0) {
    console.log("\nBy Agent:");
    renderTable(
      ["Agent", "Hit Rate", "Read", "Create", "Non-cached", "Turns"],
      window.byAgent.map((r) => [
        r.agentId,
        pct(r.cacheHitRate),
        num(r.cacheReadTokens),
        num(r.cacheCreationTokens),
        num(r.nonCachedInputTokens),
        num(r.turns),
      ]),
    );
  }
}

/**
 * Register the `cache` subcommand group on the program.
 *
 * Currently exposes only `comis cache stats`. A future `cache trace
 * tail` subcommand may consume the JSONL trace artifact.
 */
export function registerCacheCommand(program: Command): void {
  const cache = program
    .command("cache")
    .description("Cache statistics + traces");

  cache
    .command("stats")
    .description(
      "Aggregated cache statistics from durable obs_token_usage",
    )
    .option(
      "--since <window>",
      "Window start (1h | 24h | 7d | 30d — any Nh/Nd/Nw/Nm/Ny)",
      "24h",
    )
    .option("--until <iso>", "Window end (ISO-8601; defaults to now)")
    .option("--agent <agentId>", "Filter by agent")
    .option("--provider <provider>", "Filter by provider")
    .option(
      "--format <format>",
      "Output format (table | json | markdown)",
      "table",
    )
    .action(
      async (options: {
        since: string;
        until?: string;
        agent?: string;
        provider?: string;
        format: string;
      }) => {
        try {
          const windowMs = parseSince(options.since);
          const sinceMs = Date.now() - windowMs;
          const untilMs = options.until
            ? new Date(options.until).getTime()
            : undefined;
          if (untilMs !== undefined && Number.isNaN(untilMs)) {
            error(`Invalid --until value: ${options.until}`);
            process.exit(1);
          }
          const result = await withSpinner(
            "Aggregating cache statistics...",
            () =>
              withClient(async (client) =>
                callTyped(client, ObsCacheStatsWindowContract, {
                  sinceMs,
                  untilMs,
                  agent: options.agent,
                  provider: options.provider,
                }),
              ),
          );
          if (!result || result.window === null) {
            info("No data in window.");
            return;
          }
          const window = result.window as unknown as CacheStatsWindowDisplay;
          if (options.format === "json") {
            json(window);
            return;
          }
          if (options.format === "markdown") {
            renderMarkdown(window);
            return;
          }
          renderTableFormat(window);
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      },
    );
}
