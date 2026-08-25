// SPDX-License-Identifier: Apache-2.0
/**
 * `comis capability-services` and `comis managed-runs` — the operator view over
 * installed capability services and the external work they own.
 *
 * These read the host's own authority records. The companion product that owns
 * a run explains what its task means; this explains whether the host bound it,
 * whether its policy snapshot and capability ceiling resolved, which host
 * records it holds, and whether the service is still reporting. Diagnosing a
 * stuck run with only one of those halves is guesswork.
 *
 * Every method is admin-trust and has no agent route, so an unreachable or
 * refusing daemon is reported as exactly that rather than being papered over
 * with a local guess: there is no offline projection of another process's
 * authority record that would be safe to present as current.
 *
 * @module
 */
import type { Command } from "commander";
import chalk from "chalk";
import {
  CapabilityServicesGetContract,
  CapabilityServicesListContract,
  ManagedAttentionListContract,
  ManagedRunsCancelContract,
  ManagedRunsExplainContract,
  ManagedRunsGetContract,
  ManagedRunsListContract,
  ManagedRunStatusSchema,
} from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { json } from "../output/format.js";

interface FormatOption { readonly format?: string }

function asJson(options: FormatOption): boolean {
  return options.format === "json";
}

/** Stable, tabular-friendly rendering. Unknown and stale read as words, never as blanks. */
function runRow(row: Record<string, unknown>): string {
  const freshness = row["freshness"] as { livenessStale?: boolean } | undefined;
  const liveness = freshness?.livenessStale === true ? chalk.yellow("stale") : "current";
  const attention = Number(row["openAttentionCount"] ?? 0);
  return [
    String(row["managedRunId"]).padEnd(28),
    String(row["status"]).padEnd(18),
    String(row["serviceInstanceId"]).padEnd(24),
    String(row["agentId"]).padEnd(16),
    liveness.padEnd(16),
    attention > 0 ? chalk.yellow(`${attention} waiting`) : "-",
  ].join(" ");
}

function printRuns(rows: readonly Record<string, unknown>[], truncated: boolean): void {
  if (rows.length === 0) {
    process.stdout.write("No managed runs.\n");
    return;
  }
  process.stdout.write(chalk.dim([
    "RUN".padEnd(28),
    "STATE".padEnd(18),
    "SERVICE".padEnd(24),
    "AGENT".padEnd(16),
    "LIVENESS".padEnd(16),
    "ATTENTION",
  ].join(" ")) + "\n");
  for (const row of rows) process.stdout.write(`${runRow(row)}\n`);
  if (truncated) {
    // Silence here would read as "that is all of them".
    process.stdout.write(chalk.yellow("\nMore runs exist than were listed; raise --limit to see them.\n"));
  }
}

function printExplain(report: Record<string, unknown>): void {
  const run = report["run"] as Record<string, unknown> | undefined;
  const cause = report["likelyRootCause"] as { code: string; hint: string };
  const actions = (report["nextSafeActions"] as string[] | undefined) ?? [];
  if (run !== undefined) {
    process.stdout.write(`${chalk.bold(String(run["managedRunId"]))}  ${String(run["status"])}\n`);
    process.stdout.write(`  service       ${String(run["serviceInstanceId"])}\n`);
    process.stdout.write(`  agent         ${String(run["agentId"])} (tenant ${String(run["tenantId"])})\n`);
    process.stdout.write(`  policy hash   ${String(run["workspacePolicyHash"])}\n`);
    process.stdout.write(`  capability    ${String(run["capturedCapabilityViewHash"])}\n`);
    process.stdout.write(`  lease         ${String(run["workspaceLeaseId"] ?? "none")}\n`);
    process.stdout.write(`  terminals     ${(run["terminalSessionIds"] as string[]).length}\n`);
    process.stdout.write(
      `  reports       accepted ${String(run["lastAcceptedReportSequence"])}, `
      + `reduced ${String(run["lastReducedReportSequence"])}\n`,
    );
    // Naming the unavailable capability keeps an operator from reading a blank
    // as "no operator holds custody" or "no processes are running".
    process.stdout.write(`  custody       not available (${String((run["custody"] as { reasonCode: string }).reasonCode)})\n`);
    process.stdout.write(`  processes     not available (${String((run["processSummary"] as { reasonCode: string }).reasonCode)})\n\n`);
  }
  process.stdout.write(`${chalk.bold("Likely cause")}  ${cause.code}\n`);
  process.stdout.write(`${cause.hint}\n`);
  process.stdout.write(`${chalk.bold("Next safe actions")}  ${actions.length === 0 ? "none" : actions.join(", ")}\n`);
}

/** Register the operator commands over installed capability services. */
export function registerManagedRunCommands(program: Command): void {
  const services = program
    .command("capability-services")
    .description("Inspect installed capability-service instances");

  services
    .command("list")
    .description("List every configured capability-service instance and its state")
    .option("--format <format>", "Output format: table | json", "table")
    .action(async (options: FormatOption) => {
      const result = await withClient((client) =>
        callTyped(client, CapabilityServicesListContract, {}));
      if (asJson(options)) return json(result);
      const rows = result.rows as Record<string, unknown>[];
      if (rows.length === 0) {
        process.stdout.write("No capability-service instance is configured.\n");
        return;
      }
      for (const row of rows) {
        process.stdout.write(
          `${String(row["serviceInstanceId"]).padEnd(24)} ${String(row["state"]).padEnd(12)} `
          + `runs ${String(row["activeRunCount"])} (degraded ${String(row["degradedRunCount"])})\n`,
        );
      }
    });

  services
    .command("get <serviceInstanceId>")
    .description("Show one instance, its declared scopes, and its approved roots")
    .option("--format <format>", "Output format: table | json", "table")
    .action(async (serviceInstanceId: string, options: FormatOption) => {
      const result = await withClient((client) =>
        callTyped(client, CapabilityServicesGetContract, { serviceInstanceId }));
      if (asJson(options)) return json(result);
      const instance = result.instance as Record<string, unknown> | undefined;
      if (instance === undefined) {
        process.stdout.write(`No configured instance is named ${serviceInstanceId}.\n`);
        return;
      }
      process.stdout.write(`${chalk.bold(String(instance["serviceInstanceId"]))}  ${String(instance["state"])}\n`);
      process.stdout.write(`  definition    ${String(instance["serviceDefinitionId"])}\n`);
      process.stdout.write(`  scopes        ${(instance["requestedScopes"] as string[]).join(", ")}\n`);
      process.stdout.write(`  agents        ${(instance["allowedAgents"] as string[]).join(", ")}\n`);
      process.stdout.write(`  liveness      ${instance["livenessRequired"] === true ? "required" : "not required"}\n`);
      process.stdout.write(`  runs          ${String(instance["activeRunCount"])} active, ${String(instance["degradedRunCount"])} degraded\n`);
    });

  const runs = program
    .command("managed-runs")
    .description("Inspect and control external work bound to this daemon");

  runs
    .command("list")
    .description("List managed runs across every conversation this daemon holds")
    .option("--service <serviceInstanceId>", "Only runs owned by one instance")
    .option("--agent <agentId>", "Only runs bound to one agent")
    .option("--state <status>", "Only runs in one lifecycle state")
    .option("--limit <count>", "Maximum rows to return", "100")
    .option("--format <format>", "Output format: table | json", "table")
    .action(async (options: FormatOption & {
      service?: string;
      agent?: string;
      state?: string;
      limit?: string;
    }) => {
      const result = await withClient((client) => callTyped(client, ManagedRunsListContract, {
        ...(options.service === undefined ? {} : { serviceInstanceId: options.service }),
        ...(options.agent === undefined ? {} : { agentId: options.agent }),
        // Parsed through the contract rather than cast: an unknown state is a
        // typo the operator should see named, not a filter that silently matches
        // nothing and reads as "no runs are in that state".
        ...(options.state === undefined
          ? {}
          : { status: ManagedRunStatusSchema.parse(options.state) }),
        limit: Number(options.limit ?? 100),
      }));
      if (asJson(options)) return json(result);
      printRuns(result.rows as Record<string, unknown>[], result.truncated === true);
    });

  runs
    .command("get <managedRunId>")
    .description("Show one run's durable authority record")
    .option("--format <format>", "Output format: table | json", "table")
    .action(async (managedRunId: string, options: FormatOption) => {
      const result = await withClient((client) =>
        callTyped(client, ManagedRunsGetContract, { managedRunId }));
      if (asJson(options)) return json(result);
      if (result.run === undefined) {
        process.stdout.write(`No managed run is named ${managedRunId}.\n`);
        return;
      }
      printExplain({ run: result.run, likelyRootCause: { code: "-", hint: "" }, nextSafeActions: [] });
    });

  runs
    .command("explain <managedRunId>")
    .description("Diagnose one run: what bound it, what it holds, and what is blocking it")
    .option("--format <format>", "Output format: table | json", "table")
    .action(async (managedRunId: string, options: FormatOption) => {
      const result = await withClient((client) =>
        callTyped(client, ManagedRunsExplainContract, { managedRunId }));
      if (asJson(options)) return json(result);
      printExplain(result as Record<string, unknown>);
    });

  runs
    .command("cancel <managedRunId>")
    .description("Cancel one run on host authority")
    .option("--operation <operationId>", "Stable identity so a retry is not a second cancel")
    .option("--format <format>", "Output format: table | json", "table")
    .action(async (managedRunId: string, options: FormatOption & { operation?: string }) => {
      // The operation id is what makes a retry safe. Deriving it from the run
      // means a repeated command reconciles instead of cancelling twice.
      const operationId = options.operation ?? `operator-cancel-${managedRunId}`;
      const result = await withClient((client) =>
        callTyped(client, ManagedRunsCancelContract, { managedRunId, operationId }));
      if (asJson(options)) return json(result);
      if (result.outcome === "not_found") {
        process.stdout.write(`No managed run is named ${managedRunId}.\n`);
        return;
      }
      if (result.outcome === "already_terminal") {
        process.stdout.write(`Run already settled as ${String(result.status)}; nothing to cancel.\n`);
        return;
      }
      process.stdout.write("Run cancelled on host authority.\n");
      if (result.serviceAcknowledged === false) {
        // Cancelled is cancelled. Say what has not happened yet without
        // implying the cancel itself failed.
        process.stdout.write(chalk.yellow(
          `The owning service has not confirmed yet (${String(result.serviceReasonCode)}); `
          + "it reconciles on its next handshake.\n",
        ));
      }
    });

  const attention = program
    .command("managed-attention")
    .description("Inspect the questions managed runs are waiting on");

  attention
    .command("list")
    .description("List attention records, optionally for one run")
    .option("--run <managedRunId>", "Only records raised by one run")
    .option("--limit <count>", "Maximum rows to return", "100")
    .option("--format <format>", "Output format: table | json", "table")
    .action(async (options: FormatOption & { run?: string; limit?: string }) => {
      const result = await withClient((client) => callTyped(client, ManagedAttentionListContract, {
        ...(options.run === undefined ? {} : { managedRunId: options.run }),
        limit: Number(options.limit ?? 100),
      }));
      if (asJson(options)) return json(result);
      const rows = result.rows as Record<string, unknown>[];
      if (rows.length === 0) {
        process.stdout.write("No attention record.\n");
        return;
      }
      for (const row of rows) {
        process.stdout.write(
          `${String(row["attentionId"]).padEnd(28)} ${String(row["status"]).padEnd(18)} `
          + `${String(row["managedRunId"])}\n`,
        );
      }
    });
}
