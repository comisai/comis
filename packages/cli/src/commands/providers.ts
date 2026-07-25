// SPDX-License-Identifier: Apache-2.0
/**
 * Provider listing CLI command.
 *
 * Provides `comis providers list` for browsing available providers from
 * the live pi-ai catalog (with daemon RPC + local fallback). Status
 * column reports the daemon's agent-scoped credential resolution when the
 * daemon is reachable. Offline fallback reports only keyless or ambient-env
 * truth and marks all other providers unknown.
 *
 * Mirrors `commands/models.ts` shape -- RPC-first, local catalog
 * fallback, `--format` flag, no `set` subcommand (provider switching
 * goes through `comis agent configure --provider X`).
 *
 * @module
 */

import type { Command } from "commander";
import { loadProvidersWithFallback } from "../client/provider-list.js";
import { error, info, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable } from "../output/table.js";

/**
 * Register the `providers` command group on the program.
 *
 * Provides:
 * - `comis providers list` -- browse available providers
 *
 * @param program - The root Commander program
 */
export function registerProvidersCommand(program: Command): void {
  const providers = program
    .command("providers")
    .description("Provider management");

  providers
    .command("list")
    .description("List available providers from the catalog")
    .option("--format <format>", 'Output format: "table" or "json"', "table")
    .option("--agent <id>", "Resolve credentials for this agent")
    .action(async (options: { format: string; agent?: string }) => {
      try {
        const rows = await withSpinner("Loading providers...", () =>
          loadProvidersWithFallback(options.agent),
        );

        if (rows.length === 0) {
          info("No providers found in catalog");
          return;
        }

        if (options.format === "json") {
          json(rows);
          return;
        }

        renderTable(
          ["Provider", "Models", "Status"],
          rows.map((row) => [
            row.provider,
            String(row.modelCount),
            row.status.replaceAll("_", " "),
          ]),
        );

        info(
          `${rows.length} provider${rows.length !== 1 ? "s" : ""} listed`,
        );
        if (rows.some((row) => row.status === "unknown")) {
          info(
            "Credential status is unknown without the daemon; start it or use a daemon-connected CLI to inspect encrypted credentials.",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to list providers: ${msg}`);
        process.exit(1);
      }
    });
}
