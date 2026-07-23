// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ok } from "@comis/shared";
import {
  createBackgroundCompletionRunner,
  type BackgroundCompletionRunnerDeps,
} from "./completion-runner.js";
import type { BackgroundTask } from "./background-task-types.js";
import {
  getContext,
  createConversationRef,
  conversationScopeToSessionKey,
  formatSessionKey,
  RequestContextSchema,
  runWithContext,
  TypedEventBus,
  type BackgroundTaskOrigin,
  type RequestContext,
} from "@comis/core";

// Build a real-ish event bus so on()/off()/emit() work end-to-end. We
// mock the executor, sessionStore, taskManager.getTask, fallbackNotifyFn,
// and logger.
function createFakeEventBus() {
  return new TypedEventBus();
}

function buildOrigin(over: Partial<BackgroundTaskOrigin> & { agentId?: string; sessionKey?: string; channelType?: string; channelId?: string; userId?: string } = {}): BackgroundTaskOrigin {
  const agentId = over.agentId ?? "default";
  const sessionParts = over.sessionKey?.split(":") ?? [];
  const tenantId = sessionParts[0] ?? "default";
  const userId = over.userId ?? sessionParts[1] ?? "user1";
  const channelType = over.channelType ?? "echo";
  const channelId = over.channelId ?? "test";
  const referenceEndpoint = { channelType, channelInstanceId: "test-instance", conversationId: channelId || "invalid-route", conversationKind: "direct" as const };
  const turnScope = {
    conversation: { tenantId, agentId, partition: { kind: "endpoint-conversation-principal" as const, endpoint: referenceEndpoint, principalId: userId } },
    principal: { principalId: userId }, endpoint: referenceEndpoint,
  };
  const conversationRef = createConversationRef(turnScope.conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  if (channelId === "") {
    turnScope.endpoint = { ...referenceEndpoint, conversationId: "" };
    turnScope.conversation.partition.endpoint = turnScope.endpoint;
  }
  return {
    turnScope,
    conversationRef: conversationRef.value,
    deliveryOrigin: { channelType, channelId, userId, tenantId },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
    ...Object.fromEntries(Object.entries(over).filter(([key]) => !["agentId", "sessionKey", "channelType", "channelId", "userId"].includes(key))),
  };
}

function originSessionKey(origin: BackgroundTaskOrigin): string {
  const projected = conversationScopeToSessionKey(origin.turnScope.conversation);
  if (!projected.ok) throw projected.error;
  return formatSessionKey(projected.value);
}

function buildTask(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    toolName: "exec",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    origin: buildOrigin(),
    continuationExecutionId: "task-1",
    dispatchAttempts: 0,
    dispatchState: "pending",
    ...over,
  };
}

function makeLogger() {
  const child = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => child),
  } as unknown as import("@comis/core").ComisLogger;
}

describe("createBackgroundCompletionRunner", () => {
  let eventBus: ReturnType<typeof createFakeEventBus>;
  let executor: { execute: ReturnType<typeof vi.fn> };
  let sessionStore: { loadByRef: ReturnType<typeof vi.fn> };
  let taskManager: {
    getTask: ReturnType<typeof vi.fn>;
    transitionDispatchState: ReturnType<typeof vi.fn>;
    persistContinuationOutbox: ReturnType<typeof vi.fn>;
    scheduleDispatchRetry: ReturnType<typeof vi.fn>;
  };
  let fallbackNotifyFn: ReturnType<typeof vi.fn>;
  let transitionDispatchState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = createFakeEventBus();
    executor = { execute: vi.fn().mockResolvedValue({ ok: true }) };
    sessionStore = { loadByRef: vi.fn().mockReturnValue(ok({ messages: [] })) };
    transitionDispatchState = vi.fn((_taskId, next, expected) => {
      const task = taskManager.getTask();
      const current = task?.dispatchState ?? "pending";
      if (!task || (expected && !expected.includes(current))) return false;
      task.dispatchState = next;
      return true;
    });
    taskManager = {
      getTask: vi.fn(),
      transitionDispatchState,
      persistContinuationOutbox: vi.fn((_taskId, outbox, expected) => {
        const task = taskManager.getTask();
        const current = task?.dispatchState ?? "pending";
        if (!task || (expected && !expected.includes(current))) {
          return { ok: false, error: new Error("outbox transition rejected") };
        }
        task.continuationOutbox = outbox;
        task.dispatchState = "ready_to_deliver";
        return ok(undefined);
      }),
      scheduleDispatchRetry: vi.fn(),
    };
    fallbackNotifyFn = vi.fn().mockResolvedValue(undefined);
  });

  function build(
    maxBackgroundHops = 3,
    isTurnInFlight?: (key: string) => boolean,
    assembleToolsForAgent?: BackgroundCompletionRunnerDeps["assembleToolsForAgent"],
    deliverCompletion: BackgroundCompletionRunnerDeps["deliverCompletion"] = vi.fn().mockResolvedValue({ kind: "accepted" }),
  ) {
    return createBackgroundCompletionRunner({
      eventBus,
      getExecutor: (_agentId: string) => executor as unknown as import("../executor/types.js").AgentExecutor,
      sessionStore,
      taskManager: taskManager as unknown as import("./background-task-manager.js").BackgroundTaskManager,
      deliverFallback: async ({ origin, response }) => {
        await fallbackNotifyFn({
          agentId: origin.turnScope.conversation.agentId,
          message: response,
          priority: "normal",
          origin: "background_task",
        });
        return { kind: "accepted" };
      },
      deliveryProtection: "ledger",
      maxBackgroundHops,
      ...(isTurnInFlight ? { isTurnInFlight } : {}),
      ...(assembleToolsForAgent ? { assembleToolsForAgent } : {}),
      deliverCompletion,
      logger: makeLogger(),
    });
  }

  it("LIVE-TURN skip: origin turn in flight → NO re-entry turn (the live turn owns consumption)", async () => {
    // Mirrors the dispatcher's suppression (live incident: an auto-backgrounded
    // MCP call completed mid-turn; the live turn consumed it via background_tasks).
    // A re-entry now would serialize a redundant continuation behind the live turn.
    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    const runner = build(3, (key) => key === originSessionKey(task.origin));
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).not.toHaveBeenCalled();
    expect(fallbackNotifyFn).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("completed event triggers executor.execute with synthetic message AND emits background_task:reentered", async () => {
    const reenteredEvents: unknown[] = [];
    eventBus.on("background_task:reentered", (data) => reenteredEvents.push(data));
    const tools = [{ name: "next_report_page" }] as unknown as NonNullable<
      Parameters<import("../executor/types.js").AgentExecutor["execute"]>[2]
    >;
    const assembleToolsForAgent = vi.fn().mockResolvedValue(tools);

    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    const runner = build(3, undefined, assembleToolsForAgent);
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    // Wait for handler microtask chain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const [msg, parsedKey, passedTools, , passedAgentId] = executor.execute.mock.calls[0]!;
    expect(msg.text.startsWith("[Background Task: exec]")).toBe(true);
    expect(msg.channelType).toBe("background_task");
    expect(msg.senderId).toBe("background-task-runner");
    expect(msg.channelId).toBe("test");
    expect(msg.metadata.backgroundHopCount).toBe(1);
    expect(passedAgentId).toBe("default");
    expect(parsedKey).toBeDefined();
    expect(assembleToolsForAgent).toHaveBeenCalledWith("default", { sessionKey: parsedKey });
    expect(passedTools).toBe(tools);
    // reentered event fired exactly once with hopCount = 1.
    expect(reenteredEvents).toHaveLength(1);
    const reentered = reenteredEvents[0] as { taskId: string; hopCount: number; sessionKey: string };
    expect(reentered.taskId).toBe(task.id);
    expect(reentered.hopCount).toBe(1);
    expect(reentered.sessionKey).toBe(originSessionKey(task.origin));
    await runner.shutdown();
  });

  it("delivers the finalized re-entry response to the exact origin with its captured locale", async () => {
    const responseLocalePolicy = {
      locale: "he",
      source: "request" as const,
      enforceLocale: true,
    };
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({ responseLocalePolicy } as Partial<BackgroundTaskOrigin>),
    });
    taskManager.getTask.mockReturnValue(task);
    executor.execute.mockResolvedValue({
      response: "תוצאת הרקע הושלמה",
      executionId: "execution-1",
      finishReason: "stop",
    });
    const deliverCompletion = vi.fn().mockResolvedValue({ kind: "accepted" });
    const runner = build(3, undefined, undefined, deliverCompletion);

    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await runner.shutdown();

    expect(executor.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      "default",
      undefined,
      undefined,
      {
        operationType: "interactive",
        responseLocalePolicy,
      },
    );
    expect(deliverCompletion).toHaveBeenCalledWith({
      taskId: task.id,
      origin: task.origin,
      response: "תוצאת הרקע הושלמה",
      executionId: "execution-1",
      idempotencyKey: "background-continuation:task-1",
    });
  });

  it("continues re-entry execution and reaches later observers when the first re-entry subscriber throws", async () => {
    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    const laterObserver = vi.fn();
    eventBus.on("background_task:reentered", () => {
      throw new Error("private completion payload from subscriber");
    });
    eventBus.on("background_task:reentered", laterObserver);
    const runner = build();

    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(laterObserver).toHaveBeenCalledOnce();
    expect(executor.execute).toHaveBeenCalledOnce();
    await runner.shutdown();
  });

  it("re-entry ignores a mismatched ambient admin context and uses the persisted physical route at guest trust", async () => {
    const originTraceId = randomUUID();
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({
        agentId: "agent_a",
        sessionKey: "tenant_a:user_a:session-channel:thread:thread_a",
        channelType: "telegram",
        channelId: "chat_a",
        traceId: originTraceId,
      }),
    });
    taskManager.getTask.mockReturnValue(task);

    let reenteredContext: RequestContext | undefined;
    let executorContext: RequestContext | undefined;
    eventBus.on("background_task:reentered", () => {
      reenteredContext = getContext();
    });
    executor.execute.mockImplementation(async () => {
      await Promise.resolve();
      executorContext = getContext();
      return { ok: true };
    });

    const ambientAdmin = RequestContextSchema.parse({
      tenantId: "tenant_admin",
      userId: "admin_user",
      sessionKey: "tenant_admin:admin_user:admin-channel",
      agentId: "admin_agent",
      traceId: randomUUID(),
      startedAt: 100,
      trustLevel: "admin",
      channelType: "gateway",
      deliveryOrigin: {
        channelType: "gateway",
        channelId: "admin-channel",
        userId: "admin_user",
        tenantId: "tenant_admin",
      },
    });

    const runner = build();
    await runWithContext(ambientAdmin, async () => {
      eventBus.emit("background_task:completed", {
        agentId: task.origin.turnScope.conversation.agentId,
        taskId: task.id,
        toolName: task.toolName,
        durationMs: 1,
        origin: task.origin,
        timestamp: 3,
      });
      await runner.shutdown();
    });

    expect(reenteredContext).toBeDefined();
    expect(executorContext).toBe(reenteredContext);
    expect(executorContext).toMatchObject({
      tenantId: "tenant_a",
      userId: "user_a",
      sessionKey: originSessionKey(task.origin),
      agentId: "agent_a",
      traceId: originTraceId,
      trustLevel: "guest",
      channelType: "telegram",
      deliveryOrigin: {
        channelType: "telegram",
        channelId: "chat_a",
        userId: "user_a",
        tenantId: "tenant_a",
      },
    });
    expect(executorContext?.startedAt).not.toBe(ambientAdmin.startedAt);
    expect(Object.isFrozen(executorContext?.deliveryOrigin)).toBe(true);
    expect(Reflect.set(executorContext!, "trustLevel", "admin")).toBe(false);
    expect(Reflect.set(executorContext!, "agentId", "admin_agent")).toBe(false);
  });

  it("invalid persisted physical route is contained and falls back without executor re-entry", async () => {
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({
        sessionKey: "tenant_a:user_a:session-channel",
        channelType: "telegram",
        channelId: "",
        traceId: randomUUID(),
      }),
    });
    taskManager.getTask.mockReturnValue(task);

    const runner = build();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await runner.shutdown();

    expect(executor.execute).not.toHaveBeenCalled();
    expect(task.dispatchState).toBe("delivered");
    expect(fallbackNotifyFn).toHaveBeenCalledTimes(1);
  });

  it("restart re-entry without ambient context creates one valid guest scope for the event and executor", async () => {
    const task = buildTask({
      status: "failed",
      error: "Daemon restarted while task was running",
      result: undefined,
      origin: buildOrigin({
        agentId: "agent_restart",
        sessionKey: "tenant_restart:user_restart:session-channel",
        channelType: "telegram",
        channelId: "chat_restart",
        traceId: "not-a-valid-trace-id",
      }),
    });
    taskManager.getTask.mockReturnValue(task);

    let reenteredContext: RequestContext | undefined;
    let executorContext: RequestContext | undefined;
    eventBus.on("background_task:reentered", () => {
      reenteredContext = getContext();
    });
    executor.execute.mockImplementation(async () => {
      await Promise.resolve();
      executorContext = getContext();
      return { ok: true };
    });

    const runner = build();
    eventBus.emit("background_task:failed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      error: task.error!,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await runner.shutdown();

    expect(reenteredContext).toBeDefined();
    expect(executorContext).toBe(reenteredContext);
    expect(RequestContextSchema.safeParse(executorContext).success).toBe(true);
    expect(executorContext).toMatchObject({
      tenantId: "tenant_restart",
      userId: "user_restart",
      sessionKey: originSessionKey(task.origin),
      agentId: "agent_restart",
      trustLevel: "guest",
      channelType: "telegram",
      deliveryOrigin: {
        channelType: "telegram",
        channelId: "chat_restart",
        userId: "user_restart",
        tenantId: "tenant_restart",
      },
    });
    expect(executorContext?.traceId).not.toBe(task.origin.traceId);
    expect(Object.isFrozen(executorContext?.deliveryOrigin)).toBe(true);
  });

  it("failed event triggers executor.execute with failure header", async () => {
    const task = buildTask({ status: "failed", error: "boom", result: undefined });
    taskManager.getTask.mockReturnValue(task);
    const runner = build();
    eventBus.emit("background_task:failed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      error: "boom", durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const [msg] = executor.execute.mock.calls[0]!;
    expect(msg.text.startsWith("[Background Task Failed: exec]")).toBe(true);
    await runner.shutdown();
  });

  it("missing SQLite session still re-enters from persisted origin authority", async () => {
    const reenteredEvents: unknown[] = [];
    eventBus.on("background_task:reentered", (data) => reenteredEvents.push(data));

    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    sessionStore.loadByRef.mockReturnValue(ok(undefined)); // session gone
    const runner = build();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(reenteredEvents).toHaveLength(1);
    expect(fallbackNotifyFn).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("hop cap reached triggers fallbackNotifyFn", async () => {
    // Seed task.origin with backgroundHopCount = maxBackgroundHops - 1 so
    // the increment lands at the cap. With maxBackgroundHops = 3 and
    // incoming = 2, nextHopCount = 3 = cap -> fallback fires.
    const task = buildTask({ origin: buildOrigin({ backgroundHopCount: 2 }) });
    taskManager.getTask.mockReturnValue(task);
    const runner = build(3);
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).not.toHaveBeenCalled();
    expect(fallbackNotifyFn).toHaveBeenCalledTimes(1);
    const opts = fallbackNotifyFn.mock.calls[0]![0]!;
    expect(opts.message).toContain("recursion limit reached");
    await runner.shutdown();
  });

  it("subscription survives a handler error", async () => {
    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    executor.execute.mockRejectedValueOnce(new Error("transient")).mockResolvedValue({});
    const runner = build();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 4,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).toHaveBeenCalledTimes(2);
    await runner.shutdown();
  });

  it("shutdown stops further executor calls", async () => {
    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    const runner = build();
    await runner.shutdown();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("restart-recovery announcement uses recovery copy", async () => {
    const task = buildTask({
      status: "failed",
      error: "Daemon restarted while task was running",
      result: undefined,
    });
    taskManager.getTask.mockReturnValue(task);
    const runner = build();
    eventBus.emit("background_task:failed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      error: task.error!, durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const [msg] = executor.execute.mock.calls[0]!;
    expect(msg.text).toContain("interrupted by a daemon restart");
    await runner.shutdown();
  });

  it("getTask returning undefined (race) does not throw or fallback-spam", async () => {
    taskManager.getTask.mockReturnValue(undefined);
    const runner = build();
    eventBus.emit("background_task:completed", {
      agentId: "default", taskId: "missing", toolName: "exec",
      durationMs: 1, origin: buildOrigin(), timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).not.toHaveBeenCalled();
    expect(fallbackNotifyFn).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("fallbackForTask persists the exact outbox before firing fallback delivery", async () => {
    // Hop cap path is the simplest reach to fallbackForTask. With
    // maxBackgroundHops=3 and origin.backgroundHopCount=99, nextHopCount
    // exceeds the cap -> fallback fires.
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({ backgroundHopCount: 99 }),
    });
    taskManager.getTask.mockReturnValue(task);
    const runner = build(3);

    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(taskManager.persistContinuationOutbox).toHaveBeenCalledOnce();
    expect(fallbackNotifyFn).toHaveBeenCalledTimes(1);

    const persistOrder = taskManager.persistContinuationOutbox.mock.invocationCallOrder[0]!;
    const fireOrder = fallbackNotifyFn.mock.invocationCallOrder[0]!;
    expect(persistOrder).toBeLessThan(fireOrder);

    await runner.shutdown();
  });

  it("parks a rejected fallback delivery as uncertain and does not replay it", async () => {
    fallbackNotifyFn.mockRejectedValueOnce(new Error("simulated SIGKILL during fire"));
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({ backgroundHopCount: 99 }),
    });
    taskManager.getTask.mockReturnValue(task);
    const runner = build(3);
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(fallbackNotifyFn).toHaveBeenCalledTimes(1);
    expect(task.dispatchState).toBe("parked_uncertain");
    await runner.shutdown();

    taskManager.getTask.mockReset();
    taskManager.getTask.mockReturnValue(task);
    transitionDispatchState.mockReset();
    fallbackNotifyFn.mockReset();
    executor.execute.mockReset();
    const recoveredRunner = build(3);
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(fallbackNotifyFn).not.toHaveBeenCalled();
    expect(transitionDispatchState).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    await recoveredRunner.shutdown();
  });
});

describe("trace continuity sub-tests", () => {
  let eventBus: ReturnType<typeof createFakeEventBus>;
  let executor: { execute: ReturnType<typeof vi.fn> };
  let sessionStore: { loadByRef: ReturnType<typeof vi.fn> };
  let taskManager: {
    getTask: ReturnType<typeof vi.fn>;
    transitionDispatchState: ReturnType<typeof vi.fn>;
    persistContinuationOutbox: ReturnType<typeof vi.fn>;
    scheduleDispatchRetry: ReturnType<typeof vi.fn>;
  };
  let fallbackNotifyFn: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    eventBus = createFakeEventBus();
    executor = { execute: vi.fn().mockResolvedValue({ ok: true }) };
    sessionStore = { loadByRef: vi.fn().mockReturnValue(ok({ messages: [] })) };
    taskManager = {
      getTask: vi.fn(),
      transitionDispatchState: vi.fn().mockReturnValue(true),
      persistContinuationOutbox: vi.fn().mockReturnValue(ok(undefined)),
      scheduleDispatchRetry: vi.fn(),
    };
    fallbackNotifyFn = vi.fn().mockResolvedValue(undefined);
    logger = makeLogger();
  });

  function buildRunner(maxBackgroundHops = 3) {
    return createBackgroundCompletionRunner({
      eventBus,
      getExecutor: (_agentId: string) => executor as unknown as import("../executor/types.js").AgentExecutor,
      sessionStore,
      taskManager: taskManager as unknown as import("./background-task-manager.js").BackgroundTaskManager,
      deliverCompletion: async () => ({ kind: "accepted" }),
      deliverFallback: async ({ origin, response }) => {
        await fallbackNotifyFn({
          agentId: origin.turnScope.conversation.agentId,
          message: response,
          priority: "normal",
          origin: "background_task",
        });
        return { kind: "accepted" };
      },
      deliveryProtection: "ledger",
      maxBackgroundHops,
      logger,
    });
  }

  it("traceId from task.origin propagates into the synthetic NormalizedMessage.metadata.traceId", async () => {
    const traceId = randomUUID();
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({ traceId }),
    });
    taskManager.getTask.mockReturnValue(task);
    const runner = buildRunner();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).toHaveBeenCalled();
    const [msg] = executor.execute.mock.calls[0]!;
    expect((msg as { metadata?: { traceId?: string } }).metadata?.traceId).toBe(traceId);
    await runner.shutdown();
  });

  it("background_task:reentered event payload includes traceId from origin", async () => {
    const traceId = randomUUID();
    const reenteredEvents: Array<Record<string, unknown>> = [];
    eventBus.on("background_task:reentered", (data) => reenteredEvents.push(data as Record<string, unknown>));
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({ traceId }),
    });
    taskManager.getTask.mockReturnValue(task);
    const runner = buildRunner();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(reenteredEvents.length).toBeGreaterThanOrEqual(1);
    expect(reenteredEvents[0]!.traceId).toBe(traceId);
    await runner.shutdown();
  });

  it("operator-facing log lines on completion-runner WARN/INFO paths include traceId from origin", async () => {
    const traceId = randomUUID();
    // The persisted origin remains authoritative when the SQLite session store
    // has no row, so the invocation DEBUG line must carry the originating trace.
    sessionStore.loadByRef.mockReturnValue(ok(undefined));
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({ traceId }),
    });
    taskManager.getTask.mockReturnValue(task);
    const runner = buildRunner();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const childLogger = (logger as unknown as { child: ReturnType<typeof vi.fn> }).child.mock?.results?.[0]?.value
      ?? logger;
    const allCalls: unknown[][] = [];
    for (const fn of [childLogger.info, childLogger.warn, childLogger.debug]) {
      const mockFn = fn as ReturnType<typeof vi.fn> | undefined;
      if (mockFn?.mock?.calls) allCalls.push(...mockFn.mock.calls);
    }
    const sawTraceId = allCalls.some((args) => {
      const obj = args[0];
      return obj && typeof obj === "object" && (obj as Record<string, unknown>).traceId === traceId;
    });
    expect(sawTraceId).toBe(true);
    await runner.shutdown();
  });

  it("redacts executor rejection details from completion warning logs", async () => {
    const credential = `xoxb-${"s".repeat(32)}`;
    executor.execute.mockRejectedValueOnce(
      new Error(`request https://private.example failed with ${credential}`),
    );
    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    const runner = buildRunner();

    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const childLogger = (logger as unknown as { child: ReturnType<typeof vi.fn> }).child.mock.results[0]?.value;
    const warning = childLogger?.warn.mock.calls.find(
      (call: unknown[]) => call[1] === "Background completion: executor.execute() rejected",
    );
    expect(typeof warning?.[0].err).toBe("string");
    const calls = JSON.stringify(childLogger?.warn.mock.calls ?? []);
    expect(calls).not.toContain(credential);
    expect(calls).not.toContain("private.example");
    await runner.shutdown();
  });
});
