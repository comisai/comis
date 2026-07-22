// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import { TypedEventBus } from "@comis/core";
import { createTaskHandlers } from "./task-handlers.js";

function setup() {
  const inspection = {
    fileDigest: "b".repeat(64),
    tasks: [
      {
        id: "task-a",
        agentId: "agent-a",
        status: "pending" as const,
        dueEarliestMs: 1_000,
        dueLatestMs: 2_000,
        expiresAtMs: 3_000,
        attemptCount: 0,
        preAcceptanceFailureCount: 0,
        sourceExecutionId: "execution-a",
        sourceOccurrenceCount: 1,
        conversationRef: `cv_${"a".repeat(43)}`,
      },
      {
        id: "task-b",
        agentId: "agent-a",
        status: "delivered" as const,
        dueEarliestMs: 1_000,
        dueLatestMs: 2_000,
        expiresAtMs: 3_000,
        attemptCount: 1,
        preAcceptanceFailureCount: 0,
        sourceExecutionId: "execution-b",
        sourceOccurrenceCount: 2,
        conversationRef: `cv_${"a".repeat(43)}`,
      },
    ],
  };
  const store = {
    inspect: vi.fn(async () => ok(inspection)),
    cancelPending: vi.fn(async () => ok({
      status: "cancelled" as const,
      taskIds: ["task-a"],
      activeTaskIds: [],
    })),
  };
  const requestTaskRescan = vi.fn(async () => ok(undefined));
  const controller = {
    status: vi.fn(async () => ok({
      state: "ready" as const,
      configuredEnabled: true,
      strictAuthorityValid: true,
      ownershipReconciled: true,
      taskCount: 2,
      activeAttemptCount: 0,
      store: { exists: true, bytes: 66, digest: "b".repeat(64) },
      intent: { status: "none" as const },
    })),
    reset: vi.fn(async () => ok({
      operationId: "reset-a",
      beforeDigest: "b".repeat(64),
      afterDigest: "c".repeat(64),
      state: "disabled" as const,
      reinitialized: true as const,
    })),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), audit: vi.fn() };
  const eventBus = new TypedEventBus();
  const handlers = createTaskHandlers({
    defaultAgentId: "agent-a",
    tenantId: "tenant-a",
    tasksEnabled: () => true,
    followupTaskStores: new Map([["agent-a", store]]),
    taskMaintenanceControllers: new Map([["agent-a", controller]]),
    requestTaskRescan,
    schedulerNowMs: vi.fn(() => 5_000),
    eventBus,
    logger,
  } as never);
  return { handlers, store, controller, requestTaskRescan, logger, eventBus };
}

describe("follow-up task operator RPC handlers", () => {
  it("reports and filters content-free task authority state", async () => {
    const data = setup();
    await expect(data.handlers["tasks.status"]!({ _trustLevel: "admin" })).resolves.toEqual({
      resolvedAgentId: "agent-a",
      configuredEnabled: true,
      state: "ready",
      strictAuthorityValid: true,
      ownershipReconciled: true,
      store: { exists: true, bytes: 66, digest: "b".repeat(64) },
      intent: { status: "none" },
      counts: { total: 2, pending: 1, active: 0, terminal: 1 },
    });
    await expect(data.handlers["tasks.list"]!({
      _trustLevel: "admin",
      status: "pending",
      limit: 1,
    })).resolves.toMatchObject({
      resolvedAgentId: "agent-a",
      tasks: [{ id: "task-a", status: "pending" }],
    });
    expect(JSON.stringify(await data.handlers["tasks.list"]!({ _trustLevel: "admin" }))).not.toContain("text");
  });

  it("cancels through the locked store and rearms the independent due schedule", async () => {
    const data = setup();
    const cancelledEvent = vi.fn();
    const auditEvent = vi.fn();
    data.eventBus.on("scheduler:task_cancelled", cancelledEvent);
    data.eventBus.on("audit:event", auditEvent);
    await expect(data.handlers["tasks.cancel"]!({
      _trustLevel: "admin",
      agentId: "agent-a",
      taskId: "task-a",
    })).resolves.toEqual({
      outcome: { status: "cancelled", taskIds: ["task-a"], activeTaskIds: [] },
      scheduleRescan: "completed",
    });
    expect(data.store.cancelPending).toHaveBeenCalledWith({ agentId: "agent-a", taskId: "task-a" });
    expect(data.requestTaskRescan).toHaveBeenCalledWith("agent-a");
    expect(data.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      method: "tasks.cancel",
      durationMs: 0,
      outcome: "cancelled",
    }), "Follow-up task operator request completed");
    expect(cancelledEvent).toHaveBeenCalledWith({
      agentId: "agent-a",
      taskIds: ["task-a"],
      activeTaskCount: 0,
      durationMs: 0,
      timestamp: 5_000,
    });
    expect(auditEvent).toHaveBeenCalledWith({
      timestamp: 5_000,
      agentId: "agent-a",
      tenantId: "tenant-a",
      actionType: "tasks.cancel",
      kind: "audit",
      classification: "mutate",
      outcome: "success",
      metadata: {
        actorScope: "admin",
        decision: "accepted",
        targetTaskIds: ["task-a"],
      },
    });
  });

  it("audits a denied active-task cancellation without emitting a cancellation event", async () => {
    const data = setup();
    data.store.cancelPending.mockResolvedValueOnce(ok({
      status: "active_attempt" as const,
      taskId: "task-a",
      attemptId: "attempt-a",
    }));
    const cancelledEvent = vi.fn();
    const auditEvent = vi.fn();
    data.eventBus.on("scheduler:task_cancelled", cancelledEvent);
    data.eventBus.on("audit:event", auditEvent);

    await expect(data.handlers["tasks.cancel"]!({
      _trustLevel: "admin",
      agentId: "agent-a",
      taskId: "task-a",
    })).resolves.toEqual({
      outcome: { status: "active_attempt", taskId: "task-a", attemptId: "attempt-a" },
      scheduleRescan: "not_required",
    });
    expect(cancelledEvent).not.toHaveBeenCalled();
    expect(auditEvent).toHaveBeenCalledWith({
      timestamp: 5_000,
      agentId: "agent-a",
      tenantId: "tenant-a",
      actionType: "tasks.cancel",
      kind: "audit",
      classification: "mutate",
      outcome: "denied",
      metadata: {
        actorScope: "admin",
        decision: "rejected",
        targetTaskId: "task-a",
        attemptId: "attempt-a",
        code: "active_attempt",
      },
    });
  });

  it("audits a task-store cancellation denial before returning the boundary error", async () => {
    const data = setup();
    const auditEvent = vi.fn();
    data.eventBus.on("audit:event", auditEvent);
    data.store.cancelPending.mockResolvedValueOnce(err({
      code: "lock_contended" as const,
      errorKind: "resource" as const,
      message: "busy",
    }));

    await expect(data.handlers["tasks.cancel"]!({
      _trustLevel: "admin",
      agentId: "agent-a",
      taskId: "task-a",
    })).rejects.toThrow("busy");
    expect(auditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "tasks.cancel",
      outcome: "denied",
      metadata: {
        actorScope: "admin",
        decision: "rejected",
        targetTaskId: "task-a",
        code: "lock_contended",
      },
    }));
  });

  it("audits invalid cancellation input without persisting untrusted target fields", async () => {
    const data = setup();
    const auditEvent = vi.fn();
    data.eventBus.on("audit:event", auditEvent);

    await expect(data.handlers["tasks.cancel"]!({
      _trustLevel: "admin",
      taskId: "",
    })).rejects.toThrow();
    expect(data.store.cancelPending).not.toHaveBeenCalled();
    expect(auditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "tasks.cancel",
      outcome: "denied",
      metadata: {
        actorScope: "admin",
        decision: "rejected",
        code: "validation",
      },
    }));
  });

  it("resets only through the guarded maintenance controller", async () => {
    const data = setup();

    await expect(data.handlers["tasks.reset"]!({
      _trustLevel: "admin",
      agentId: "agent-a",
      expectedDigest: "b".repeat(64),
      confirmed: true,
    })).resolves.toEqual({
      resolvedAgentId: "agent-a",
      operationId: "reset-a",
      beforeDigest: "b".repeat(64),
      afterDigest: "c".repeat(64),
      state: "disabled",
      reinitialized: true,
    });
    expect(data.controller.reset).toHaveBeenCalledWith({
      expectedDigest: "b".repeat(64),
      confirmed: true,
      actorScope: "admin",
    });
    expect(data.store.cancelPending).not.toHaveBeenCalled();
  });
});
