import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { wrapToolForAutoBackground, type ToolDefinition } from "./auto-background-middleware.js";
import { createBackgroundTaskManager, type BackgroundTaskManager } from "./background-task-manager.js";
import type { BackgroundTasksConfig } from "@comis/core";

function createMockEventBus() {
  return { emit: vi.fn() } as unknown as import("@comis/core").TypedEventBus;
}

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function createMockTool(opts: {
  name?: string;
  resolveAfterMs?: number;
  rejectAfterMs?: number;
  result?: unknown;
  error?: Error;
}): ToolDefinition {
  const { name = "test_tool", resolveAfterMs = 0, rejectAfterMs, result = "tool-result", error } = opts;
  return {
    name,
    description: "test tool",
    parameters: {},
    execute: vi.fn((_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      if (rejectAfterMs !== undefined) {
        return new Promise((_, reject) =>
          setTimeout(() => reject(error ?? new Error("tool failed")), rejectAfterMs),
        );
      }
      return new Promise((resolve) =>
        setTimeout(() => resolve(result), resolveAfterMs),
      );
    }),
  };
}

describe("wrapToolForAutoBackground", () => {
  let dataDir: string;
  let manager: BackgroundTaskManager;
  let config: BackgroundTasksConfig;
  let notifyFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dataDir = join(tmpdir(), `comis-bg-mw-test-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    manager = createBackgroundTaskManager({
      dataDir,
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      maxPerAgent: 5,
      maxTotal: 20,
      maxBackgroundDurationMs: 60_000,
    });
    config = {
      enabled: true,
      autoBackgroundMs: 50, // 50ms timeout for tests
      maxPerAgent: 5,
      maxTotal: 20,
      maxBackgroundDurationMs: 60_000,
      excludeTools: [],
    };
    notifyFn = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const task of manager.getAllTasks()) {
      if (task._hardTimeoutTimer) clearTimeout(task._hardTimeoutTimer);
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns result directly when tool completes before timeout", async () => {
    const tool = createMockTool({ resolveAfterMs: 5, result: "fast-result" });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, "agent-1");

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
    expect(result).toBe("fast-result");
    expect(manager.getAllTasks()).toHaveLength(0);
  });

  it("returns backgrounded placeholder when tool exceeds timeout", async () => {
    const tool = createMockTool({ resolveAfterMs: 200, result: "slow-result" });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, "agent-1");

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe("backgrounded");
    expect(parsed.taskId).toBeDefined();
    expect(parsed.toolName).toBe("test_tool");

    // Task is tracked
    const tasks = manager.getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("running");
  });

  it("completes the background task when the tool eventually resolves", async () => {
    const tool = createMockTool({ resolveAfterMs: 100, result: "slow-result" });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, "agent-1");

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
    const parsed = JSON.parse(result as string);

    // Wait for the tool to actually complete
    await new Promise((r) => setTimeout(r, 150));

    const task = manager.getTask(parsed.taskId);
    expect(task!.status).toBe("completed");
    expect(task!.result).toContain("slow-result");
  });

  it("excluded tools are not wrapped", () => {
    config.excludeTools = ["excluded_tool"];
    const tool = createMockTool({ name: "excluded_tool" });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, "agent-1");

    // Should be the exact same object (not wrapped)
    expect(wrapped).toBe(tool);
  });

  it("links parent AbortSignal to child AbortController", async () => {
    const parentAc = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const tool: ToolDefinition = {
      name: "signal_tool",
      description: "test",
      parameters: {},
      execute: vi.fn((_tcId, _params, signal) => {
        receivedSignal = signal;
        return new Promise((resolve) => setTimeout(() => resolve("ok"), 5));
      }),
    };

    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, "agent-1");
    await wrapped.execute("call-1", {}, parentAc.signal, undefined, undefined);

    expect(receivedSignal).toBeDefined();
    // The child signal is not the parent signal (it's a new AbortController)
    expect(receivedSignal).not.toBe(parentAc.signal);

    // Abort the parent should propagate to child
    parentAc.abort();
    expect(receivedSignal!.aborted).toBe(true);
  });

  it("survives in-place tool.execute mutation without infinite recursion", async () => {
    const tool = createMockTool({ resolveAfterMs: 5, result: "ok" });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, "agent-1");

    // Simulate pi-executor in-place mutation (line 1172)
    tool.execute = wrapped.execute;

    // This would stack overflow without the origExecute fix
    const result = await tool.execute("call-1", {}, undefined, undefined, undefined);
    expect(result).toBe("ok");
  });

  it("backgrounds correctly after in-place mutation", async () => {
    const tool = createMockTool({ resolveAfterMs: 200, result: "slow" });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, "agent-1");

    // Simulate pi-executor in-place mutation
    tool.execute = wrapped.execute;

    const result = await tool.execute("call-1", {}, undefined, undefined, undefined);
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe("backgrounded");
  });

  it("falls back to foreground when concurrency limit exceeded", async () => {
    // Create a manager with very low limits
    const limitedManager = createBackgroundTaskManager({
      dataDir,
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      maxPerAgent: 1,
      maxTotal: 1,
      maxBackgroundDurationMs: 60_000,
    });

    // Fill up the limit
    limitedManager.promote("agent-1", "t1", new Promise(() => {}), new AbortController());

    const tool = createMockTool({ resolveAfterMs: 100, result: "foreground-result" });
    const wrapped = wrapToolForAutoBackground(tool, limitedManager, config, notifyFn, "agent-1");

    // Should await normally since promotion will fail
    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
    expect(result).toBe("foreground-result");

    // Clean up the stuck task
    for (const task of limitedManager.getAllTasks()) {
      if (task._hardTimeoutTimer) clearTimeout(task._hardTimeoutTimer);
    }
  });
});
