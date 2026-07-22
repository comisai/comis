// SPDX-License-Identifier: Apache-2.0
import {
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  hashWorkspacePolicyContent,
  type TaskExtractionTurn,
} from "@comis/core";
import type { AgentExecutor, ExecutionResult } from "@comis/agent";
import { ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFollowupTaskExtractionRuntime } from "./setup-followup-task-extraction.js";

function turn(): TaskExtractionTurn {
  const conversation = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "agent" as const },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  const content = "# Scope\n\nUse the configured scope.";
  const section = {
    id: "workspace:scope",
    sourceKind: "operator" as const,
    trust: "trusted" as const,
    stability: "stable" as const,
    content,
    contentHash: hashWorkspacePolicyContent(content),
    maxChars: 20_000,
  };
  return {
    sourceExecutionId: "execution-source-a",
    origin: {
      turnScope: {
        conversation,
        principal: { principalId: "user-a" },
        endpoint: {
          channelType: "echo",
          channelInstanceId: "echo-main",
          conversationId: "conversation-a",
          conversationKind: "direct",
        },
      },
      conversationRef: conversationRef.value,
      deliveryOrigin: {
        tenantId: "tenant-a",
        channelType: "echo",
        channelId: "conversation-a",
        userId: "user-a",
      },
      traceId: "trace-a",
      backgroundHopCount: 0,
    },
    workspacePolicySnapshot: {
      agentId: "agent-a",
      sections: [section],
      combinedHash: computeWorkspacePolicyCombinedHash([section]),
    },
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    capturedAtMs: 1_000,
    userText: "Please check this later.",
    deliveredAssistantText: "I will follow up.",
  };
}

function execution(response: string): ExecutionResult {
  return {
    response,
    sessionKey: { tenantId: "tenant-a", userId: "scheduler", channelId: "task" },
    tokensUsed: { input: 10, output: 5, total: 15 },
    cost: { total: 0.001 },
    stepsExecuted: 0,
    llmCalls: 1,
    finishReason: "stop",
  };
}

function setup() {
  const timers = createFakeTimers();
  let sequence = 0;
  const config = {
    tenantId: "tenant-a",
    agents: {
      "agent-a": {
        provider: "anthropic",
        model: "anthropic:primary-model",
        operationModels: {
          taskExtraction: { model: "anthropic:extractor-model", timeout: 30_000 },
        },
        promptTimeout: { promptTimeoutMs: 180_000 },
        scheduler: { heartbeat: { enabled: false, intervalMs: 60_000 } },
      },
    },
    scheduler: {
      tasks: {
        enabled: true,
        confidenceThreshold: 0.8,
        debounceMs: 1_000,
        batchMax: 8,
        maxPerCheck: 3,
        maxPerDayPerConversation: 3,
        defaultWindowMs: 3_600_000,
        preAcceptanceRetryLimit: 3,
      },
      heartbeat: { enabled: false, intervalMs: 60_000 },
    },
  };
  const execute = vi.fn(async (message: { text: string }) => {
    const itemId = /Item (\S+)/u.exec(message.text)?.[1] ?? "missing";
    return execution(JSON.stringify({
      candidates: [{
        itemId,
        text: "Check the outcome",
        dueInSecondsEarliest: 60,
        dueInSecondsLatest: 120,
        confidence: 0.9,
      }],
    }));
  });
  const admitCandidates = vi.fn(async () => ok([
    { itemId: "item-a", disposition: "created" as const, taskId: "task-a" },
  ]));
  const emitSafely = vi.fn(() => ({ delivered: 0, failures: [] }));
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const mintLease = vi.fn(() => ({ leaseId: "lease-a", bearer: "bearer-a" }));
  const onTaskStoreChanged = vi.fn(async () => ok(undefined));
  const runtime = createFollowupTaskExtractionRuntime({
    config: config as never,
    clock: { now: () => 2_000, nowDate: () => new Date(2_000) },
    timers,
    eventBus: { emitSafely } as never,
    logger: logger as never,
    taskStores: new Map([["agent-a", { admitCandidates } as never]]),
    workspaceDirs: new Map([["agent-a", "/workspace/agent-a"]]),
    getExecutor: () => ({ execute } as unknown as AgentExecutor),
    leaseManager: { mintLease, revoke: vi.fn() } as never,
    outputGuard: { registerSecret: vi.fn() },
    boundedAutonomyHolder: {
      current: { registerRoot: vi.fn(), evictRootIfIdle: vi.fn() },
    } as never,
    onTaskStoreChanged,
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  return { runtime, config, timers, execute, admitCandidates, emitSafely, logger, mintLease, onTaskStoreChanged };
}

describe("follow-up task extraction composition", () => {
  it("runs captured turns through one governed root and durable admission", async () => {
    const data = setup();
    expect(data.runtime.ok).toBe(true);
    if (!data.runtime.ok) return;

    expect(data.runtime.value.taskExtractionPort.enqueue(turn())).toEqual(ok("enqueued"));
    data.timers.advance(1_000);
    await data.runtime.value.waitForIdle();

    expect(data.mintLease).toHaveBeenCalledWith(expect.objectContaining({
      caps: [],
      rootRunId: expect.stringMatching(/^root-task-extract-/u),
    }));
    expect(data.execute).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ trigger: "task_extraction" }) }),
      expect.any(Object),
      [],
      undefined,
      "agent-a",
      undefined,
      undefined,
      expect.objectContaining({
        operationType: "taskExtraction",
        capabilityAccess: "none",
        model: "anthropic:extractor-model",
        skipRag: true,
        skipSep: true,
      }),
    );
    expect(data.admitCandidates).toHaveBeenCalledWith({
      candidates: [expect.objectContaining({ text: "Check the outcome" })],
      confidenceThreshold: 0.8,
    });
    expect(data.onTaskStoreChanged).toHaveBeenCalledWith("agent-a");
    expect(data.emitSafely).toHaveBeenCalledWith(
      "scheduler:task_extraction_completed",
      expect.objectContaining({
        agentId: "agent-a",
        candidateCount: 1,
        createdCount: 1,
        sourceExecutionIds: ["execution-source-a"],
        taskIds: ["task-a"],
        durationMs: 0,
      }),
    );
    expect(data.emitSafely).not.toHaveBeenCalledWith("scheduler:task_extraction_outcome", expect.anything());
  });

  it("rejects new capture immediately after the live opt-in gate closes", () => {
    const data = setup();
    expect(data.runtime.ok).toBe(true);
    if (!data.runtime.ok) return;

    data.config.scheduler.tasks.enabled = false;

    expect(data.runtime.value.taskExtractionPort.enqueue(turn())).toMatchObject({
      ok: false,
      error: { code: "not_accepting", errorKind: "precondition" },
    });
    expect(data.runtime.value.status()).toMatchObject({
      queue: { accepting: true, itemCount: 0 },
      runner: { accepting: true, activeCount: 0 },
    });
  });

  it("fails setup before activation when an enabled agent lacks its durable store", () => {
    const data = setup();
    if (data.runtime.ok) {
      data.runtime.value.closeAdmission();
      data.runtime.value.abortActive();
    }
    const missing = createFollowupTaskExtractionRuntime({
      config: data.config as never,
      clock: { now: () => 2_000, nowDate: () => new Date(2_000) },
      timers: data.timers,
      eventBus: { emitSafely: data.emitSafely } as never,
      logger: data.logger as never,
      taskStores: new Map(),
      workspaceDirs: new Map([["agent-a", "/workspace/agent-a"]]),
      getExecutor: () => ({ execute: data.execute } as unknown as AgentExecutor),
      leaseManager: { mintLease: vi.fn(), revoke: vi.fn() } as never,
      outputGuard: { registerSecret: vi.fn() },
      boundedAutonomyHolder: { current: { registerRoot: vi.fn(), evictRootIfIdle: vi.fn() } } as never,
      onTaskStoreChanged: vi.fn(async () => ok(undefined)),
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });

    expect(missing).toMatchObject({
      ok: false,
      error: { code: "store_unavailable", errorKind: "precondition" },
    });
  });
});
