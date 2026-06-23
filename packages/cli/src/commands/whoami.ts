// SPDX-License-Identifier: Apache-2.0
/**
 * `comis whoami` — operator/agent CLI for the Phase-215 `capabilities.introspect`
 * read: the run's resolved orchestration capabilities + the remaining per-root
 * budget/quota.
 *
 * Usage:
 *   comis whoami [--caps] [--format table|json]
 *
 * Backed by `CapabilitiesIntrospectContract` (`capabilities.introspect`,
 * `scopes:["rpc"]` — read-only, no cap). The request is `{}`: the read is
 * SELF-SCOPED — the daemon resolves the caller from the dispatcher-injected
 * `_agentId`, so an operator/CLI token sees the default agent's posture and an
 * agent sees its OWN.
 *
 * Per the cli-uses-typed-rpc arch invariant: ONLY `callTyped` is used here —
 * never raw `client.call`. `callTyped` runs `CapabilitiesIntrospectContract`
 * request + response parse.
 *
 * LIVE-ONLY (Pitfall 4 / G5 / T-215-13): unlike `comis explain`, `whoami` has NO
 * `--offline` mode and NO unreachable-fallback. The remaining budget/quota lives
 * ONLY in the running daemon's `BoundedAutonomy` maps — never on disk — so a
 * post-mortem reconstruction is impossible. On an unreachable (or token-rejected)
 * daemon the command FAILS clearly with `process.exit(1)`; it NEVER fabricates an
 * empty/zero snapshot (which would report a FALSE posture).
 *
 * @module
 */

import type { Command } from "commander";
import { CapabilitiesIntrospectContract } from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { info, error, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";

/**
 * Register the `whoami` command on the program.
 *
 * @param program - The root Commander program
 */
export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Show this run's resolved capabilities + remaining budget/quota (live)")
    .option("--caps", "Show capabilities only (omit the budget/quota lines)")
    .option("--format <format>", "Output format: table | json", "table")
    .action(async (options: { caps?: boolean; format: string }) => {
      try {
        // LIVE-only: a direct RPC, NO offline assembler. Remaining budget is
        // in-memory daemon state; an unreachable daemon must fail, not fabricate.
        const report = await withSpinner("Reading capabilities...", async () =>
          withClient((client) => callTyped(client, CapabilitiesIntrospectContract, {})),
        );

        if (options.format === "json") {
          json(report);
          return;
        }

        // Table view — Agent + Caps always; Budget/Outward only when present AND
        // --caps was not requested.
        info(`Agent:   ${report.agentId}`);
        info(`Caps:    ${report.caps.length > 0 ? report.caps.join(", ") : "(none)"}`);
        if (!options.caps && report.budget) {
          const usd =
            report.budget.usdRemaining !== null
              ? ` · $${report.budget.usdRemaining}`
              : " · $ uncountable";
          info(
            `Budget:  ${report.budget.tokensRemaining} tok · ${report.budget.wallClockMsRemaining} ms${usd}`,
          );
        }
        if (!options.caps && report.outwardQuota) {
          info(`Outward: ${report.outwardQuota.perHourRemaining}/hr remaining`);
        }
      } catch (e) {
        // LIVE-only honesty: surface the failure, never a fabricated snapshot.
        error(`whoami failed: ${e instanceof Error ? e.message : String(e)}`);
        error(
          "tip: whoami is live-only — the remaining budget is in-memory daemon state. Ensure the daemon is running and COMIS_GATEWAY_TOKEN is set.",
        );
        process.exit(1);
      }
    });
}
