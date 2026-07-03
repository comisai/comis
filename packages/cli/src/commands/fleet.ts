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
import type { FleetHealthReport } from "@comis/core";
import { assembleFleetHealthReportOffline, resolveOfflineDataDir } from "../util/offline-obs.js";
import { callTyped, isGatewayAuthRejection, withClient } from "../client/rpc-client.js";
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
    .option(
      "--offline",
      "Assemble from the local ~/.comis files without contacting the daemon",
    )
    .action(async (options: { since: string; format: string; offline?: boolean }) => {
      try {
        const sinceHours = Number.parseFloat(options.since);
        // Same offline contract as `comis explain` — explicit --offline, or
        // automatic fallback when the gateway is UNREACHABLE; an auth-rejection
        // surfaces (the daemon is up — masking the token problem hides a
        // misconfiguration).
        let assembledOffline = options.offline === true;
        const report: FleetHealthReport = await withSpinner(
          assembledOffline
            ? "Assembling fleet health report (offline)..."
            : "Assembling fleet health report...",
          async () => {
            if (options.offline === true) {
              return assembleFleetHealthReportOffline(resolveOfflineDataDir(), sinceHours);
            }
            try {
              return await withClient((client) =>
                callTyped(client, ObsFleetHealthContract, { sinceHours }),
              );
            } catch (e) {
              if (isGatewayAuthRejection(e)) throw e;
              assembledOffline = true;
              return assembleFleetHealthReportOffline(resolveOfflineDataDir(), sinceHours);
            }
          },
        );
        if (assembledOffline && options.offline !== true && options.format !== "json") {
          info("daemon unreachable — report assembled offline from the local data dir");
        }
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
        // The fleet-level degradation detector: degraded counts by
        // named endReason cause. Surface it in the TABLE view (not only via
        // --format json) so an operator running `comis fleet` SEES the spread.
        // Sorted deterministically (count desc, then cause name asc) to match the
        // reducer's bounded ordering; omitted entirely when the map is empty (no
        // degraded sessions, or none with a named cause). Bounded: capped counts
        // + closed-set labels only — no raw bodies.
        const degradedByCause = Object.entries(report.degradedByCause).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        );
        if (degradedByCause.length > 0) {
          info(
            `Degraded by cause: ${degradedByCause.map(([cause, count]) => `${cause}=${count}`).join(", ")}`,
          );
        }
        info(`Breaker:    ${report.breakerTripTotal} trips`);
        // The cross-run AUTONOMY-health slice. Guarded like
        // degradedByCause (above): present ONLY when the daemon ran durable
        // (unattended) runs and the durable store was wired; ABSENT under
        // --offline / a non-durability boot (the assembler omits the block —
        // honest coverage degradation, not a zero-filled stub). Counts + the
        // worst run's id ONLY — never a lease bearer, an orphan-reason body, or a
        // secret (the schema carries no free-text field to leak). The
        // worstRootRunId line is a copy-pasteable `comis explain <rootRunId>` so
        // the operator drills into the worst run's spawn-tree next (the two-tier
        // fleet → explain workflow). --format json (above) emits the block
        // automatically — this is the human-readable table render only.
        if (report.autonomy) {
          const a = report.autonomy;
          // `denialBreaker` is the capability-DENIAL breaker
          // trip count — SEPARATE from `breaker` (the tool-failure breaker). A
          // denial-breaker-aborted run is invisible to every other count (it lands in
          // durable status 'completed'), so this is its only fleet surface.
          info(
            `Autonomy:   ${a.runs.total} run(s) (${a.runs.degraded} degraded, ${(a.runs.degradedRate * 100).toFixed(0)}%) · orphaned=${a.orphaned} resumed=${a.resumed} revoked=${a.revoked} killed=${a.killed} · breaker=${a.breakerTrips} denialBreaker=${a.denialBreakerTrips} budgetBreaches=${a.budgetBreaches}`,
          );
          if (a.worstRootRunId) {
            info(`  → worst run: comis explain ${a.worstRootRunId}`);
          }
        }
        // cost.costUsd is sourced from the session-summary store; the token
        // total is sourced from the session-index files and degrades independently.
        // When the token read degraded (coverage.sessionIndex.daysMissing > 0) the token
        // figure is an unreliable 0 — printing "$X · 0 tok" alongside a real
        // cost reads as a data bug. Drop the contradictory "0 tok" and surface
        // the honest degraded-coverage signal instead; otherwise the normal line.
        const tokensDegraded =
          report.cost.totalTokens === 0 &&
          report.cost.costUsd > 0 &&
          (report.coverage?.sessionIndex.daysMissing ?? 0) > 0;
        if (tokensDegraded) {
          info(
            `Cost:       $${report.cost.costUsd} (tokens unavailable: ${report.coverage?.sessionIndex.daysMissing ?? 0} day(s) of session-index missing)`,
          );
        } else {
          info(
            `Cost:       $${report.cost.costUsd} · ${report.cost.totalTokens} tok`,
          );
        }
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
        if (isGatewayAuthRejection(e)) {
          error("tip: `comis fleet --offline` assembles from the local files without the daemon");
        }
        process.exit(1);
      }
    });
}
