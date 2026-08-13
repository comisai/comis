// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createConversationRef, runWithContext, safePath, scrubSecretsFromText, TypedEventBus } from "@comis/core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { wrapToolForAutoBackground, type ToolDefinition } from "./auto-background-middleware.js";
import { createBackgroundTaskManager, type BackgroundTaskManager } from "./background-task-manager.js";
import type { BackgroundTasksConfig, ClockPort, TimerPort, TimerHandle } from "@comis/core";
import type { BackgroundTaskOrigin } from "./background-task-types.js";
import { projectSessionValueForPersistence } from "../session/sanitize-session-secrets.js";

// ---------------------------------------------------------------------------
// Lightweight port wrappers that delegate to globals so vi.useFakeTimers()
// continues to intercept Date.now / setTimeout below.
// ---------------------------------------------------------------------------

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(t);
    },
    unref() {
      if (cancelled || unrefCalled) return;
      unrefCalled = true;
      t.unref();
    },
  };
}

const testClock: ClockPort = {
  now: () => Date.now(),
  nowDate: () => new Date(),
};

const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};

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

function buildOrigin(
  overrides: Partial<BackgroundTaskOrigin> & { agentId?: string; sessionKey?: string } = {},
): BackgroundTaskOrigin {
  const agentId = overrides.agentId ?? "default";
  const tenantId = overrides.sessionKey?.split(":")[0] ?? "default";
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "test-instance",
    conversationId: "test",
    conversationKind: "direct" as const,
  };
  const turnScope = {
    conversation: {
      tenantId,
      agentId,
      partition: {
        kind: "endpoint-conversation-principal" as const,
        endpoint,
        principalId: "user1",
      },
    },
    principal: { principalId: "user1" },
    endpoint,
  };
  const conversationRef = createConversationRef(turnScope.conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    turnScope,
    conversationRef: conversationRef.value,
    deliveryOrigin: {
      channelType: "echo",
      channelId: "test",
      userId: "user1",
      tenantId,
    },
    traceId: null,
    trustLevel: "user",
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    backgroundHopCount: 0,
    workspacePolicyHash: "a".repeat(64),
    capturedToolIds: [],
    capturedCapabilityViewHash: "b".repeat(64),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "agentId" && key !== "sessionKey"),
    ),
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

  beforeEach(() => {
    dataDir = safePath(tmpdir(), `comis-bg-mw-test-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    manager = createBackgroundTaskManager({
      dataDir,
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      clock: testClock,
      timers: testTimers,
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
  });

  afterEach(() => {
    for (const task of manager.getAllTasks()) {
      if (task._hardTimeoutTimer) task._hardTimeoutTimer.cancel();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns result directly when tool completes before timeout", async () => {
    const tool = createMockTool({ resolveAfterMs: 5, result: toolOk("fast-result") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
    expect(result).toEqual(toolOk("fast-result"));
    expect(manager.getAllTasks()).toHaveLength(0);
  });

  it("keeps slow scheduler tools in the foreground until the occurrence is terminal", async () => {
    const promoteSpy = vi.spyOn(manager, "promote");
    const tool = createMockTool({
      resolveAfterMs: config.autoBackgroundMs + 50,
      result: toolOk("scheduler-result"),
    });
    const wrapped = wrapToolForAutoBackground(
      tool,
      manager,
      config,
      () => buildOrigin({ agentId: "agent-1" }),
    );

    const result = await runWithContext({
      tenantId: "default",
      userId: "scheduler-user",
      agentId: "agent-1",
      sessionKey: "default:agent-1:scheduler:job-a",
      traceId: "10000000-0000-4000-8000-000000000002",
      startedAt: 1,
      trustLevel: "user",
      channelType: "scheduler",
    }, () => wrapped.execute("call-scheduler", {}, undefined, undefined, undefined));

    expect((result.content[0] as { text: string }).text).toBe("scheduler-result");
    expect(promoteSpy).not.toHaveBeenCalled();
  });

  it("returns a well-formed AgentToolResult placeholder when tool exceeds timeout", async () => {
    const tool = createMockTool({ resolveAfterMs: 200, result: toolOk("slow-result") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);

    // Invariant: the wrapper MUST return AgentToolResult shape so the SDK's
    // emitToolCallOutcome produces a non-empty toolResult message. Returning
    // a raw string collapses to content:undefined -> silent LLM failure.
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    const firstBlock = result.content[0]!;
    expect(firstBlock.type).toBe("text");
    expect((firstBlock as { text: string }).text).toContain("moved to the background");
    expect((firstBlock as { text: string }).text).toContain(
      "Automatic completion re-entry will resume this conversation with the result",
    );
    expect((firstBlock as { text: string }).text).toContain(
      "Do not call background_tasks or sleep to poll it",
    );
    expect((firstBlock as { text: string }).text).not.toContain(
      'Call background_tasks once with action "read_output"',
    );

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

  it("excludes a correlated human approval wait from the promotion timer", async () => {
    vi.useFakeTimers();
    const eventBus = new TypedEventBus();
    const promoteSpy = vi.spyOn(manager, "promote");
    const traceId = "10000000-0000-4000-8000-000000000001";
    const sessionKey = "default:agent-1:echo:test";
    let resolveTool: ((result: AgentToolResult<unknown>) => void) | undefined;
    const tool: ToolDefinition = {
      name: "approval_gated_tool",
      description: "test tool",
      parameters: {},
      execute: vi.fn(() => {
        eventBus.emit("approval:requested", {
          requestId: "approval-1",
          shortId: "Ab3Cd5Ef7Gh9",
          toolName: "approval_gated_tool",
          action: "update",
          params: {},
          tenantId: "default",
          agentId: "agent-1",
          conversationRef: "cv_test",
          sessionKey,
          resolvingPrincipalId: "user1",
          trustLevel: "user",
          createdAt: 1,
          timeoutMs: 60_000,
          traceId,
        });
        return new Promise((resolve) => {
          resolveTool = resolve;
        });
      }),
    };
    const wrapped = wrapToolForAutoBackground(
      tool,
      manager,
      config,
      () => buildOrigin({ agentId: "agent-1" }),
      undefined,
      eventBus,
    );
    const execution = runWithContext({
      tenantId: "default",
      userId: "user1",
      agentId: "agent-1",
      sessionKey,
      traceId,
      startedAt: 1,
      trustLevel: "user",
    }, () => wrapped.execute("call-approval", {}, undefined, undefined, undefined));

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(config.autoBackgroundMs + 10);
    const promotionsWhileApprovalPending = promoteSpy.mock.calls.length;
    eventBus.emit("approval:resolved", {
      requestId: "approval-1",
      approved: true,
      approvedBy: "user1",
      resolvedAt: 2,
    });
    resolveTool?.(toolOk("approved-result"));
    await vi.runAllTimersAsync();
    await execution;
    vi.useRealTimers();

    expect(promotionsWhileApprovalPending).toBe(0);
  });

  it("keeps a registered high-entropy tool label usable across status boundaries", async () => {
    const toolName = "mcp__background-report--read_assistant_report";
    const tool = createMockTool({ name: toolName, resolveAfterMs: 200 });
    const wrapped = wrapToolForAutoBackground(
      tool,
      manager,
      config,
      () => buildOrigin({ agentId: "agent-1" }),
    );

    const result = await wrapped.execute(
      "call-registered-identity",
      {},
      undefined,
      undefined,
      undefined,
    );
    const projected = projectSessionValueForPersistence(result);
    const text = (projected.value.content[0] as { text: string }).text;

    expect(projected.redactions).toBe(0);
    expect(scrubSecretsFromText(text).redactions).toBe(0);
    expect(text).not.toContain("[REDACTED]");
    expect((result.details as { toolName: string }).toolName).toBe(toolName);
  });

  it("marks deferred work exactly when background ownership is accepted", async () => {
    const tool = createMockTool({ resolveAfterMs: 200, result: toolOk("slow-result") });
    const onPromoted = vi.fn();
    const wrapped = wrapToolForAutoBackground(
      tool,
      manager,
      config,
      () => buildOrigin({ agentId: "agent-1" }),
      onPromoted,
    );

    expect(onPromoted).not.toHaveBeenCalled();
    await wrapped.execute("call-accepted", {}, undefined, undefined, undefined);

    expect(onPromoted).toHaveBeenCalledTimes(1);
  });

  it("does not mark deferred work for foreground completion or rejected promotion", async () => {
    const onForegroundPromoted = vi.fn();
    const foreground = wrapToolForAutoBackground(
      createMockTool({ resolveAfterMs: 5 }),
      manager,
      config,
      () => buildOrigin({ agentId: "agent-1" }),
      onForegroundPromoted,
    );
    await foreground.execute("call-foreground", {}, undefined, undefined, undefined);
    expect(onForegroundPromoted).not.toHaveBeenCalled();

    const rejectingManager = {
      ...manager,
      promote: vi.fn().mockReturnValue({ ok: false, error: new Error("limit") }),
    } as unknown as BackgroundTaskManager;
    const onRejectedPromoted = vi.fn();
    const rejected = wrapToolForAutoBackground(
      createMockTool({ resolveAfterMs: 75 }),
      rejectingManager,
      config,
      () => buildOrigin({ agentId: "agent-1" }),
      onRejectedPromoted,
    );
    await expect(
      rejected.execute("call-rejected", {}, undefined, undefined, undefined),
    ).rejects.toThrow("limit");
    expect(onRejectedPromoted).not.toHaveBeenCalled();
  });

  it("completes the background task when the tool eventually resolves", async () => {
    const tool = createMockTool({ resolveAfterMs: 100, result: toolOk("slow-result") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

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
    const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

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

    const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));
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
    const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

    // Simulate pi-executor in-place mutation (line 1172)
    tool.execute = wrapped.execute;

    // This would stack overflow without the origExecute fix
    const result = await tool.execute("call-1", {}, undefined, undefined, undefined);
    expect(result).toEqual(toolOk("ok"));
  });

  it("backgrounds correctly after in-place mutation", async () => {
    const tool = createMockTool({ resolveAfterMs: 200, result: toolOk("slow") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

    // Simulate pi-executor in-place mutation
    tool.execute = wrapped.execute;

    const result = await tool.execute("call-1", {}, undefined, undefined, undefined);
    const details = result.details as { status: string };
    expect(details.status).toBe("backgrounded");
  });

  it("rejects immediately and aborts the tool when background capacity is exhausted", async () => {
    // Create a manager with very low limits
    const limitedManager = createBackgroundTaskManager({
      dataDir,
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      clock: testClock,
      timers: testTimers,
      maxPerAgent: 1,
      maxTotal: 1,
      maxBackgroundDurationMs: 60_000,
    });

    // Fill up the limit
    limitedManager.promote("t1", new Promise(() => {}), new AbortController(), buildOrigin({ agentId: "agent-1" }));

    let receivedSignal: AbortSignal | undefined;
    const tool: ToolDefinition = {
      name: "slow_report",
      description: "test",
      parameters: {},
      execute: vi.fn((_toolCallId, _params, signal) => {
        receivedSignal = signal;
        return new Promise<AgentToolResult<unknown>>((resolve, reject) => {
          const timer = setTimeout(() => resolve(toolOk("foreground-result")), 75);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("underlying tool aborted"));
          }, { once: true });
        });
      }),
    };
    const wrapped = wrapToolForAutoBackground(tool, limitedManager, config, () => buildOrigin({ agentId: "agent-1" }));

    await expect(
      wrapped.execute("call-1", {}, undefined, undefined, undefined),
    ).rejects.toThrow(
      "[background_capacity] Background task capacity reached: agents.agent-1.backgroundTasks.maxPerAgent=1; active=1",
    );
    expect(receivedSignal?.aborted).toBe(true);

    // Clean up the stuck task
    for (const task of limitedManager.getAllTasks()) {
      if (task._hardTimeoutTimer) task._hardTimeoutTimer.cancel();
    }
  });

  // Regression: the original bug returned a JSON string here, which the SDK
  // then processed as AgentToolResult (string.content === undefined) and
  // produced an empty toolResult message on the wire, triggering the silent
  // LLM failure cascade that ended the user's xlsx skill install with a
  // generic "An error occurred while processing your request" Telegram reply.
  it("promoted tool result never collapses to empty content (regression)", async () => {
    const tool = createMockTool({ resolveAfterMs: 200, result: toolOk("slow-result") });
    const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);

    expect(result).toBeTypeOf("object");
    expect(result).not.toBeNull();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0);
    expect(result.details).toBeDefined();
  });

  describe("originResolver threading", () => {
    it("originResolver is called before manager.promote()", async () => {
      const originResolver = vi.fn().mockReturnValue(buildOrigin({ agentId: "resolver-agent" }));
      const tool = createMockTool({ resolveAfterMs: 200 });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, originResolver);

      await wrapped.execute("call-1", {}, undefined, undefined, undefined);

      expect(originResolver).toHaveBeenCalled();
    });

    it("when originResolver returns undefined, falls through to foreground (no promote)", async () => {
      const originResolver = vi.fn().mockReturnValue(undefined);
      const promoteSpy = vi.spyOn(manager, "promote");
      const tool = createMockTool({ resolveAfterMs: 200, result: toolOk("foreground-result") });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, originResolver);

      const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);

      expect(promoteSpy).not.toHaveBeenCalled();
      expect((result.content[0] as { text: string }).text).toBe("foreground-result");
    });

    it("keeps nested work foreground when its delivery origin cannot bind to the child turn", async () => {
      const endpoint = {
        channelType: "sub-agent",
        channelInstanceId: "runtime",
        conversationId: "child-run",
        conversationKind: "direct" as const,
      };
      const turnScope = {
        conversation: {
          tenantId: "default",
          agentId: "default",
          partition: {
            kind: "endpoint-conversation-principal" as const,
            endpoint,
            principalId: "conversation",
          },
        },
        principal: { principalId: "conversation" },
        endpoint,
      };
      const conversationRef = createConversationRef(turnScope.conversation);
      if (!conversationRef.ok) throw conversationRef.error;
      const nestedOrigin: BackgroundTaskOrigin = {
        turnScope,
        conversationRef: conversationRef.value,
        deliveryOrigin: {
          channelType: "telegram",
          channelId: "-1001234567890",
          userId: "conversation",
          threadId: "3",
          tenantId: "default",
        },
        traceId: "child-trace",
        trustLevel: "user",
        responseLocalePolicy: { source: "unset", enforceLocale: false },
        backgroundHopCount: 0,
        workspacePolicyHash: "a".repeat(64),
        capturedToolIds: [],
        capturedCapabilityViewHash: "b".repeat(64),
      };
      const promoteSpy = vi.spyOn(manager, "promote");
      const tool = createMockTool({
        name: "test_generic_tool",
        resolveAfterMs: 200,
        result: toolOk("foreground-search-result"),
      });
      const wrapped = wrapToolForAutoBackground(
        tool,
        manager,
        config,
        () => nestedOrigin,
      );

      const result = await wrapped.execute(
        "call-nested-search",
        {},
        undefined,
        undefined,
        undefined,
      );

      expect(promoteSpy).not.toHaveBeenCalled();
      expect((result.content[0] as { text: string }).text).toBe(
        "foreground-search-result",
      );
      expect(manager.getAllTasks()).toHaveLength(0);
    });

    it("when originResolver returns valid origin, promote is called with (tool.name, taskPromise, ac, origin)", async () => {
      const expectedOrigin = buildOrigin({ agentId: "origin-agent" });
      const originResolver = vi.fn().mockReturnValue(expectedOrigin);
      const promoteSpy = vi.spyOn(manager, "promote");
      const tool = createMockTool({ resolveAfterMs: 200, name: "bg_tool" });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, originResolver);

      await wrapped.execute("call-1", {}, undefined, undefined, undefined);

      expect(promoteSpy).toHaveBeenCalledWith(
        "bg_tool",
        expect.any(Promise),
        expect.any(AbortController),
        expectedOrigin,
        undefined,
        // Ids-only correlation captured at promote time so the TERMINAL event
        // can close the activity card this tool call opened.
        expect.objectContaining({ toolCallId: "call-1" }),
      );
    });

    it("placeholder ends the turn for automatic completion re-entry", async () => {
      const tool = createMockTool({ resolveAfterMs: 200 });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-7" }));

      const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Automatic completion re-entry will resume this conversation");
      expect(text).toContain("end this turn now");
      expect(text).not.toContain('Call background_tasks once with action "read_output"');
      expect(text).toContain("unrelated earlier data");
      expect(text).not.toContain("user will be notified");
    });
  });

  // ---------------------------------------------------------------------------
  // exec single-owner contract: exec opts out of the generic auto-background
  // wrapper so exec-tool.ts:613-668's internal escalation is the SOLE
  // backgrounding owner. The wrapper skips when tool.name === "exec"
  // regardless of excludeTools config.
  // ---------------------------------------------------------------------------
  describe("exec single-owner contract", () => {
    it("when tool.name === 'exec', wrapToolForAutoBackground returns the original tool unchanged", () => {
      // Use the default config (excludeTools: []) — keep empty to make the
      // gate explicit.
      config.excludeTools = [];
      const tool = createMockTool({ name: "exec" });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

      // Should be the exact same object (no-op wrap).
      expect(wrapped).toBe(tool);
    });

    it("with excludeTools=[] AND tool.name === 'exec', wrapper still skips wrapping (hardcoded 'exec' exclusion)", () => {
      // Make the contract independent of config — exec is excluded regardless.
      config.excludeTools = [];
      const tool = createMockTool({ name: "exec" });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

      expect(wrapped).toBe(tool);
    });

    it("a generic non-exec tool is still wrapped when excludeTools does not list it", () => {
      config.excludeTools = [];
      const tool = createMockTool({ name: "test_generic_tool" });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

      // Non-exec tools must still receive the wrapper (the wrapper is a NEW object,
      // not the original tool).
      expect(wrapped).not.toBe(tool);
    });

    it("a synthetic exec tool exceeding autoBackgroundMs does NOT call manager.promote (the wrapper is a no-op for exec)", async () => {
      config.excludeTools = [];
      const promoteSpy = vi.spyOn(manager, "promote");
      // Use a short resolveAfterMs that exceeds autoBackgroundMs (50ms by default
      // in beforeEach). The tool resolves at 150ms, but the wrapper is a no-op
      // for exec; the tool runs to completion in the foreground without any
      // promote call.
      const tool = createMockTool({
        name: "exec",
        resolveAfterMs: config.autoBackgroundMs + 100,
        result: toolOk("foreground-exec-result"),
      });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));

      // Race the tool: it should run to completion in the foreground (no promote).
      const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
      // Foreground result reaches the caller intact.
      expect((result.content[0] as { text: string }).text).toBe("foreground-exec-result");
      // Critical: manager.promote MUST NOT be invoked — the exec-tool's own
      // internal escalation is the sole backgrounding owner.
      expect(promoteSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Never-auto-background tools: observer/wait tools and the self-delivering
  // media-generation tools must never be promoted (regardless of excludeTools
  // config), exactly like exec.
  //
  // Live incident (2026-07-08): a "make me an image" request auto-promoted
  // image_generate at the 10s threshold and returned a "backgrounded"
  // placeholder; the model then tried to WAIT for it via `background_tasks
  // read_output`/`list` — each blocking ~10s and SELF-promoting into a
  // "Background task background_tasks completed" notification + a re-entry
  // LLM turn that polled again, an amplifying loop that burned the 2M-token
  // per-execution budget → budget_exceeded (with an empty request echo).
  //   - background_tasks OBSERVES background tasks; promoting it is
  //     structurally self-referential and self-amplifying.
  //   - image_generate/video_generate DELIVER out-of-band via the media
  //     pipeline (image.delivered fires independent of the wrapper — verified
  //     live), so the "backgrounded" placeholder is redundant and is exactly
  //     what tricks the model into polling.
  // ---------------------------------------------------------------------------
  describe("never-auto-background tools with results required by the current turn", () => {
    // `sleep` joined the set after a second live incident (2026-07-08): the model
    // slept to await a backgrounded MCP result; the sleep itself hit the 10s
    // threshold, promoted, and its raw 'Background task "sleep" completed.'
    // notice leaked to the user. Backgrounding a WAIT is self-defeating — the
    // stub returns instantly (defeating the wait) and the completion notice is
    // pure noise.
    // `discover_tools` joined for the SAME self-defeating reason as `sleep`, found live:
    // the cold long-tail of tools is deferred behind `discover_tools`, so a deferred tool only
    // becomes callable if discovery returns WITHIN the turn. A discovery call measured
    // durationMs=10101 — 101ms over the 10000ms threshold — was promoted, its result replaced by
    // the instant stub, and the real result arrived as a notification AFTER the turn had answered.
    // The turn therefore told the user "the scheduler tool is not currently callable" while
    // scheduling was enabled, capability-granted, and registered. Backgrounding a DISCOVERY is
    // self-defeating exactly as backgrounding a wait is: the stub returns instantly, so the tools
    // it existed to surface are absent from the one turn that needed them.
    for (const name of [
      "background_tasks",
      "subagents",
      "sleep",
      "image_generate",
      "video_generate",
      "discover_tools",
      "tokens_manage",
      "web_search",
      "web_fetch",
    ]) {
      it(`when tool.name === '${name}', wrapToolForAutoBackground returns the original tool unchanged (excludeTools=[])`, () => {
        config.excludeTools = [];
        const tool = createMockTool({ name });
        const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));
        expect(wrapped).toBe(tool);
      });

      it(`a slow '${name}' exceeding autoBackgroundMs does NOT call manager.promote`, async () => {
        config.excludeTools = [];
        const promoteSpy = vi.spyOn(manager, "promote");
        const tool = createMockTool({
          name,
          resolveAfterMs: config.autoBackgroundMs + 100,
          result: toolOk(`foreground-${name}-result`),
        });
        const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));
        const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
        expect((result.content[0] as { text: string }).text).toBe(`foreground-${name}-result`);
        expect(promoteSpy).not.toHaveBeenCalled();
      });
    }

    it("a generic slow tool is STILL promoted (the exclusion is narrow, not a blanket disable)", async () => {
      config.excludeTools = [];
      const promoteSpy = vi.spyOn(manager, "promote");
      const tool = createMockTool({
        name: "test_generic_tool",
        resolveAfterMs: config.autoBackgroundMs + 100,
        result: toolOk("late"),
      });
      const wrapped = wrapToolForAutoBackground(tool, manager, config, () => buildOrigin({ agentId: "agent-1" }));
      await wrapped.execute("call-1", {}, undefined, undefined, undefined);
      expect(promoteSpy).toHaveBeenCalled();
    });
  });
});
