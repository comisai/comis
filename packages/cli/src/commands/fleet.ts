// SPDX-License-Identifier: Apache-2.0
/**
 * `comis fleet` — operator CLI for the cross-session FleetHealthReport
 * (`obs.fleet.health`).
 *
 * Assembles a bounded fleet-health triage (degradation rate, recurring WARNs,
 * model/config health) over a window and prints it as a concise table or as
 * JSON. Backed by the admin-scoped `ObsFleetHealthContract`; the operator's
 * gateway token carries admin scope, so the daemon-side admin gate passes on
 * this WS RPC path (the non-MCP path — no governance change).
 *
 * Usage:
 *   comis fleet [--since <hours>] [--format table|json]
 *
 * DISTINCT from `comis health` (the LOCAL doctor — `runDoctorChecks`, no RPC):
 * this is a REMOTE admin RPC. It is the cross-session SIBLING of `comis explain`
 * (single-session post-mortem).
 *
 * Per the cli-uses-typed-rpc arch invariant: ONLY callTyped is used here —
 * never raw client.call. callTyped runs ObsFleetHealthContract.request.parse on
 * the params and FleetHealthReportSchema.parse on the response.
 *
 * @module
 */

import type { Command } from "commander";
import { ObsFleetHealthContract } from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { info, error, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";

/**
 * Register the `fleet` command on the program.
 *
 * Backed by the admin-scoped `ObsFleetHealthContract` (`obs.fleet.health`). The
 * operator's gateway token carries admin scope, so the daemon-side admin gate
 * passes on this WS RPC path. A DISTINCT command from `registerHealthCommand`
 * (`comis health`, the local doctor) — this one does NOT overload it.
 *
 * @param program - The root Commander program
 */
export function registerFleetCommand(program: Command): void {
  program
    .command("fleet")
    .description(
      "Cross-session fleet-health triage (recurring WARNs, degradation rate, model/config health)",
    )
    .option("--since <hours>", "Window in hours", "24")
    .option("--format <format>", "Output format: table | json", "table")
    .action(async (options: { since: string; format: string }) => {
      try {
        const sinceHours = Number.parseFloat(options.since);
        const report = await withSpinner(
          "Assembling fleet health report...",
          () =>
            withClient((client) =>
              callTyped(client, ObsFleetHealthContract, { sinceHours }),
            ),
        );
        if (options.format === "json") {
          json(report);
          return;
        }
        // Table view — concise key fields (kept small; the test exercises both
        // this branch and the json branch to hold the coverage floor).
        info(`Window:     last ${report.windowHours}h`);
        info(
          `Sessions:   ${report.sessions.total} (${report.sessions.degraded} degraded, ${(report.sessions.degradedRate * 100).toFixed(0)}%)`,
        );
        info(`Breaker:    ${report.breakerTripTotal} trips`);
        info(
          `Cost:       $${report.cost.costUsd} · ${report.cost.totalTokens} tok`,
        );
        for (const f of report.findings) {
          info(`  [${f.code}] ${f.detail} (×${f.count}) → ${f.hint}`);
        }
        if (report.likelyRootCause) {
          info(
            `Root cause [${report.likelyRootCause.code}]: ${report.likelyRootCause.detail}`,
          );
        }
        for (const step of report.suggestedNextSteps) {
          info(`  → ${step}`);
        }
      } catch (e) {
        error(`fleet failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
