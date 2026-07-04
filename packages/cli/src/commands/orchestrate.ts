// SPDX-License-Identifier: Apache-2.0
/**
 * `comis orchestrate` — operator commands for durable orchestrate runs.
 *
 * Subcommands:
 *   orchestrate replay <runId> [--format text|json]
 *     Deterministically re-run a durable orchestrate run's PINNED script bytes
 *     against a SEPARATE, operator-invoked replay socket that serves the run's
 *     recorded results, and print the byte-identical stdout. The determinism +
 *     confused-deputy safety live in the daemon handler
 *     (setup-orchestrate-replay.ts): the caller supplies ONLY a runId (never a
 *     script), the RPC is admin-scoped + deny-by-origin, and the re-spawn hits
 *     the separate replay socket (never the production endpoint — INV-1).
 *
 * Per the cli-uses-typed-rpc arch invariant: ONLY `callTyped` is used here —
 * never raw `client.call`. `callTyped` runs `OrchestrateReplayContract.request.parse`
 * on `{ runId }` and `OrchestrateReplayContract.response.parse` on the response.
 *
 * @module
 */
import type { Command } from "commander";
import { OrchestrateReplayContract } from "@comis/core";
import { callTyped, isGatewayAuthRejection, withClient } from "../client/rpc-client.js";
import { info, error, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";

/**
 * Register the `orchestrate` command group (currently `orchestrate replay`) on
 * the program.
 *
 * Backed by the frozen `OrchestrateReplayContract` (`orchestrate.replay`, admin
 * scope). The operator's gateway token carries admin scope, so the daemon-side
 * deny-by-origin chokepoint passes for this operator-invoked WS RPC (an
 * agent-origin call is rejected — INV-3).
 *
 * @param program - The root Commander program
 */
export function registerOrchestrateCommand(program: Command): void {
  const orchestrate = program
    .command("orchestrate")
    .description("Operate on durable orchestrate runs");

  orchestrate
    .command("replay <runId>")
    .description(
      "Deterministically re-run a durable orchestrate run's pinned script against its recorded results",
    )
    .option("--format <format>", "Output format: text | json", "text")
    .action(async (runId: string, options: { format: string }) => {
      try {
        const result = await withSpinner("Replaying orchestrate run...", async () =>
          withClient((client) => callTyped(client, OrchestrateReplayContract, { runId })),
        );

        if (options.format === "json") {
          json(result);
          return;
        }

        // A human-readable divergence note (the re-run's cap calls did not line up
        // with the recorded results) — an annotation on the console channel; the
        // recorded stdout is still printed below.
        if (result.diverged) {
          info(
            "replay diverged from the recorded results (a re-run cap call did not match the recording)",
          );
        }

        // Print the recorded stdout VERBATIM (byte-faithful — no chalk/indent/
        // trailing-newline mangling); the recorded output carries its own newlines.
        process.stdout.write(result.stdout);
      } catch (e) {
        error(`replay failed: ${e instanceof Error ? e.message : String(e)}`);
        if (isGatewayAuthRejection(e)) {
          error(
            "tip: orchestrate.replay is admin-only — ensure your gateway token carries admin scope (COMIS_GATEWAY_TOKEN)",
          );
        }
        process.exit(1);
      }
    });
}
