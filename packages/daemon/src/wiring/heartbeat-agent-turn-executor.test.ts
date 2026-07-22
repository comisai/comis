// SPDX-License-Identifier: Apache-2.0
import {
  HeartbeatConfigSchema,
  TypedEventBus,
  getContext,
  type PerAgentConfig,
} from "@comis/core";
import { ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import type { HeartbeatCoordinatorAgentRunInput } from "@comis/scheduler";
import { createHeartbeatAgentTurnExecutor } from "./heartbeat-agent-turn-executor.js";

const CORRELATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const endpoint = {
  channelType: "telegram",
  channelInstanceId: "bot-main",
  conversationId: "chat-a",
  conversationKind: "direct" as const,
};

function agentConfig(heartbeat: Record<string, unknown> = {}): PerAgentConfig {
  return {
    model: "model-main",
    provider: "example",
    scheduler: { heartbeat: { enabled: true, intervalMs: 60_000, ...heartbeat } },
  } as never;
}

function runInput(overrides: Partial<HeartbeatCoordinatorAgentRunInput> = {}): HeartbeatCoordinatorAgentRunInput {
  return {
    correlationId: CORRELATION_ID,
    target: { kind: "agent", agentId: "agent-a" },
    lane: "normal",
    reason: "cron",
    rootRunId: "root-heartbeat-a",
    eventBatch: [{
      text: "backup completed",
      contextKey: "cron:backup",
      trigger: "cron",
      enqueuedAt: 1_000,
    }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function executionResult(response: string, finishReason = "stop") {
  return {
    response,
    sessionKey: { tenantId: "tenant-a", userId: "scheduler-heartbeat-agent-a", channelId: "scheduler:heartbeat:agent-a" },
    tokensUsed: { input: 10, output: 5, total: 15 },
    cost: { total: 0.01 },
    stepsExecuted: 2,
    llmCalls: 1,
    finishReason,
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const eventBus = new TypedEventBus();
  const execute = vi.fn(async () => executionResult("Alert: disk usage is high"));
  const deliver = vi.fn(async () => ({
    status: "accepted" as const,
    deliveredChunks: 1,
    settledAtMs: 1_050,
    lastMessageId: "message-a",
  }));
  const pruneAcknowledgedTurn = vi.fn(async () => ok(undefined));
  let id = 0;
  return {
    deps: {
      tenantId: "tenant-a",
      agents: { "agent-a": agentConfig({ target: endpoint, showOk: false, showAlerts: true }) },
      globalHeartbeatConfig: HeartbeatConfigSchema.parse({}),
      clock: { now: vi.fn(() => 1_000), nowDate: () => new Date(1_000) },
      eventBus,
      getExecutor: vi.fn(() => ({ execute })),
      assembleTools: vi.fn(async () => []),
      resolveModel: vi.fn(() => ({
        model: "model-heartbeat",
        source: "explicit_config" as const,
        timeoutMs: 30_000,
        timeoutSource: "operation_explicit" as const,
        cacheRetention: "none" as const,
      })),
      getMemoryStats: vi.fn(() => undefined),
      deliver,
      pruneAcknowledgedTurn,
      idFactory: () => `agent-execution-${++id}`,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
    } as never,
    eventBus,
    execute,
    deliver,
    pruneAcknowledgedTurn,
  };
}

describe("heartbeat agent turn executor", () => {
  it("runs the claimed event batch under the registered root and awaits exact delivery", async () => {
    const { deps, execute, deliver } = makeDeps();
    execute.mockImplementationOnce(async (message) => {
      expect(getContext()).toMatchObject({
        agentId: "agent-a",
        rootRunId: "root-heartbeat-a",
        traceId: CORRELATION_ID,
        channelType: "scheduler",
      });
      expect(message.text).toContain("Scheduled events");
      expect(message.text).toContain("backup completed");
      return executionResult("Alert: disk usage is high");
    });

    const result = await createHeartbeatAgentTurnExecutor(deps)(runInput());

    expect(result).toEqual(ok(expect.objectContaining({
      status: "settled",
      trigger: "cron",
      rootRunId: "root-heartbeat-a",
      agentExecutionId: "agent-execution-1",
      execution: { status: "completed", finishReason: "stop" },
      modelResolved: "model-heartbeat",
      modelResolutionSource: "explicit_config",
      metrics: { totalTokens: 15, costUsd: 0.01, toolCalls: 2, llmCalls: 1 },
      delivery: expect.objectContaining({ status: "accepted", lastMessageId: "message-a" }),
      sessionMaintenance: { status: "not_required" },
      eventBatch: { status: "consumed", entryCount: 1 },
    })));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: CORRELATION_ID,
      agentId: "agent-a",
      endpoint,
      text: "Alert: disk usage is high",
      level: "alert",
    }));
  });

  it("prunes token acknowledgements and suppresses them when showOk is false", async () => {
    const { deps, execute, deliver, pruneAcknowledgedTurn } = makeDeps();
    execute.mockResolvedValueOnce(executionResult("HEARTBEAT_OK"));

    const result = await createHeartbeatAgentTurnExecutor(deps)(runInput({ reason: "manual", eventBatch: [] }));

    expect(result).toMatchObject({
      ok: true,
      value: {
        delivery: { status: "suppressed", reason: "visibility_policy" },
        sessionMaintenance: { status: "completed" },
        eventBatch: { status: "none" },
      },
    });
    expect(pruneAcknowledgedTurn).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("keeps critical output visible when ordinary alerts are hidden", async () => {
    const { deps, execute, deliver } = makeDeps({
      agents: { "agent-a": agentConfig({ target: endpoint, showOk: false, showAlerts: false }) },
    });
    execute.mockResolvedValueOnce(executionResult("CRITICAL: service unreachable"));

    const result = await createHeartbeatAgentTurnExecutor(deps)(runInput({ eventBatch: [] }));

    expect(result).toMatchObject({ ok: true, value: { delivery: { status: "accepted" } } });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ level: "critical" }));
  });

  it("returns pre-side-effect errors only for unbound inputs", async () => {
    const missing = makeDeps({ agents: {} });
    await expect(createHeartbeatAgentTurnExecutor(missing.deps)(runInput())).resolves.toEqual({
      ok: false,
      error: { code: "not_bound", errorKind: "precondition" },
    });

    const task = makeDeps();
    await expect(createHeartbeatAgentTurnExecutor(task.deps)(runInput({ lane: "task", reason: "task" }))).resolves.toEqual({
      ok: false,
      error: { code: "not_bound", errorKind: "precondition" },
    });
  });

  it("settles executor rejection as unknown without attempting delivery", async () => {
    const { deps, execute, deliver } = makeDeps();
    execute.mockRejectedValueOnce(new Error("provider disconnected"));

    const result = await createHeartbeatAgentTurnExecutor(deps)(runInput());

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "settled",
        execution: { status: "unknown", errorKind: "internal" },
        delivery: { status: "not_requested" },
      },
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});
