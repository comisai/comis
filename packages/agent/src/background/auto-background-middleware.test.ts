// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { safePath } from "@comis/core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { wrapToolForAutoBackground, type ToolDefinition } from "./auto-background-middleware.js";
import { createBackgroundTaskManager, type BackgroundTaskManager } from "./background-task-manager.js";
import type { BackgroundTasksConfig } from "@comis/core";
import type { BackgroundTaskOrigin } from "./background-task-types.js";

function createMockEventBus() {
  return { emit: vi.fn() } as unknown as import("@comis/core").TypedEventBus;
}

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

/** Helper: build a minimal well-formed AgentToolResult for test fixtures. */
function toolOk(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function buildOrigin(overrides: Partial<BackgroundTaskOrigin> = {}): BackgroundTaskOrigin {
  return {
    agentId: "default",
    sessionKey: "default:echo:test:user1",
    channelType: "echo",
    channelId: "test",
    traceId: null,
    backgroundHopCount: 0,
    ...overrides,
  };
}

function createMockTool(opts: {
  name?: string;
  resolveAfterMs?: number;
  rejectAfterMs?: number;
  result?: AgentToolResult<unknown>;
  error?: Error;
}): ToolDefinition {
  const {
    name = "test_tool",
    resolveAfterMs = 0,
    rejectAfterMs,
    result = toolOk("tool-result"),
    error,
  } = opts;
  return {
    name,
    description: "test tool",
    parameters: {},
    execute: vi.fn((_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      if (rejectAfterMs !== undefined) {
        return new Promise<AgentToolResult<unknown>>((_, reject) =>
          setTimeout(() => reject(error ?? new Error("tool failed")), rejectAfterMs),
        );
      }
      return new Promise<AgentToolResult<unknown>>((resolve) =>
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
    dataDir = safePath(tmpdir(), `comis-bg-mw-test-${randomUUID()}`);
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
    const tool = createMockTool({ resolveAfterMs: 5, result: toolOk("fast-result") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, () => buildOrigin({ agentId: "agent-1" }));

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
    expect(result).toEqual(toolOk("fast-result"));
    expect(manager.getAllTasks()).toHaveLength(0);
  });

  it("returns a well-formed AgentToolResult placeholder when tool exceeds timeout", async () => {
    const tool = createMockTool({ resolveAfterMs: 200, result: toolOk("slow-result") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, () => buildOrigin({ agentId: "agent-1" }));

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);

    // Invariant: the wrapper MUST return AgentToolResult shape so the SDK's
    // emitToolCallOutcome produces a non-empty toolResult message. Returning
    // a raw string collapses to content:undefined -> silent LLM failure.
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    const firstBlock = result.content[0]!;
    expect(firstBlock.type).toBe("text");
    expect((firstBlock as { text: string }).text).toContain("moved to the background");

    const details = result.details as {
      status: string;
      taskId: string;
      toolName: string;
    };
    expect(details.status).toBe("backgrounded");
    expect(details.taskId).toBeDefined();
    expect(details.toolName).toBe("test_tool");

    // Task is tracked
    const tasks = manager.getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("running");
  });

  it("completes the background task when the tool eventually resolves", async () => {
    const tool = createMockTool({ resolveAfterMs: 100, result: toolOk("slow-result") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, () => buildOrigin({ agentId: "agent-1" }));

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
    const details = result.details as { taskId: string };

    // Wait for the tool to actually complete
    await new Promise((r) => setTimeout(r, 150));

    const task = manager.getTask(details.taskId);
    expect(task!.status).toBe("completed");
    expect(task!.result).toContain("slow-result");
  });

  it("excluded tools are not wrapped", () => {
    config.excludeTools = ["excluded_tool"];
    const tool = createMockTool({ name: "excluded_tool" });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, () => buildOrigin({ agentId: "agent-1" }));

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
        return new Promise<AgentToolResult<unknown>>((resolve) =>
          setTimeout(() => resolve(toolOk("ok")), 5),
        );
      }),
    };

    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, () => buildOrigin({ agentId: "agent-1" }));
    await wrapped.execute("call-1", {}, parentAc.signal, undefined, undefined);

    expect(receivedSignal).toBeDefined();
    // The child signal is not the parent signal (it's a new AbortController)
    expect(receivedSignal).not.toBe(parentAc.signal);

    // Abort the parent should propagate to child
    parentAc.abort();
    expect(receivedSignal!.aborted).toBe(true);
  });

  it("survives in-place tool.execute mutation without infinite recursion", async () => {
    const tool = createMockTool({ resolveAfterMs: 5, result: toolOk("ok") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, () => buildOrigin({ agentId: "agent-1" }));

    // Simulate pi-executor in-place mutation (line 1172)
    tool.execute = wrapped.execute;

    // This would stack overflow without the origExecute fix
    const result = await tool.execute("call-1", {}, undefined, undefined, undefined);
    expect(result).toEqual(toolOk("ok"));
  });

  it("backgrounds correctly after in-place mutation", async () => {
    const tool = createMockTool({ resolveAfterMs: 200, result: toolOk("slow") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, () => buildOrigin({ agentId: "agent-1" }));

    // Simulate pi-executor in-place mutation
    tool.execute = wrapped.execute;

    const result = await tool.execute("call-1", {}, undefined, undefined, undefined);
    const details = result.details as { status: string };
    expect(details.status).toBe("backgrounded");
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
    limitedManager.promote("t1", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));

    const tool = createMockTool({ resolveAfterMs: 100, result: toolOk("foreground-result") });
    const wrapped = wrapToolForAutoBackground(tool, limitedManager, config, notifyFn, () => buildOrigin({ agentId: "agent-1" }));

    // Should await normally since promotion will fail
    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
    expect(result).toEqual(toolOk("foreground-result"));

    // Clean up the stuck task
    for (const task of limitedManager.getAllTasks()) {
      if (task._hardTimeoutTimer) clearTimeout(task._hardTimeoutTimer);
    }
  });

  // Regression: the original bug returned a JSON string here, which the SDK
  // then processed as AgentToolResult (string.content === undefined) and
  // produced an empty toolResult message on the wire, triggering the silent
  // LLM failure cascade that ended the user's xlsx skill install with a
  // generic "An error occurred while processing your request" Telegram reply.
  it("promoted tool result never collapses to empty content (regression)", async () => {
    const tool = createMockTool({ resolveAfterMs: 200, result: toolOk("slow-result") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, () => buildOrigin({ agentId: "agent-1" }));

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);

    expect(result).toBeTypeOf("object");
    expect(result).not.toBeNull();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0);
    expect(result.details).toBeDefined();
  });

  describe("Phase 14: originResolver threading (D-02 / SPEC AC-12)", () => {
    it("Test 4: originResolver is called before manager.promote()", async () => {
      const originResolver = vi.fn().mockReturnValue(buildOrigin({ agentId: "resolver-agent" }));
      const tool = createMockTool({ resolveAfterMs: 200 });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, originResolver);

      await wrapped.execute("call-1", {}, undefined, undefined, undefined);

      expect(originResolver).toHaveBeenCalled();
    });

    it("Test 5: when originResolver returns undefined, falls through to foreground (no promote)", async () => {
      const originResolver = vi.fn().mockReturnValue(undefined);
      const promoteSpy = vi.spyOn(manager, "promote");
      const tool = createMockTool({ resolveAfterMs: 200, result: toolOk("foreground-result") });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, originResolver);

      const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);

      expect(promoteSpy).not.toHaveBeenCalled();
      expect((result.content[0] as { text: string }).text).toBe("foreground-result");
    });

    it("Test 6: when originResolver returns valid origin, promote is called with (tool.name, taskPromise, ac, origin)", async () => {
      const expectedOrigin = buildOrigin({ agentId: "origin-agent" });
      const originResolver = vi.fn().mockReturnValue(expectedOrigin);
      const promoteSpy = vi.spyOn(manager, "promote");
      const tool = createMockTool({ resolveAfterMs: 200, name: "bg_tool" });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, originResolver);

      await wrapped.execute("call-1", {}, undefined, undefined, undefined);

      expect(promoteSpy).toHaveBeenCalledWith(
        "bg_tool",
        expect.any(Promise),
        expect.any(AbortController),
        expectedOrigin,
      );
    });

    it("Test 7: placeholder text contains \"I'll continue when it completes.\" and not \"user will be notified\"", async () => {
      const tool = createMockTool({ resolveAfterMs: 200 });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, notifyFn, () => buildOrigin({ agentId: "agent-7" }));

      const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("I'll continue when it completes.");
      expect(text).not.toContain("user will be notified");
    });
  });
});
