// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "@comis/core";
import { err, ok } from "@comis/shared";
import type { SchedulerLogger } from "../shared-types.js";
import type { CronExecutionTerminalRow } from "./cron-execution-record.js";
import type { ExecutionTracker } from "./execution-tracker.js";
import { emitCronModelDrift, prepareCronModelDriftEvidence } from "./cron-model-drift.js";

function logger(): SchedulerLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child() { return this; },
  };
}

function internalTerminal(input: {
  executionId: string;
  action: "memory_review" | "reflection" | "memory_lifecycle";
  modelResolved: string | null;
  modelResolutionSource: "agent_primary" | "family_default" | null;
  status?: "completed" | "failed";
  terminalAtMs: number;
}): CronExecutionTerminalRow {
  const completed = input.status !== "failed";
  return {
    executionId: input.executionId,
    bootId: "boot-a",
    jobId: "job-a",
    agentId: "agent-a",
    scheduledForMs: input.terminalAtMs - 10,
    trigger: "scheduled",
    recordType: "terminal",
    workKind: "internal_action",
    terminalAtMs: input.terminalAtMs,
    durationMs: 10,
    outcome: {
      kind: "internal_action",
      action: input.action,
      rootRunId: `root-cron-${input.executionId}`,
      modelResolved: input.modelResolved,
      modelResolutionSource: input.modelResolutionSource,
      metrics: input.modelResolved === null
        ? { totalTokens: null, costUsd: null, llmCalls: 0 }
        : { totalTokens: 1, costUsd: 0.01, llmCalls: 1 },
      execution: completed
        ? { status: "completed", counters: [] }
        : { status: "failed", errorKind: "dependency", counters: [] },
    },
  };
}

function trackerWith(terminals: readonly CronExecutionTerminalRow[]): ExecutionTracker {
  return {
    listHistory: vi.fn(async () => ok(terminals.map((terminal) => ({
      start: {
        executionId: terminal.executionId,
        bootId: terminal.bootId,
        jobId: terminal.jobId,
        agentId: terminal.agentId,
        scheduledForMs: terminal.scheduledForMs,
        trigger: terminal.trigger,
        recordType: "started" as const,
        workKind: terminal.workKind,
        rootRunId: terminal.outcome.kind === "internal_action" ? terminal.outcome.rootRunId : null,
        startedAtMs: terminal.terminalAtMs - terminal.durationMs,
      },
      terminal,
    })))),
  } as unknown as ExecutionTracker;
}

function agentTerminal(executionId: string, modelResolved: string, terminalAtMs: number): CronExecutionTerminalRow {
  return {
    ...internalTerminal({
      executionId,
      action: "memory_review",
      modelResolved,
      modelResolutionSource: "agent_primary",
      terminalAtMs,
    }),
    workKind: "agent_turn",
    outcome: {
      kind: "agent_turn",
      rootRunId: `root-cron-${executionId}`,
      sessionKey: { tenantId: "tenant-a", agentId: "agent-a", userId: "cron", channelId: "cron" },
      agentExecutionId: `agent-${executionId}`,
      execution: { status: "completed", finishReason: "stop" },
      modelResolved,
      modelResolutionSource: "agent_primary",
      metrics: { totalTokens: 1, costUsd: 0.01, toolCalls: 0, llmCalls: 1 },
      wakeGate: { status: "not_configured" },
      delivery: { status: "not_requested" },
      continuation: { mode: "none", status: "not_requested" },
    },
  };
}

describe("scheduled cron model drift comparison", () => {
  it("compares model-backed internal actions only with the same action", async () => {
    const reflection = internalTerminal({
      executionId: "execution-reflection",
      action: "reflection",
      modelResolved: "provider/model-x",
      modelResolutionSource: "agent_primary",
      terminalAtMs: 1_200,
    });
    const review = internalTerminal({
      executionId: "execution-review",
      action: "memory_review",
      modelResolved: "provider/model-a",
      modelResolutionSource: "agent_primary",
      terminalAtMs: 1_100,
    });
    const current = internalTerminal({
      executionId: "execution-current",
      action: "memory_review",
      modelResolved: "provider/model-b",
      modelResolutionSource: "family_default",
      terminalAtMs: 1_300,
    });

    await expect(prepareCronModelDriftEvidence({
      tracker: trackerWith([reflection, review]),
      logger: logger(),
      terminal: current,
    })).resolves.toEqual(expect.objectContaining({
      previousExecutionId: "execution-review",
      workKind: "internal_action",
      action: "memory_review",
      previousModelResolved: "provider/model-a",
      modelResolved: "provider/model-b",
    }));
  });

  it("excludes keyless lifecycle terminals before reading history", async () => {
    const tracker = trackerWith([]);
    const current = internalTerminal({
      executionId: "execution-lifecycle",
      action: "memory_lifecycle",
      modelResolved: null,
      modelResolutionSource: null,
      terminalAtMs: 1_300,
    });

    await expect(prepareCronModelDriftEvidence({
      tracker,
      logger: logger(),
      terminal: current,
    })).resolves.toBeUndefined();
    expect(tracker.listHistory).not.toHaveBeenCalled();
  });

  it("warns and omits drift when execution history cannot be read", async () => {
    const schedulerLogger = logger();
    const tracker = {
      listHistory: vi.fn(async () => err({ code: "read_failed", errorKind: "resource", message: "unavailable" })),
    } as unknown as ExecutionTracker;

    await expect(prepareCronModelDriftEvidence({
      tracker,
      logger: schedulerLogger,
      terminal: agentTerminal("execution-current", "provider/model-b", 1_300),
    })).resolves.toBeUndefined();
    expect(schedulerLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
      step: "model_drift_lookup",
      errorKind: "resource",
    }), "Cron model drift baseline could not be read");
  });

  it("ignores history for another work kind and unchanged model evidence", async () => {
    const internal = internalTerminal({
      executionId: "execution-internal",
      action: "memory_review",
      modelResolved: "provider/model-a",
      modelResolutionSource: "agent_primary",
      terminalAtMs: 1_100,
    });
    const current = agentTerminal("execution-current", "provider/model-a", 1_300);

    await expect(prepareCronModelDriftEvidence({
      tracker: trackerWith([internal, agentTerminal("execution-previous", "provider/model-a", 1_200)]),
      logger: logger(),
      terminal: current,
    })).resolves.toBeUndefined();
  });

  it("emits model drift evidence and isolates subscriber failures", () => {
    const eventBus = new TypedEventBus();
    const schedulerLogger = logger();
    eventBus.on("scheduler:cron_model_drift", () => { throw new Error("observer unavailable"); });
    const evidence = {
      executionId: "execution-current",
      previousExecutionId: "execution-previous",
      jobId: "job-a",
      agentId: "agent-a",
      workKind: "agent_turn" as const,
      previousModelResolved: "provider/model-a",
      modelResolved: "provider/model-b",
      previousModelResolutionSource: "agent_primary" as const,
      modelResolutionSource: "family_default" as const,
      timestamp: 1_300,
    };

    emitCronModelDrift({ eventBus, logger: schedulerLogger, evidence });

    expect(schedulerLogger.info).toHaveBeenCalledWith(expect.objectContaining({ step: "model_drift" }), expect.any(String));
    expect(schedulerLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
      subscriberFailures: 1,
      errorKind: "internal",
    }), "Cron observational event subscriber failed");
  });
});
