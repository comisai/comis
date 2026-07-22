// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Commander.js command handlers translate RPC and validation failures to user-facing CLI errors.
/** Strict RPC-backed cron inventory, history, status, and manual execution commands. */
import type { Command } from "commander";
import type { z } from "zod";
import {
  CronListContract,
  CronRunContract,
  CronRunsContract,
  CronResetContract,
  CronStatusContract,
  redactOutputText,
  systemDateFrom,
} from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { error, info, json } from "../output/format.js";
import { renderKeyValue, renderTable } from "../output/table.js";
import { withSpinner } from "../output/spinner.js";

type OutputFormat = "table" | "json";
type CronJobView = z.output<typeof CronListContract.response>["jobs"][number];
type CronRunView = z.output<typeof CronRunsContract.response>["runs"][number];

interface CommonOptions {
  readonly agent?: string;
  readonly format: string;
}

interface ListOptions extends CommonOptions {
  readonly all?: boolean;
}

interface RunsOptions extends CommonOptions {
  readonly limit?: string;
}

interface ResetOptions extends CommonOptions {
  readonly target: string;
  readonly storeDigest?: string;
  readonly ledgerDigest?: string;
  readonly confirm?: boolean;
}

function fail(message: string): never {
  error(message);
  process.exit(1);
}

function parseFormat(value: string): OutputFormat {
  if (value === "table" || value === "json") return value;
  return fail(`invalid --format '${value}' — expected table or json`);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 10_000) {
    return fail(`invalid --limit '${value}' — expected an integer from 1 to 10000`);
  }
  return parsed;
}

function parseResetTarget(value: string): "store" | "ledger" | "all" {
  if (value === "store" || value === "ledger" || value === "all") return value;
  return fail(`invalid --target '${value}' — expected store, ledger, or all`);
}

function parseDigest(option: "--store-digest" | "--ledger-digest", value: string | undefined): string | null {
  if (value === undefined) return fail(`${option} is required for the selected reset target`);
  if (value === "missing") return null;
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  return fail(`invalid ${option} — expected a lowercase SHA-256 digest or 'missing'`);
}

function tableCell(value: string): string {
  const redacted = redactOutputText(value).text;
  return Array.from(redacted).filter((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined
      && !(codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || (codePoint >= 0x2028 && codePoint <= 0x202e)
        || (codePoint >= 0x2066 && codePoint <= 0x2069));
  }).join("");
}

function formatEpoch(epochMs: number | undefined): string {
  return epochMs === undefined ? "-" : systemDateFrom(epochMs).toISOString();
}

function formatCounters(counters: CronRunView["counters"]): string {
  return counters === undefined || counters.length === 0
    ? "-"
    : counters.map((counter) => `${counter.name}=${counter.value}`).join(", ");
}

function formatSchedule(job: CronJobView): string {
  switch (job.schedule.kind) {
    case "cron":
      return `${job.schedule.expr} (${job.schedule.tz})`;
    case "every":
      return `every ${job.schedule.everyMs}ms from ${formatEpoch(job.schedule.anchorMs)}`;
    case "at":
      return `at ${formatEpoch(job.schedule.atMs)}`;
    default: {
      const _exhaustive: never = job.schedule;
      return String(_exhaustive);
    }
  }
}

function formatLifecycle(job: CronJobView): string {
  const lifecycle = job.lifecycle;
  switch (lifecycle.status) {
    case "scheduled":
      return `scheduled · ${formatEpoch(lifecycle.nextRunAtMs)}`;
    case "paused":
      return `paused (${lifecycle.reason}) · ${formatEpoch(lifecycle.nextRunAtMs)}`;
    case "one_shot_claimed":
      return `claimed · ${tableCell(lifecycle.executionId)}`;
    case "one_shot_terminal":
      return `terminal · ${formatEpoch(lifecycle.terminalAtMs)}`;
    default: {
      const _exhaustive: never = lifecycle;
      return String(_exhaustive);
    }
  }
}

function renderJobs(jobs: readonly CronJobView[]): void {
  if (jobs.length === 0) {
    info("No cron jobs found");
    return;
  }
  renderTable(
    ["Agent", "Name", "Source", "Schedule", "State"],
    jobs.map((job) => [
      tableCell(job.agentId),
      tableCell(job.name),
      job.source,
      tableCell(formatSchedule(job)),
      tableCell(formatLifecycle(job)),
    ]),
  );
}

function renderRuns(runs: readonly CronRunView[]): void {
  if (runs.length === 0) {
    info("No cron execution history found");
    return;
  }
  renderTable(
    ["Started", "Status", "Delivery", "Trigger", "Work", "Counters", "Execution ID"],
    runs.map((run) => [
      formatEpoch(run.startedAtMs),
      run.status,
      run.deliveryStatus,
      run.trigger,
      run.workKind,
      formatCounters(run.counters),
      tableCell(run.executionId),
    ]),
  );
}

async function runCommand(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    fail(`${label} failed: ${message}`);
  }
}

/** Register `comis cron` without importing scheduler implementation types or files. */
export function registerCronCommand(program: Command): void {
  const cron = program
    .command("cron")
    .description("Inspect and manually run daemon-managed cron jobs");

  cron
    .command("list")
    .description("List persisted cron jobs")
    .option("--agent <id>", "Select one agent")
    .option("--all", "List jobs for all agents (admin only)")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: ListOptions) => {
      const format = parseFormat(options.format);
      if (options.all === true && options.agent !== undefined) {
        fail("--all and --agent cannot be used together");
      }
      await runCommand("Cron list", async () => {
        const agentId = options.all === true ? "*" : options.agent;
        const response = await withSpinner("Fetching cron jobs...", () =>
          withClient((client) => callTyped(
            client,
            CronListContract,
            agentId === undefined ? {} : { agentId },
          )),
        );
        if (format === "json") json(response);
        else renderJobs(response.jobs);
      });
    });

  cron
    .command("run <jobName>")
    .description("Force one named cron job to run")
    .option("--agent <id>", "Select one agent")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (jobName: string, options: CommonOptions) => {
      const format = parseFormat(options.format);
      await runCommand("Cron run", async () => {
        const response = await withSpinner(`Running cron job "${tableCell(jobName)}"...`, () =>
          withClient((client) => callTyped(client, CronRunContract, {
            jobName,
            mode: "force",
            ...(options.agent === undefined ? {} : { agentId: options.agent }),
          })),
        );
        if (format === "json") json(response);
        else {
          renderKeyValue([
            ["Agent", tableCell(response.resolvedAgentId)],
            ["Job", tableCell(response.jobName ?? jobName)],
            ["Triggered", response.triggered ? "yes" : "no"],
            ["Execution ID", tableCell(response.executionId ?? "-")],
          ]);
        }
      });
    });

  cron
    .command("runs <jobName>")
    .description("Show immutable execution history for one named cron job")
    .option("--agent <id>", "Select one agent")
    .option("--limit <n>", "Maximum run groups (1-10000)")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (jobName: string, options: RunsOptions) => {
      const format = parseFormat(options.format);
      const limit = parseLimit(options.limit);
      await runCommand("Cron runs", async () => {
        const response = await withSpinner(`Fetching cron history for "${tableCell(jobName)}"...`, () =>
          withClient((client) => callTyped(client, CronRunsContract, {
            jobName,
            ...(limit === undefined ? {} : { limit }),
            ...(options.agent === undefined ? {} : { agentId: options.agent }),
          })),
        );
        if (format === "json") json(response);
        else renderRuns(response.runs);
      });
    });

  cron
    .command("status")
    .description("Show scheduler status for one agent")
    .option("--agent <id>", "Select one agent")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: CommonOptions) => {
      const format = parseFormat(options.format);
      await runCommand("Cron status", async () => {
        const response = await withSpinner("Fetching cron scheduler status...", () =>
          withClient((client) => callTyped(
            client,
            CronStatusContract,
            options.agent === undefined ? {} : { agentId: options.agent },
          )),
        );
        if (format === "json") json(response);
        else {
          renderKeyValue([
            ["Agent", tableCell(response.resolvedAgentId)],
            ["State", response.state],
            ["Configured", response.configuredEnabled ? "enabled" : "disabled"],
            ["Jobs", String(response.jobCount)],
            ["Active claims", String(response.activeClaimCount)],
            ["Store digest", response.store.digest ?? "missing"],
            ["Ledger digest", response.ledger.digest ?? "missing"],
            ["Reset intent", response.intent.status],
            ["Ownership", response.ownershipReconciled ? "reconciled" : "not reconciled"],
            ["Last error", response.lastError?.code ?? "-"],
          ]);
        }
      });
    });

  cron
    .command("reset")
    .description("Archive and replace selected cron authority files (admin only)")
    .option("--agent <id>", "Select one agent")
    .requiredOption("--target <target>", "Authority target (store|ledger|all)")
    .option("--store-digest <sha256|missing>", "Expected raw store digest from cron status")
    .option("--ledger-digest <sha256|missing>", "Expected raw ledger digest from cron status")
    .option("--confirm", "Confirm archival and strict empty replacement")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: ResetOptions) => {
      const format = parseFormat(options.format);
      const target = parseResetTarget(options.target);
      if (options.confirm !== true) fail("--confirm is required for cron authority reset");
      let store: string | null = null;
      let ledger: string | null = null;
      if (target === "store" || target === "all") {
        store = parseDigest("--store-digest", options.storeDigest);
      }
      if (target === "ledger" || target === "all") {
        ledger = parseDigest("--ledger-digest", options.ledgerDigest);
      }
      if (target === "store" && options.ledgerDigest !== undefined) {
        fail("--ledger-digest is not valid for a store-only reset");
      }
      if (target === "ledger" && options.storeDigest !== undefined) {
        fail("--store-digest is not valid for a ledger-only reset");
      }
      await runCommand("Cron reset", async () => {
        const response = await withSpinner("Resetting cron authority...", () => {
          if (target === "store") {
            return withClient((client) => callTyped(client, CronResetContract, {
              target: "store",
              expectedDigests: { store },
              confirmed: true,
              ...(options.agent === undefined ? {} : { agentId: options.agent }),
            }));
          }
          if (target === "ledger") {
            return withClient((client) => callTyped(client, CronResetContract, {
              target: "ledger",
              expectedDigests: { ledger },
              confirmed: true,
              ...(options.agent === undefined ? {} : { agentId: options.agent }),
            }));
          }
          return withClient((client) => callTyped(client, CronResetContract, {
            target: "all",
            expectedDigests: { store, ledger },
            confirmed: true,
            ...(options.agent === undefined ? {} : { agentId: options.agent }),
          }));
        });
        if (format === "json") json(response);
        else {
          renderKeyValue([
            ["Agent", tableCell(response.resolvedAgentId)],
            ["Operation", tableCell(response.operationId)],
            ["Target", response.target],
            ["State", response.state],
            ["Reactivated", response.reactivated ? "yes" : "no"],
            ["Store before", response.beforeDigests.store ?? "missing"],
            ["Store after", response.afterDigests.store ?? "missing"],
            ["Ledger before", response.beforeDigests.ledger ?? "missing"],
            ["Ledger after", response.afterDigests.ledger ?? "missing"],
          ]);
        }
      });
    });
}
