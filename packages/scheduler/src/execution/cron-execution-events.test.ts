// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { describe, expect, it, vi } from "vitest";
import type { SchedulerLogger } from "../shared-types.js";
import {
  emitDurableCronStarted,
  emitDurableCronTerminal,
} from "./cron-execution-events.js";
import type {
  CronExecutionStartedRow,
  CronExecutionTerminalRow,
} from "./cron-execution-record.js";

function logger(): SchedulerLogger {
  const value = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as SchedulerLogger;
  vi.mocked(value.child).mockReturnValue(value);
  return value;
}

function start(): CronExecutionStartedRow {
  return {
    executionId: "execution-a",
    bootId: "boot-a",
    jobId: "job-a",
    agentId: "agent-a",
    scheduledForMs: 100,
    trigger: "scheduled",
    recordType: "started",
    workKind: "agent_turn",
    rootRunId: "root-cron-execution-a",
    startedAtMs: 110,
  };
}

function terminal(): CronExecutionTerminalRow {
  return {
    executionId: "execution-a",
    bootId: "boot-a",
    jobId: "job-a",
    agentId: "agent-a",
    scheduledForMs: 100,
    trigger: "scheduled",
    recordType: "terminal",
    workKind: "agent_turn",
    terminalAtMs: 130,
    durationMs: 20,
    outcome: {
      kind: "pre_dispatch_failure",
      stage: "start_record_recovery",
      errorKind: "internal",
    },
  };
}

describe("durable cron execution event projection", () => {
  it("announces persisted start and terminal facts through typed events", () => {
    const eventBus = new TypedEventBus();
    const started = vi.fn();
    const ended = vi.fn();
    eventBus.on("scheduler:cron_execution_started", started);
    eventBus.on("scheduler:cron_execution_terminal", ended);

    emitDurableCronStarted({ eventBus, logger: logger(), start: start() });
    emitDurableCronTerminal({ eventBus, logger: logger(), terminal: terminal() });

    expect(started).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-a",
      rootRunId: "root-cron-execution-a",
    }));
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-a",
      executionStatus: "failed",
      deliveryStatus: "not_requested",
      outcomeKind: "pre_dispatch_failure",
    }));
  });

  it("warns actionably when an observational subscriber fails", () => {
    const eventBus = new TypedEventBus();
    const schedulerLogger = logger();
    eventBus.on("scheduler:cron_execution_started", () => {
      throw new Error("subscriber unavailable");
    });

    emitDurableCronStarted({ eventBus, logger: schedulerLogger, start: start() });

    expect(schedulerLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "scheduler:cron_execution_started",
      subscriberFailures: 1,
      step: "event_emit",
      hint: expect.any(String),
      errorKind: "internal",
    }), "Cron observational event subscriber failed");
  });
});
