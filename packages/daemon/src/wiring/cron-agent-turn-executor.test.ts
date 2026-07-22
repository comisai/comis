// SPDX-License-Identifier: Apache-2.0
import {
  TypedEventBus,
  createConversationRef,
  formatSessionKey,
  tryGetContext,
  unwrapExternalContent,
  type PerAgentConfig,
} from "@comis/core";
import type { AgentExecutor, ExecutionResult } from "@comis/agent";
import { ok } from "@comis/shared";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createCronAgentTurnExecutor } from "./cron-agent-turn-executor.js";

const NOW_MS = 1_800_000_000_000;
const EXECUTION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_EXECUTION_ID = "executor-issued-execution-a";

function successfulExecution(
  sessionKey: ExecutionResult["sessionKey"],
  overrides: Partial<Omit<ExecutionResult, "finishReason" | "terminalErrorKind">> = {},
): ExecutionResult {
  return {
    response: " Queue healthy ",
    sessionKey,
    executionId: AGENT_EXECUTION_ID,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    sideEffectSummary: {
      schedulingCapabilityInvoked: false,
      outboundDeliveryCapabilityInvoked: false,
      deferredWorkCapabilityInvoked: false,
      unclassifiedInvocationObserved: false,
    },
    tokensUsed: { input: 20, output: 5, total: 25 },
    cost: { total: 0.004 },
    stepsExecuted: 1,
    llmCalls: 1,
    finishReason: "stop",
    ...overrides,
  };
}

function failedExecution(
  sessionKey: ExecutionResult["sessionKey"],
  terminalErrorKind: "auth" | "dependency",
): ExecutionResult {
  return {
    ...successfulExecution(sessionKey),
    response: "",
    finishReason: "error",
    terminalErrorKind,
  };
}

function target() {
  const destinationEndpoint = {
    channelType: "telegram",
    channelInstanceId: "bot-a",
    conversationId: "chat-a",
    conversationKind: "direct" as const,
  };
  const conversationScope = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "endpoint-conversation" as const, endpoint: destinationEndpoint },
  };
  const conversationRef = createConversationRef(conversationScope);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    conversation: { conversationScope, conversationRef: conversationRef.value },
    destinationEndpoint,
  };
}

function input(
  overrides: Partial<Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }>["job"]> = {},
): Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }> {
  return {
    executionId: EXECUTION_ID,
    scheduledForMs: NOW_MS,
    trigger: "scheduled",
    kind: "agent_turn",
    rootRunId: `root-cron-${EXECUTION_ID}`,
    job: {
      id: "job-a",
      name: "Status check",
      agentId: "agent-a",
      source: "authored",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: NOW_MS },
      lifecycle: {
        status: "scheduled",
        nextRunAtMs: NOW_MS + 60_000,
        consecutiveDependencyErrors: 0,
      },
      payload: {
        kind: "agent_turn",
        message: "Inspect the queue",
        model: "openai:gpt-5-mini",
        timeoutSeconds: 600,
      },
      sessionPolicy: { strategy: "rolling", maxHistoryTurns: 3 },
      continuationMode: "none",
      cacheRetention: "long",
      toolPolicy: { profile: "full", allow: [], deny: ["message_send"] },
      deliveryTarget: target(),
      ...overrides,
    },
  };
}

function makeDeps() {
  const eventBus = new TypedEventBus();
  const executor: AgentExecutor = {
    execute: vi.fn(async (_message, sessionKey, tools) => {
      const context = tryGetContext();
      expect(context?.rootRunId).toBe(`root-cron-${EXECUTION_ID}`);
      expect(context?.sessionKey).toBe(formatSessionKey(sessionKey));
      expect(tools?.map((tool) => tool.name)).toEqual(["read"]);
      return successfulExecution(sessionKey);
    }),
  };
  const sessionPolicy = {
    before: vi.fn(async () => ok(undefined)),
    after: vi.fn(async () => ok(undefined)),
  };
  return {
    tenantId: "tenant-a",
    agents: {
      "agent-a": {
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        operationModels: {},
        promptTimeout: { promptTimeoutMs: 180_000, retryPromptTimeoutMs: 60_000 },
        cacheRetention: "long",
        skills: {
          toolPolicy: { profile: "full", allow: [], deny: ["exec"] },
        },
      } as PerAgentConfig,
    },
    clock: createFakeClock(NOW_MS),
    eventBus,
    getExecutor: vi.fn(() => executor),
    assembleTools: vi.fn(async () => [
      { name: "read", description: "read", parameters: {}, execute: vi.fn() },
      { name: "exec", description: "exec", parameters: {}, execute: vi.fn() },
      { name: "message_send", description: "send", parameters: {}, execute: vi.fn() },
    ]),
    sessionPolicy,
    resolveWakeGateCapability: vi.fn(() => "enabled" as const),
    runWakeGate: vi.fn(),
    deliverText: vi.fn(async () => ({
      status: "accepted" as const,
      deliveredChunks: 1,
      settledAtMs: NOW_MS,
      lastMessageId: "message-a",
    })),
    continueTurn: vi.fn(async () => ({ mode: "none" as const, status: "not_requested" as const })),
    readMetrics: vi.fn(() => ({ totalTokens: 0, costUsd: 0, toolCalls: 0, llmCalls: 0 })),
    idFactory: vi.fn(() => "agent-execution-a"),
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), audit: vi.fn(),
    } as never,
    _executor: executor,
  };
}

describe("cron governed agent-turn executor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs one synthetic rooted turn with bounded policy, fresh framing, and settled delivery", async () => {
    const deps = makeDeps();
    const execute = createCronAgentTurnExecutor(deps);

    const result = await execute(input(), new AbortController().signal);

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "agent_turn") return;
    expect(deps.sessionPolicy.before).toHaveBeenCalledBefore(deps._executor.execute as never);
    expect(deps.sessionPolicy.after).toHaveBeenCalledAfter(deps._executor.execute as never);
    const [message, , tools, , agentId, , , overrides] = vi.mocked(deps._executor.execute).mock.calls[0]!;
    expect(unwrapExternalContent(message.text)).toMatchObject({
      content: "Inspect the queue",
      source: "api",
    });
    expect(agentId).toBe("agent-a");
    expect(tools?.map((tool) => tool.name)).toEqual(["read"]);
    expect(overrides).toMatchObject({
      operationType: "cron",
      model: "openai:gpt-5-mini",
      cacheRetention: "short",
      promptTimeout: { promptTimeoutMs: 150_000, retryPromptTimeoutMs: 150_000 },
    });
    expect(overrides?.signal).toBeInstanceOf(AbortSignal);
    expect(result.value.outcome).toMatchObject({
      agentExecutionId: AGENT_EXECUTION_ID,
      rootRunId: `root-cron-${EXECUTION_ID}`,
      execution: { status: "completed", finishReason: "stop" },
      modelResolved: "openai:gpt-5-mini",
      modelResolutionSource: "cron_job_override",
      metrics: { durationMs: 0, totalTokens: 25, costUsd: 0.004, toolCalls: 1, llmCalls: 1 },
      wakeGate: { status: "not_configured" },
      delivery: { status: "accepted", deliveredChunks: 1 },
      continuation: { mode: "none", status: "not_requested" },
    });
    expect(deps.deliverText).toHaveBeenCalledWith(expect.objectContaining({ text: "Queue healthy" }));
  });

  it("passes exact accepted evidence and agent execution identity to origin continuation", async () => {
    const deps = makeDeps();
    deps.continueTurn.mockResolvedValue({ mode: "origin_history", status: "appended" });
    const execute = createCronAgentTurnExecutor(deps);

    const result = await execute(input({ continuationMode: "origin_history" }), new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(deps.continueTurn).toHaveBeenCalledWith({
      input: expect.objectContaining({ executionId: EXECUTION_ID }),
      sourceExecutionId: AGENT_EXECUTION_ID,
      visibleText: "Queue healthy",
      delivery: {
        status: "accepted",
        deliveredChunks: 1,
        settledAtMs: NOW_MS,
        lastMessageId: "message-a",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("consumes a configured gate as a closed pre-model skip when capability is disabled", async () => {
    const deps = makeDeps();
    deps.resolveWakeGateCapability.mockReturnValue("disabled");
    const execute = createCronAgentTurnExecutor(deps);

    const result = await execute(input({
      wakeGate: { script: "console.log('{\"wake\":true}')", language: "js", timeoutSeconds: 2 },
    }), new AbortController().signal);

    expect(result).toEqual(ok({
      kind: "agent_turn_pre_model_skip",
      rootRunId: `root-cron-${EXECUTION_ID}`,
      reason: "wake_gate_disabled",
      errorKind: "precondition",
      continuation: { mode: "none", status: "not_requested" },
    }));
    expect(deps.sessionPolicy.before).not.toHaveBeenCalled();
    expect(deps._executor.execute).not.toHaveBeenCalled();
  });

  it("settles wake-false delivery without preparing or invoking the agent", async () => {
    const deps = makeDeps();
    deps.runWakeGate.mockResolvedValue({
      status: "skip",
      durationMs: 8,
      toolCalls: 2,
      deliver: "No changes",
    });
    const execute = createCronAgentTurnExecutor(deps);

    const result = await execute(input({
      wakeGate: { script: "console.log('{\"wake\":false}')", language: "js", timeoutSeconds: 2 },
    }), new AbortController().signal);

    expect(result).toEqual(ok({
      kind: "wake_gate_skip",
      rootRunId: `root-cron-${EXECUTION_ID}`,
      durationMs: 8,
      toolCalls: 2,
      delivery: {
        status: "accepted",
        deliveredChunks: 1,
        settledAtMs: NOW_MS,
        lastMessageId: "message-a",
      },
      continuation: { mode: "none", status: "not_requested" },
    }));
    expect(deps.deliverText).toHaveBeenCalledWith(expect.objectContaining({ text: "No changes" }));
    expect(deps.sessionPolicy.before).not.toHaveBeenCalled();
    expect(deps._executor.execute).not.toHaveBeenCalled();
  });

  it("uses the exact execution-aborted event as terminal authority over a clean SDK finish", async () => {
    const deps = makeDeps();
    vi.mocked(deps._executor.execute).mockImplementationOnce(async (_message, sessionKey) => {
      deps.eventBus.emit("execution:aborted", {
        sessionKey,
        reason: "budget_exceeded",
        agentId: "agent-a",
        timestamp: NOW_MS,
      });
      return successfulExecution(sessionKey, {
        response: "late response",
        tokensUsed: { input: 10, output: 2, total: 12 },
        cost: { total: 0.001 },
        stepsExecuted: 0,
      });
    });
    const execute = createCronAgentTurnExecutor(deps);

    const result = await execute(input({ deliveryTarget: undefined }), new AbortController().signal);

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "agent_turn") return;
    expect(result.value.outcome.execution).toEqual({
      status: "aborted",
      abortReason: "budget_exceeded",
      finishReason: "stop",
      errorKind: "resource",
    });
    expect(result.value.outcome.delivery).toEqual({ status: "not_requested" });
  });

  it.each([
    ["dependency", "dependency"],
    ["auth", "auth"],
  ] as const)("preserves the executor %s terminal kind on a failed cron turn", async (_label, errorKind) => {
    const deps = makeDeps();
    vi.mocked(deps._executor.execute).mockImplementationOnce(async (_message, sessionKey) => (
      failedExecution(sessionKey, errorKind)
    ));
    const execute = createCronAgentTurnExecutor(deps);

    const result = await execute(input({ deliveryTarget: undefined }), new AbortController().signal);

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "agent_turn") return;
    expect(result.value.outcome.agentExecutionId).toBe(AGENT_EXECUTION_ID);
    expect(result.value.outcome.execution).toEqual({
      status: "failed",
      finishReason: "error",
      errorKind,
    });
  });

  it("frames wake-gate context separately from the stored job message", async () => {
    const deps = makeDeps();
    deps.runWakeGate.mockResolvedValue({
      status: "woke",
      durationMs: 3,
      toolCalls: 1,
      context: "Gate observed a queue transition",
    });
    vi.mocked(deps._executor.execute).mockImplementationOnce(async (_message, sessionKey) => (
      successfulExecution(sessionKey, {
        response: "done",
        tokensUsed: { input: 1, output: 1, total: 2 },
        cost: { total: 0 },
        stepsExecuted: 0,
      })
    ));
    const execute = createCronAgentTurnExecutor(deps);

    const result = await execute(input({
      wakeGate: { script: "console.log('{}')", language: "js", timeoutSeconds: 2 },
      deliveryTarget: undefined,
    }), new AbortController().signal);

    expect(result.ok).toBe(true);
    const message = vi.mocked(deps._executor.execute).mock.calls[0]![0];
    expect(message.text.match(/<<<UNTRUSTED_[a-f0-9]{24}>>>/g)).toHaveLength(2);
    expect(message.text.match(/<<<END_UNTRUSTED_[a-f0-9]{24}>>>/g)).toHaveLength(2);
    expect(message.text).toContain("Inspect the queue");
    expect(message.text).toContain("Gate observed a queue transition");
  });

  it("settles scheduler cancellation after a live gate without preparing the model session", async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    deps.runWakeGate.mockImplementation(async () => {
      controller.abort();
      return {
        status: "failed_open",
        durationMs: 2,
        toolCalls: 0,
        errorKind: "precondition",
      };
    });
    const execute = createCronAgentTurnExecutor(deps);

    const result = await execute(input({
      wakeGate: { script: "console.log('{}')", language: "js", timeoutSeconds: 2 },
      deliveryTarget: undefined,
    }), controller.signal);

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "agent_turn") return;
    expect(result.value.outcome).toMatchObject({
      execution: { status: "aborted", abortReason: "pipeline_timeout" },
      wakeGate: { status: "failed_open", errorKind: "precondition" },
      delivery: { status: "not_requested" },
    });
    expect(deps.assembleTools).not.toHaveBeenCalled();
    expect(deps.sessionPolicy.before).not.toHaveBeenCalled();
    expect(deps._executor.execute).not.toHaveBeenCalled();
  });
});
