// SPDX-License-Identifier: Apache-2.0
//
// Completion dispatcher routes notify calls through state-machine
// transitions and respects at-most-once.
//
// The dispatcher lives in `packages/agent/src/background/completion-dispatcher.ts`,
// subscribes to `background_task:completed`, and inspects
// `task.dispatchState` before firing the notify fallback.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BackgroundTask } from "./background-task-types.js";
import type { BackgroundTaskOrigin } from "@comis/core";

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
  } as unknown as import("@comis/infra").ComisLogger;
}

// Dynamic loader for the dispatcher factory. If the import returns
// undefined the asserting test fails meaningfully.
async function loadDispatcher(): Promise<
  | {
      createCompletionDispatcher: (deps: {
        eventBus: import("@comis/core").TypedEventBus;
        taskManager: { getTask: (id: string) => unknown };
        notifyFn: (...args: unknown[]) => void | Promise<unknown>;
        logger: import("@comis/infra").ComisLogger;
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
        notifyFn: (...args: unknown[]) => void | Promise<unknown>;
        logger: import("@comis/infra").ComisLogger;
      }) => { shutdown: () => Promise<void> };
    };
  } catch {
    return undefined;
  }
}

describe("createCompletionDispatcher: at-most-once routing via dispatchState", () => {
  let eventBus: ReturnType<typeof createFakeEventBus>;
  let taskManager: { getTask: ReturnType<typeof vi.fn> };
  let notifyFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventBus = createFakeEventBus();
    taskManager = { getTask: vi.fn() };
    notifyFn = vi.fn().mockResolvedValue(undefined);
  });

  it("pending → dispatched transition does NOT call notifyFn (single-owner reentry)", async () => {
    const mod = await loadDispatcher();
    expect(mod).toBeDefined();
    if (!mod) return;

    const task = buildTask({ dispatchState: "pending" });
    taskManager.getTask.mockReturnValue(task);
    const dispatcher = mod.createCompletionDispatcher({
      eventBus,
      taskManager,
      notifyFn,
      logger: makeLogger(),
    });

    eventBus.emit("background_task:completed", {
      agentId: task.origin.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    // Wait for handler microtask chain.
    await new Promise((r) => setTimeout(r, 5));

    // Pending → dispatched: completion-runner reentry handles it. The
    // dispatcher MUST NOT call the notifyFn fallback (zero spurious
    // notifications).
    expect(notifyFn).not.toHaveBeenCalled();
    await dispatcher.shutdown();
  });

  it("already-notified state does NOT call notifyFn again (at-most-once)", async () => {
    const mod = await loadDispatcher();
    expect(mod).toBeDefined();
    if (!mod) return;

    const task = buildTask({ dispatchState: "notified" });
    taskManager.getTask.mockReturnValue(task);
    const dispatcher = mod.createCompletionDispatcher({
      eventBus,
      taskManager,
      notifyFn,
      logger: makeLogger(),
    });

    eventBus.emit("background_task:completed", {
      agentId: task.origin.agentId,
      taskId: task.id,
      toolName: task.toolName,
      durationMs: 1,
      origin: task.origin,
      timestamp: 3,
    });
    await new Promise((r) => setTimeout(r, 5));

    // Already notified — the dispatcher MUST NOT double-notify.
    expect(notifyFn).not.toHaveBeenCalled();
    await dispatcher.shutdown();
  });
});
