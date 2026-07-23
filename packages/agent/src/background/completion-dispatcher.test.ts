// SPDX-License-Identifier: Apache-2.0
//
// Completion dispatcher routes notify calls through state-machine
// transitions and respects at-most-once.
//
// The dispatcher lives in `packages/agent/src/background/completion-dispatcher.ts`,
// subscribes to `background_task:completed`, and inspects
// `task.dispatchState` before firing the notify fallback.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ok } from "@comis/shared";
import type { BackgroundTask } from "./background-task-types.js";
import { conversationScopeToSessionKey, createConversationRef, formatSessionKey, TypedEventBus, type BackgroundTaskOrigin } from "@comis/core";

function createFakeEventBus() {
  return new TypedEventBus();
}

function buildOrigin(over: Partial<BackgroundTaskOrigin> & { agentId?: string; sessionKey?: string } = {}): BackgroundTaskOrigin {
  const agentId = over.agentId ?? "default";
  const tenantId = over.sessionKey?.split(":")[0] ?? "default";
  const endpoint = { channelType: "echo", channelInstanceId: "test-instance", conversationId: "test", conversationKind: "direct" as const };
  const turnScope = {
    conversation: { tenantId, agentId, partition: { kind: "endpoint-conversation-principal" as const, endpoint, principalId: "user1" } },
    principal: { principalId: "user1" }, endpoint,
  };
  const conversationRef = createConversationRef(turnScope.conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    turnScope,
    conversationRef: conversationRef.value,
    deliveryOrigin: { channelType: "echo", channelId: "test", userId: "user1", tenantId },
    traceId: null,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
    ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== "agentId" && key !== "sessionKey")),
  };
}

function originSessionKey(origin: BackgroundTaskOrigin): string {
  const projected = conversationScopeToSessionKey(origin.turnScope.conversation);
  if (!projected.ok) throw projected.error;
  return formatSessionKey(projected.value);
}

function buildTask(over: Partial<BackgroundTask> & { dispatchState?: string } = {}): BackgroundTask & { dispatchState?: string } {
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
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import("@comis/core").ComisLogger;
}

// Dynamic loader for the dispatcher factory. If the import returns
// undefined the asserting test fails meaningfully.
async function loadDispatcher(): Promise<
  | {
      createCompletionDispatcher: (deps: {
        eventBus: import("@comis/core").TypedEventBus;
        taskManager: { getTask: (id: string) => unknown };
        fallbackNotifyFn: (...args: unknown[]) => void | Promise<unknown>;
        logger: import("@comis/core").ComisLogger;
      }) => { shutdown: () => Promise<void> };
    }
  | undefined
> {
  try {
    const mod = (await import("./completion-dispatcher.js")) as Record<string, unknown>;
    if (typeof mod.createCompletionDispatcher !== "function") return undefined;
    return mod as unknown as {
      createCompletionDispatcher: (deps: {
        eventBus: import("@comis/core").TypedEventBus;
        taskManager: { getTask: (id: string) => unknown };
        fallbackNotifyFn: (...args: unknown[]) => void | Promise<unknown>;
        logger: import("@comis/core").ComisLogger;
      }) => { shutdown: () => Promise<void> };
    };
  } catch {
    return undefined;
  }
}

describe("createCompletionDispatcher: at-most-once routing via dispatchState", () => {
  let eventBus: ReturnType<typeof createFakeEventBus>;
  let taskManager: { getTask: ReturnType<typeof vi.fn> };
  let fallbackNotifyFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = createFakeEventBus();
    taskManager = { getTask: vi.fn() };
    fallbackNotifyFn = vi.fn().mockResolvedValue(undefined);
  });

  it("pending → dispatched transition does NOT call fallbackNotifyFn (single-owner reentry)", async () => {
    const mod = await loadDispatcher();
    expect(mod).toBeDefined();
    if (!mod) return;

    const task = buildTask({ dispatchState: "pending" });
    taskManager.getTask.mockReturnValue(task);
    const dispatcher = mod.createCompletionDispatcher({
      eventBus,
      taskManager,
      fallbackNotifyFn,
      logger: makeLogger(),
    });

    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    // Wait for handler microtask chain.
    await new Promise((r) => setTimeout(r, 5));

    // Pending → dispatched: completion-runner reentry handles it. The
    // dispatcher MUST NOT call the fallbackNotifyFn fallback (zero spurious
    // notifications).
    expect(fallbackNotifyFn).not.toHaveBeenCalled();
    await dispatcher.shutdown();
  });

  it("already-notified state does NOT call fallbackNotifyFn again (at-most-once)", async () => {
    const mod = await loadDispatcher();
    expect(mod).toBeDefined();
    if (!mod) return;

    const task = buildTask({ dispatchState: "notified" });
    taskManager.getTask.mockReturnValue(task);
    const dispatcher = mod.createCompletionDispatcher({
      eventBus,
      taskManager,
      fallbackNotifyFn,
      logger: makeLogger(),
    });

    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((r) => setTimeout(r, 5));

    // Already notified — the dispatcher MUST NOT double-notify.
    expect(fallbackNotifyFn).not.toHaveBeenCalled();
    await dispatcher.shutdown();
  });

  it("LIVE-TURN suppression: origin turn in flight → NO raw notice, state → dispatched (live-incident regression)", async () => {
    // Live incident: an auto-backgrounded MCP call completed ~1s after promotion
    // while its ORIGIN TURN was still executing (consuming the result via the
    // background_tasks stub protocol). The dispatcher consulted the persistent
    // session store — near-EMPTY in DAG mode — concluded "no active session",
    // and sent the user a raw 'Background task "…" completed.' message; the real
    // answer then arrived from the live turn. With `isTurnInFlight` wired, an
    // in-flight origin turn suppresses the notice (the live turn owns consumption).
    const mod = await loadDispatcher();
    expect(mod).toBeDefined();
    if (!mod) return;

    const task = buildTask({ dispatchState: "pending" });
    taskManager.getTask.mockReturnValue(task);
    const transitionDispatchState = vi.fn();
    const dispatcher = (mod.createCompletionDispatcher as unknown as (deps: Record<string, unknown>) => { shutdown(): Promise<void> })({
      eventBus,
      taskManager: { getTask: taskManager.getTask, transitionDispatchState },
      fallbackNotifyFn,
      logger: makeLogger(),
      // The DAG-mode live-incident shape: the persistent store misses the LIVE session…
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      // …but the origin turn is demonstrably in flight.
      isTurnInFlight: vi.fn((key: string) => key === originSessionKey(task.origin)),
    });

    // OBSERVABILITY: the suppression must be visible from the trajectory in one
    // `comis explain` call (previously wire-grep-only) — a content-free
    // background_task:notified event, notified:false + reason:live_turn_suppressed.
    const notifiedEvents: Array<Record<string, unknown>> = [];
    eventBus.on("background_task:notified", (d) => notifiedEvents.push(d as Record<string, unknown>));

    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(fallbackNotifyFn).not.toHaveBeenCalled(); // NO raw notice mid-conversation
    expect(transitionDispatchState).toHaveBeenCalledWith(task.id, "dispatched");
    expect(notifiedEvents).toHaveLength(1);
    expect(notifiedEvents[0]).toMatchObject({
      taskId: task.id,
      toolName: task.toolName,
      sessionKey: originSessionKey(task.origin),
      notified: false,
      reason: "live_turn_suppressed",
    });
    await dispatcher.shutdown();
  });

  it("origin turn finished + SQLite session missing → dispatches persisted JSONL conversation for re-entry", async () => {
    const mod = await loadDispatcher();
    expect(mod).toBeDefined();
    if (!mod) return;

    const task = buildTask({ dispatchState: "pending" });
    taskManager.getTask.mockReturnValue(task);
    const transitionDispatchState = vi.fn();
    const dispatcher = (mod.createCompletionDispatcher as unknown as (deps: Record<string, unknown>) => { shutdown(): Promise<void> })({
      eventBus,
      taskManager: { getTask: taskManager.getTask, transitionDispatchState },
      fallbackNotifyFn,
      logger: makeLogger(),
      sessionStore: { loadByRef: vi.fn(() => ok(undefined)) },
      isTurnInFlight: vi.fn(() => false),
    });
    const notifiedEvents: Array<Record<string, unknown>> = [];
    eventBus.on("background_task:notified", (d) => notifiedEvents.push(d as Record<string, unknown>));

    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(fallbackNotifyFn).not.toHaveBeenCalled();
    expect(transitionDispatchState).toHaveBeenCalledWith(task.id, "dispatched");
    expect(notifiedEvents).toHaveLength(0);
    await dispatcher.shutdown();
  });

  it("preserves fallback dispatch and later notified observers after sync and async subscriber failures", async () => {
    const mod = await loadDispatcher();
    expect(mod).toBeDefined();
    if (!mod) return;
    const task = buildTask({ dispatchState: "pending" });
    taskManager.getTask.mockReturnValue(task);
    const logger = makeLogger();
    const laterObserver = vi.fn();
    eventBus.on("background_task:notified", () => {
      throw new Error("private sync notified content");
    });
    eventBus.on("background_task:notified", async () => {
      throw new Error("private async notified content");
    });
    eventBus.on("background_task:notified", laterObserver);
    const dispatcher = mod.createCompletionDispatcher({
      eventBus,
      taskManager,
      fallbackNotifyFn,
      sessionStore: { loadByRef: () => ok(undefined) },
      maxBackgroundHops: 1,
      logger,
    });

    eventBus.emit("background_task:completed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(task.dispatchState).toBe("notified");
    expect(fallbackNotifyFn).toHaveBeenCalledOnce();
    expect(laterObserver).toHaveBeenCalledOnce();
    await dispatcher.shutdown();
  });

  it("labels failed tasks as failed when the hop cap requires fallback delivery", async () => {
    const mod = await loadDispatcher();
    expect(mod).toBeDefined();
    if (!mod) return;
    const task = buildTask({ dispatchState: "pending", status: "failed", error: "upstream timeout" });
    taskManager.getTask.mockReturnValue(task);
    const dispatcher = mod.createCompletionDispatcher({
      eventBus,
      taskManager,
      fallbackNotifyFn,
      maxBackgroundHops: 1,
      logger: makeLogger(),
    });

    eventBus.emit("background_task:failed", {
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      error: task.error ?? "",
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fallbackNotifyFn).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining(`Background task "${task.toolName}" failed`),
    }));
    await dispatcher.shutdown();
  });
});
