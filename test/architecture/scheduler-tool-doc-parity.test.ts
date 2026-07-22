// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const guide = readFileSync(resolve(repoRoot, "docs/agent-tools/scheduling.mdx"), "utf8");
const cronTool = readFileSync(
  resolve(repoRoot, "packages/skills/src/platform-tools/tools/cron-tool.ts"),
  "utf8",
);
const heartbeatTool = readFileSync(
  resolve(repoRoot, "packages/skills/src/platform-tools/tools/heartbeat-manage-tool.ts"),
  "utf8",
);

function between(document: string, startMarker: string, endMarker: string): string {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Documentation section is missing: ${startMarker}`);
  }
  return document.slice(start, end);
}

function tableKeys(section: string): string[] {
  return [...section.matchAll(/^\s*\| `([^`]+)` \|/gmu)].map((match) => match[1]!);
}

function expectTokens(section: string, tokens: readonly string[]): void {
  for (const token of tokens) expect(section, `missing ${token}`).toContain(`\`${token}\``);
}

function typeBoxObjectKeys(source: string, declaration: string): string[] {
  const body = between(source, `const ${declaration} = Type.Object({`, "\n});");
  return [...body.matchAll(/^ {2}([a-z_][a-z0-9_]*):/gmu)].map((match) => match[1]!);
}

const cronActions = ["add", "list", "update", "remove", "status", "runs", "run", "wake"] as const;
const scheduleKinds = ["cron", "every", "at", "in"] as const;
const payloadKinds = ["heartbeat_event", "delivery", "agent_turn"] as const;
const sessionStrategies = ["fresh", "rolling"] as const;
const continuationModes = ["none", "heartbeat_excerpt", "origin_history"] as const;

describe("scheduler tool documentation parity", () => {
  it("requires documented cron vocabulary to match the live tool", () => {
    expect(cronTool).toContain(`const VALID_ACTIONS = [${cronActions.map((value) => `"${value}"`).join(", ")}] as const;`);
    expect(cronTool).toContain(`const VALID_SCHEDULE_KINDS = [${scheduleKinds.map((value) => `"${value}"`).join(", ")}] as const;`);
    expect(cronTool).toContain(`const VALID_PAYLOAD_KINDS = [${payloadKinds.map((value) => `"${value}"`).join(", ")}] as const;`);
    expect(cronTool).toContain(`const VALID_SESSION_STRATEGIES = [${sessionStrategies.map((value) => `"${value}"`).join(", ")}] as const;`);
    expect(cronTool).toContain(`const VALID_CONTINUATION_MODES = [${continuationModes.map((value) => `"${value}"`).join(", ")}] as const;`);

    const scheduleTypes = between(guide, "### Schedule Types", "### Payload and continuation behavior");
    const add = between(guide, '<Accordion title="add -- Create a scheduled job">', '<Accordion title="list -- List all scheduled jobs">');
    const list = between(guide, '<Accordion title="list -- List all scheduled jobs">', '<Accordion title="update -- Update an existing job">');
    expect(guide).toContain("**4 schedule types**");
    expect(tableKeys(scheduleTypes)).toEqual(scheduleKinds);
    expectTokens(add, payloadKinds);
    expectTokens(add, sessionStrategies);
    expectTokens(add, continuationModes);
    expect(tableKeys(add)).toEqual([
      "action",
      "name",
      "schedule_kind",
      "schedule_expr",
      "schedule_every_ms",
      "schedule_at",
      "schedule_in_seconds",
      "timezone",
      "payload_kind",
      "payload_text",
      "wake_mode",
      "session_strategy",
      "max_history_turns",
      "model",
      "continuation_mode",
      "wake_gate_script",
      "wake_gate_language",
      "wake_gate_timeout_seconds",
    ]);
    expect(tableKeys(list)).toEqual(["action"]);
    expect(add).not.toMatch(/system_event|accumulate/u);
  });

  it("requires every mutable cron field and wake admission result", () => {
    const update = between(guide, '<Accordion title="update -- Update an existing job">', '<Accordion title="remove -- Delete a scheduled job">');
    const remove = between(guide, '<Accordion title="remove -- Delete a scheduled job">', '<Accordion title="status -- Check scheduler authority">');
    const run = between(guide, '<Accordion title="run -- Manually trigger cron execution">', '<Accordion title="wake -- Submit a scheduler wake">');
    const wake = between(guide, '<Accordion title="wake -- Submit a scheduler wake">', "</AccordionGroup>");

    expect(tableKeys(update)).toEqual([
      "action",
      "job_name",
      "name",
      "paused",
      "schedule_kind",
      "schedule_expr",
      "schedule_every_ms",
      "schedule_at",
      "schedule_in_seconds",
      "timezone",
      "payload_kind",
      "payload_text",
      "wake_mode",
      "model",
      "wake_gate_script",
      "wake_gate_language",
      "wake_gate_timeout_seconds",
    ]);
    expect(update).not.toContain("`enabled`");
    expect(update).toMatch(/session_strategy.*continuation_mode.*cannot be changed/isu);
    expect(tableKeys(remove)).toEqual(["action", "job_name", "_confirmed"]);
    expect(tableKeys(run)).toEqual(["action", "job_name", "mode"]);
    expectTokens(run, ["executionId", "executionIds"]);
    expect(tableKeys(wake)).toEqual(["action", "wake_target"]);
    expectTokens(wake, ["agent", "monitoring", "accepted", "coalesced", "correlationId", "lane", "retainedReason"]);
    expect(wake).not.toMatch(/restart|replay|`source`/iu);

    const list = between(guide, '<Accordion title="list -- List all scheduled jobs">', '<Accordion title="update -- Update an existing job">');
    const status = between(guide, '<Accordion title="status -- Check scheduler authority">', '<Accordion title="runs -- View immutable run history">');
    const runs = between(guide, '<Accordion title="runs -- View immutable run history">', '<Accordion title="run -- Manually trigger cron execution">');
    const add = between(guide, '<Accordion title="add -- Create a scheduled job">', '<Accordion title="list -- List all scheduled jobs">');
    const documented = new Set([
      ...tableKeys(add),
      ...tableKeys(list),
      ...tableKeys(update),
      ...tableKeys(remove),
      ...tableKeys(status),
      ...tableKeys(runs),
      ...tableKeys(run),
      ...tableKeys(wake),
    ]);
    expect([...documented].sort()).toEqual(typeBoxObjectKeys(cronTool, "CronToolParams").sort());
  });

  it("requires durable authority without replay or implicit profiles", () => {
    expect(guide).toContain("<agentWorkspace>/.scheduler/cron-jobs.json");
    expect(guide).toContain("<agentWorkspace>/.scheduler/cron-executions.jsonl");
    expect(guide).toMatch(/durable claim/iu);
    expect(guide).toMatch(/durable started record.*never.*replay/isu);
    expect(guide).toMatch(/dispatch.*uncertain.*never.*replay/isu);
    expect(guide).toMatch(/trusted originating conversation/iu);
    expect(guide).toMatch(/exact delivery target/iu);
    expect(guide).not.toMatch(/data\.db|SQLite/iu);
    expect(guide).not.toMatch(/(?:cron-minimal|heartbeat-minimal)[^.\n]*default|default[^.\n]*(?:cron-minimal|heartbeat-minimal)/iu);
    expect(guide).toMatch(/cron-minimal.*opt-in/iu);
    expect(guide).toMatch(/heartbeat-minimal.*opt-in/iu);
  });

  it("requires strict status and immutable run projections", () => {
    const status = between(guide, '<Accordion title="status -- Check scheduler authority">', '<Accordion title="runs -- View immutable run history">');
    const runs = between(guide, '<Accordion title="runs -- View immutable run history">', '<Accordion title="run -- Manually trigger cron execution">');

    expect(tableKeys(status)).toEqual(["action"]);
    expect(tableKeys(runs)).toEqual(["action", "job_name", "limit"]);
    expectTokens(status, [
      "state",
      "configuredEnabled",
      "running",
      "strictAuthoritiesValid",
      "ownershipReconciled",
      "jobCount",
      "activeClaimCount",
      "resolvedAgentId",
      "store",
      "ledger",
      "intent",
      "lastError",
    ]);
    expectTokens(runs, [
      "executionId",
      "jobId",
      "agentId",
      "scheduledForMs",
      "trigger",
      "workKind",
      "rootRunId",
      "startedAtMs",
      "terminalAtMs",
      "durationMs",
      "status",
      "deliveryStatus",
      "errorKind",
      "counters",
    ]);
    expectTokens(runs, ["started", "dispatched", "completed", "failed", "aborted", "skipped", "unknown"]);
    expectTokens(runs, ["not_requested", "suppressed", "pre_send_failed", "accepted", "partial", "rejected"]);
  });

  it("requires the exposed and bounded wake gate contract", () => {
    const wakeGate = between(guide, "## Wake-Gate -- Run the Model Only When It Matters", "## heartbeat_manage -- Agent Heartbeat");

    expectTokens(wakeGate, ["wake_gate_script", "wake_gate_language", "wake_gate_timeout_seconds"]);
    expect(wakeGate).toMatch(/1--300|1–300/u);
    expect(wakeGate).toMatch(/default.*30/iu);
    expect(wakeGate).not.toMatch(/not exposed|only the script and language are authorable/iu);
  });

  it("requires heartbeat action fields and strict outcomes", () => {
    expect(heartbeatTool).toContain('const VALID_ACTIONS = ["get", "update", "status", "trigger"] as const;');
    const heartbeat = between(guide, "## heartbeat_manage -- Agent Heartbeat", "## End-to-end example:");
    const get = between(heartbeat, '<Accordion title="get -- View heartbeat configuration">', '<Accordion title="update -- Change heartbeat settings">');
    const update = between(heartbeat, '<Accordion title="update -- Change heartbeat settings">', "**Target object:**");
    const target = between(heartbeat, "**Target object:**", '<Accordion title="status -- Check heartbeat status">');
    const status = between(heartbeat, '<Accordion title="status -- Check heartbeat status">', '<Accordion title="trigger -- Submit a manual heartbeat">');
    const trigger = between(heartbeat, '<Accordion title="trigger -- Submit a manual heartbeat">', "</AccordionGroup>");

    expect(tableKeys(get)).toEqual(["action", "agent_id"]);
    expect(tableKeys(update)).toEqual([
      "action",
      "agent_id",
      "enabled",
      "interval_ms",
      "prompt",
      "target",
      "light_context",
      "show_ok",
      "show_alerts",
      "allow_dm",
      "ack_max_chars",
      "response_prefix",
      "alert_threshold",
      "alert_cooldown_ms",
      "stale_ms",
    ]);
    expect(tableKeys(target)).toEqual([
      "channel_type",
      "channel_instance_id",
      "conversation_id",
      "thread_id",
      "conversation_kind",
    ]);
    expect(update).not.toMatch(/target_channel_type|target_channel_id|target_chat_id|target_is_dm|\| `model`/u);
    expect(status).toContain("`heartbeat.states`");
    expect(tableKeys(status)).toEqual(["action"]);
    expect(status).not.toMatch(/last fire/iu);
    expectTokens(status, ["agentId", "enabled", "intervalMs", "nextDueAtMs"]);
    expect(trigger).toMatch(/spacing bypass/iu);
    expect(tableKeys(trigger)).toEqual(["action", "agent_id"]);
    expectTokens(trigger, ["accepted", "coalesced", "correlationId", "lane", "retainedReason"]);
    expect(heartbeat).toMatch(/admin trust/iu);

    const documented = new Set([
      ...tableKeys(get),
      ...tableKeys(update),
      ...tableKeys(status),
      ...tableKeys(trigger),
    ]);
    expect([...documented].sort()).toEqual(
      typeBoxObjectKeys(heartbeatTool, "HeartbeatManageToolParams").sort(),
    );
  });

  it("requires cron dependency suspension to remain separate from heartbeat alerts", () => {
    const failureModes = between(guide, "## Failure modes", "## Related");
    expect(failureModes).toMatch(/maxConsecutiveDependencyErrors.*dependency/isu);
    expect(failureModes).toMatch(/alert_threshold.*alert_cooldown_ms.*heartbeat/isu);
    expect(failureModes).not.toMatch(/agent turn errors.*alert_threshold/isu);
  });

  it("binds the end-to-end example to its originating conversation", () => {
    const example = between(guide, "## End-to-end example:", "## Failure modes");
    expect(example).toMatch(/trusted originating conversation/iu);
    expect(example).toMatch(/exact delivery target/iu);
    expect(example).not.toMatch(/data\.db|SQLite|cron-minimal|#ai-news|via the message tool/iu);
  });
});
