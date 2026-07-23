// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  PerAgentCronConfigSchema,
  PerAgentHeartbeatConfigSchema,
  SchedulerConfigSchema,
} from "@comis/core";

const root = resolve(import.meta.dirname, "../..");
const operationsDoc = readFileSync(resolve(root, "docs/operations/scheduler.mdx"), "utf8");
const configDoc = readFileSync(resolve(root, "docs/reference/config-yaml.mdx"), "utf8");

const cronDefaults = {
  enabled: "true",
  maxRunsPerTick: "3",
  defaultTimezone: '"UTC"',
  maxJobs: "100",
  maxConsecutiveDependencyErrors: "5",
  staggerWindowMs: "0",
  wakeGate: "(unset)",
} as const;

const executionDefaults = {
  maxLogBytes: "2000000",
  retainedExecutions: "1000",
} as const;

const taskDefaults = {
  enabled: "false",
  confidenceThreshold: "0.8",
  debounceMs: "15000",
  batchMax: "8",
  maxPerCheck: "3",
  maxPerDayPerConversation: "3",
  defaultWindowMs: "43200000",
  preAcceptanceRetryLimit: "3",
} as const;

const heartbeatDefaults = {
  enabled: "true",
  intervalMs: "300000",
  showOk: "false",
  showAlerts: "true",
  alertThreshold: "2",
  alertCooldownMs: "300000",
  staleMs: "120000",
} as const;

const perAgentHeartbeatDefaults = {
  enabled: "(unset)",
  intervalMs: "(unset)",
  showOk: "(unset)",
  showAlerts: "(unset)",
  target: "(unset)",
  prompt: "(unset)",
  allowDm: "(unset)",
  lightContext: "(unset)",
  ackMaxChars: "(unset)",
  responsePrefix: "(unset)",
  alertThreshold: "(unset)",
  alertCooldownMs: "(unset)",
  staleMs: "(unset)",
  toolPolicy: "(unset)",
} as const;

function between(document: string, startMarker: string, endMarker: string): string {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Documentation section is missing: ${startMarker}`);
  }
  return document.slice(start, end);
}

function tableKeys(section: string): string[] {
  return [...section.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1]!);
}

function tableDefault(section: string, key: string): string {
  const row = section.split("\n").find((line) => line.startsWith(`| \`${key}\` |`));
  if (row === undefined) throw new Error(`Documentation row is missing: ${key}`);
  const cells = row.split("|").slice(1, -1);
  const value = cells[cells.length === 3 ? 1 : 2];
  if (value === undefined) throw new Error(`Documentation default is missing: ${key}`);
  return value.replaceAll("`", "").replaceAll("_", "").trim();
}

function expectTableDefaults(section: string, expected: Readonly<Record<string, string>>): void {
  expect(tableKeys(section)).toEqual(Object.keys(expected));
  for (const [key, defaultValue] of Object.entries(expected)) {
    expect(tableDefault(section, key), `${key} documentation default`).toBe(defaultValue);
  }
}

describe("scheduler documentation configuration parity", () => {
  it("pins canonical scheduler and per-agent cron defaults", () => {
    const scheduler = SchedulerConfigSchema.parse({});
    const perAgentCron = PerAgentCronConfigSchema.parse({});

    expect(scheduler.cron).toEqual({
      enabled: true,
      maxRunsPerTick: 3,
      defaultTimezone: "UTC",
      maxJobs: 100,
      maxConsecutiveDependencyErrors: 5,
      staggerWindowMs: 0,
    });
    expect(perAgentCron).toEqual(scheduler.cron);
    expect(scheduler.execution).toEqual({ maxLogBytes: 2_000_000, retainedExecutions: 1_000 });
    expect(scheduler.tasks).toEqual({
      enabled: false,
      confidenceThreshold: 0.8,
      debounceMs: 15_000,
      batchMax: 8,
      maxPerCheck: 3,
      maxPerDayPerConversation: 3,
      defaultWindowMs: 43_200_000,
      preAcceptanceRetryLimit: 3,
    });
    expect(scheduler.quietHours.timezone).toBe("UTC");
  });

  it("documents the complete global and per-agent cron surfaces", () => {
    const operationsCron = between(operationsDoc, "### Cron Jobs", "### Heartbeat Monitoring");
    const perAgentCron = between(
      configDoc,
      "**Cron (agents.*.scheduler.cron)**",
      "**Heartbeat (agents.*.scheduler.heartbeat)**",
    );
    const globalCron = between(configDoc, "**Cron (scheduler.cron)**", "**Heartbeat (scheduler.heartbeat)**");

    expectTableDefaults(operationsCron, cronDefaults);
    expectTableDefaults(perAgentCron, cronDefaults);
    expectTableDefaults(globalCron, cronDefaults);
    for (const section of [operationsCron, perAgentCron, globalCron]) {
      expect(section).not.toMatch(/storeDir|maxConcurrentRuns|maxConsecutiveErrors/u);
      expect(section).toMatch(/positive authored-job cap/iu);
    }
  });

  it("documents the complete global and per-agent heartbeat surfaces", () => {
    const scheduler = SchedulerConfigSchema.parse({});
    const perAgentHeartbeat = PerAgentHeartbeatConfigSchema.parse({});
    const globalHeartbeat = between(
      configDoc,
      "**Heartbeat (scheduler.heartbeat)**",
      "**Quiet Hours (scheduler.quietHours)**",
    );
    const agentHeartbeat = between(
      configDoc,
      "**Heartbeat (agents.*.scheduler.heartbeat)**",
      "```yaml",
    );

    expect(scheduler.heartbeat).toEqual({
      enabled: true,
      intervalMs: 300_000,
      showOk: false,
      showAlerts: true,
      alertThreshold: 2,
      alertCooldownMs: 300_000,
      staleMs: 120_000,
    });
    expect(perAgentHeartbeat).toEqual({});
    expectTableDefaults(globalHeartbeat, heartbeatDefaults);
    expectTableDefaults(agentHeartbeat, perAgentHeartbeatDefaults);
    expect(agentHeartbeat).toMatch(
      /channelType.*channelInstanceId.*conversationId.*threadId.*conversationKind/isu,
    );
    expect(agentHeartbeat).not.toMatch(
      /\| `(?:model|session|skipHeartbeatOnlyDelivery)`|channelId|chatId|isDm/iu,
    );
    expect(agentHeartbeat).toMatch(/additional restriction|cannot restore/iu);
  });

  it("documents only the current execution ledger settings", () => {
    const operationsExecution = between(operationsDoc, "## Execution Ledger", "## Full Configuration Reference");
    const referenceExecution = between(
      configDoc,
      "**Execution (scheduler.execution)**",
      "**Tasks (scheduler.tasks)**",
    );

    expectTableDefaults(operationsExecution, executionDefaults);
    expectTableDefaults(referenceExecution, executionDefaults);
    expect(`${operationsExecution}\n${referenceExecution}`).not.toMatch(
      /lockDir|logDir|keepLines|\| `staleMs`|\| `updateMs`/u,
    );
  });

  it("documents opt-in task extraction with every current setting", () => {
    const operationsTasks = between(operationsDoc, "### Task Extraction", "## Quiet Hours");
    const referenceTasks = between(configDoc, "**Tasks (scheduler.tasks)**", "<Info>See [Scheduler]");

    expectTableDefaults(operationsTasks, taskDefaults);
    expectTableDefaults(referenceTasks, taskDefaults);
    expect(`${operationsTasks}\n${referenceTasks}`).not.toMatch(/on by default|opt out|storeDir/iu);
    expect(`${operationsTasks}\n${referenceTasks}`).toMatch(/explicit opt-in/iu);
  });

  it("requires UTC quiet hours and durable per-tick safety", () => {
    const operationsQuietHours = between(operationsDoc, "## Quiet Hours", "## Wake-Gate Efficiency");
    const referenceQuietHours = between(
      configDoc,
      "**Quiet Hours (scheduler.quietHours)**",
      "**Execution (scheduler.execution)**",
    );
    const safety = between(operationsDoc, "## Safety", "## Execution Ledger");

    expect(tableDefault(operationsQuietHours, "timezone")).toBe('"UTC"');
    expect(tableDefault(referenceQuietHours, "timezone")).toBe('"UTC"');
    expect(operationsQuietHours).toMatch(/cron and agent-heartbeat runs still execute/iu);
    expect(operationsQuietHours).toMatch(/routine and non-critical delivery is suppressed/iu);
    expect(operationsQuietHours).toMatch(/critical heartbeat output.*criticalBypass.*bypass/isu);
    expect(operationsQuietHours).toMatch(/task-lane checks defer before the model runs.*window ends/isu);
    expect(operationsQuietHours).not.toMatch(/cron jobs and heartbeat alerts are suppressed|they resume/iu);
    expect(safety).toMatch(/durable claim/iu);
    expect(safety).toMatch(/start\/terminal execution ledger/iu);
    expect(safety).toMatch(/per scheduler tick/iu);
    expect(safety).toMatch(/dependency.*suspend/isu);
    expect(safety).not.toMatch(/lock files|maxConcurrentRuns|stale timeout|releases the lock/iu);
  });

  it("keeps examples current without removing agent run concurrency", () => {
    const fullConfiguration = between(operationsDoc, "## Full Configuration Reference", "## Related Pages");
    const concurrency = between(configDoc, "#### Concurrency (agents.*.concurrency)", "#### Broadcast Groups");

    for (const key of [...Object.keys(cronDefaults), ...Object.keys(executionDefaults), ...Object.keys(taskDefaults)]) {
      expect(fullConfiguration, `full scheduler example is missing ${key}`).toContain(`${key}:`);
    }
    expect(fullConfiguration).not.toMatch(/storeDir|maxConcurrentRuns|maxConsecutiveErrors|lockDir|logDir|keepLines/iu);
    expect(concurrency).toContain("| `maxConcurrentRuns` | `number` | `4` |");
  });

  it("keeps executable system fixtures on the strict scheduler schema", () => {
    for (const name of ["integrations", "manual", "crud", "api"]) {
      const document = parse(readFileSync(
        resolve(root, `test/config/config.test-system-${name}.yaml`),
        "utf8",
      )) as { scheduler?: unknown };
      expect(
        SchedulerConfigSchema.safeParse(document.scheduler),
        `config.test-system-${name}.yaml scheduler`,
      ).toMatchObject({ success: true });
    }
  });
});
