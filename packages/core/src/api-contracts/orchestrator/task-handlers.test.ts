// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  TasksCancelContract,
  TasksListContract,
  TasksResetContract,
  TasksStatusContract,
} from "./task-handlers.js";

const task = {
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
};

describe("follow-up task operator RPC contracts", () => {
  it("keeps status list and cancellation on strict admin-only routes", () => {
    for (const contract of [TasksStatusContract, TasksListContract, TasksCancelContract, TasksResetContract]) {
      expect(contract.scopes).toEqual(["admin"]);
    }
    expect(TasksCancelContract.request.parse({ taskId: "task-a" })).toEqual({ taskId: "task-a" });
    expect(TasksCancelContract.request.parse({ allPending: true, agentId: "agent-a" })).toEqual({
      allPending: true,
      agentId: "agent-a",
    });
    expect(() => TasksCancelContract.request.parse({ taskId: "task-a", allPending: true })).toThrow();
    expect(() => TasksCancelContract.request.parse({})).toThrow();
    expect(TasksResetContract.request.parse({
      expectedDigest: "d".repeat(64), confirmed: true, agentId: "agent-a",
    })).toEqual({ expectedDigest: "d".repeat(64), confirmed: true, agentId: "agent-a" });
    expect(() => TasksResetContract.request.parse({ expectedDigest: "d".repeat(64), confirmed: false })).toThrow();
  });

  it("accepts only content-free inspection projections", () => {
    expect(TasksStatusContract.response.parse({
      resolvedAgentId: "agent-a",
      configuredEnabled: true,
      state: "ready",
      strictAuthorityValid: true,
      ownershipReconciled: true,
      store: { exists: true, bytes: 66, digest: "b".repeat(64) },
      quarantine: { exists: false, bytes: 0, digest: null, recordCount: 0, state: "valid" },
      intent: { status: "none" },
      counts: { total: 1, pending: 1, active: 0, terminal: 0 },
    })).toBeDefined();
    expect(TasksListContract.response.parse({
      resolvedAgentId: "agent-a",
      fileDigest: "b".repeat(64),
      tasks: [task],
    })).toBeDefined();
    expect(() => TasksListContract.response.parse({
      resolvedAgentId: "agent-a",
      fileDigest: "b".repeat(64),
      tasks: [{ ...task, conversationRef: "a".repeat(64) }],
    })).toThrow();
    expect(() => TasksListContract.response.parse({
      resolvedAgentId: "agent-a",
      fileDigest: "b".repeat(64),
      tasks: [{ ...task, text: "secret task text" }],
    })).toThrow();
    expect(() => TasksListContract.response.parse({
      resolvedAgentId: "agent-a",
      fileDigest: "b".repeat(64),
      tasks: [{ ...task, origin: { channelId: "conversation-a" } }],
    })).toThrow();
    expect(TasksResetContract.response.parse({
      resolvedAgentId: "agent-a",
      operationId: "reset-a",
      beforeDigest: "b".repeat(64),
      afterDigest: "c".repeat(64),
      state: "disabled",
      reinitialized: true,
    })).toBeDefined();
  });
});
