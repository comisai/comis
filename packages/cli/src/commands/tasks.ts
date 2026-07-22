// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Commander.js handlers translate typed RPC and validation failures to CLI errors.
/** Strict RPC-backed operator commands for inferred follow-up tasks. */
import type { Command } from "commander";
import type { z } from "zod";
import {
  TasksCancelContract,
  TasksListContract,
  TasksResetContract,
  TasksStatusContract,
  redactOutputText,
  systemDateFrom,
} from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
import { error, info, json } from "../output/format.js";
import { renderKeyValue, renderTable } from "../output/table.js";
import { withSpinner } from "../output/spinner.js";

type TaskView = z.output<typeof TasksListContract.response>["tasks"][number];
type TaskStatus = TaskView["status"];
type OutputFormat = "table" | "json";
const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "checking",
  "delivering",
  "delivered",
  "delivery_partial",
  "dismissed",
  "delivery_unknown",
  "expired",
  "cancelled",
];

interface CommonOptions {
  readonly agent?: string;
  readonly format: string;
}

interface ListOptions extends CommonOptions {
  readonly status?: string;
  readonly limit?: string;
}

interface CancelOptions extends CommonOptions {
  readonly allPending?: boolean;
  readonly confirm?: boolean;
}

interface ResetOptions extends CommonOptions {
  readonly expectedDigest: string;
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
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 256) {
    return fail(`invalid --limit '${value}' — expected an integer from 1 to 256`);
  }
  return parsed;
}

function parseStatus(value: string | undefined): TaskStatus | undefined {
  if (value === undefined) return undefined;
  const status = TASK_STATUSES.find((candidate) => candidate === value);
  return status ?? fail(`invalid --status '${value}' — expected a closed task state`);
}

function parseDigest(value: string): string {
  return /^[a-f0-9]{64}$/u.test(value)
    ? value
    : fail("invalid --expected-digest — expected a lowercase SHA-256 digest");
}

function tableCell(value: string): string {
  return Array.from(redactOutputText(value).text).filter((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined
      && !(codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || (codePoint >= 0x2028 && codePoint <= 0x202e)
        || (codePoint >= 0x2066 && codePoint <= 0x2069));
  }).join("");
}

function formatEpoch(epochMs: number): string {
  return systemDateFrom(epochMs).toISOString();
}

function renderTasks(tasks: readonly TaskView[]): void {
  if (tasks.length === 0) {
    info("No follow-up tasks found");
    return;
  }
  renderTable(
    ["Task ID", "Agent", "State", "Due latest", "Expires", "Attempts", "Source execution"],
    tasks.map((task) => [
      tableCell(task.id),
      tableCell(task.agentId),
      task.status,
      formatEpoch(task.dueLatestMs),
      formatEpoch(task.expiresAtMs),
      String(task.attemptCount),
      tableCell(task.sourceExecutionId),
    ]),
  );
}

async function runCommand(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (caught) {
    fail(`${label} failed: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

/** Register `comis tasks`; every operation uses the daemon's strict admin RPC. */
export function registerTasksCommand(program: Command): void {
  const tasks = program
    .command("tasks")
    .description("Inspect, cancel, and recover inferred follow-up tasks");

  tasks
    .command("status")
    .description("Show content-free task authority status")
    .option("--agent <id>", "Select one agent")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: CommonOptions) => {
      const format = parseFormat(options.format);
      await runCommand("Task status", async () => {
        const response = await withSpinner("Fetching follow-up task status...", () =>
          withClient((client) => callTyped(
            client,
            TasksStatusContract,
            options.agent === undefined ? {} : { agentId: options.agent },
          )),
        );
        if (format === "json") json(response);
        else renderKeyValue([
          ["Agent", tableCell(response.resolvedAgentId)],
          ["Configured", response.configuredEnabled ? "enabled" : "disabled"],
          ["Runtime state", response.state],
          ["Strict authority", response.strictAuthorityValid ? "valid" : "invalid"],
          ["Ownership", response.ownershipReconciled ? "reconciled" : "not reconciled"],
          ["File digest", response.store.digest ?? "missing"],
          ["Reset intent", response.intent.status],
          ["Total", String(response.counts.total)],
          ["Pending", String(response.counts.pending)],
          ["Active", String(response.counts.active)],
          ["Terminal", String(response.counts.terminal)],
        ]);
      });
    });

  tasks
    .command("list")
    .description("List content-free task records")
    .option("--agent <id>", "Select one agent")
    .option("--status <state>", "Filter by exact task state")
    .option("--limit <n>", "Maximum records (1-256)")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: ListOptions) => {
      const format = parseFormat(options.format);
      const limit = parseLimit(options.limit);
      const status = parseStatus(options.status);
      await runCommand("Task list", async () => {
        const response = await withSpinner("Fetching follow-up tasks...", () =>
          withClient((client) => callTyped(client, TasksListContract, {
            ...(options.agent === undefined ? {} : { agentId: options.agent }),
            ...(status === undefined ? {} : { status }),
            ...(limit === undefined ? {} : { limit }),
          })),
        );
        if (format === "json") json(response);
        else renderTasks(response.tasks);
      });
    });

  tasks
    .command("cancel [taskId]")
    .description("Cancel one pending task or all pending tasks")
    .option("--agent <id>", "Select one agent")
    .option("--all-pending", "Cancel every pending task for the selected agent")
    .option("--confirm", "Confirm cancellation of all pending tasks")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (taskId: string | undefined, options: CancelOptions) => {
      const format = parseFormat(options.format);
      if (options.allPending === true && taskId !== undefined) fail("taskId and --all-pending cannot be used together");
      if (options.allPending !== true && taskId === undefined) fail("taskId or --all-pending is required");
      if (options.allPending === true && options.confirm !== true) {
        fail("--confirm is required when cancelling all pending tasks");
      }
      const request = options.allPending === true
        ? { allPending: true as const, ...(options.agent === undefined ? {} : { agentId: options.agent }) }
        : taskId === undefined
          ? fail("taskId or --all-pending is required")
          : { taskId, ...(options.agent === undefined ? {} : { agentId: options.agent }) };
      await runCommand("Task cancellation", async () => {
        const response = await withSpinner("Cancelling follow-up task authority...", () =>
          withClient((client) => callTyped(
            client,
            TasksCancelContract,
            request,
          )),
        );
        if (format === "json") json(response);
        else renderKeyValue([
          ["Outcome", response.outcome.status],
          ["Schedule rescan", response.scheduleRescan],
          ["Cancelled", response.outcome.status === "cancelled" ? String(response.outcome.taskIds.length) : "0"],
        ]);
      });
    });

  tasks
    .command("reset")
    .description("Archive and replace a disabled task authority after digest review")
    .option("--agent <id>", "Select one agent")
    .requiredOption("--expected-digest <sha256>", "Expected raw task authority SHA-256")
    .option("--confirm", "Confirm irreversible authority replacement")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: ResetOptions) => {
      const format = parseFormat(options.format);
      const expectedDigest = parseDigest(options.expectedDigest);
      if (options.confirm !== true) fail("--confirm is required for task authority reset");
      await runCommand("Task reset", async () => {
        const response = await withSpinner("Resetting follow-up task authority...", () =>
          withClient((client) => callTyped(client, TasksResetContract, {
            expectedDigest,
            confirmed: true,
            ...(options.agent === undefined ? {} : { agentId: options.agent }),
          })),
        );
        if (format === "json") json(response);
        else renderKeyValue([
          ["Agent", tableCell(response.resolvedAgentId)],
          ["Operation", tableCell(response.operationId)],
          ["Before digest", response.beforeDigest ?? "missing"],
          ["After digest", response.afterDigest],
          ["State", response.state],
        ]);
      });
    });
}
