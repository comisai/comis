// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command module — Commander.js boundary catches throws and surfaces user-readable messages. The catch block below converts them to error()/process.exit(1) directly.
/**
 * `comis cost export` — operator CLI for the corrected-cost export.
 *
 * Emits the corrected-cost time buckets (hourly by default, or 15-min quarter-hour
 * via `--quarter-hour`) as CSV (default) or JSON, honoring agent/provider/model/since
 * filters. Each row carries the four cost rollups + cacheSaved + costCorrection + the
 * pricing-coverage pair (`pricingState`/`missingPricingCount`) so a finance review
 * sees how trustworthy the dollars are.
 *
 * Data source: the LOCAL ~/.comis observability store, read OFFLINE — the telemetry
 * lives on disk, so an export must not require a live gateway. (There is no admin
 * aggregate RPC for the quarter-hour buckets; this command deliberately contacts no
 * daemon RPC and so trivially satisfies the cli-uses-typed-rpc gate.)
 *
 * Content-free: the CSV/JSON carries ONLY the explicit column allowlist (the cost
 * buckets + coverage) — never a message body / secret / query. The
 * `toCsv` serializer projects only `COST_EXPORT_COLUMNS`, so a stray source-row field
 * can never reach the file.
 *
 * Usage:
 *   comis cost export [--format csv|json] [--quarter-hour] [--since <ms>]
 *     [--agent <id>] [--provider <id>] [--model <id>]
 *
 * @module
 */

import type { Command } from "commander";
import type { QuarterHourBucket } from "@comis/memory";
import { error, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { toCsv } from "../util/csv.js";
import { readCostExportOffline, resolveOfflineDataDir } from "../util/offline-obs.js";

/**
 * The export column allowlist — the ONLY fields emitted (the content-free guard).
 * Order is the CSV header order. Every column is a `QuarterHourBucket` field.
 */
const COST_EXPORT_COLUMNS: ReadonlyArray<keyof QuarterHourBucket> = [
  "bucket",
  "totalCost",
  "totalTokens",
  "callCount",
  "totalCacheSaved",
  "totalCostCorrection",
  "pricingState",
  "missingPricingCount",
];

/** CLI options for `comis cost export`. */
interface CostExportCliOptions {
  format: string;
  quarterHour?: boolean;
  since?: string;
  agent?: string;
  provider?: string;
  model?: string;
}

/**
 * Register the `cost export` command on the program.
 *
 * @param program - The root Commander program
 */
export function registerCostExportCommand(program: Command): void {
  const cost = program.command("cost").description("Cost-attribution exports and reports");
  cost
    .command("export")
    .description(
      "Export corrected-cost buckets (CSV/JSON) with a pricing-coverage column, honoring agent/provider/model filters",
    )
    .option("--format <format>", "Output format: csv | json", "csv")
    .option("--quarter-hour", "Bucket by 15-min quarter-hours instead of hours")
    .option("--since <ms>", "Lower time bound (epoch ms); default all time")
    .option("--agent <id>", "Filter to one agent")
    .option("--provider <id>", "Filter to one provider")
    .option("--model <id>", "Filter to one model")
    .action(async (options: CostExportCliOptions) => {
      try {
        // A non-numeric --since is dropped (widen rather than crash) — the typed
        // store filter wants a number or undefined.
        const sinceMs =
          options.since !== undefined && Number.isFinite(Number(options.since))
            ? Number(options.since)
            : undefined;
        const rows: QuarterHourBucket[] = await withSpinner(
          "Reading corrected-cost buckets (offline)...",
          async () =>
            readCostExportOffline(resolveOfflineDataDir(), {
              sinceMs,
              agent: options.agent,
              provider: options.provider,
              model: options.model,
              granularity: options.quarterHour === true ? "quarter-hour" : "hourly",
            }),
        );

        if (options.format === "json") {
          // Project to the allowlist even for JSON (defense-in-depth: the rows are
          // already content-free, but never trust a row to be exactly the shape).
          json(rows.map((r) => projectRow(r)));
          return;
        }
        // CSV: toCsv projects ONLY COST_EXPORT_COLUMNS — a stray field cannot leak.
        // eslint-disable-next-line no-console -- the export writes to stdout for redirection (> cost.csv)
        console.log(toCsv(rows as unknown as Array<Record<string, unknown>>, COST_EXPORT_COLUMNS as string[]));
      } catch (e) {
        error(`cost export failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}

/** Project a bucket to the content-free export shape (the JSON path's allowlist). */
function projectRow(row: QuarterHourBucket): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of COST_EXPORT_COLUMNS) out[col] = row[col];
  return out;
}
