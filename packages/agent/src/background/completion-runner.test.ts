// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createBackgroundCompletionRunner } from "./completion-runner.js";
import type { BackgroundTask } from "./background-task-types.js";
import {
  getContext,
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

function buildOrigin(over: Partial<BackgroundTaskOrigin> = {}): BackgroundTaskOrigin {
  return {
    agentId: "default",
    sessionKey: "default:echo:test:user1",
    channelType: "echo",
    channelId: "test",
    traceId: null,
    backgroundHopCount: 0,
    ...over,
  };
}

function buildTask(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    toolName: "exec",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    origin: buildOrigin(),
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
  let sessionStore: { loadByFormattedKey: ReturnType<typeof vi.fn> };
  let taskManager: { getTask: ReturnType<typeof vi.fn>; transitionDispatchState: ReturnType<typeof vi.fn> };
  let fallbackNotifyFn: ReturnType<typeof vi.fn>;
  let transitionDispatchState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = createFakeEventBus();
    executor = { execute: vi.fn().mockResolvedValue({ ok: true }) };
    sessionStore = { loadByFormattedKey: vi.fn().mockReturnValue({ messages: [] }) };
    transitionDispatchState = vi.fn().mockReturnValue(true);
    taskManager = {
      getTask: vi.fn(),
      transitionDispatchState,
    };
    fallbackNotifyFn = vi.fn().mockResolvedValue(undefined);
  });

  function build(maxBackgroundHops = 3, isTurnInFlight?: (key: string) => boolean) {
    return createBackgroundCompletionRunner({
      eventBus,
      getExecutor: (_agentId: string) => executor as unknown as import("../executor/types.js").AgentExecutor,
      sessionStore,
      taskManager: taskManager as unknown as import("./background-task-manager.js").BackgroundTaskManager,
      fallbackNotifyFn,
      maxBackgroundHops,
      ...(isTurnInFlight ? { isTurnInFlight } : {}),
      logger: makeLogger(),
    });
  }

  it("LIVE-TURN skip: origin turn in flight → NO re-entry turn (the live turn owns consumption)", async () => {
    // Mirrors the dispatcher's suppression (live incident: an auto-backgrounded
    // MCP call completed mid-turn; the live turn consumed it via background_tasks).
    // A re-entry now would serialize a redundant continuation behind the live turn.
    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    const runner = build(3, (key) => key === task.origin.sessionKey);
    eventBus.emit("background_task:completed", {
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
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

    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    const runner = build();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    // Wait for handler microtask chain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const [msg, parsedKey, , , passedAgentId] = executor.execute.mock.calls[0]!;
    expect(msg.text.startsWith("[Background Task: exec]")).toBe(true);
    expect(msg.channelType).toBe("background_task");
    expect(msg.senderId).toBe("background-task-runner");
    expect(msg.channelId).toBe("test");
    expect(msg.metadata.backgroundHopCount).toBe(1);
    expect(passedAgentId).toBe("default");
    expect(parsedKey).toBeDefined();
    // reentered event fired exactly once with hopCount = 1.
    expect(reenteredEvents).toHaveLength(1);
    const reentered = reenteredEvents[0] as { taskId: string; hopCount: number; sessionKey: string };
    expect(reentered.taskId).toBe(task.id);
    expect(reentered.hopCount).toBe(1);
    expect(reentered.sessionKey).toBe(task.origin.sessionKey);
    await runner.shutdown();
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
      agentId: task.origin.agentId,
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
        agentId: task.origin.agentId,
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
      sessionKey: task.origin.sessionKey,
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
      agentId: task.origin.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await runner.shutdown();

    expect(executor.execute).not.toHaveBeenCalled();
    expect(transitionDispatchState).toHaveBeenCalledWith(task.id, "notified");
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
      agentId: task.origin.agentId,
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
      sessionKey: task.origin.sessionKey,
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
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
      error: "boom", durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const [msg] = executor.execute.mock.calls[0]!;
    expect(msg.text.startsWith("[Background Task Failed: exec]")).toBe(true);
    await runner.shutdown();
  });

  it("missing session skips re-entry and fallback (session expired)", async () => {
    const reenteredEvents: unknown[] = [];
    eventBus.on("background_task:reentered", (data) => reenteredEvents.push(data));

    const task = buildTask({ result: "ok" });
    taskManager.getTask.mockReturnValue(task);
    sessionStore.loadByFormattedKey.mockReturnValue(undefined); // session gone
    const runner = build();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(executor.execute).not.toHaveBeenCalled();
    // Reentered event should NOT have fired -- the runner short-circuits before emit.
    expect(reenteredEvents).toHaveLength(0);
    // No fallback either -- expired session has no channel to deliver to.
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
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
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
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    eventBus.emit("background_task:completed", {
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
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
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
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
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
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

  // -------------------------------------------------------------------------
  // Two-phase commit on fallbackForTask.
  //
  // fallbackForTask persists dispatchState="notified" via
  // taskManager.transitionDispatchState BEFORE invoking fallbackNotifyFn.
  // The persist runs synchronously (persistTaskSync) so any SIGKILL after
  // the persist returns leaves the on-disk state at "notified" -> recovery
  // sees the at-most-once gate fire -> no duplicate. Without this ordering,
  // the gate would miss and the user would see a duplicate notification.
  // -------------------------------------------------------------------------
  it("fallbackForTask persists dispatchState='notified' BEFORE firing fallbackNotifyFn (two-phase commit)", async () => {
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
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Both must have been called once.
    expect(transitionDispatchState).toHaveBeenCalledTimes(1);
    expect(transitionDispatchState).toHaveBeenCalledWith(task.id, "notified");
    expect(fallbackNotifyFn).toHaveBeenCalledTimes(1);

    // Critical ordering assertion: invocationCallOrder is a global counter
    // across all vitest mocks; smaller = earlier. transitionDispatchState's
    // call MUST precede fallbackNotifyFn's.
    const persistOrder = transitionDispatchState.mock.invocationCallOrder[0]!;
    const fireOrder = fallbackNotifyFn.mock.invocationCallOrder[0]!;
    expect(persistOrder).toBeLessThan(fireOrder);

    await runner.shutdown();
  });

  it("SIGKILL between persist and fire — recovery's at-most-once gate fires (no duplicate)", async () => {
    // Simulate the crash: transitionDispatchState succeeds (state lands on
    // disk via persistTaskSync), then fallbackNotifyFn rejects (modeling
    // \"daemon dies during the network call\"). The runner WARNs but does
    // not retry. A FRESH runner instance receiving the same task with
    // dispatchState=\"notified\" (the persisted state) MUST skip via the
    // at-most-once gate at completion-runner.ts handleEvent's early-return
    // when task.dispatchState === \"notified\".
    fallbackNotifyFn.mockRejectedValueOnce(new Error("simulated SIGKILL during fire"));
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({ backgroundHopCount: 99 }),
    });
    taskManager.getTask.mockReturnValue(task);
    // Mirror what the real BackgroundTaskManager.transitionDispatchState
    // does: mutate the in-memory task object BEFORE persistTaskSync. This
    // mirrors the on-disk state for the subsequent recovery-instance
    // assertion below.
    transitionDispatchState.mockImplementation((tid: string, next: string) => {
      if (tid === task.id) (task as unknown as { dispatchState: string }).dispatchState = next;
      return true;
    });

    const runner = build(3);
    eventBus.emit("background_task:completed", {
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Persist step ran.
    expect(transitionDispatchState).toHaveBeenCalledTimes(1);
    // Fire step was attempted and rejected.
    expect(fallbackNotifyFn).toHaveBeenCalledTimes(1);
    // task.dispatchState is now "notified" on the in-memory task object,
    // mirroring the on-disk state that recovery would load.
    expect((task as unknown as { dispatchState: string }).dispatchState).toBe("notified");
    await runner.shutdown();

    // Now simulate "daemon recovers" — fresh runner instance, same task
    // object (dispatchState="notified" already set above).
    taskManager.getTask.mockReset();
    taskManager.getTask.mockReturnValue(task);
    transitionDispatchState.mockReset();
    fallbackNotifyFn.mockReset();
    executor.execute.mockReset();
    const recoveredRunner = build(3);
    eventBus.emit("background_task:completed", {
      agentId: task.origin.agentId, taskId: task.id, toolName: task.toolName,
      durationMs: 1, origin: task.origin, timestamp: 3,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // At-most-once gate (handleEvent: if task.dispatchState === "notified") returns
    // immediately -> nothing fires.
    expect(fallbackNotifyFn).not.toHaveBeenCalled();
    expect(transitionDispatchState).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    await recoveredRunner.shutdown();
  });
});

describe("trace continuity sub-tests", () => {
  let eventBus: ReturnType<typeof createFakeEventBus>;
  let executor: { execute: ReturnType<typeof vi.fn> };
  let sessionStore: { loadByFormattedKey: ReturnType<typeof vi.fn> };
  let taskManager: { getTask: ReturnType<typeof vi.fn>; transitionDispatchState: ReturnType<typeof vi.fn> };
  let fallbackNotifyFn: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    eventBus = createFakeEventBus();
    executor = { execute: vi.fn().mockResolvedValue({ ok: true }) };
    sessionStore = { loadByFormattedKey: vi.fn().mockReturnValue({ messages: [] }) };
    taskManager = {
      getTask: vi.fn(),
      transitionDispatchState: vi.fn().mockReturnValue(true),
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
      fallbackNotifyFn,
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
      agentId: task.origin.agentId,
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
      agentId: task.origin.agentId,
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
    const traceId = "trace-29c";
    // Force a path that emits an INFO log: session expired (sessionStore returns undefined).
    sessionStore.loadByFormattedKey.mockReturnValue(undefined);
    const task = buildTask({
      result: "ok",
      origin: buildOrigin({ traceId }),
    });
    taskManager.getTask.mockReturnValue(task);
    const runner = buildRunner();
    eventBus.emit("background_task:completed", {
      agentId: task.origin.agentId,
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
      agentId: task.origin.agentId,
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
