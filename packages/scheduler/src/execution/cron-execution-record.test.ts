// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  classifyCronDependencyOutcome,
  CronExecutionRowSchema,
  encodeCronExecutionRow,
  projectCronTerminalOutcome,
  type CronTerminalOutcome,
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

function agentOutcome(overrides: Record<string, unknown> = {}): Extract<CronTerminalOutcome, { kind: "agent_turn" }> {
  return {
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
    delivery: { status: "not_requested" },
    continuation: { mode: "none", status: "not_requested" },
    ...overrides,
  } as Extract<CronTerminalOutcome, { kind: "agent_turn" }>;
}

function internalOutcome(
  execution: Extract<CronTerminalOutcome, { kind: "internal_action" }>["execution"],
): Extract<CronTerminalOutcome, { kind: "internal_action" }> {
  return {
    kind: "internal_action",
    action: "memory_review",
    rootRunId: "root-cron-execution_a",
    modelResolved: "provider/model",
    modelResolutionSource: "agent_primary",
    metrics: { totalTokens: 10, costUsd: 0.01, llmCalls: 1 },
    execution,
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

  it("rejects invalid rows and fixed pre-dispatch error-kind mismatches", () => {
    expect(encodeCronExecutionRow(started({ executionId: "" }) as never)).toMatchObject({
      ok: false,
      error: { code: "invalid_row", errorKind: "validation" },
    });
    expect(CronExecutionRowSchema.safeParse(terminal({
      kind: "pre_dispatch_failure",
      stage: "root_registration",
      errorKind: "dependency",
    })).success).toBe(false);
    expect(CronExecutionRowSchema.safeParse(terminal({
      kind: "pre_dispatch_failure",
      stage: "executor_invalid_input",
      errorKind: "validation",
    })).success).toBe(true);
    expect(CronExecutionRowSchema.safeParse(terminal({
      kind: "pre_dispatch_failure",
      stage: "dispatch_rejected",
      errorKind: "dependency",
    })).success).toBe(true);
  });

  it("projects every settled agent execution status independently from delivery", () => {
    expect(projectCronTerminalOutcome(agentOutcome())).toEqual({
      status: "completed",
      deliveryStatus: "not_requested",
    });
    expect(projectCronTerminalOutcome(agentOutcome({
      execution: { status: "failed", finishReason: "error", errorKind: "dependency" },
      delivery: { status: "accepted", deliveredChunks: 1, settledAtMs: 2_000 },
    }))).toEqual({ status: "failed", deliveryStatus: "accepted", errorKind: "dependency" });
    expect(projectCronTerminalOutcome(agentOutcome({
      execution: { status: "aborted", abortReason: "user_stop" },
    }))).toEqual({ status: "aborted", deliveryStatus: "not_requested" });
    expect(projectCronTerminalOutcome(agentOutcome({
      execution: { status: "aborted", abortReason: "deadline", errorKind: "timeout" },
    }))).toEqual({ status: "aborted", deliveryStatus: "not_requested", errorKind: "timeout" });
    expect(projectCronTerminalOutcome(agentOutcome({
      execution: { status: "unknown", errorKind: "internal" },
      delivery: { status: "pre_send_failed", reason: "output_guard", errorKind: "auth" },
    }))).toEqual({ status: "unknown", deliveryStatus: "pre_send_failed", errorKind: "internal" });
  });

  it("projects wake gate pre-model and heartbeat terminal outcomes", () => {
    expect(projectCronTerminalOutcome({
      kind: "wake_gate_skip",
      rootRunId: "root-cron-execution_a",
      gateDurationMs: 20,
      gateToolCalls: 1,
      delivery: { status: "rejected", errorKind: "platform", deliveredChunks: 0, failedChunks: 1, settledAtMs: 30 },
      continuation: { mode: "none", status: "not_requested" },
    })).toEqual({ status: "skipped", deliveryStatus: "rejected", errorKind: "platform" });
    expect(projectCronTerminalOutcome({
      kind: "agent_turn_pre_model_skip",
      rootRunId: "root-cron-execution_a",
      reason: "wake_gate_unbound",
      errorKind: "precondition",
      continuation: { mode: "none", status: "not_requested" },
    })).toEqual({ status: "skipped", deliveryStatus: "not_requested", errorKind: "precondition" });
    expect(projectCronTerminalOutcome({
      kind: "heartbeat_event",
      correlationId: "correlation-a",
      queueDisposition: "duplicate",
    })).toEqual({ status: "dispatched", deliveryStatus: "not_requested" });
  });

  it("projects every internal action execution status without delivery evidence", () => {
    expect(projectCronTerminalOutcome(internalOutcome({ status: "completed", counters: [] })))
      .toEqual({ status: "completed", deliveryStatus: "not_requested" });
    expect(projectCronTerminalOutcome(internalOutcome({ status: "failed", errorKind: "dependency", counters: [] })))
      .toEqual({ status: "failed", deliveryStatus: "not_requested", errorKind: "dependency" });
    expect(projectCronTerminalOutcome(internalOutcome({ status: "aborted", abortReason: "deadline", counters: [] })))
      .toEqual({ status: "aborted", deliveryStatus: "not_requested" });
    expect(projectCronTerminalOutcome(internalOutcome({ status: "skipped", reason: "configuration_disabled", counters: [] })))
      .toEqual({ status: "skipped", deliveryStatus: "not_requested" });
    expect(projectCronTerminalOutcome(internalOutcome({ status: "unknown", errorKind: "internal", counters: [] })))
      .toEqual({ status: "unknown", deliveryStatus: "not_requested", errorKind: "internal" });
  });

  it("projects pre-send and partial direct delivery failures", () => {
    expect(projectCronTerminalOutcome({
      kind: "delivery_only",
      delivery: { status: "pre_send_failed", reason: "output_guard", errorKind: "auth" },
    })).toEqual({ status: "failed", deliveryStatus: "pre_send_failed", errorKind: "auth" });
    expect(projectCronTerminalOutcome({
      kind: "delivery_only",
      delivery: { status: "partial", errorKind: "platform", deliveredChunks: 1, failedChunks: 1, settledAtMs: 30 },
    })).toEqual({ status: "failed", deliveryStatus: "partial", errorKind: "platform" });
  });

  it("classifies only successful or dependency-failed model work as dependency evidence", () => {
    expect(classifyCronDependencyOutcome(agentOutcome())).toBe("success");
    expect(classifyCronDependencyOutcome(agentOutcome({
      execution: { status: "failed", finishReason: "error", errorKind: "dependency" },
    }))).toBe("dependency_error");
    expect(classifyCronDependencyOutcome(agentOutcome({
      execution: { status: "failed", finishReason: "error", errorKind: "internal" },
    }))).toBe("neutral");
    expect(classifyCronDependencyOutcome(internalOutcome({ status: "completed", counters: [] }))).toBe("success");
    expect(classifyCronDependencyOutcome(internalOutcome({ status: "failed", errorKind: "dependency", counters: [] })))
      .toBe("dependency_error");
    expect(classifyCronDependencyOutcome(internalOutcome({ status: "failed", errorKind: "internal", counters: [] })))
      .toBe("neutral");
    expect(classifyCronDependencyOutcome({
      kind: "delivery_only",
      delivery: { status: "accepted", deliveredChunks: 1, settledAtMs: 20 },
    })).toBe("neutral");
  });
});
