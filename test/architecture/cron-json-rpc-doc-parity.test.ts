// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const reference = readFileSync(resolve(repoRoot, "docs/reference/json-rpc.mdx"), "utf8");

function between(document: string, startMarker: string, endMarker: string): string {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Documentation section is missing: ${startMarker}`);
  return document.slice(start, end);
}

function expectTokens(section: string, tokens: readonly string[]): void {
  for (const token of tokens) expect(section, `missing ${token}`).toContain(`\`${token}\``);
}

const cron = between(reference, '<Accordion title="cron (', '<Accordion title="browser (');

describe("cron JSON-RPC documentation parity", () => {
  it("documents the strict cron method inventory and authoring vocabulary", () => {
    expectTokens(cron, [
      "cron.add",
      "cron.list",
      "cron.update",
      "cron.remove",
      "cron.status",
      "cron.runs",
      "cron.run",
      "cron.reset",
    ]);
    const add = between(cron, "### `cron.add`", "### `cron.list`");
    expectTokens(add, [
      "name",
      "agentId",
      "schedule",
      "payload",
      "sessionPolicy",
      "continuationMode",
      "deliveryTarget",
      "wakeGate",
      "cacheRetention",
      "toolPolicy",
      "maxConsecutiveDependencyErrors",
      "cron",
      "every",
      "at",
      "in",
      "heartbeat_event",
      "delivery",
      "agent_turn",
      "jobId",
    ]);
    expect(add).not.toMatch(/\bmessage\b.*top-level|"interval"|"once"/u);
  });

  it("documents strict inventory mutation and authority projections", () => {
    const list = between(cron, "### `cron.list`", "### `cron.update`");
    const update = between(cron, "### `cron.update`", "### `cron.status`");
    const status = between(cron, "### `cron.status`", "### `cron.runs`");
    expectTokens(list, ["agentId", "id", "name", "source", "schedule", "lifecycle", "payload"]);
    expectTokens(update, [
      "jobId",
      "jobName",
      "name",
      "schedule",
      "payload",
      "paused",
      "updated",
      "removed",
    ]);
    expectTokens(status, [
      "agentId",
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
    expect(status).not.toMatch(/single cron job|\{ name: string \}/iu);
  });

  it("documents immutable execution history and bounded diagnostic counters", () => {
    const runs = between(cron, "### `cron.runs`", "### `cron.remove`");
    expectTokens(runs, [
      "jobName",
      "limit",
      "agentId",
      "executionId",
      "jobId",
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
      "started",
      "dispatched",
      "completed",
      "failed",
      "aborted",
      "skipped",
      "unknown",
    ]);
    expect(runs).not.toMatch(/\bts\b|status.*"ok"|summary\?|error\?: string/iu);
  });

  it("documents manual execution and guarded reset without replay claims", () => {
    const run = between(cron, "### `cron.run`", "### `cron.reset`");
    const reset = between(cron, "### `cron.reset`", "</Accordion>");
    expectTokens(run, [
      "jobName",
      "mode",
      "force",
      "due",
      "agentId",
      "triggered",
      "resolvedAgentId",
      "executionId",
      "executionIds",
    ]);
    expectTokens(reset, [
      "admin",
      "target",
      "expectedDigests",
      "confirmed",
      "agentId",
      "operationId",
      "beforeDigests",
      "afterDigests",
      "state",
      "reactivated",
    ]);
    expect(reset).toMatch(/compare-and-set|digest/iu);
  });
});

describe("scheduler wake JSON-RPC documentation parity", () => {
  it("documents target-specific admitted and coalesced wake outcomes", () => {
    const scheduler = between(reference, '<Accordion title="scheduler (', "</AccordionGroup>");
    const wake = between(scheduler, "### `scheduler.wake`", "</Accordion>");
    expectTokens(wake, [
      "target",
      "agent",
      "monitoring",
      "accepted",
      "coalesced",
      "disposition",
      "new_occurrence",
      "occurrence_upgraded",
      "correlationId",
      "lane",
      "retainedReason",
    ]);
    expect(wake).not.toMatch(/\{ source\?: string \}|\{ woke: true|free-form label|fire-and-forget/iu);
  });
});
