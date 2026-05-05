// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createBackgroundCompletionRunner } from "./completion-runner.js";
import type { BackgroundTask } from "./background-task-types.js";
import type { BackgroundTaskOrigin } from "@comis/core";

// Build a real-ish event bus so on()/off()/emit() work end-to-end. We
// mock the executor, sessionStore, taskManager.getTask, fallbackNotifyFn,
// and logger.
function createFakeEventBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event: string, handler: (data: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return this;
    },
    off(event: string, handler: (data: unknown) => void) {
      handlers.get(event)?.delete(handler);
      return this;
    },
    emit(event: string, data: unknown) {
      for (const h of handlers.get(event) ?? []) h(data);
    },
  } as unknown as import("@comis/core").TypedEventBus;
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
  } as unknown as import("@comis/infra").ComisLogger;
}

describe("createBackgroundCompletionRunner", () => {
  let eventBus: ReturnType<typeof createFakeEventBus>;
  let executor: { execute: ReturnType<typeof vi.fn> };
  let sessionStore: { loadByFormattedKey: ReturnType<typeof vi.fn> };
  let taskManager: { getTask: ReturnType<typeof vi.fn> };
  let fallbackNotifyFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = createFakeEventBus();
    executor = { execute: vi.fn().mockResolvedValue({ ok: true }) };
    sessionStore = { loadByFormattedKey: vi.fn().mockReturnValue({ messages: [] }) };
    taskManager = { getTask: vi.fn() };
    fallbackNotifyFn = vi.fn().mockResolvedValue(undefined);
  });

  function build(maxBackgroundHops = 3) {
    return createBackgroundCompletionRunner({
      eventBus,
      getExecutor: (_agentId: string) => executor as unknown as import("../executor/types.js").AgentExecutor,
      sessionStore,
      taskManager: taskManager as unknown as import("./background-task-manager.js").BackgroundTaskManager,
      fallbackNotifyFn,
      maxBackgroundHops,
      logger: makeLogger(),
    });
  }

  it("Test 1: completed event triggers executor.execute with synthetic message AND emits background_task:reentered", async () => {
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

  it("Test 2: failed event triggers executor.execute with failure header", async () => {
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

  it("Test 3: missing session skips re-entry and fallback (session expired)", async () => {
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

  it("Test 4: hop cap reached triggers fallbackNotifyFn", async () => {
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

  it("Test 5: subscription survives a handler error", async () => {
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

  it("Test 6: shutdown stops further executor calls", async () => {
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

  it("Test 7: restart-recovery announcement uses recovery copy", async () => {
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

  it("Test 8: getTask returning undefined (race) does not throw or fallback-spam", async () => {
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
});
