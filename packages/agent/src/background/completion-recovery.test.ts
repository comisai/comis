// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createConversationLocator } from "@comis/core";
import { err, ok } from "@comis/shared";
import { createCompletionRecovery } from "./completion-recovery.js";
import type { BackgroundTaskOrigin } from "./background-task-types.js";

function makeOrigin(): BackgroundTaskOrigin {
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "conversation-a",
    conversationKind: "direct" as const,
  };
  const locator = createConversationLocator({
    tenantId: "default",
    agentId: "agent-a",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint,
      principalId: "user_a",
    },
  });
  if (!locator.ok) throw locator.error;
  return {
    turnScope: {
      conversation: locator.value.conversationScope,
      principal: { principalId: "user_a" },
      endpoint,
    },
    conversationRef: locator.value.conversationRef,
    deliveryOrigin: {
      tenantId: "default",
      userId: "user_a",
      channelType: "echo",
      channelId: "conversation-a",
    },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
  };
}

describe("createCompletionRecovery", () => {
  it("exposes the complete durable recovery lifecycle", () => {
    const recovery = createCompletionRecovery({} as never);

    expect(Object.keys(recovery).sort()).toEqual([
      "finishCleanup",
      "reconcileDeliveryClaim",
      "recoverClaimedTask",
    ]);
  });

  it("records an incident when an absent-journal reset cannot persist", async () => {
    const origin = makeOrigin();
    const task = {
      id: "task-a",
      toolName: "report",
      status: "completed" as const,
      startedAt: 1,
      completedAt: 2,
      origin,
      continuationExecutionId: "execution-a",
      dispatchAttempts: 1,
      dispatchState: "execution_claimed" as const,
    };
    const recordRecoveryIncident = vi.fn(() => ok(undefined));
    const scheduleDispatchRetry = vi.fn();
    const emitRoutingOutcome = vi.fn();
    const recovery = createCompletionRecovery({
      taskManager: {
        getTask: vi.fn(() => task),
        persistContinuationOutbox: vi.fn(),
        persistCleanupPendingOutbox: vi.fn(),
        persistFinalizedResult: vi.fn(),
        scheduleDispatchRetry,
        scheduleStateRetry: vi.fn(),
        recordRecoveryIncident,
      },
      recoverFinalizedResult: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupFinalizedSession: vi.fn().mockResolvedValue(ok(undefined)),
      reconcileDelivery: vi.fn(),
      deliveryProtection: "ledger",
      commitState: vi.fn(() => err(new Error("protected storage unavailable"))),
      emitRoutingOutcome,
      deliverPersistedOutbox: vi.fn(),
    });

    await recovery.recoverClaimedTask(task.id, origin, task.toolName);

    expect(recordRecoveryIncident).toHaveBeenCalledWith(task.id);
    expect(scheduleDispatchRetry).toHaveBeenCalledWith(task.id);
    expect(emitRoutingOutcome).toHaveBeenCalledWith(
      task.id,
      origin,
      task.toolName,
      false,
      "retry_scheduled",
    );
  });
});
