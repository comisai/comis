// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { describe, expect, it, vi } from "vitest";
import {
  cronModelDriftEventToRow,
  cronStoreResetEventToRow,
  cronOwnershipReconciliationEventToRow,
  wireSchedulerDiagnostics,
} from "./obs-scheduler-rows.js";

describe("scheduler ownership diagnostic persistence", () => {
  it("maps a completed reconciliation to a content-free informational row", () => {
    const row = cronOwnershipReconciliationEventToRow({
      agentId: "agent-a",
      status: "completed",
      recoveredBeforeStart: 1,
      ownerLostAfterStart: 2,
      settledFromTerminal: 3,
      retainedCurrentBoot: 0,
      durationMs: 7,
      timestamp: 1_000,
    });

    expect(row).toMatchObject({
      timestamp: 1_000,
      category: "health_signal",
      severity: "info",
      agentId: "agent-a",
      message: "scheduler:cron_ownership_reconciliation",
    });
    expect(JSON.parse(row.details ?? "{}")).toEqual({
      signal: "cron_ownership_reconciliation",
      status: "completed",
      recoveredBeforeStart: 1,
      ownerLostAfterStart: 2,
      settledFromTerminal: 3,
      retainedCurrentBoot: 0,
      durationMs: 7,
    });
  });

  it("maps a failed reconciliation to an actionable closed-label warning row", () => {
    const row = cronOwnershipReconciliationEventToRow({
      agentId: "agent-a",
      status: "failed",
      errorCode: "identity_mismatch",
      errorKind: "validation",
      durationMs: 4,
      timestamp: 2_000,
    });

    expect(row).toMatchObject({ severity: "warning", agentId: "agent-a" });
    expect(JSON.parse(row.details ?? "{}")).toEqual({
      signal: "cron_ownership_reconciliation",
      status: "failed",
      errorCode: "identity_mismatch",
      errorKind: "validation",
      durationMs: 4,
    });
  });

  it("subscribes the daemon-wide diagnostic buffer to ownership health events", () => {
    const eventBus = new TypedEventBus();
    const push = vi.fn();
    wireSchedulerDiagnostics({ eventBus, diagnosticBuffer: { push } });

    eventBus.emit("scheduler:cron_ownership_reconciliation", {
      agentId: "agent-a",
      status: "failed",
      errorCode: "orphan_start",
      errorKind: "validation",
      durationMs: 5,
      timestamp: 3_000,
    });

    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      category: "health_signal",
      severity: "warning",
      agentId: "agent-a",
    }));
  });

  it("persists a content-free cron reset state row with digest evidence", () => {
    const payload = {
      agentId: "agent-a",
      operationId: "operation-a",
      target: "all" as const,
      beforeDigests: { store: "a".repeat(64), ledger: "b".repeat(64) },
      afterDigests: { store: "c".repeat(64), ledger: "d".repeat(64) },
      reactivated: true,
      timestamp: 4_000,
    };

    expect(cronStoreResetEventToRow(payload)).toMatchObject({
      timestamp: 4_000,
      category: "health_signal",
      severity: "info",
      agentId: "agent-a",
      message: "scheduler:cron_store_reset",
      details: JSON.stringify({ signal: "cron_store_reset", ...payload, agentId: undefined, timestamp: undefined }),
    });
  });

  it("subscribes the existing scheduler diagnostic bridge to reset events", () => {
    const eventBus = new TypedEventBus();
    const push = vi.fn();
    wireSchedulerDiagnostics({ eventBus, diagnosticBuffer: { push } });

    eventBus.emit("scheduler:cron_store_reset", {
      agentId: "agent-a",
      operationId: "operation-a",
      target: "store",
      beforeDigests: { store: "a".repeat(64), ledger: null },
      afterDigests: { store: "c".repeat(64), ledger: null },
      reactivated: false,
      timestamp: 5_000,
    });

    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      message: "scheduler:cron_store_reset",
      agentId: "agent-a",
    }));
  });

  it("persists scheduled-model drift as a content-free health signal", () => {
    const payload = {
      executionId: "execution-b",
      previousExecutionId: "execution-a",
      jobId: "job-a",
      agentId: "agent-a",
      workKind: "internal_action" as const,
      action: "reflection" as const,
      previousModelResolved: "provider/model-a",
      modelResolved: "provider/model-b",
      previousModelResolutionSource: "agent_primary" as const,
      modelResolutionSource: "family_default" as const,
      timestamp: 5_500,
    };

    expect(cronModelDriftEventToRow(payload)).toEqual({
      timestamp: 5_500,
      category: "health_signal",
      severity: "info",
      agentId: "agent-a",
      sessionKey: "",
      message: "scheduler:cron_model_drift",
      details: JSON.stringify({ signal: "cron_model_drift", ...payload, agentId: undefined, timestamp: undefined }),
      traceId: undefined,
    });

    const eventBus = new TypedEventBus();
    const push = vi.fn();
    wireSchedulerDiagnostics({ eventBus, diagnosticBuffer: { push } });
    eventBus.emit("scheduler:cron_model_drift", payload);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      message: "scheduler:cron_model_drift",
      severity: "info",
    }));
    expect(JSON.stringify(push.mock.calls)).not.toMatch(/prompt|message body|reflection text/iu);
  });

  it("persists every exact follow-up task event with closed content-free evidence", () => {
    const eventBus = new TypedEventBus();
    const push = vi.fn();
    wireSchedulerDiagnostics({ eventBus, diagnosticBuffer: { push } });

    eventBus.emit("scheduler:task_extraction_completed", {
      agentId: "agent-a", rootRunId: "root-task-extract-a", itemCount: 1,
      candidateCount: 1, createdCount: 1, mergedCount: 0,
      sourceExecutionIds: ["execution-a"], taskIds: ["task-a"], durationMs: 5, timestamp: 1_000,
    });
    eventBus.emit("scheduler:task_extraction_failed", {
      agentId: "agent-a", rootRunId: "root-task-extract-b", itemCount: 1,
      sourceExecutionIds: ["execution-b"], stage: "model", errorKind: "dependency",
      durationMs: 6, timestamp: 2_000,
    });
    eventBus.emit("scheduler:task_check_started", {
      agentId: "agent-a", attemptId: "attempt-a", rootRunId: "root-task-check-a",
      correlationId: "correlation-a", taskIds: ["task-a"], sourceExecutionIds: ["execution-a"],
      originTraceIds: ["trace-a"], durationMs: 3, timestamp: 3_000,
    });
    eventBus.emit("scheduler:task_check_terminal", {
      agentId: "agent-a", attemptId: "attempt-a", rootRunId: "root-task-check-a",
      correlationId: "correlation-a", taskIds: ["task-a"], sourceExecutionIds: ["execution-a"],
      originTraceIds: ["trace-a"], outcome: "delivery_unknown", recovery: "ownership_recovery",
      errorKind: "internal", deliveredChunks: null, failedChunks: null, ambiguousChunks: null,
      durationMs: 20, timestamp: 3_020,
    });
    eventBus.emit("scheduler:task_delivery_history_failed", {
      agentId: "agent-a", attemptId: "attempt-a", rootRunId: "root-task-check-a",
      taskIds: ["task-a"], errorKind: "resource", durationMs: 2, timestamp: 3_018,
    });
    eventBus.emit("scheduler:task_cap_deferred", {
      agentId: "agent-a", rootRunId: "root-task-check-b", correlationId: "correlation-b",
      deferredTaskCount: 2, expiredTaskCount: 0, durationMs: 1, timestamp: 4_000,
    });
    eventBus.emit("scheduler:task_store_degraded", {
      agentId: "agent-a", operation: "settle_delivery", errorCode: "io", errorKind: "internal",
      rootRunId: "root-task-check-a", attemptId: "attempt-a", durationMs: 4, timestamp: 5_000,
    });
    eventBus.emit("scheduler:task_cancelled", {
      agentId: "agent-a", taskIds: ["task-a"], activeTaskCount: 0, durationMs: 3, timestamp: 6_000,
    });
    eventBus.emit("scheduler:task_store_reset", {
      agentId: "agent-a", operationId: "operation-a", beforeDigest: "a".repeat(64),
      afterDigest: "b".repeat(64), durationMs: 7, timestamp: 7_000,
    });

    expect(push).toHaveBeenCalledTimes(9);
    const rows = push.mock.calls.map(([row]) => row);
    expect(rows.map((row) => row.message)).toEqual([
      "scheduler:task_extraction_completed",
      "scheduler:task_extraction_failed",
      "scheduler:task_check_started",
      "scheduler:task_check_terminal",
      "scheduler:task_delivery_history_failed",
      "scheduler:task_cap_deferred",
      "scheduler:task_store_degraded",
      "scheduler:task_cancelled",
      "scheduler:task_store_reset",
    ]);
    expect(rows[0]).toMatchObject({ category: "health_signal", severity: "info", agentId: "agent-a" });
    expect(rows[1]).toMatchObject({ severity: "warning" });
    expect(rows[3]).toMatchObject({ severity: "warning" });
    expect(rows[6]).toMatchObject({ severity: "warning" });
    expect(rows.every((row) => !String(row.details).includes("archive"))).toBe(true);
    expect(JSON.parse(rows[3].details)).toMatchObject({
      signal: "task_check_terminal",
      attemptId: "attempt-a",
      recovery: "ownership_recovery",
      originTraceIds: ["trace-a"],
    });
  });
});
