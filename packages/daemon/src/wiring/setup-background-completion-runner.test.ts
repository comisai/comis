// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { setupBackgroundCompletionRunner } from "./setup-background-completion-runner.js";

function makeFakeEventBus() {
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
    emit(_event: string, _data: unknown) {},
  } as unknown as import("@comis/core").TypedEventBus;
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

describe("setupBackgroundCompletionRunner", () => {
  it("Test 1: returns a context object with a runner.shutdown function", async () => {
    const ctx = setupBackgroundCompletionRunner({
      eventBus: makeFakeEventBus(),
      executor: { execute: vi.fn() } as unknown as import("@comis/agent").AgentExecutor,
      sessionStore: { loadByFormattedKey: vi.fn() },
      taskManager: { getTask: vi.fn() } as unknown as import("@comis/agent").BackgroundTaskManager,
      fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
      maxBackgroundHops: 3,
      logger: makeLogger(),
    });
    expect(ctx).toBeDefined();
    expect(ctx.runner).toBeDefined();
    expect(typeof ctx.runner.shutdown).toBe("function");
  });

  it("Test 2: shutdown() resolves cleanly", async () => {
    const ctx = setupBackgroundCompletionRunner({
      eventBus: makeFakeEventBus(),
      executor: { execute: vi.fn() } as unknown as import("@comis/agent").AgentExecutor,
      sessionStore: { loadByFormattedKey: vi.fn() },
      taskManager: { getTask: vi.fn() } as unknown as import("@comis/agent").BackgroundTaskManager,
      fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
      maxBackgroundHops: 3,
      logger: makeLogger(),
    });
    await expect(ctx.runner.shutdown()).resolves.toBeUndefined();
  });

  it("Test 3: shutdown() is idempotent", async () => {
    const ctx = setupBackgroundCompletionRunner({
      eventBus: makeFakeEventBus(),
      executor: { execute: vi.fn() } as unknown as import("@comis/agent").AgentExecutor,
      sessionStore: { loadByFormattedKey: vi.fn() },
      taskManager: { getTask: vi.fn() } as unknown as import("@comis/agent").BackgroundTaskManager,
      fallbackNotifyFn: vi.fn().mockResolvedValue(undefined),
      maxBackgroundHops: 3,
      logger: makeLogger(),
    });
    await ctx.runner.shutdown();
    await expect(ctx.runner.shutdown()).resolves.toBeUndefined();
  });
});
