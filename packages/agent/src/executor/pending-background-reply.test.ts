import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BackgroundTask } from "../background/background-task-types.js";
import { reconcilePendingBackgroundTurn } from "./pending-background-reply.js";

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-a",
    toolName: "mcp__large_report",
    status: "running",
    startedAt: 1,
    dispatchState: "pending",
    notificationPolicy: "deferred",
    origin: {
      conversationRef: "tenant:agent:user:telegram:peer:user",
      traceId: "11111111-1111-4111-8111-111111111111",
      backgroundHopCount: 0,
      turnScope: {
        conversation: { tenantId: "tenant", agentId: "agent", userId: "user", channelType: "telegram", conversationId: "chat" },
        endpoint: { channelType: "telegram", conversationId: "chat" },
      },
      deliveryOrigin: { tenantId: "tenant", userId: "user", channelType: "telegram", channelId: "chat" },
    },
    ...overrides,
  };
}

describe("reconcilePendingBackgroundTurn", () => {
  it("replaces unrelated terminal text while required work from this execution is still running", () => {
    const result = reconcilePendingBackgroundTurn({
      response: "The previously requested vehicle is parked in Tel Aviv.",
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: [task()],
    });

    expect(result.finishReason).toBe("background_pending");
    expect(result.response).toContain("mcp__large_report");
    expect(result.response).toContain("task-a");
    expect(result.response).not.toContain("Tel Aviv");
  });

  it("leaves a terminal answer unchanged when this execution has no running work", () => {
    const response = "The requested report is complete.";
    expect(reconcilePendingBackgroundTurn({
      response,
      executionId: "11111111-1111-4111-8111-111111111111",
      tasks: [task({ status: "completed" })],
    })).toEqual({ response, finishReason: undefined, pendingCount: 0 });
  });

  it("is wired at the post-execution terminal chokepoint with the task manager", () => {
    const postExecution = readFileSync(fileURLToPath(new URL("./executor-post-execution.ts", import.meta.url)), "utf8");
    const piExecutor = readFileSync(fileURLToPath(new URL("./pi-executor/pi-executor.ts", import.meta.url)), "utf8");
    expect(postExecution).toContain("reconcilePendingBackgroundTurn");
    expect(postExecution).toMatch(/backgroundTaskManager\?\.getTasks/);
    expect(postExecution).toMatch(/executionId,\s*tasks:/);
    expect(piExecutor).toMatch(/backgroundTaskManager:\s*deps\.backgroundTaskManager/);
  });
});
