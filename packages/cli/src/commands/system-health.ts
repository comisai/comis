// SPDX-License-Identifier: Apache-2.0
/**
 * `comis system-health` — operator CLI for the cross-session SystemHealthReport
 * (`obs.system.health`).
 *
 * Assembles a bounded system-health triage (degradation rate, recurring WARNs,
 * model/config health) over a window and prints it as a concise table or as
 * JSON. Backed by the admin-scoped `ObsSystemHealthContract`; the operator's
 * gateway token carries admin scope, so the daemon-side admin gate passes on
 * this WS RPC path (the non-MCP path — no governance change).
 *
 * Usage:
 *   comis system-health [--since <hours>] [--format table|json]
 *
 * DISTINCT from `comis health` (the LOCAL doctor — `runDoctorChecks`, no RPC):
 * this is a REMOTE admin RPC. It is the cross-session SIBLING of `comis explain`
 * (single-session post-mortem).
 *
 * Per the cli-uses-typed-rpc arch invariant: ONLY callTyped is used here —
 * never raw client.call. callTyped runs ObsSystemHealthContract.request.parse on
 * the params and SystemHealthReportSchema.parse on the response.
 *
 * @module
 */

import type { Command } from "commander";
import { ObsSystemHealthContract } from "@comis/core";
import type { SystemHealthReport } from "@comis/core";
import { assembleSystemHealthReportOffline, resolveOfflineDataDir } from "../util/offline-obs.js";
import { callTyped, isGatewayAuthRejection, withClient } from "../client/rpc-client.js";
import { info, error, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";

/**
 * Register the `system` command on the program.
 *
 * Backed by the admin-scoped `ObsSystemHealthContract` (`obs.system.health`). The
 * operator's gateway token carries admin scope, so the daemon-side admin gate
 * passes on this WS RPC path. A DISTINCT command from `registerHealthCommand`
 * (`comis health`, the local doctor) — this one does NOT overload it.
 *
 * @param program - The root Commander program
 */
export function registerSystemHealthCommand(program: Command): void {
  program
    .command("system-health")
    .description(
      "Cross-session system-health triage (recurring WARNs, degradation rate, model/config health)",
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
        const report: SystemHealthReport = await withSpinner(
          assembledOffline
            ? "Assembling system health report (offline)..."
            : "Assembling system health report...",
          async () => {
            if (options.offline === true) {
              return assembleSystemHealthReportOffline(resolveOfflineDataDir(), sinceHours);
            }
            try {
              return await withClient((client) =>
                callTyped(client, ObsSystemHealthContract, { sinceHours }),
              );
            } catch (e) {
              if (isGatewayAuthRejection(e)) throw e;
              assembledOffline = true;
              return assembleSystemHealthReportOffline(resolveOfflineDataDir(), sinceHours);
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
        // Split the degraded count into HARD failures (user got a degraded/no
        // reply) vs delivered-with-tool-errors (a final answer WAS delivered
        // despite a recovered/acknowledged tool error) so a system of self-healed
        // hiccups is not misread as a high failure rate.
        // Read the split OFF the report — deriving it here is what let the table
        // and the report's own JSON disagree (comis-moshe 2026-07-26). The `??`
        // fallbacks keep an older daemon's report renderable.
        const delivered = report.sessions.deliveredWithToolErrors ?? 0;
        const hardDegraded = report.sessions.hardDegraded ?? (report.sessions.degraded - delivered);
        const hardRate = report.sessions.hardDegradedRate
          ?? (report.sessions.total > 0 ? hardDegraded / report.sessions.total : 0);
        const hardPct = Math.round(hardRate * 100);
        info(
          delivered > 0
            ? `Sessions:   ${report.sessions.total} (${hardDegraded} hard-degraded, ${hardPct}%; +${delivered} delivered-with-tool-errors — user still got a reply)`
            : `Sessions:   ${report.sessions.total} (${report.sessions.degraded} degraded, ${(report.sessions.degradedRate * 100).toFixed(0)}%)`,
        );
        // The system-level degradation detector: degraded counts by
        // named endReason cause. Surface it in the TABLE view (not only via
        // --format json) so an operator running `comis system-health` SEES the spread.
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
        if (report.worstDegradedExecution) {
          info(`Worst:      comis explain ${report.worstDegradedExecution.traceId}`);
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
        // system → explain workflow). --format json (above) emits the block
        // automatically — this is the human-readable table render only.
        if (report.autonomy) {
          const a = report.autonomy;
          // `denialBreaker` is the capability-DENIAL breaker
          // trip count — SEPARATE from `breaker` (the tool-failure breaker). A
          // denial-breaker-aborted run is invisible to every other count (it lands in
          // durable status 'completed'), so this is its only system surface.
          info(
            `Autonomy:   ${a.runs.total} run(s) (${a.runs.degraded} degraded, ${(a.runs.degradedRate * 100).toFixed(0)}%) · orphaned=${a.orphaned} resumed=${a.resumed} revoked=${a.revoked} killed=${a.killed} · breaker=${a.breakerTrips} denialBreaker=${a.denialBreakerTrips} budgetBreaches=${a.budgetBreaches}`,
          );
          if (a.worstRootRunId) {
            info(`  → worst run: comis explain ${a.worstRootRunId}`);
          }
        }
        // Cost, tokens, and calls share the corrected provider-billing ledger.
        // Session-index tokens remain a separate activity metric.
        const offSession = report.cost.offSessionUsd ?? 0;
        const offSessionSuffix =
          offSession > 0 ? ` (includes $${offSession} synthetic off-session)` : "";
        const callSuffix =
          report.cost.callCount === undefined ? "" : ` · ${report.cost.callCount} call(s)`;
        info(
          `Cost:       $${report.cost.costUsd} · ${report.cost.totalTokens} tok (input+output+cache)${callSuffix}${offSessionSuffix}`,
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
        error(`system-health failed: ${e instanceof Error ? e.message : String(e)}`);
        if (isGatewayAuthRejection(e)) {
          error("tip: `comis system-health --offline` assembles from the local files without the daemon");
        }
        process.exit(1);
      }
    });
}
