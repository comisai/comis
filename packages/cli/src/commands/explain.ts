// SPDX-License-Identifier: Apache-2.0
/**
 * `comis explain` — operator CLI for the Phase-153 IncidentReport.
 *
 * Assembles a bounded, redaction-safe post-mortem (outcome, cost, per-tool
 * stats, failures, breaker timeline, deterministic likely root cause) for a
 * single agent session and prints it as a concise table or as JSON.
 *
 * Usage:
 *   comis explain <sessionKeyOrTraceId> [--format table|json] [--depth summary|full]
 *
 * Arg routing: a session key contains ':' (tenant:user:channel:ts) → {sessionKey};
 * a UUID (no ':') → {traceId}. The daemon canonicalizes a traceId to its
 * sessionKey, so both produce the identical report.
 *
 * Per the cli-uses-typed-rpc arch invariant: ONLY callTyped is used here —
 * never raw client.call. callTyped runs ObsExplainContract.request.parse on the
 * params and IncidentReportSchema.parse on the response.
 *
 * @module
 */

import type { Command } from "commander";
import { ObsExplainContract } from "@comis/core";
import type { IncidentReport } from "@comis/core";
import { callTyped, isGatewayAuthRejection, withClient } from "../client/rpc-client.js";
import { info, error, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { assembleIncidentReportOffline, resolveOfflineDataDir } from "../util/offline-obs.js";

/**
 * Register the `explain` command on the program.
 *
 * Backed by the frozen `ObsExplainContract` (`obs.explain`, admin scope). The
 * operator's gateway token carries admin scope, so the daemon-side admin gate
 * passes on this WS RPC path (the non-MCP path — no governance change).
 *
 * @param program - The root Commander program
 */
export function registerExplainCommand(program: Command): void {
  program
    .command("explain <sessionKeyOrTraceId>")
    .description(
      "Assemble an IncidentReport for a session (root-cause post-mortem)",
    )
    .option("--format <format>", "Output format: table | json", "table")
    .option("--depth <depth>", "Report depth: summary | full", "summary")
    .option(
      "--offline",
      "Assemble from the local ~/.comis files without contacting the daemon",
    )
    .action(
      async (idArg: string, options: { format: string; depth: string; offline?: boolean }) => {
        try {
          const depth = options.depth as "summary" | "full";
          // Route by arg shape: a sessionKey is tenant:user:channel:ts (has ':');
          // a traceId is a UUID (no ':').
          const params = idArg.includes(":")
            ? { sessionKey: idArg, depth }
            : { traceId: idArg, depth };
          // W14 (obs-llm-troubleshooting): the telemetry lives on LOCAL disk —
          // a post-mortem must not require a live gateway. --offline assembles
          // locally; an UNREACHABLE gateway falls back automatically. An
          // AUTH-REJECTED gateway does NOT auto-fall-back (the daemon is up;
          // masking the token problem hides a misconfiguration) — the error
          // names COMIS_GATEWAY_TOKEN and --offline remains the explicit out.
          let assembledOffline = options.offline === true;
          const report: IncidentReport = await withSpinner(
            assembledOffline
              ? "Assembling incident report (offline)..."
              : "Assembling incident report...",
            async () => {
              if (options.offline === true) {
                return assembleIncidentReportOffline(resolveOfflineDataDir(), params);
              }
              try {
                return await withClient((client) =>
                  callTyped(client, ObsExplainContract, params),
                );
              } catch (e) {
                if (isGatewayAuthRejection(e)) throw e;
                assembledOffline = true;
                return assembleIncidentReportOffline(resolveOfflineDataDir(), params);
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
          info(`Session:    ${report.sessionKey}`);
          info(
            `Outcome:    ${report.outcome.severity} (endReason=${report.outcome.endReason}, degraded=${report.outcome.degraded})`,
          );
          info(
            `Cost:       $${report.cost.costUsd} · ${report.cost.totalTokens} tok`,
          );
          info(
            `Timing:     ${report.timing.durationMs} ms · ${report.timing.turnCount} turns`,
          );
          info(`Summary:    ${report.summary}`);
          if (report.likelyRootCause) {
            info(
              `Root cause [${report.likelyRootCause.code}]: ${report.likelyRootCause.detail}`,
            );
          }
          for (const step of report.suggestedNextSteps) {
            info(`  → ${step}`);
          }
        } catch (e) {
          error(`explain failed: ${e instanceof Error ? e.message : String(e)}`);
          if (isGatewayAuthRejection(e)) {
            error("tip: `comis explain --offline` assembles from the local files without the daemon");
          }
          process.exit(1);
        }
      },
    );
}
