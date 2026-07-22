// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  CronExecutionRowSchema,
  encodeCronExecutionRow,
  projectCronTerminalOutcome,
} from "./cron-execution-record.js";

const recordBase = {
  executionId: "execution_a",
  bootId: "boot_a",
  jobId: "job_a",
  agentId: "agent_a",
  scheduledForMs: 10_000,
  trigger: "scheduled" as const,
};

function started(overrides: Record<string, unknown> = {}) {
  return {
    ...recordBase,
    recordType: "started",
    workKind: "agent_turn",
    rootRunId: "root-cron-execution_a",
    startedAtMs: 10_010,
    ...overrides,
  };
}

function terminal(outcome: unknown, overrides: Record<string, unknown> = {}) {
  return {
    ...recordBase,
    recordType: "terminal",
    workKind: "agent_turn",
    terminalAtMs: 10_030,
    durationMs: 20,
    outcome,
    ...overrides,
  };
}

describe("cron execution ledger row contracts", () => {
  it("requires governed roots only for agent and internal work", () => {
    expect(CronExecutionRowSchema.safeParse(started()).success).toBe(true);
    expect(CronExecutionRowSchema.safeParse(started({ rootRunId: null })).success).toBe(false);
    expect(CronExecutionRowSchema.safeParse(started({ workKind: "delivery_only", rootRunId: null })).success).toBe(true);
    expect(CronExecutionRowSchema.safeParse(started({ workKind: "delivery_only" })).success).toBe(false);
  });

  it("accepts one strict settled agent outcome with independent delivery evidence", () => {
    const row = terminal({
      kind: "agent_turn",
      rootRunId: "root-cron-execution_a",
      sessionKey: {
        tenantId: "tenant_a",
        agentId: "agent_a",
        userId: "cron-job_a",
        channelId: "cron",
      },
      agentExecutionId: "agent-execution_a",
      execution: { status: "completed", finishReason: "stop" },
      modelResolved: "provider/model",
      modelResolutionSource: "agent_primary",
      metrics: { totalTokens: 10, costUsd: 0.01, toolCalls: 1, llmCalls: 1 },
      wakeGate: { status: "not_configured" },
      delivery: {
        status: "partial",
        errorKind: "platform",
        deliveredChunks: 1,
        failedChunks: 1,
        settledAtMs: 10_025,
      },
      continuation: { mode: "none", status: "not_requested" },
    });

    expect(CronExecutionRowSchema.safeParse(row).success).toBe(true);
    expect(projectCronTerminalOutcome(row.outcome)).toEqual({
      status: "completed",
      deliveryStatus: "partial",
      errorKind: "platform",
    });
  });

  it("rejects terminal outcomes that do not match the claimed work kind", () => {
    const heartbeat = {
      kind: "heartbeat_event",
      correlationId: "heartbeat_a",
      queueDisposition: "accepted",
    };
    expect(CronExecutionRowSchema.safeParse(terminal(heartbeat)).success).toBe(false);
    expect(CronExecutionRowSchema.safeParse(terminal(heartbeat, {
      workKind: "heartbeat_event",
    })).success).toBe(true);
  });

  it("keeps pre-dispatch and unsettled evidence closed and non-replayable", () => {
    expect(CronExecutionRowSchema.safeParse(terminal({
      kind: "pre_dispatch_failure",
      stage: "executor_not_bound",
      errorKind: "precondition",
    })).success).toBe(true);
    expect(CronExecutionRowSchema.safeParse(terminal({
      kind: "unsettled",
      reason: "deadline_termination_unestablished",
      rootRunId: "root-cron-execution_a",
      errorKind: "timeout",
    })).success).toBe(true);
    expect(projectCronTerminalOutcome({
      kind: "unsettled",
      reason: "deadline_termination_unestablished",
      rootRunId: "root-cron-execution_a",
      errorKind: "timeout",
    })).toEqual({ status: "unknown", deliveryStatus: "not_requested", errorKind: "timeout" });
    expect(CronExecutionRowSchema.safeParse(terminal({
      kind: "unsettled",
      reason: "executor_rejected_after_invocation",
      rootRunId: "root-cron-execution_a",
      errorKind: "internal",
    })).success).toBe(true);
    expect(projectCronTerminalOutcome({
      kind: "unsettled",
      reason: "executor_rejected_after_invocation",
      rootRunId: "root-cron-execution_a",
      errorKind: "internal",
    })).toEqual({ status: "unknown", deliveryStatus: "not_requested", errorKind: "internal" });
  });

  it("projects delivery-only acceptance, suppression, rejection, and ambiguity exactly", () => {
    expect(projectCronTerminalOutcome({
      kind: "delivery_only",
      delivery: { status: "accepted", deliveredChunks: 1, settledAtMs: 20_000 },
    })).toEqual({ status: "completed", deliveryStatus: "accepted" });
    expect(projectCronTerminalOutcome({
      kind: "delivery_only",
      delivery: { status: "suppressed", reason: "quiet_hours" },
    })).toEqual({ status: "skipped", deliveryStatus: "suppressed" });
    expect(projectCronTerminalOutcome({
      kind: "delivery_only",
      delivery: { status: "rejected", errorKind: "platform", deliveredChunks: 0, failedChunks: 1, settledAtMs: 20_000 },
    })).toEqual({ status: "failed", deliveryStatus: "rejected", errorKind: "platform" });
    expect(projectCronTerminalOutcome({
      kind: "delivery_only",
      delivery: { status: "unknown", errorKind: "platform", deliveredChunks: 0, failedChunks: 1, ambiguousChunks: 1, settledAtMs: 20_000 },
    })).toEqual({ status: "unknown", deliveryStatus: "unknown", errorKind: "platform" });
  });

  it("uses one canonical newline-terminated encoder", () => {
    const encoded = encodeCronExecutionRow(started());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.value.toString("utf8")).toBe(
      '{"executionId":"execution_a","bootId":"boot_a","jobId":"job_a","agentId":"agent_a","scheduledForMs":10000,"trigger":"scheduled","recordType":"started","workKind":"agent_turn","rootRunId":"root-cron-execution_a","startedAtMs":10010}\n',
    );
  });
});
