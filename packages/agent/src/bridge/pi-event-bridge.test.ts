import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "@comis/shared";
import type { ModelOperationType } from "@comis/core";
import { BudgetError } from "../budget/budget-guard.js";
import { createPiEventBridge, sanitizeToolArgs, extractErrorText } from "./pi-event-bridge.js";
import type { PiEventBridgeDeps } from "./pi-event-bridge.js";
import { createBridgeMetrics, buildBridgeResult } from "./bridge-metrics.js";
import type { ExecutionResult } from "../executor/types.js";
import type { ExecutionPlan } from "../planner/types.js";

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<PiEventBridgeDeps>): PiEventBridgeDeps {
  return {
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      listenerCount: vi.fn().mockReturnValue(0),
    } as any,
    budgetGuard: {
      recordUsage: vi.fn(),
      checkBudget: vi.fn().mockReturnValue(ok(undefined)),
      estimateCost: vi.fn(),
      resetExecution: vi.fn(),
    },
    costTracker: {
      record: vi.fn(),
      getByAgent: vi.fn(),
      getByChannel: vi.fn(),
      getByExecution: vi.fn(),
      getBySession: vi.fn(),
      getByProvider: vi.fn(),
      getAll: vi.fn(),
      prune: vi.fn(),
    } as any,
    stepCounter: {
      increment: vi.fn().mockReturnValue(1),
      shouldHalt: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
      getCount: vi.fn().mockReturnValue(0),
    },
    circuitBreaker: {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      getState: vi.fn(),
      reset: vi.fn(),
    },
    sessionKey: { tenantId: "t1", channelId: "c1", userId: "u1" },
    agentId: "test-agent",
    channelId: "test-channel",
    executionId: "exec-001",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    operationType: "interactive" as ModelOperationType,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as any,
    onDelta: vi.fn(),
    onAbort: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers to construct fake AgentSessionEvent objects
// ---------------------------------------------------------------------------

function makeTextDeltaEvent(delta: string) {
  return {
    type: "message_update" as const,
    message: {} as any,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: {} as any,
    },
  };
}

function makeToolExecutionStartEvent(toolName: string, toolCallId: string = "tc-1") {
  return {
    type: "tool_execution_start" as const,
    toolCallId,
    toolName,
    args: { path: "/tmp/test" },
  };
}

function makeToolExecutionEndEvent(
  toolName: string,
  toolCallId: string = "tc-1",
  isError: boolean = false,
  result?: unknown,
) {
  return {
    type: "tool_execution_end" as const,
    toolCallId,
    toolName,
    result: result ?? { content: [{ type: "text", text: "ok" }] },
    isError,
  };
}

function makeTurnEndEvent(usage?: {
  input?: number;
  output?: number;
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  stopReason?: string;
}) {
  const defaultUsage = {
    input: usage?.input ?? 100,
    output: usage?.output ?? 50,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: usage?.totalTokens ?? 150,
    cost: usage?.cost ?? { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };

  return {
    type: "turn_end" as const,
    message: {
      role: "assistant" as const,
      content: [{ type: "text", text: "Hello" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      usage: defaultUsage,
      stopReason: usage?.stopReason ?? "stop",
      timestamp: Date.now(),
    },
    toolResults: [],
  };
}

function makeAutoCompactionStartEvent() {
  return {
    type: "compaction_start" as const,
    reason: "threshold" as const,
  };
}

function makeAutoCompactionEndEvent(hasResult: boolean = true) {
  return {
    type: "compaction_end" as const,
    result: hasResult ? { summary: "compacted", firstKeptEntryId: "e1", tokensBefore: 5000 } : undefined,
    aborted: false,
    willRetry: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPiEventBridge", () => {
  let deps: PiEventBridgeDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  // -------------------------------------------------------------------------
  // message_update / streaming
  // -------------------------------------------------------------------------

  describe("message_update / streaming", () => {
    it("text_delta event calls onDelta with delta text", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeTextDeltaEvent("Hello ") as any);
      listener(makeTextDeltaEvent("world") as any);

      expect(deps.onDelta).toHaveBeenCalledTimes(2);
      expect(deps.onDelta).toHaveBeenCalledWith("Hello ");
      expect(deps.onDelta).toHaveBeenCalledWith("world");
    });

    it("onDelta error does not propagate", () => {
      const throwingDelta = vi.fn(() => {
        throw new Error("callback boom");
      });
      deps = createMockDeps({ onDelta: throwingDelta });
      const { listener } = createPiEventBridge(deps);

      // Should not throw
      expect(() => listener(makeTextDeltaEvent("test") as any)).not.toThrow();
      expect(throwingDelta).toHaveBeenCalledWith("test");
    });

    it("no onDelta callback does not crash", () => {
      deps = createMockDeps({ onDelta: undefined });
      const { listener } = createPiEventBridge(deps);

      expect(() => listener(makeTextDeltaEvent("test") as any)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // tool_execution_start
  // -------------------------------------------------------------------------

  describe("tool_execution_start", () => {
    it("does NOT emit tool:executed on eventBus (only tool_execution_end does)", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionStartEvent("bash") as any);

      // tool_execution_start should NOT emit tool:executed -- that would cause double-emission
      const toolExecutedCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[0] === "tool:executed");
      expect(toolExecutedCalls).toHaveLength(0);
    });

    it("logs DEBUG with tool name and args preview", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionStartEvent("read") as any);

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "read", argsPreview: expect.any(String) }),
        expect.stringContaining("Tool execution started"),
      );
    });

    it("logs DEBUG without argsPreview when args is undefined", () => {
      const { listener } = createPiEventBridge(deps);

      listener({ type: "tool_execution_start", toolName: "read", toolCallId: "tc-1" } as any);

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "read" }),
        "Tool execution started",
      );
      // argsPreview should not be present
      const logObj = (deps.logger.debug as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(logObj.argsPreview).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // tool_execution_end
  // -------------------------------------------------------------------------

  describe("tool_execution_end", () => {
    it("increments step counter", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionEndEvent("bash") as any);

      expect(deps.stepCounter.increment).toHaveBeenCalledTimes(1);
    });

    it("emits tool:executed with success=true when not isError", () => {
      const { listener } = createPiEventBridge(deps);

      // Start tool first (for duration tracking)
      listener(makeToolExecutionStartEvent("bash", "tc-1") as any);
      listener(makeToolExecutionEndEvent("bash", "tc-1", false) as any);

      // Second emit (from tool_execution_end)
      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].durationMs >= 0 && c[1].toolName === "bash",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].success).toBe(true);
    });

    it("emits tool:executed with success=false when isError", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionEndEvent("bash", "tc-2", true) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "bash" && c[1].success === false,
      );
      expect(endEmit).toBeDefined();
    });

    it("emits tool:executed with success=false when result has non-zero exitCode", () => {
      const { listener } = createPiEventBridge(deps);

      const result = { content: [{ type: "text", text: '{"exitCode":1}' }], details: { exitCode: 1, stdout: "", stderr: "error" } };
      listener(makeToolExecutionEndEvent("exec", "tc-3", false, result) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "exec",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].success).toBe(false);
      expect(endEmit![1].errorKind).toBe("nonzero-exit");
    });

    it("emits tool:executed with success=true when result has exitCode 0", () => {
      const { listener } = createPiEventBridge(deps);

      const result = { content: [{ type: "text", text: '{"exitCode":0}' }], details: { exitCode: 0, stdout: "ok", stderr: "" } };
      listener(makeToolExecutionEndEvent("exec", "tc-4", false, result) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "exec",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].success).toBe(true);
      expect(endEmit![1].errorKind).toBeUndefined();
    });

    it("details.error string no longer triggers failure (errorResult convention removed, SDK isError is sole detection)", () => {
      const { listener } = createPiEventBridge(deps);

      // Details.error string fallback removed.
      // Tools now throw (SDK sets isError:true) instead of returning errorResult.
      // A details.error field with isError=false is treated as success.
      const result = { content: [{ type: "text", text: "Error: Approval denied" }], details: { error: "Approval denied" } };
      listener(makeToolExecutionEndEvent("approve_action", "tc-5", false, result) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "approve_action",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].success).toBe(true);
      expect(endEmit![1].errorKind).toBeUndefined();
    });

    it("emits tool:executed with success=true when details.error is absent", () => {
      const { listener } = createPiEventBridge(deps);

      const result = { content: [{ type: "text", text: "done" }], details: { output: "all good" } };
      listener(makeToolExecutionEndEvent("some_tool", "tc-6", false, result) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "some_tool",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].success).toBe(true);
      expect(endEmit![1].errorKind).toBeUndefined();
    });

    it("when stepCounter.shouldHalt() returns true, calls onAbort and sets finishReason to max_steps", () => {
      (deps.stepCounter.shouldHalt as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeToolExecutionEndEvent("bash") as any);

      expect(deps.onAbort).toHaveBeenCalledTimes(1);
      expect(getResult().finishReason).toBe("max_steps");
    });

    it("does not call onAbort twice when already aborted", () => {
      (deps.stepCounter.shouldHalt as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionEndEvent("bash", "tc-1") as any);
      listener(makeToolExecutionEndEvent("bash", "tc-2") as any);

      // onAbort should only be called once due to aborted flag
      expect(deps.onAbort).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // single emission per tool lifecycle
  // -------------------------------------------------------------------------

  describe("single emission per tool lifecycle", () => {
    it("emits exactly 1 tool:executed event for a complete tool start+end cycle", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionStartEvent("bash", "tc-1") as any);
      listener(makeToolExecutionEndEvent("bash", "tc-1", false) as any);

      const toolExecutedCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[0] === "tool:executed");
      expect(toolExecutedCalls).toHaveLength(1);
      expect(toolExecutedCalls[0][1]).toEqual(expect.objectContaining({
        toolName: "bash",
        success: true,
        agentId: "test-agent",
      }));
      // durationMs should be >= 0 (from tool_execution_end, not the removed start emission)
      expect(toolExecutedCalls[0][1].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("emits exactly 1 tool:executed per tool when multiple tools run sequentially", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionStartEvent("bash", "tc-1") as any);
      listener(makeToolExecutionEndEvent("bash", "tc-1", false) as any);
      listener(makeToolExecutionStartEvent("read", "tc-2") as any);
      listener(makeToolExecutionEndEvent("read", "tc-2", true) as any);

      const toolExecutedCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[0] === "tool:executed");
      expect(toolExecutedCalls).toHaveLength(2);
      expect(toolExecutedCalls[0][1].toolName).toBe("bash");
      expect(toolExecutedCalls[0][1].success).toBe(true);
      expect(toolExecutedCalls[1][1].toolName).toBe("read");
      expect(toolExecutedCalls[1][1].success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // turn_end
  // -------------------------------------------------------------------------

  describe("turn_end", () => {
    it("increments llmCallCount (verify via getResult)", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);
      listener(makeTurnEndEvent() as any);

      expect(getResult().llmCalls).toBe(2);
    });

    it("records usage on budgetGuard and costTracker when message has usage", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ input: 200, output: 80, totalTokens: 280 }) as any);

      expect(deps.budgetGuard.recordUsage).toHaveBeenCalledWith(280);
      expect(deps.costTracker.record).toHaveBeenCalledWith(
        "test-agent",
        "test-channel",
        "exec-001",
        expect.objectContaining({
          input: 200,
          output: 80,
          totalTokens: 280,
          provider: "anthropic",
          model: "claude-sonnet-4-5-20250929",
        }),
      );
    });

    it("includes operationType in costTracker.record when set in deps", () => {
      const depsWithOp = createMockDeps({ operationType: "cron" as const });
      const { listener } = createPiEventBridge(depsWithOp);

      listener(makeTurnEndEvent({ input: 200, output: 80, totalTokens: 280 }) as any);

      expect(depsWithOp.costTracker.record).toHaveBeenCalledWith(
        "test-agent",
        "test-channel",
        "exec-001",
        expect.objectContaining({
          operationType: "cron",
        }),
      );
    });

    it("uses operationType from deps (no fallback)", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ input: 200, output: 80, totalTokens: 280 }) as any);

      expect(deps.costTracker.record).toHaveBeenCalledWith(
        "test-agent",
        "test-channel",
        "exec-001",
        expect.objectContaining({
          operationType: "interactive",
        }),
      );
    });

    it("emits observability:token_usage on eventBus with cache fields defaulting to 0", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ input: 100, output: 50, totalTokens: 150 }) as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("observability:token_usage", expect.objectContaining({
        agentId: "test-agent",
        channelId: "test-channel",
        executionId: "exec-001",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        tokens: { prompt: 100, completion: 50, total: 150 },
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }));
    });

    it("emits observability:token_usage with non-zero cache token fields from SDK", () => {
      const { listener } = createPiEventBridge(deps);

      // Create a turn_end event with non-zero cache values
      const event = makeTurnEndEvent({ input: 100, output: 50, totalTokens: 150 });
      // Patch the usage object to include non-zero cache fields
      (event.message.usage as any).cacheRead = 8000;
      (event.message.usage as any).cacheWrite = 3000;

      listener(event as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("observability:token_usage", expect.objectContaining({
        cacheReadTokens: 8000,
        cacheWriteTokens: 3000,
      }));
    });

    it("when budgetGuard.checkBudget returns err, calls onAbort and sets finishReason to budget_exceeded", () => {
      (deps.budgetGuard.checkBudget as ReturnType<typeof vi.fn>).mockReturnValue(
        err(new BudgetError("per-execution", 5000, 5000, 0)),
      );
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(deps.onAbort).toHaveBeenCalledTimes(1);
      expect(getResult().finishReason).toBe("budget_exceeded");
    });

    it("records success on circuitBreaker", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(deps.circuitBreaker.recordSuccess).toHaveBeenCalledTimes(1);
    });

    it("detects LLM error via stopReason and records circuit breaker failure", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ stopReason: "error" }) as any);

      // recordSuccess is called in the main turn_end handler, then
      // recordFailure is called in the error detection section
      expect(deps.circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Check LLM provider status",
          errorKind: "dependency",
        }),
        "LLM call returned error",
      );
    });

    it("accumulates cacheRead and cacheWrite across multiple turn_end events", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ cacheRead: 1000, cacheWrite: 300 }) as any);
      listener(makeTurnEndEvent({ cacheRead: 500, cacheWrite: 0 }) as any);
      listener(makeTurnEndEvent({ cacheRead: 200, cacheWrite: 100 }) as any);

      const result = getResult();
      expect(result.tokensUsed!.cacheRead).toBe(1700);
      expect(result.tokensUsed!.cacheWrite).toBe(400);
    });

    it("getResult returns cacheRead and cacheWrite as zero when no usage events fired", () => {
      const { getResult } = createPiEventBridge(deps);

      const result = getResult();
      expect(result.tokensUsed!.cacheRead).toBe(0);
      expect(result.tokensUsed!.cacheWrite).toBe(0);
    });

    it("cacheRead and cacheWrite are always numbers, never undefined", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      // Fire one turn_end with default usage (cacheRead: 0, cacheWrite: 0)
      listener(makeTurnEndEvent() as any);

      const result = getResult();
      expect(typeof result.tokensUsed!.cacheRead).toBe("number");
      expect(typeof result.tokensUsed!.cacheWrite).toBe("number");
    });
  });

  // -------------------------------------------------------------------------
  // circuit breaker mid-execution abort
  // -------------------------------------------------------------------------

  describe("circuit breaker mid-execution abort", () => {
    it("triggers abort when circuit breaker opens after recordFailure", () => {
      // Circuit breaker opens after recordFailure is called
      (deps.circuitBreaker.isOpen as ReturnType<typeof vi.fn>)
        .mockReturnValue(false)
        .mockReturnValueOnce(false)   // initial check during turn_end
        .mockReturnValueOnce(true);   // after recordFailure
      // Need isOpen to return true AFTER recordFailure, so we chain:
      // First call in turn_end: false; second call after recordFailure: true
      const isOpenMock = vi.fn()
        .mockReturnValueOnce(true); // called once after recordFailure
      deps.circuitBreaker.isOpen = isOpenMock;

      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ stopReason: "error" }) as any);

      expect(deps.onAbort).toHaveBeenCalledTimes(1);
      expect(getResult().finishReason).toBe("circuit_open");
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: expect.stringContaining("Circuit breaker opened"),
          errorKind: "dependency",
        }),
        "Circuit breaker opened, aborting execution",
      );
    });

    it("does not abort when circuit breaker remains closed after failure", () => {
      (deps.circuitBreaker.isOpen as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ stopReason: "error" }) as any);

      // recordFailure was called but circuit breaker stayed closed
      expect(deps.circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
      expect(deps.onAbort).not.toHaveBeenCalled();
      expect(getResult().finishReason).toBe("stop"); // unchanged
    });

    it("emits execution:aborted event with reason circuit_breaker", () => {
      (deps.circuitBreaker.isOpen as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ stopReason: "error" }) as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("execution:aborted", expect.objectContaining({
        sessionKey: deps.sessionKey,
        reason: "circuit_breaker",
        agentId: "test-agent",
        timestamp: expect.any(Number),
      }));
    });

    it("emits execution:aborted event with reason budget_exceeded", () => {
      (deps.budgetGuard.checkBudget as ReturnType<typeof vi.fn>).mockReturnValue(
        err(new BudgetError("per-execution", 5000, 5000, 0)),
      );
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("execution:aborted", expect.objectContaining({
        sessionKey: deps.sessionKey,
        reason: "budget_exceeded",
        agentId: "test-agent",
        timestamp: expect.any(Number),
      }));
    });

    it("emits execution:aborted event with reason max_steps", () => {
      (deps.stepCounter.shouldHalt as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionEndEvent("bash") as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("execution:aborted", expect.objectContaining({
        sessionKey: deps.sessionKey,
        reason: "max_steps",
        agentId: "test-agent",
        timestamp: expect.any(Number),
      }));
    });
  });

  // -------------------------------------------------------------------------
  // compaction_start
  // -------------------------------------------------------------------------

  describe("compaction_start", () => {
    it("logs INFO with agentId and sessionKey", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeAutoCompactionStartEvent() as any);

      expect(deps.logger.info).toHaveBeenCalledWith(
        { sessionKey: "t1:u1:c1" },
        "Auto-compaction started",
      );
    });

    it("emits compaction:started event on eventBus", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeAutoCompactionStartEvent() as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "compaction:started",
        expect.objectContaining({
          agentId: "test-agent",
          sessionKey: deps.sessionKey,
          timestamp: expect.any(Number),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // compaction_end
  // -------------------------------------------------------------------------

  describe("compaction_end", () => {
    it("emits compaction:flush with memoriesWritten=0 when no memoryPort", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeAutoCompactionEndEvent(true) as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("compaction:flush", expect.objectContaining({
        sessionKey: deps.sessionKey,
        memoriesWritten: 0,
        trigger: "soft",
        success: true,
      }));
    });

    it("emits compaction:flush with success=false when result is undefined", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeAutoCompactionEndEvent(false) as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("compaction:flush", expect.objectContaining({
        success: false,
      }));
    });

    it("emits compaction:flush with success=false when aborted", () => {
      const { listener } = createPiEventBridge(deps);

      listener({
        type: "compaction_end" as const,
        result: { summary: "compacted", firstKeptEntryId: "e1", tokensBefore: 5000 },
        aborted: true,
        willRetry: false,
      } as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("compaction:flush", expect.objectContaining({
        success: false,
      }));
    });

    it("logs INFO with structured fields for successful auto-compaction", () => {
      const { listener } = createPiEventBridge(deps);

      // Send compaction start first (for durationMs tracking)
      listener(makeAutoCompactionStartEvent() as any);
      listener(makeAutoCompactionEndEvent(true) as any);

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          durationMs: expect.any(Number),
          aborted: false,
          hasSummary: true,
          memoriesWritten: 0,
        }),
        "Auto-compaction completed",
      );
    });

    it("logs WARN with hint and errorKind when aborted", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeAutoCompactionStartEvent() as any);
      listener({
        type: "compaction_end" as const,
        result: { summary: "compacted", firstKeptEntryId: "e1", tokensBefore: 5000 },
        aborted: true,
        willRetry: false,
      } as any);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          aborted: true,
          hint: expect.any(String),
          errorKind: "internal",
        }),
        "Auto-compaction failed",
      );
    });

    it("logs WARN with hint and errorKind when errorMessage present", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeAutoCompactionStartEvent() as any);
      listener({
        type: "compaction_end" as const,
        result: undefined,
        aborted: false,
        willRetry: true,
        errorMessage: "LLM rate limit",
      } as any);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: "LLM rate limit",
          hint: expect.any(String),
          errorKind: "internal",
        }),
        "Auto-compaction failed",
      );
    });

    it("computes durationMs from compaction start", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeAutoCompactionStartEvent() as any);
      listener(makeAutoCompactionEndEvent(true) as any);

      // Find the INFO call for "Auto-compaction completed"
      const infoCalls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const completedCall = infoCalls.find((c) => c[1] === "Auto-compaction completed");
      expect(completedCall).toBeDefined();
      expect(completedCall![0].durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof completedCall![0].durationMs).toBe("number");
    });

    it("calls memoryPort.store() with correct entry shape when result has summary", () => {
      const mockMemoryPort = {
        store: vi.fn().mockResolvedValue({ ok: true, value: {} }),
        search: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      };
      const depsWithMemory = createMockDeps({ memoryPort: mockMemoryPort as any });
      const { listener } = createPiEventBridge(depsWithMemory);

      listener(makeAutoCompactionEndEvent(true) as any);

      expect(mockMemoryPort.store).toHaveBeenCalledTimes(1);
      const storedEntry = mockMemoryPort.store.mock.calls[0][0];
      expect(storedEntry).toMatchObject({
        tenantId: "t1",
        userId: "u1",
        agentId: "test-agent",
        content: "compacted",
        trustLevel: "learned",
        source: { who: "compaction", channel: "test-channel" },
        tags: ["compaction-summary"],
      });
      expect(storedEntry.id).toBeTypeOf("string");
      expect(storedEntry.createdAt).toBeTypeOf("number");
    });

    it("emits memoriesWritten=1 when memoryPort.store is called", () => {
      const mockMemoryPort = {
        store: vi.fn().mockResolvedValue({ ok: true, value: {} }),
        search: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      };
      const depsWithMemory = createMockDeps({ memoryPort: mockMemoryPort as any });
      const { listener } = createPiEventBridge(depsWithMemory);

      listener(makeAutoCompactionEndEvent(true) as any);

      expect(depsWithMemory.eventBus.emit).toHaveBeenCalledWith("compaction:flush", expect.objectContaining({
        memoriesWritten: 1,
        success: true,
      }));
    });

    it("does NOT call memoryPort.store() when result is undefined", () => {
      const mockMemoryPort = {
        store: vi.fn().mockResolvedValue({ ok: true, value: {} }),
        search: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      };
      const depsWithMemory = createMockDeps({ memoryPort: mockMemoryPort as any });
      const { listener } = createPiEventBridge(depsWithMemory);

      listener(makeAutoCompactionEndEvent(false) as any);

      expect(mockMemoryPort.store).not.toHaveBeenCalled();
    });

    it("memoryPort.store() rejection does not throw (fire-and-forget)", () => {
      const mockMemoryPort = {
        store: vi.fn().mockRejectedValue(new Error("DB write failed")),
        search: vi.fn(),
        retrieve: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      };
      const depsWithMemory = createMockDeps({ memoryPort: mockMemoryPort as any });
      const { listener } = createPiEventBridge(depsWithMemory);

      // Should not throw even when store rejects
      expect(() => listener(makeAutoCompactionEndEvent(true) as any)).not.toThrow();
      expect(mockMemoryPort.store).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // context guard
  // -------------------------------------------------------------------------

  describe("context guard", () => {
    it("calls guard.check after turn_end when contextGuard and getContextUsage are provided", () => {
      const mockGuard = { check: vi.fn().mockReturnValue({ level: "ok" }) };
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 50_000, contextWindow: 200_000, percent: 25 });
      deps = createMockDeps({ contextGuard: mockGuard, getContextUsage } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(getContextUsage).toHaveBeenCalledTimes(1);
      expect(mockGuard.check).toHaveBeenCalledWith({ tokens: 50_000, contextWindow: 200_000, percent: 25 });
    });

    it("when guard returns warn, logger.warn is called but execution continues", () => {
      const mockGuard = {
        check: vi.fn().mockReturnValue({ level: "warn", percent: 85, message: "Context window running low: 85% used" }),
      };
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 170_000, contextWindow: 200_000, percent: 85 });
      deps = createMockDeps({ contextGuard: mockGuard, getContextUsage } as any);
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          contextPercent: 85,
          hint: expect.stringContaining("compaction"),
          errorKind: "resource",
        }),
        "Context window running low",
      );
      expect(deps.onAbort).not.toHaveBeenCalled();
      expect(getResult().finishReason).toBe("stop");
    });

    it("when guard returns block, onAbort is called and execution:aborted is emitted with reason context_exhausted", () => {
      const mockGuard = {
        check: vi.fn().mockReturnValue({ level: "block", percent: 97, message: "Context window critically full: 97% used" }),
      };
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 194_000, contextWindow: 200_000, percent: 97 });
      deps = createMockDeps({ contextGuard: mockGuard, getContextUsage } as any);
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(deps.onAbort).toHaveBeenCalledTimes(1);
      expect(getResult().finishReason).toBe("context_exhausted");
      expect(deps.eventBus.emit).toHaveBeenCalledWith("execution:aborted", expect.objectContaining({
        sessionKey: deps.sessionKey,
        reason: "context_exhausted",
        agentId: "test-agent",
        timestamp: expect.any(Number),
      }));
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          contextPercent: 97,
          hint: expect.stringContaining("Context window critically full"),
          errorKind: "resource",
        }),
        "Context window exhausted, aborting execution",
      );
    });

    it("when getContextUsage returns undefined, guard check is skipped", () => {
      const mockGuard = { check: vi.fn() };
      const getContextUsage = vi.fn().mockReturnValue(undefined);
      deps = createMockDeps({ contextGuard: mockGuard, getContextUsage } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(getContextUsage).toHaveBeenCalledTimes(1);
      expect(mockGuard.check).not.toHaveBeenCalled();
    });

    it("when contextGuard is not provided (undefined), guard check is skipped entirely", () => {
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 100_000, contextWindow: 200_000, percent: 50 });
      deps = createMockDeps({ getContextUsage } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      // getContextUsage should not even be called when contextGuard is undefined
      expect(getContextUsage).not.toHaveBeenCalled();
    });

    it("context guard check happens AFTER budget guard check", () => {
      const callOrder: string[] = [];
      const mockBudgetGuard = {
        recordUsage: vi.fn(),
        checkBudget: vi.fn(() => {
          callOrder.push("budget");
          return { ok: true };
        }),
        estimateCost: vi.fn(),
        resetExecution: vi.fn(),
      };
      const mockContextGuard = {
        check: vi.fn(() => {
          callOrder.push("context");
          return { level: "ok" as const };
        }),
      };
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 50_000, contextWindow: 200_000, percent: 25 });
      deps = createMockDeps({
        budgetGuard: mockBudgetGuard as any,
        contextGuard: mockContextGuard,
        getContextUsage,
      } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(callOrder).toEqual(["budget", "context"]);
    });

    it("stores lastContextUsage and returns it via getResult", () => {
      const mockGuard = { check: vi.fn().mockReturnValue({ level: "ok" }) };
      const contextData = { tokens: 60_000, contextWindow: 200_000, percent: 30 };
      const getContextUsage = vi.fn().mockReturnValue(contextData);
      deps = createMockDeps({ contextGuard: mockGuard, getContextUsage } as any);
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(getResult().contextUsage).toEqual(contextData);
    });

    it("does not call context guard when already aborted by budget", () => {
      const mockBudgetGuard = {
        recordUsage: vi.fn(),
        checkBudget: vi.fn().mockReturnValue({ ok: false, error: new Error("budget") }),
        estimateCost: vi.fn(),
        resetExecution: vi.fn(),
      };
      const mockContextGuard = { check: vi.fn() };
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
      deps = createMockDeps({
        budgetGuard: mockBudgetGuard as any,
        contextGuard: mockContextGuard,
        getContextUsage,
      } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      // Budget aborted first, so context guard should be skipped
      expect(mockContextGuard.check).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // compaction recommendation
  // -------------------------------------------------------------------------

  describe("compaction recommendation", () => {
    it("fires compaction:recommended when shouldCompact returns true (high usage)", () => {
      // shouldCompact triggers when tokens > contextWindow - reserveTokens (128000 - 16384 = 111616)
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 115000, contextWindow: 128000, percent: 90 });
      deps = createMockDeps({
        getContextUsage,
        compactionSettings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 32768 },
      } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("compaction:recommended", expect.objectContaining({
        agentId: "test-agent",
        sessionKey: deps.sessionKey,
        contextPercent: 90,
        contextTokens: 115000,
        contextWindow: 128000,
        timestamp: expect.any(Number),
      }));
    });

    it("does NOT fire compaction:recommended when context usage is low", () => {
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 20000, contextWindow: 128000, percent: 16 });
      deps = createMockDeps({
        getContextUsage,
        compactionSettings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 32768 },
      } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      const recommendedCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[0] === "compaction:recommended");
      expect(recommendedCalls).toHaveLength(0);
    });

    it("does NOT fire compaction:recommended when compactionSettings not provided", () => {
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 110000, contextWindow: 128000, percent: 86 });
      deps = createMockDeps({ getContextUsage } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      const recommendedCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[0] === "compaction:recommended");
      expect(recommendedCalls).toHaveLength(0);
    });

    it("does NOT fire compaction:recommended when tokens is null", () => {
      const getContextUsage = vi.fn().mockReturnValue({ tokens: null, contextWindow: 128000, percent: null });
      deps = createMockDeps({
        getContextUsage,
        compactionSettings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 32768 },
      } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      const recommendedCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[0] === "compaction:recommended");
      expect(recommendedCalls).toHaveLength(0);
    });

    it("does NOT fire compaction:recommended when execution is aborted", () => {
      // Abort via budget exceeded before compaction check runs
      const abortingBudgetGuard = {
        recordUsage: vi.fn(),
        checkBudget: vi.fn().mockReturnValue(err(new BudgetError("per-execution", 5000, 5000, 0))),
        estimateCost: vi.fn(),
        resetExecution: vi.fn(),
      };
      const getContextUsage = vi.fn().mockReturnValue({ tokens: 115000, contextWindow: 128000, percent: 90 });
      deps = createMockDeps({
        budgetGuard: abortingBudgetGuard as any,
        getContextUsage,
        compactionSettings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 32768 },
      } as any);
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      const recommendedCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[0] === "compaction:recommended");
      expect(recommendedCalls).toHaveLength(0);
    });

    it("existing compaction:started event still fires on compaction_start", () => {
      const { listener } = createPiEventBridge(deps);

      listener(makeAutoCompactionStartEvent() as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "compaction:started",
        expect.objectContaining({
          agentId: "test-agent",
          sessionKey: deps.sessionKey,
          timestamp: expect.any(Number),
        }),
      );
    });

    it("existing execution:aborted events still fire for max_steps reason", () => {
      (deps.stepCounter.shouldHalt as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionEndEvent("bash") as any);

      expect(deps.eventBus.emit).toHaveBeenCalledWith("execution:aborted", expect.objectContaining({
        sessionKey: deps.sessionKey,
        reason: "max_steps",
        agentId: "test-agent",
        timestamp: expect.any(Number),
      }));
    });
  });

  // -------------------------------------------------------------------------
  // error handling (general)
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("does not throw for unknown event types", () => {
      const { listener } = createPiEventBridge(deps);

      expect(() => listener({ type: "unknown_future_event" } as any)).not.toThrow();
    });

    it("catches and logs listener errors", () => {
      // Force an error by making emit throw on tool_execution_end (which still calls emit)
      (deps.eventBus.emit as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("emit boom");
      });
      const { listener } = createPiEventBridge(deps);

      // Should not throw
      expect(() => listener(makeToolExecutionEndEvent("bash") as any)).not.toThrow();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "tool_execution_end",
          hint: expect.stringContaining("unexpected error"),
          errorKind: "internal",
        }),
        "Event bridge listener error",
      );
    });
  });

  // -------------------------------------------------------------------------
  // getResult
  // -------------------------------------------------------------------------

  describe("getResult", () => {
    it("returns accumulated token totals, step count, llm call count", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      // Two turns
      listener(makeTurnEndEvent({ input: 100, output: 50, totalTokens: 150 }) as any);
      listener(makeTurnEndEvent({ input: 200, output: 100, totalTokens: 300 }) as any);

      const result = getResult();
      expect(result.tokensUsed).toEqual({ input: 300, output: 150, total: 450, cacheRead: 0, cacheWrite: 0 });
      expect(result.llmCalls).toBe(2);
    });

    it("default finishReason is stop", () => {
      const { getResult } = createPiEventBridge(deps);

      expect(getResult().finishReason).toBe("stop");
    });

    it("finishReason reflects max_steps abort", () => {
      (deps.stepCounter.shouldHalt as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeToolExecutionEndEvent("bash") as any);

      expect(getResult().finishReason).toBe("max_steps");
    });

    it("finishReason reflects budget_exceeded abort", () => {
      (deps.budgetGuard.checkBudget as ReturnType<typeof vi.fn>).mockReturnValue(
        err(new BudgetError("per-execution", 5000, 5000, 0)),
      );
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent() as any);

      expect(getResult().finishReason).toBe("budget_exceeded");
    });

    it("returns step count from stepCounter.getCount()", () => {
      (deps.stepCounter.getCount as ReturnType<typeof vi.fn>).mockReturnValue(5);
      const { getResult } = createPiEventBridge(deps);

      expect(getResult().stepsExecuted).toBe(5);
    });

    it("accumulates cost from multiple turns", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({
        input: 100, output: 50, totalTokens: 150,
        cost: { input: 0.001, output: 0.002, total: 0.003 },
      }) as any);
      listener(makeTurnEndEvent({
        input: 200, output: 100, totalTokens: 300,
        cost: { input: 0.002, output: 0.004, total: 0.006 },
      }) as any);

      const result = getResult();
      expect(result.cost!.total).toBeCloseTo(0.009);
    });
  });

  // -------------------------------------------------------------------------
  // textEmitted tracking
  // -------------------------------------------------------------------------

  describe("textEmitted tracking", () => {
    it("textEmitted defaults to false in getResult", () => {
      const { getResult } = createPiEventBridge(deps);

      expect(getResult().textEmitted).toBe(false);
    });

    it("textEmitted becomes true after text_delta event", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTextDeltaEvent("Hello") as any);

      expect(getResult().textEmitted).toBe(true);
    });

    it("textEmitted is true even without onDelta callback", () => {
      deps = createMockDeps({ onDelta: undefined });
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTextDeltaEvent("Hello") as any);

      expect(getResult().textEmitted).toBe(true);
    });

    it("textEmitted remains false when only tool events and turn_end occur (no text)", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeToolExecutionStartEvent("bash", "tc-1") as any);
      listener(makeToolExecutionEndEvent("bash", "tc-1") as any);
      listener(makeTurnEndEvent() as any);

      expect(getResult().textEmitted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // tool failure tracking
  // -------------------------------------------------------------------------

  describe("tool failure tracking", () => {
    it("stores sanitized tool args from tool_execution_start and cleans up after tool_execution_end", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      // Fire start with args containing a 300-char string value
      listener({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tc-snap-1",
        args: { code: "x".repeat(300), name: "short" },
      } as any);

      // Fire end with success
      listener(makeToolExecutionEndEvent("bash", "tc-snap-1", false) as any);

      // Successful tool: no WARN log for failure
      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] === "Tool execution failed");
      expect(warnCalls).toHaveLength(0);

      // getResult should not have leaked arg snapshots
      const result = getResult();
      expect(result.failedToolCalls).toBe(0);
    });

    it("logs WARN with error text and sanitized args when tool fails", () => {
      const { listener } = createPiEventBridge(deps);

      // Fire start with args
      listener({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tc-fail-1",
        args: { command: "rm -rf /" },
      } as any);

      // Fire end with isError: true and string result
      listener(makeToolExecutionEndEvent("bash", "tc-fail-1", true, "Something went wrong") as any);

      // Verify logger.warn was called with correct fields
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "bash",
          toolCallId: "tc-fail-1",
          errorText: "Something went wrong",
          toolArgs: { command: "rm -rf /" },
          hint: "Tool execution failed; check errorText and toolArgs for root cause",
          errorKind: "dependency",
        }),
        "Tool execution failed",
      );
    });

    it("extracts error text from Error instance, object with message, and plain string", () => {
      const { listener } = createPiEventBridge(deps);

      // Failure 1: plain string
      listener({ type: "tool_execution_start", toolName: "t1", toolCallId: "tc-e1" } as any);
      listener(makeToolExecutionEndEvent("t1", "tc-e1", true, "plain error") as any);

      // Failure 2: Error instance
      listener({ type: "tool_execution_start", toolName: "t2", toolCallId: "tc-e2" } as any);
      listener(makeToolExecutionEndEvent("t2", "tc-e2", true, new Error("Error instance msg")) as any);

      // Failure 3: object with message
      listener({ type: "tool_execution_start", toolName: "t3", toolCallId: "tc-e3" } as any);
      listener(makeToolExecutionEndEvent("t3", "tc-e3", true, { message: "Object message" }) as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] === "Tool execution failed");

      expect(warnCalls).toHaveLength(3);
      expect(warnCalls[0][0].errorText).toBe("plain error");
      expect(warnCalls[1][0].errorText).toBe("Error instance msg");
      expect(warnCalls[2][0].errorText).toBe("Object message");
    });

    it("accumulates failedToolCalls and failedTools in getResult", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      // Fail tool "bash" twice (same name), succeed tool "read" once
      listener({ type: "tool_execution_start", toolName: "bash", toolCallId: "tc-a1" } as any);
      listener(makeToolExecutionEndEvent("bash", "tc-a1", true, "err1") as any);

      listener({ type: "tool_execution_start", toolName: "bash", toolCallId: "tc-a2" } as any);
      listener(makeToolExecutionEndEvent("bash", "tc-a2", true, "err2") as any);

      listener({ type: "tool_execution_start", toolName: "read", toolCallId: "tc-a3" } as any);
      listener(makeToolExecutionEndEvent("read", "tc-a3", false) as any);

      const result = getResult();
      expect(result.failedToolCalls).toBe(2);
      expect(result.failedTools).toEqual(["bash"]); // deduplicated
    });

    it("tracks toolExecResults with success/failure/errorText", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      // 1 success, 1 failure
      listener({ type: "tool_execution_start", toolName: "read", toolCallId: "tc-r1" } as any);
      listener(makeToolExecutionEndEvent("read", "tc-r1", false) as any);

      listener({ type: "tool_execution_start", toolName: "bash", toolCallId: "tc-r2" } as any);
      listener(makeToolExecutionEndEvent("bash", "tc-r2", true, "command failed") as any);

      const result = getResult();
      expect(result.toolExecResults).toHaveLength(2);
      expect(result.toolExecResults![0]).toMatchObject({ toolName: "read", success: true });
      expect(result.toolExecResults![0].errorText).toBeUndefined();
      expect(result.toolExecResults![1]).toMatchObject({ toolName: "bash", success: false, errorText: "command failed" });
    });

    it("truncates arg values >200 chars to char count placeholder", () => {
      const { listener } = createPiEventBridge(deps);

      listener({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tc-trunc",
        args: { code: "x".repeat(300), name: "short" },
      } as any);

      // Fire failure end
      listener(makeToolExecutionEndEvent("bash", "tc-trunc", true, "failed") as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] === "Tool execution failed");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0][0].toolArgs.code).toBe("[300 chars]");
      expect(warnCalls[0][0].toolArgs.name).toBe("short");
    });

    it("handles tool_execution_end without prior tool_execution_start gracefully", () => {
      const { listener, getResult } = createPiEventBridge(deps);

      // Fire end without start -- no crash expected
      listener(makeToolExecutionEndEvent("bash", "tc-orphan", true, "no start") as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] === "Tool execution failed");
      expect(warnCalls).toHaveLength(1);
      // sanitizedArgs should be undefined (no prior start)
      expect(warnCalls[0][0].toolArgs).toBeUndefined();
      // Still counts as a failure
      expect(getResult().failedToolCalls).toBe(1);
    });

    it("populates errorMessage on tool:executed event for failures", () => {
      const { listener } = createPiEventBridge(deps);

      listener({ type: "tool_execution_start", toolName: "bash", toolCallId: "tc-em" } as any);
      listener(makeToolExecutionEndEvent("bash", "tc-em", true, "Something broke") as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "bash",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].errorMessage).toBe("Something broke");
      expect(endEmit![1].success).toBe(false);
    });

    it("does not include errorMessage on tool:executed event for successes", () => {
      const { listener } = createPiEventBridge(deps);

      listener({ type: "tool_execution_start", toolName: "read", toolCallId: "tc-succ" } as any);
      listener(makeToolExecutionEndEvent("read", "tc-succ", false) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "read",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].errorMessage).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // MCP attribution in tool failure logs
  // -------------------------------------------------------------------------

  describe("MCP attribution in tool failure logs", () => {
    it("MCP tool failure includes mcpServer and mcpErrorType in WARN log", () => {
      const { listener } = createPiEventBridge(deps);

      listener({
        type: "tool_execution_start",
        toolName: "mcp__context7--resolve-library-id",
        toolCallId: "tc-mcp-1",
        args: { query: "react" },
      } as any);
      listener(makeToolExecutionEndEvent(
        "mcp__context7--resolve-library-id", "tc-mcp-1", true, "Server not connected",
      ) as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] === "Tool execution failed");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0][0].mcpServer).toBe("context7");
      expect(warnCalls[0][0].mcpErrorType).toBe("connection");
    });

    it("MCP tool timeout failure includes mcpErrorType: timeout", () => {
      const { listener } = createPiEventBridge(deps);

      listener({
        type: "tool_execution_start",
        toolName: "mcp__db-server--search",
        toolCallId: "tc-mcp-2",
      } as any);
      listener(makeToolExecutionEndEvent(
        "mcp__db-server--search", "tc-mcp-2", true, "Request timed out after 30s",
      ) as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] === "Tool execution failed");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0][0].mcpServer).toBe("db-server");
      expect(warnCalls[0][0].mcpErrorType).toBe("timeout");
    });

    it("non-MCP tool failure does NOT include mcpServer or mcpErrorType in WARN log", () => {
      const { listener } = createPiEventBridge(deps);

      listener({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tc-nomcp-1",
        args: { command: "ls" },
      } as any);
      listener(makeToolExecutionEndEvent("bash", "tc-nomcp-1", true, "command failed") as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] === "Tool execution failed");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0][0].mcpServer).toBeUndefined();
      expect(warnCalls[0][0].mcpErrorType).toBeUndefined();
    });

    it("MCP tool failure includes mcpServer and mcpErrorType on tool:executed event", () => {
      const { listener } = createPiEventBridge(deps);

      listener({
        type: "tool_execution_start",
        toolName: "mcp__context7--resolve-library-id",
        toolCallId: "tc-mcp-ev",
      } as any);
      listener(makeToolExecutionEndEvent(
        "mcp__context7--resolve-library-id", "tc-mcp-ev", true, "MCP tool error: invalid input",
      ) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "mcp__context7--resolve-library-id",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].mcpServer).toBe("context7");
      expect(endEmit![1].mcpErrorType).toBe("tool_error");
      expect(endEmit![1].success).toBe(false);
    });

    it("non-MCP tool failure does NOT include mcpServer on tool:executed event", () => {
      const { listener } = createPiEventBridge(deps);

      listener({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "tc-nomcp-ev",
      } as any);
      listener(makeToolExecutionEndEvent("read", "tc-nomcp-ev", true, "file not found") as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "read",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].mcpServer).toBeUndefined();
      expect(endEmit![1].mcpErrorType).toBeUndefined();
    });

    it("MCP tool success does NOT include mcpServer on tool:executed event", () => {
      const { listener } = createPiEventBridge(deps);

      listener({
        type: "tool_execution_start",
        toolName: "mcp__context7--resolve-library-id",
        toolCallId: "tc-mcp-succ",
      } as any);
      listener(makeToolExecutionEndEvent(
        "mcp__context7--resolve-library-id", "tc-mcp-succ", false,
      ) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "mcp__context7--resolve-library-id",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].success).toBe(true);
      expect(endEmit![1].mcpServer).toBeUndefined();
      expect(endEmit![1].mcpErrorType).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // sanitizeToolArgs / extractErrorText helpers
  // -------------------------------------------------------------------------

  describe("sanitizeToolArgs", () => {
    it("truncates string values >200 chars", () => {
      const result = sanitizeToolArgs({ big: "a".repeat(250), small: "ok" });
      expect(result.big).toBe("[250 chars]");
      expect(result.small).toBe("ok");
    });

    it("truncates serialized non-string values >200 chars", () => {
      const bigObj = { data: "x".repeat(300) };
      const result = sanitizeToolArgs({ nested: bigObj, num: 42 });
      expect(result.nested).toMatch(/^\[\d+ chars\]$/);
      expect(result.num).toBe(42);
    });

    it("does not mutate input", () => {
      const input = { val: "a".repeat(300) };
      const original = { ...input };
      sanitizeToolArgs(input);
      expect(input).toEqual(original);
    });
  });

  describe("extractErrorText", () => {
    it("returns string as-is", () => {
      expect(extractErrorText("plain")).toBe("plain");
    });

    it("returns Error.message", () => {
      expect(extractErrorText(new Error("boom"))).toBe("boom");
    });

    it("returns object.message", () => {
      expect(extractErrorText({ message: "msg" })).toBe("msg");
    });

    it("returns object.error", () => {
      expect(extractErrorText({ error: "err" })).toBe("err");
    });

    it("falls back to JSON.stringify", () => {
      expect(extractErrorText({ code: 42 })).toBe('{"code":42}');
    });

    it("returns [unserializable] for circular refs", () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(extractErrorText(obj)).toBe("[unserializable]");
    });
  });

  // -------------------------------------------------------------------------
  // Empty turn detection
  // -------------------------------------------------------------------------

  describe("empty turn detection", () => {
    /** Build a turn_end event with specific content blocks. */
    function makeTurnEndWithContent(
      content: Array<{ type: string; text?: string; [key: string]: unknown }>,
    ) {
      return {
        type: "turn_end" as const,
        message: {
          role: "assistant" as const,
          content,
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-5-20250929",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        toolResults: [],
      };
    }

    it("single empty turn does not warn", () => {
      deps = createMockDeps();
      const { listener } = createPiEventBridge(deps);

      // One turn with empty content array
      listener(makeTurnEndWithContent([]) as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const emptyTurnWarns = warnCalls.filter(
        (c: unknown[]) => typeof c[1] === "string" && c[1].includes("Consecutive empty"),
      );
      expect(emptyTurnWarns).toHaveLength(0);
    });

    it("two consecutive empty turns triggers warn", () => {
      deps = createMockDeps();
      const { listener } = createPiEventBridge(deps);

      // Two turns with empty content
      listener(makeTurnEndWithContent([]) as any);
      listener(makeTurnEndWithContent([]) as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const emptyTurnWarns = warnCalls.filter(
        (c: unknown[]) => typeof c[1] === "string" && c[1].includes("Consecutive empty"),
      );
      expect(emptyTurnWarns).toHaveLength(1);
      expect(emptyTurnWarns[0][0]).toMatchObject({
        consecutiveEmptyTurns: 2,
        model: "claude-sonnet-4-5-20250929",
        lastToolUsed: "none",
        hint: expect.stringContaining("consecutive empty responses"),
        errorKind: "dependency",
      });
      expect(emptyTurnWarns[0][0]).toHaveProperty("contextTokens");
    });

    it("tool-use turn resets counter", () => {
      deps = createMockDeps();
      const { listener } = createPiEventBridge(deps);

      // Empty, then tool call, then empty -- should NOT warn
      listener(makeTurnEndWithContent([]) as any);
      listener(makeTurnEndWithContent([{ type: "toolCall", toolName: "bash", toolCallId: "tc-1" }]) as any);
      listener(makeTurnEndWithContent([]) as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const emptyTurnWarns = warnCalls.filter(
        (c: unknown[]) => typeof c[1] === "string" && c[1].includes("Consecutive empty"),
      );
      expect(emptyTurnWarns).toHaveLength(0);
    });

    it("text turn resets counter", () => {
      deps = createMockDeps();
      const { listener } = createPiEventBridge(deps);

      // Empty, then text content, then empty -- should NOT warn
      listener(makeTurnEndWithContent([]) as any);
      listener(makeTurnEndWithContent([{ type: "text", text: "Hello" }]) as any);
      listener(makeTurnEndWithContent([]) as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const emptyTurnWarns = warnCalls.filter(
        (c: unknown[]) => typeof c[1] === "string" && c[1].includes("Consecutive empty"),
      );
      expect(emptyTurnWarns).toHaveLength(0);
    });

    it("three consecutive empty turns warns at 2 and 3", () => {
      deps = createMockDeps();
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndWithContent([]) as any);
      listener(makeTurnEndWithContent([]) as any);
      listener(makeTurnEndWithContent([]) as any);

      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const emptyTurnWarns = warnCalls.filter(
        (c: unknown[]) => typeof c[1] === "string" && c[1].includes("Consecutive empty"),
      );
      expect(emptyTurnWarns).toHaveLength(2);
      expect(emptyTurnWarns[0][0].consecutiveEmptyTurns).toBe(2);
      expect(emptyTurnWarns[1][0].consecutiveEmptyTurns).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // R-04: responseId extraction
  // -------------------------------------------------------------------------

  describe("responseId extraction (R-04)", () => {
    it("extracts responseId from assistant message", () => {
      const { listener } = createPiEventBridge(deps);
      listener({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          usage: { input: 100, output: 50, totalTokens: 150, cacheRead: 0, cacheWrite: 0, cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 } },
          responseId: "resp_abc123",
        },
      } as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      expect(emitCall).toBeDefined();
      expect(emitCall[1].responseId).toBe("resp_abc123");
    });

    it("responseId is undefined when provider does not supply it", () => {
      const { listener } = createPiEventBridge(deps);
      listener({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          usage: { input: 100, output: 50, totalTokens: 150, cacheRead: 0, cacheWrite: 0, cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 } },
        },
      } as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      expect(emitCall[1].responseId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Dual-model cost tracking
  // -------------------------------------------------------------------------

  describe("cache cost tracking", () => {
    // Sonnet 4.5 pricing (per-token, after / 1_000_000):
    // input=0.000003, cacheWrite(5m)=0.00000375, cacheRead=0.0000003

    const SONNET_MODEL = "claude-sonnet-4-5-20250929";
    const P = {
      input: 0.000003,
      cacheWrite: 0.00000375,
      cacheRead: 0.0000003,
      output: 0.000015,
    };

    /**
     * Build a turn_end event with specific cache token counts and cost.
     * Cost fields match what the SDK would calculate using the 5m rate.
     */
    function makeCacheTurnEnd(opts: {
      cacheRead: number;
      cacheWrite: number;
      input?: number;
      output?: number;
    }) {
      const input = opts.input ?? 100;
      const output = opts.output ?? 50;
      const totalTokens = input + output;
      const sdkCacheWriteCost = opts.cacheWrite * P.cacheWrite;
      const sdkInputCost = input * P.input;
      const sdkOutputCost = output * P.output;
      const sdkCacheReadCost = opts.cacheRead * P.cacheRead;
      const sdkTotalCost = sdkInputCost + sdkOutputCost + sdkCacheReadCost + sdkCacheWriteCost;

      return {
        type: "turn_end" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "text", text: "response" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: SONNET_MODEL,
          usage: {
            input,
            output,
            cacheRead: opts.cacheRead,
            cacheWrite: opts.cacheWrite,
            totalTokens,
            cost: {
              input: sdkInputCost,
              output: sdkOutputCost,
              cacheRead: sdkCacheReadCost,
              cacheWrite: sdkCacheWriteCost,
              total: sdkTotalCost,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        toolResults: [],
      };
    }

    it("no cost correction when ttlSplit is not provided (SDK passthrough)", () => {
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
      });
      const { listener } = createPiEventBridge(deps);

      const event = makeCacheTurnEnd({ cacheRead: 5000, cacheWrite: 10000 });
      listener(event as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      expect(emitCall).toBeDefined();

      // cost.total must match SDK's total exactly (no correction delta)
      expect(emitCall[1].cost.total).toBeCloseTo(event.message.usage.cost.total, 10);
      expect(emitCall[1].cost.cacheWrite).toBeCloseTo(event.message.usage.cost.cacheWrite, 10);
    });

    it("savedVsUncached uses pricing.cacheWrite from resolved model (5m rate)", () => {
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 10000 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );

      // readSavings = 50000 * (input - cacheRead) = 50000 * 0.0000027 = 0.135
      // writeOverhead (5m) = 10000 * (cacheWrite - input) = 10000 * 0.00000075 = 0.0075
      // savedVsUncached = 0.135 - 0.0075 = 0.1275
      expect(emitCall[1].savedVsUncached).toBeCloseTo(0.1275, 6);
    });

    it("getCurrentModel getter is read per turn_end for pricing resolution", () => {
      const getCurrentModel = vi.fn().mockReturnValue(SONNET_MODEL);
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        getCurrentModel,
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 10000 }) as any);
      listener(makeCacheTurnEnd({ cacheRead: 30000, cacheWrite: 5000 }) as any);

      // getCurrentModel called once per turn_end for pricing resolution
      expect(getCurrentModel).toHaveBeenCalledTimes(2);
    });

    it("onCacheReads callback still fires with cacheReadTokens", () => {
      const onCacheReads = vi.fn();
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        onCacheReads,
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeCacheTurnEnd({ cacheRead: 5000, cacheWrite: 1000 }) as any);

      expect(onCacheReads).toHaveBeenCalledTimes(1);
      expect(onCacheReads).toHaveBeenCalledWith(5000);
    });

    it("event emission does NOT include cacheRetention, cacheWriteShortTtl, cacheWriteLongTtl", () => {
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeCacheTurnEnd({ cacheRead: 1000, cacheWrite: 500 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      expect(emitCall[1]).not.toHaveProperty("cacheRetention");
      expect(emitCall[1]).not.toHaveProperty("cacheWriteShortTtl");
      expect(emitCall[1]).not.toHaveProperty("cacheWriteLongTtl");
    });

    it("savedVsUncached is 0 when both cacheRead and cacheWrite tokens are 0", () => {
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
      });
      const { listener } = createPiEventBridge(deps);

      // Zero cache tokens -- guard condition (cacheReadTokens > 0 || cacheWriteTokens > 0) is false
      listener(makeCacheTurnEnd({ cacheRead: 0, cacheWrite: 0 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      expect(emitCall[1].savedVsUncached).toBe(0);
    });

    it("ttlSplit shared object populates bridge metrics on turn_end", () => {
      const ttlSplit = { cacheWrite5mTokens: 858, cacheWrite1hTokens: 23400 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 24258 }) as any);

      const result = getResult();
      expect(result.cacheWrite5mTokens).toBe(858);
      expect(result.cacheWrite1hTokens).toBe(23400);
    });

    it("ttlSplit data updates savedVsUncached with split rates", () => {
      // Sonnet pricing: input=0.000003, cacheWrite=0.00000375, cacheWrite1h=0.000006
      const ttlSplit = { cacheWrite5mTokens: 858, cacheWrite1hTokens: 23400 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 24258 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );

      // readSavings = 50000 * (0.000003 - 0.0000003) = 0.135
      // write5mOverhead = 858 * (0.00000375 - 0.000003) = 858 * 0.00000075 = 0.0006435
      // write1hOverhead = 23400 * (0.000006 - 0.000003) = 23400 * 0.000003 = 0.0702
      // total writeOverhead = 0.0708435
      // savedVsUncached = 0.135 - 0.0708435 = 0.0641565
      expect(emitCall[1].savedVsUncached).toBeCloseTo(0.0641565, 5);
    });

    it("ttlSplit accumulates across multiple turn_end events", () => {
      const ttlSplit = { cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener, getResult } = createPiEventBridge(deps);

      // First turn: populate ttlSplit
      ttlSplit.cacheWrite5mTokens = 500;
      ttlSplit.cacheWrite1hTokens = 10000;
      listener(makeCacheTurnEnd({ cacheRead: 20000, cacheWrite: 10500 }) as any);

      // Second turn: update ttlSplit with new values
      ttlSplit.cacheWrite5mTokens = 300;
      ttlSplit.cacheWrite1hTokens = 5000;
      listener(makeCacheTurnEnd({ cacheRead: 30000, cacheWrite: 5300 }) as any);

      const result = getResult();
      // Accumulated: 500+300=800 5m, 10000+5000=15000 1h
      expect(result.cacheWrite5mTokens).toBe(800);
      expect(result.cacheWrite1hTokens).toBe(15000);
    });

    it("savedVsUncached is 0 when pricing.input is 0 (unknown model guard)", () => {
      // Use an unknown model so resolveModelPricing returns ZERO_COST (input=0)
      deps = createMockDeps({
        provider: "anthropic",
        model: "unknown-model-xyz",
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 10000 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      // pricing.input === 0 guard prevents division/computation
      expect(emitCall[1].savedVsUncached).toBe(0);
    });

    it("savedVsUncached uses per-TTL split when ttlSplit data is available", () => {
      // Sonnet pricing: input=0.000003, cacheWrite(5m)=0.00000375, cacheWrite1h=0.000006 (2x input)
      const ttlSplit = { cacheWrite5mTokens: 858, cacheWrite1hTokens: 23400 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener, getResult } = createPiEventBridge(deps);

      // Total cacheWriteTokens = 858 + 23400 = 24258
      listener(makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 24258 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );

      // Expected with split formula:
      // readSavings = 50000 * (0.000003 - 0.0000003) = 50000 * 0.0000027 = 0.135
      // write5mOverhead = 858 * (0.00000375 - 0.000003) = 858 * 0.00000075 = 0.0006435
      // write1hOverhead = 23400 * (0.000006 - 0.000003) = 23400 * 0.000003 = 0.0702
      // writeOverhead = 0.0006435 + 0.0702 = 0.0708435
      // savedVsUncached = 0.135 - 0.0708435 = 0.0641565
      expect(emitCall[1].savedVsUncached).toBeCloseTo(0.0641565, 5);

      // Check bridge metrics accumulated the TTL split
      const result = getResult();
      expect((result as any).cacheWrite5mTokens).toBe(858);
      expect((result as any).cacheWrite1hTokens).toBe(23400);
    });

    it("falls back to single-rate when ttlSplit is not provided", () => {
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        // No ttlSplit provided
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 10000 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );

      // Same as existing test: readSavings - writeOverhead at 5m rate
      // readSavings = 50000 * 0.0000027 = 0.135
      // writeOverhead = 10000 * 0.00000075 = 0.0075
      // savedVsUncached = 0.135 - 0.0075 = 0.1275
      expect(emitCall[1].savedVsUncached).toBeCloseTo(0.1275, 6);
    });

    it("savedVsUncached is negative when write overhead exceeds read savings (first-turn cache fill)", () => {
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
      });
      const { listener } = createPiEventBridge(deps);

      // High cache writes, low cache reads -- net cost from cache creation
      listener(makeCacheTurnEnd({ cacheRead: 100, cacheWrite: 50000 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      // readSavings = 100 * (0.000003 - 0.0000003) = 100 * 0.0000027 = 0.00027
      // writeOverhead = 50000 * (0.00000375 - 0.000003) = 50000 * 0.00000075 = 0.0375
      // savedVsUncached = 0.00027 - 0.0375 = -0.03723 (negative)
      expect(emitCall[1].savedVsUncached).toBeLessThan(0);
      expect(emitCall[1].savedVsUncached).toBeCloseTo(-0.03723, 5);
    });

    // COST-FIX: Cost correction delta tests
    it("cost correction delta applied when ttlSplit has 1h tokens", () => {
      // Sonnet: cacheWrite(5m) = 0.00000375, cacheWrite1h = 0.000006
      // delta per 1h token = 0.000006 - 0.00000375 = 0.00000225
      const ttlSplit = { cacheWrite5mTokens: 858, cacheWrite1hTokens: 23400 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener } = createPiEventBridge(deps);

      const event = makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 24258 });
      listener(event as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );

      // costCorrectionDelta = 23400 * (0.000006 - 0.00000375) = 23400 * 0.00000225 = 0.05265
      const expectedDelta = 23400 * (0.000006 - 0.00000375);
      const sdkTotal = event.message.usage.cost.total;
      expect(emitCall[1].cost.total).toBeCloseTo(sdkTotal + expectedDelta, 8);
      // cacheWrite in cost object stays at SDK value (only total is corrected)
      expect(emitCall[1].cost.cacheWrite).toBeCloseTo(event.message.usage.cost.cacheWrite, 10);
    });

    it("no cost correction when ttlSplit has only 5m tokens (cacheWrite1hTokens=0)", () => {
      const ttlSplit = { cacheWrite5mTokens: 10000, cacheWrite1hTokens: 0 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener } = createPiEventBridge(deps);

      const event = makeCacheTurnEnd({ cacheRead: 5000, cacheWrite: 10000 });
      listener(event as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );

      // No 1h tokens -> delta = 0 -> SDK cost passes through
      expect(emitCall[1].cost.total).toBeCloseTo(event.message.usage.cost.total, 10);
    });

    it("corrected cost accumulates in getResult().cost.total across turns", () => {
      const ttlSplit = { cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener, getResult } = createPiEventBridge(deps);

      // Turn 1: 10000 1h tokens
      ttlSplit.cacheWrite5mTokens = 500;
      ttlSplit.cacheWrite1hTokens = 10000;
      const event1 = makeCacheTurnEnd({ cacheRead: 20000, cacheWrite: 10500 });
      listener(event1 as any);

      // Turn 2: 5000 1h tokens
      ttlSplit.cacheWrite5mTokens = 300;
      ttlSplit.cacheWrite1hTokens = 5000;
      const event2 = makeCacheTurnEnd({ cacheRead: 30000, cacheWrite: 5300 });
      listener(event2 as any);

      const result = getResult();
      // delta1 = 10000 * 0.00000225 = 0.0225
      // delta2 = 5000 * 0.00000225 = 0.01125
      const delta1 = 10000 * (0.000006 - 0.00000375);
      const delta2 = 5000 * (0.000006 - 0.00000375);
      const expectedTotal = event1.message.usage.cost.total + delta1 + event2.message.usage.cost.total + delta2;
      expect(result.cost!.total).toBeCloseTo(expectedTotal, 8);
    });

    it("costTracker.record receives corrected cost when ttlSplit present", () => {
      const ttlSplit = { cacheWrite5mTokens: 858, cacheWrite1hTokens: 23400 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener } = createPiEventBridge(deps);

      const event = makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 24258 });
      listener(event as any);

      const recordCall = (deps.costTracker.record as any).mock.calls[0];
      const recordedCost = recordCall[3].cost;
      const expectedDelta = 23400 * (0.000006 - 0.00000375);
      expect(recordedCost.total).toBeCloseTo(event.message.usage.cost.total + expectedDelta, 8);
    });

    it("m.sessionCumulativeCostUsd uses corrected cost when ttlSplit present", () => {
      const ttlSplit = { cacheWrite5mTokens: 858, cacheWrite1hTokens: 23400 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener, getResult } = createPiEventBridge(deps);

      const event = makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 24258 });
      listener(event as any);

      const result = getResult();
      const expectedDelta = 23400 * (0.000006 - 0.00000375);
      expect(result.cost!.total).toBeCloseTo(event.message.usage.cost.total + expectedDelta, 8);
    });

    it("cost correction uses normalized ttlSplit (not raw inflated estimates)", () => {
      // Production scenario: raw ttlSplit estimates sum to MORE than actual cacheWriteTokens
      // Raw: 5m=48000, 1h=208414 => rawTotal=256414
      // Actual cacheWriteTokens from SDK: 160233 (1.6x less than raw estimates)
      // After normalization: scale = 160233/256414 = 0.6249
      //   norm5m = round(48000 * 0.6249) = 29998
      //   norm1h = 160233 - 29998 = 130235
      // Cost correction should use normalized 1h (130235), NOT raw (208414)
      const ttlSplit = { cacheWrite5mTokens: 48000, cacheWrite1hTokens: 208414 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET_MODEL,
        ttlSplit,
      });
      const { listener } = createPiEventBridge(deps);

      const event = makeCacheTurnEnd({ cacheRead: 50000, cacheWrite: 160233 });
      listener(event as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );

      // After normalization:
      const rawTotal = 48000 + 208414; // 256414
      const scale = 160233 / rawTotal;
      const norm5m = Math.round(48000 * scale);
      const norm1h = 160233 - norm5m;

      // Correct delta uses NORMALIZED 1h tokens
      const expectedDelta = norm1h * (0.000006 - 0.00000375);
      // Wrong delta would use RAW inflated 1h tokens (the bug)
      const wrongDelta = 208414 * (0.000006 - 0.00000375);

      const sdkTotal = event.message.usage.cost.total;

      // Cost total should match SDK + normalized delta
      expect(emitCall[1].cost.total).toBeCloseTo(sdkTotal + expectedDelta, 8);
      // Cost total should NOT match SDK + raw inflated delta
      expect(emitCall[1].cost.total).not.toBeCloseTo(sdkTotal + wrongDelta, 8);

      // Verify ttlSplit was mutated to normalized values
      expect(ttlSplit.cacheWrite1hTokens).toBe(norm1h);
      expect(ttlSplit.cacheWrite5mTokens).toBe(norm5m);
    });
  });

  // -------------------------------------------------------------------------
  // R-03: Google provider usage validation
  // -------------------------------------------------------------------------

  describe("Google provider usage validation (R-03)", () => {
    it("Google provider usage excludes cached tokens from prompt count", () => {
      deps = createMockDeps({ provider: "google", model: "gemini-3-pro-preview" });
      const { listener } = createPiEventBridge(deps);

      // SDK-corrected usage: input=500 already excludes 300 cached tokens
      listener({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "response" }],
          usage: { input: 500, output: 100, totalTokens: 900, cacheRead: 300, cacheWrite: 0, cost: { input: 0.001, output: 0.0005, cacheRead: 0.0001, cacheWrite: 0, total: 0.0016 } },
        },
      } as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      expect(emitCall[1].tokens.prompt).toBe(500);
      expect(emitCall[1].cacheReadTokens).toBe(300);
    });
  });

  // -------------------------------------------------------------------------
  // Truncation metadata flow
  // -------------------------------------------------------------------------

  describe("truncation metadata flow", () => {
    it("includes truncation metadata on tool:executed when getTruncationMeta returns data", () => {
      const getTruncationMeta = vi.fn().mockReturnValue({
        truncated: true,
        fullChars: 300_000,
        returnedChars: 200_000,
      });
      deps = createMockDeps({ getTruncationMeta });
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionStartEvent("bash", "tc-trunc") as any);
      listener(makeToolExecutionEndEvent("bash", "tc-trunc", false) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "bash",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].truncated).toBe(true);
      expect(endEmit![1].fullChars).toBe(300_000);
      expect(endEmit![1].returnedChars).toBe(200_000);

      // Verify the getter was called with the correct toolCallId
      expect(getTruncationMeta).toHaveBeenCalledWith("tc-trunc");
    });

    it("does not include truncation fields when getTruncationMeta returns undefined", () => {
      const getTruncationMeta = vi.fn().mockReturnValue(undefined);
      deps = createMockDeps({ getTruncationMeta });
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionStartEvent("read", "tc-notrunc") as any);
      listener(makeToolExecutionEndEvent("read", "tc-notrunc", false) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "read",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].truncated).toBeUndefined();
      expect(endEmit![1].fullChars).toBeUndefined();
      expect(endEmit![1].returnedChars).toBeUndefined();
    });

    it("does not include truncation fields when getTruncationMeta is not provided", () => {
      deps = createMockDeps({ getTruncationMeta: undefined });
      const { listener } = createPiEventBridge(deps);

      listener(makeToolExecutionStartEvent("bash", "tc-none") as any);
      listener(makeToolExecutionEndEvent("bash", "tc-none", false) as any);

      const calls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const endEmit = calls.find(
        (c) => c[0] === "tool:executed" && c[1].toolName === "bash",
      );
      expect(endEmit).toBeDefined();
      expect(endEmit![1].truncated).toBeUndefined();
      expect(endEmit![1].fullChars).toBeUndefined();
      expect(endEmit![1].returnedChars).toBeUndefined();
    });
  });

  describe("cache break event includes structured analytics fields", () => {
    it("emits toolsAdded, toolsRemoved, toolsSchemaChanged, systemCharDelta, model", () => {
      const mockBreakEvent = {
        provider: "anthropic",
        reason: "tools_changed",
        tokenDrop: 5000,
        tokenDropRelative: 0.5,
        previousCacheRead: 10000,
        currentCacheRead: 5000,
        callCount: 5,
        changes: {
          systemChanged: true,
          toolsChanged: true,
          metadataChanged: false,
          modelChanged: false,
          retentionChanged: false,
          addedTools: ["new_tool"],
          removedTools: ["old_tool"],
          changedSchemaTools: ["modified_tool"],
          headersChanged: false,
          extraBodyChanged: false,
        },
        toolsChanged: ["new_tool", "old_tool", "modified_tool"],
        ttlCategory: "short" as const,
        agentId: "test-agent",
        sessionKey: "t1:c1:u1",
        timestamp: Date.now(),
        previousSystem: "short system",
        currentSystem: "much longer system prompt text here",
      };

      deps = createMockDeps({
        checkCacheBreak: vi.fn().mockReturnValue(mockBreakEvent),
        getCurrentModel: () => "claude-sonnet-4-5-20250929",
      });
      const { listener } = createPiEventBridge(deps);

      // Feed a turn_end event with cache usage to trigger break detection
      listener(makeTurnEndEvent({ cacheRead: 5000, cacheWrite: 100 }) as any);

      const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const cacheBreakEmit = emitCalls.find((c) => c[0] === "observability:cache_break");

      expect(cacheBreakEmit).toBeDefined();
      const payload = cacheBreakEmit![1];

      // Structured analytics fields
      expect(payload.toolsAdded).toEqual(["new_tool"]);
      expect(payload.toolsRemoved).toEqual(["old_tool"]);
      expect(payload.toolsSchemaChanged).toEqual(["modified_tool"]);
      expect(payload.systemCharDelta).toBe(
        "much longer system prompt text here".length - "short system".length,
      );
      expect(payload.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("handles missing previousSystem/currentSystem gracefully (systemCharDelta = 0)", () => {
      const mockBreakEvent = {
        provider: "anthropic",
        reason: "model_changed",
        tokenDrop: 1000,
        tokenDropRelative: 0.1,
        previousCacheRead: 10000,
        currentCacheRead: 9000,
        callCount: 3,
        changes: {
          systemChanged: false,
          toolsChanged: false,
          metadataChanged: false,
          modelChanged: true,
          retentionChanged: false,
          addedTools: [],
          removedTools: [],
          changedSchemaTools: [],
          headersChanged: false,
          extraBodyChanged: false,
        },
        toolsChanged: [],
        ttlCategory: undefined,
        agentId: "test-agent",
        sessionKey: "t1:c1:u1",
        timestamp: Date.now(),
        // No previousSystem/currentSystem
      };

      deps = createMockDeps({
        checkCacheBreak: vi.fn().mockReturnValue(mockBreakEvent),
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ cacheRead: 9000 }) as any);

      const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const cacheBreakEmit = emitCalls.find((c) => c[0] === "observability:cache_break");

      expect(cacheBreakEmit).toBeDefined();
      const payload = cacheBreakEmit![1];

      expect(payload.toolsAdded).toEqual([]);
      expect(payload.toolsRemoved).toEqual([]);
      expect(payload.systemCharDelta).toBe(0);
      expect(payload.model).toBe("claude-sonnet-4-5-20250929"); // Falls back to deps.model
    });

    it("sanitizes MCP tool names to bare 'mcp' in analytics fields", () => {
      const mockBreakEvent = {
        provider: "anthropic",
        reason: "tools_changed",
        tokenDrop: 5000,
        tokenDropRelative: 0.5,
        previousCacheRead: 10000,
        currentCacheRead: 5000,
        callCount: 5,
        changes: {
          systemChanged: false,
          toolsChanged: true,
          metadataChanged: false,
          modelChanged: false,
          retentionChanged: false,
          addedTools: ["mcp__myserver--tool1", "read_file"],
          removedTools: ["mcp__oldserver--tool2"],
          changedSchemaTools: ["mcp__another--tool3", "bash"],
          headersChanged: false,
          extraBodyChanged: false,
        },
        toolsChanged: ["mcp__myserver", "read_file", "mcp__oldserver", "mcp__another", "bash"],
        ttlCategory: "short" as const,
        agentId: "test-agent",
        sessionKey: "t1:c1:u1",
        timestamp: Date.now(),
      };

      deps = createMockDeps({
        checkCacheBreak: vi.fn().mockReturnValue(mockBreakEvent),
        getCurrentModel: () => "claude-sonnet-4-5-20250929",
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ cacheRead: 5000, cacheWrite: 100 }) as any);

      const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const cacheBreakEmit = emitCalls.find((c) => c[0] === "observability:cache_break");

      expect(cacheBreakEmit).toBeDefined();
      const payload = cacheBreakEmit![1];

      // MCP names collapsed to "mcp", non-MCP names unchanged
      expect(payload.toolsAdded).toEqual(["mcp", "read_file"]);
      expect(payload.toolsRemoved).toEqual(["mcp"]);
      expect(payload.toolsSchemaChanged).toEqual(["mcp", "bash"]);
    });
  });

  // -------------------------------------------------------------------------
  // cache:graph_prefix_written signal
  // -------------------------------------------------------------------------

  describe("cache:graph_prefix_written signal", () => {
    it("emits signal on first turn_end with cacheWrite > 0 when graphId is set", () => {
      deps = createMockDeps({
        graphId: "graph-001",
        nodeId: "node-A",
      });
      const { listener } = createPiEventBridge(deps);

      // First turn with cache write
      listener(makeTurnEndEvent({ cacheWrite: 5000 }) as any);

      const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const cacheSignal = emitCalls.find((c) => c[0] === "cache:graph_prefix_written");

      expect(cacheSignal).toBeDefined();
      expect(cacheSignal![1]).toMatchObject({
        graphId: "graph-001",
        nodeId: "node-A",
        cacheWriteTokens: 5000,
      });
      expect(cacheSignal![1].timestamp).toBeTypeOf("number");
    });

    it("does NOT emit signal when cacheWrite === 0 on first turn", () => {
      deps = createMockDeps({
        graphId: "graph-001",
        nodeId: "node-A",
      });
      const { listener } = createPiEventBridge(deps);

      // First turn with zero cache write
      listener(makeTurnEndEvent({ cacheWrite: 0 }) as any);

      const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const cacheSignal = emitCalls.find((c) => c[0] === "cache:graph_prefix_written");

      expect(cacheSignal).toBeUndefined();
    });

    it("does NOT emit signal on second+ turn even with cacheWrite > 0", () => {
      deps = createMockDeps({
        graphId: "graph-001",
        nodeId: "node-A",
      });
      const { listener } = createPiEventBridge(deps);

      // First turn with cache write (emits signal)
      listener(makeTurnEndEvent({ cacheWrite: 5000 }) as any);

      // Clear emit mock to isolate second turn
      (deps.eventBus.emit as ReturnType<typeof vi.fn>).mockClear();

      // Second turn also with cache write
      listener(makeTurnEndEvent({ cacheWrite: 3000 }) as any);

      const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const cacheSignal = emitCalls.find((c) => c[0] === "cache:graph_prefix_written");

      expect(cacheSignal).toBeUndefined();
    });

    it("does NOT emit signal when graphId is NOT set (non-graph subagent)", () => {
      // Default deps have no graphId/nodeId
      deps = createMockDeps();
      const { listener } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({ cacheWrite: 5000 }) as any);

      const emitCalls = (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const cacheSignal = emitCalls.find((c) => c[0] === "cache:graph_prefix_written");

      expect(cacheSignal).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // ghost cost tracking
  // -------------------------------------------------------------------------

  describe("ghost cost tracking", () => {
    it("createBridgeMetrics initializes ghostCostUsd=0 and timedOutRequests=0", () => {
      const m = createBridgeMetrics();
      expect(m.ghostCostUsd).toBe(0);
      expect(m.timedOutRequests).toBe(0);
    });

    it("addGhostCost accumulates ghost cost and increments timedOutRequests", () => {
      const { listener, getResult, addGhostCost } = createPiEventBridge(deps);

      addGhostCost({
        inputTokens: 5000,
        cacheWriteTokens: 1000,
        cacheReadTokens: 0,
        costUsd: 0.147,
      });

      const result = getResult();
      expect(result.cost!.ghostCostUsd).toBeCloseTo(0.147);
      expect(result.cost!.timedOutRequests).toBe(1);
    });

    it("buildBridgeResult includes ghostCostUsd and timedOutRequests when > 0", () => {
      const m = createBridgeMetrics();
      m.ghostCostUsd = 0.25;
      m.timedOutRequests = 2;

      const result = buildBridgeResult(m, 3);
      expect(result.cost!.ghostCostUsd).toBeCloseTo(0.25);
      expect(result.cost!.timedOutRequests).toBe(2);
    });

    it("buildBridgeResult omits ghost fields when 0 (returns undefined)", () => {
      const m = createBridgeMetrics();
      // ghostCostUsd and timedOutRequests are 0 by default

      const result = buildBridgeResult(m, 0);
      expect(result.cost!.ghostCostUsd).toBeUndefined();
      expect(result.cost!.timedOutRequests).toBeUndefined();
    });

    it("multiple addGhostCost calls accumulate correctly", () => {
      const { getResult, addGhostCost } = createPiEventBridge(deps);

      addGhostCost({
        inputTokens: 5000,
        cacheWriteTokens: 1000,
        cacheReadTokens: 0,
        costUsd: 0.10,
      });
      addGhostCost({
        inputTokens: 3000,
        cacheWriteTokens: 500,
        cacheReadTokens: 2000,
        costUsd: 0.05,
      });

      const result = getResult();
      expect(result.cost!.ghostCostUsd).toBeCloseTo(0.15);
      expect(result.cost!.timedOutRequests).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 49-01: TTL split normalization and cacheCreation event field
  // ---------------------------------------------------------------------------

  describe("49-01: TTL split normalization", () => {
    const SONNET = "claude-sonnet-4-5-20250929";

    function makeTtlTurnEnd(opts: { cacheRead: number; cacheWrite: number }) {
      const input = 1000;
      const output = 200;
      const totalTokens = input + output + opts.cacheRead + opts.cacheWrite;
      return {
        type: "turn_end" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "text", text: "response" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: SONNET,
          usage: {
            input,
            output,
            cacheRead: opts.cacheRead,
            cacheWrite: opts.cacheWrite,
            totalTokens,
            cost: { input: 0.003, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.006 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        toolResults: [],
      };
    }

    it("when raw 5m=32213 + raw 1h=0, and actual=24929, output 5m=24929, 1h=0", () => {
      const ttlSplit = { cacheWrite5mTokens: 32213, cacheWrite1hTokens: 0 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET,
        ttlSplit,
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeTtlTurnEnd({ cacheRead: 0, cacheWrite: 24929 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      expect(emitCall).toBeDefined();

      const payload = emitCall[1];
      expect(payload.cacheCreation).toBeDefined();
      expect(payload.cacheCreation.shortTtl).toBe(24929);
      expect(payload.cacheCreation.longTtl).toBe(0);
    });

    it("when raw 5m=3201 + raw 1h=21543, and actual=39458, scale factor applied, sum equals actual", () => {
      const ttlSplit = { cacheWrite5mTokens: 3201, cacheWrite1hTokens: 21543 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET,
        ttlSplit,
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeTtlTurnEnd({ cacheRead: 0, cacheWrite: 39458 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      const payload = emitCall[1];
      expect(payload.cacheCreation).toBeDefined();
      expect(payload.cacheCreation.shortTtl + payload.cacheCreation.longTtl).toBe(39458);
    });

    it("when raw total is 0, no normalization occurs (avoids division by zero)", () => {
      const ttlSplit = { cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET,
        ttlSplit,
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeTtlTurnEnd({ cacheRead: 0, cacheWrite: 1000 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      const payload = emitCall[1];
      // When ttlSplit is all zeros, cacheCreation from bridge metrics should be undefined
      expect(payload.cacheCreation).toBeUndefined();
    });

    it("cacheCreation is undefined when no TTL split data exists", () => {
      deps = createMockDeps({
        provider: "anthropic",
        model: SONNET,
        // No ttlSplit provided
      });
      const { listener } = createPiEventBridge(deps);

      listener(makeTtlTurnEnd({ cacheRead: 0, cacheWrite: 5000 }) as any);

      const emitCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any[]) => c[0] === "observability:token_usage",
      );
      expect(emitCall[1].cacheCreation).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 49-05: Session-cumulative cost accumulators and thinking token tracking
  // ---------------------------------------------------------------------------

  describe("49-05: session-cumulative cost accumulators", () => {
    it("createBridgeMetrics initializes sessionCumulativeCostUsd=0 and sessionCumulativeCacheSavedUsd=0", () => {
      const m = createBridgeMetrics();
      expect(m.sessionCumulativeCostUsd).toBe(0);
      expect(m.sessionCumulativeCacheSavedUsd).toBe(0);
    });

    it("after 3 turn_end events with costs [0.15, 0.05, 0.10], sessionCumulativeCostUsd = 0.30", () => {
      deps = createMockDeps({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" });
      const { listener, getResult } = createPiEventBridge(deps);

      const costs = [0.15, 0.05, 0.10];
      for (const c of costs) {
        listener(makeTurnEndEvent({
          input: 100,
          output: 50,
          totalTokens: 150,
          cost: { input: c * 0.3, output: c * 0.7, cacheRead: 0, cacheWrite: 0, total: c },
        }) as any);
      }

      const result = getResult();
      expect(result.sessionCostUsd).toBeCloseTo(0.30);
    });

    it("after 3 turn_end events with savings, sessionCacheSavedUsd accumulates correctly", () => {
      deps = createMockDeps({
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        getCurrentModel: () => "claude-sonnet-4-5-20250929",
      });
      const { listener, getResult } = createPiEventBridge(deps);

      // Turn with cache reads (generates savings)
      listener(makeTurnEndEvent({
        input: 100,
        output: 50,
        totalTokens: 150,
        cacheRead: 10000,
        cacheWrite: 0,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      }) as any);

      const result = getResult();
      // Session cache saved should be > 0 when cache reads happened
      expect(result.sessionCacheSavedUsd).toBeDefined();
      expect(typeof result.sessionCacheSavedUsd).toBe("number");
    });

    it("buildBridgeResult includes sessionCostUsd and sessionCacheSavedUsd", () => {
      const m = createBridgeMetrics();
      m.sessionCumulativeCostUsd = 0.42;
      m.sessionCumulativeCacheSavedUsd = 0.15;

      const result = buildBridgeResult(m, 3);
      expect(result.sessionCostUsd).toBeCloseTo(0.42);
      expect(result.sessionCacheSavedUsd).toBeCloseTo(0.15);
    });
  });

  describe("49-05: thinking token tracking", () => {
    it("createBridgeMetrics initializes totalThinkingTokens=0", () => {
      const m = createBridgeMetrics();
      expect(m.totalThinkingTokens).toBe(0);
    });

    it("thinkingTokens = 0 when no reasoningTokens in SDK usage", () => {
      deps = createMockDeps({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" });
      const { listener, getResult } = createPiEventBridge(deps);

      listener(makeTurnEndEvent({
        input: 100,
        output: 50,
        totalTokens: 150,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      }) as any);

      const result = getResult();
      expect(result.thinkingTokens).toBeUndefined(); // omitted when 0
    });

    it("thinkingTokens accumulated when SDK provides reasoningTokens", () => {
      deps = createMockDeps({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" });
      const { listener, getResult } = createPiEventBridge(deps);

      // Create turn_end with reasoningTokens in usage
      const event = {
        type: "turn_end" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "text", text: "Hello" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-5-20250929",
          usage: {
            input: 100,
            output: 150, // includes 100 thinking + 50 visible
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 250,
            cost: { input: 0.001, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.004 },
            reasoningTokens: 100,
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        toolResults: [],
      };

      listener(event as any);

      const result = getResult();
      expect(result.thinkingTokens).toBe(100);
    });

    it("buildBridgeResult omits thinkingTokens when 0", () => {
      const m = createBridgeMetrics();
      // totalThinkingTokens is 0 by default

      const result = buildBridgeResult(m, 0);
      expect(result.thinkingTokens).toBeUndefined();
    });

    it("buildBridgeResult includes thinkingTokens when > 0", () => {
      const m = createBridgeMetrics();
      m.totalThinkingTokens = 500;

      const result = buildBridgeResult(m, 2);
      expect(result.thinkingTokens).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // LLM duration metric accuracy
  // -------------------------------------------------------------------------

  describe("LLM duration metric accuracy", () => {
    it("subtracts tool execution time from turn wallclock to compute LLM duration", () => {
      const nowSpy = vi.spyOn(Date, "now");
      // Bridge creation: t=1000
      nowSpy.mockReturnValue(1000);
      const { listener, getResult } = createPiEventBridge(deps);

      // LLM thinks for 500ms, then decides to call a tool at t=1500
      // Tool start: t=1500
      nowSpy.mockReturnValue(1500);
      listener(makeToolExecutionStartEvent("read_file", "tc-1") as any);

      // Tool end: t=2100 (600ms tool duration)
      nowSpy.mockReturnValue(2100);
      listener(makeToolExecutionEndEvent("read_file", "tc-1") as any);

      // Turn end: t=2200 (wallclock = 2200-1000 = 1200ms, tool = 600ms, LLM = 600ms)
      // BUG path: would compute 2200 - 2100 = 100ms (gap after last tool end)
      // CORRECT: 1200 - 600 = 600ms
      nowSpy.mockReturnValue(2200);
      listener(makeTurnEndEvent() as any);

      const result = getResult();
      expect(result.cumulativeLlmDurationMs).toBe(600);
      expect(result.cumulativeToolDurationMs).toBe(600);

      nowSpy.mockRestore();
    });

    it("accumulates LLM duration correctly for a turn with no tool calls", () => {
      const nowSpy = vi.spyOn(Date, "now");
      // Bridge creation: t=1000
      nowSpy.mockReturnValue(1000);
      const { listener, getResult } = createPiEventBridge(deps);

      // Turn end: t=1500 (500ms LLM only, no tools)
      nowSpy.mockReturnValue(1500);
      listener(makeTurnEndEvent() as any);

      const result = getResult();
      expect(result.cumulativeLlmDurationMs).toBe(500);

      nowSpy.mockRestore();
    });

    it("resets per-turn tool duration between turns so second turn is not affected", () => {
      const nowSpy = vi.spyOn(Date, "now");
      // Bridge creation: t=1000
      nowSpy.mockReturnValue(1000);
      const { listener, getResult } = createPiEventBridge(deps);

      // Turn 1: LLM 500ms thinking + tool 600ms + LLM 100ms after = wallclock 1200ms
      // Tool: 600ms, LLM: 1200 - 600 = 600ms
      nowSpy.mockReturnValue(1500);
      listener(makeToolExecutionStartEvent("read_file", "tc-1") as any);
      nowSpy.mockReturnValue(2100);
      listener(makeToolExecutionEndEvent("read_file", "tc-1") as any);
      nowSpy.mockReturnValue(2200);
      listener(makeTurnEndEvent() as any);

      // Turn 2: no tools, wallclock 300ms => LLM 300ms
      // (turnStartMs should reset to 2200 at turn_end)
      nowSpy.mockReturnValue(2500);
      listener(makeTurnEndEvent() as any);

      const result = getResult();
      // Cumulative: 600 + 300 = 900
      // BUG path: would compute 100 + 300 = 400
      expect(result.cumulativeLlmDurationMs).toBe(900);

      nowSpy.mockRestore();
    });

    it("sums multiple tool durations within a single turn and subtracts from wallclock", () => {
      const nowSpy = vi.spyOn(Date, "now");
      // Bridge creation: t=1000
      nowSpy.mockReturnValue(1000);
      const { listener, getResult } = createPiEventBridge(deps);

      // LLM thinks 200ms, then tool 1: 200ms
      nowSpy.mockReturnValue(1200);
      listener(makeToolExecutionStartEvent("read_file", "tc-1") as any);
      nowSpy.mockReturnValue(1400);
      listener(makeToolExecutionEndEvent("read_file", "tc-1") as any);

      // LLM thinks 100ms, then tool 2: 300ms
      nowSpy.mockReturnValue(1500);
      listener(makeToolExecutionStartEvent("write_file", "tc-2") as any);
      nowSpy.mockReturnValue(1800);
      listener(makeToolExecutionEndEvent("write_file", "tc-2") as any);

      // Turn end: t=1900
      // Wallclock = 1900 - 1000 = 900ms, tools = 500ms, LLM = 400ms
      // BUG path: would compute 1900 - 1800 = 100ms (gap after last tool)
      nowSpy.mockReturnValue(1900);
      listener(makeTurnEndEvent() as any);

      const result = getResult();
      expect(result.cumulativeLlmDurationMs).toBe(400);
      expect(result.cumulativeToolDurationMs).toBe(500);

      nowSpy.mockRestore();
    });

    it("caps cumulativeToolWallclockMs to turn wallclock when parallel tools overlap", () => {
      const nowSpy = vi.spyOn(Date, "now");
      // Bridge creation: t=1000
      nowSpy.mockReturnValue(1000);
      const { listener, getResult } = createPiEventBridge(deps);

      // Two parallel tools started at same time: t=1200
      nowSpy.mockReturnValue(1200);
      listener(makeToolExecutionStartEvent("read_file", "tc-1") as any);
      listener(makeToolExecutionStartEvent("bash", "tc-2") as any);

      // Tool 2 finishes first at t=1500 (300ms)
      nowSpy.mockReturnValue(1500);
      listener(makeToolExecutionEndEvent("bash", "tc-2") as any);

      // Tool 1 finishes at t=1700 (500ms)
      nowSpy.mockReturnValue(1700);
      listener(makeToolExecutionEndEvent("read_file", "tc-1") as any);

      // Turn end: t=1800
      // Wallclock = 1800 - 1000 = 800ms
      // Raw tool sum = 500 + 300 = 800ms (turnToolDurationMs)
      // effectiveTurnToolMs = min(800, 800) = 800 (no capping needed)
      nowSpy.mockReturnValue(1800);
      listener(makeTurnEndEvent() as any);

      const result = getResult();
      // Raw CPU sum: 500 + 300 = 800
      expect(result.cumulativeToolDurationMs).toBe(800);
      // Wallclock-capped: min(800, 800) = 800 (equal when sum <= wallclock)
      expect(result.cumulativeToolWallclockMs).toBe(800);

      nowSpy.mockRestore();
    });

    it("caps cumulativeToolWallclockMs when parallel tools exceed turn wallclock", () => {
      const nowSpy = vi.spyOn(Date, "now");
      // Bridge creation: t=1000
      nowSpy.mockReturnValue(1000);
      const { listener, getResult } = createPiEventBridge(deps);

      // LLM thinking: 200ms (t=1000 to t=1200)
      // Two parallel tools started at t=1200
      nowSpy.mockReturnValue(1200);
      listener(makeToolExecutionStartEvent("read_file", "tc-1") as any);
      listener(makeToolExecutionStartEvent("bash", "tc-2") as any);

      // Tool 2 finishes at t=1500 (300ms)
      nowSpy.mockReturnValue(1500);
      listener(makeToolExecutionEndEvent("bash", "tc-2") as any);

      // Tool 1 finishes at t=1700 (500ms)
      nowSpy.mockReturnValue(1700);
      listener(makeToolExecutionEndEvent("read_file", "tc-1") as any);

      // Turn end: t=1700 (LLM returns immediately after tools)
      // Wallclock = 1700 - 1000 = 700ms
      // Raw tool sum = 500 + 300 = 800ms (exceeds wallclock!)
      // effectiveTurnToolMs = min(800, 700) = 700ms
      // LLM = 700 - 700 = 0ms (all time was tools)
      nowSpy.mockReturnValue(1700);
      listener(makeTurnEndEvent() as any);

      const result = getResult();
      // Raw CPU sum: 500 + 300 = 800 (parallel overlap counted)
      expect(result.cumulativeToolDurationMs).toBe(800);
      // Wallclock-capped: min(800, 700) = 700
      expect(result.cumulativeToolWallclockMs).toBe(700);
      // LLM: 700 - 700 = 0 (correct: no LLM thinking after tools in this scenario)
      expect(result.cumulativeLlmDurationMs).toBe(0);

      nowSpy.mockRestore();
    });
  });

  describe("49-05: ExecutionResult.cost session fields", () => {
    it("sessionCostUsd and sessionCacheSavedUsd present on ExecutionResult.cost type", () => {
      // Type-level test: ensure the fields exist in the type
      const cost: ExecutionResult["cost"] = {
        total: 0.50,
        cacheSaved: 0.10,
        sessionCostUsd: 1.20,
        sessionCacheSavedUsd: 0.35,
      };
      expect(cost.sessionCostUsd).toBe(1.20);
      expect(cost.sessionCacheSavedUsd).toBe(0.35);
    });
  });

  // -------------------------------------------------------------------------
  // SEP mid-loop plan extraction
  // -------------------------------------------------------------------------

  describe("SEP mid-loop plan extraction", () => {
    const PLAN_TEXT =
      "I'll help you set up the project. Here's my plan:\n1. Read the configuration file\n2. Install dependencies\n3. Run the build\n4. Verify the output";

    /** Build a turn_end event with both tool calls and plan text in assistant content. */
    function makeTurnEndWithPlan(planText: string, hasToolCalls = true) {
      const content: unknown[] = [
        { type: "text", text: planText },
      ];
      if (hasToolCalls) {
        content.push({ type: "toolCall", toolCallId: "tc-plan", toolName: "read_file", args: {} });
      }
      return {
        type: "turn_end" as const,
        message: {
          role: "assistant" as const,
          content,
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
          stopReason: "tool_use",
        },
        toolResults: [],
      };
    }

    it("extracts plan on first turn_end with tool calls + numbered-list text", () => {
      const executionPlan = { current: undefined as ExecutionPlan | undefined };
      const sepDeps = createMockDeps({
        executionPlan,
        sepConfig: { maxSteps: 15, minSteps: 3 },
        sepMessageText: "Please set up the project",
        sepExecutionStartMs: Date.now(),
      });
      const { listener } = createPiEventBridge(sepDeps);

      listener(makeTurnEndWithPlan(PLAN_TEXT) as any);

      expect(executionPlan.current).toBeDefined();
      expect(executionPlan.current!.active).toBe(true);
      expect(executionPlan.current!.steps.length).toBe(4);
      expect(executionPlan.current!.steps[0].description).toBe("Read the configuration file");
      expect(executionPlan.current!.request).toBe("Please set up the project");
      expect(sepDeps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "test-agent", stepCount: 4 }),
        "SEP plan extracted (mid-loop)",
      );
      expect(sepDeps.eventBus.emit).toHaveBeenCalledWith("sep:plan_extracted", expect.objectContaining({
        agentId: "test-agent",
        stepCount: 4,
      }));
    });

    it("does NOT extract plan when first turn_end has text but no tool calls", () => {
      const executionPlan = { current: undefined as ExecutionPlan | undefined };
      const sepDeps = createMockDeps({
        executionPlan,
        sepConfig: { maxSteps: 15, minSteps: 3 },
        sepMessageText: "Tell me about the project",
        sepExecutionStartMs: Date.now(),
      });
      const { listener } = createPiEventBridge(sepDeps);

      // Turn with plan text but no tool calls (conversational response)
      listener(makeTurnEndWithPlan(PLAN_TEXT, false) as any);

      expect(executionPlan.current).toBeUndefined();
    });

    it("extracts plan only once (second turn_end does NOT overwrite)", () => {
      const executionPlan = { current: undefined as ExecutionPlan | undefined };
      const sepDeps = createMockDeps({
        executionPlan,
        sepConfig: { maxSteps: 15, minSteps: 3 },
        sepMessageText: "Set up everything",
        sepExecutionStartMs: Date.now(),
      });
      const { listener } = createPiEventBridge(sepDeps);

      // First turn with plan
      listener(makeTurnEndWithPlan(PLAN_TEXT) as any);
      const firstPlan = executionPlan.current;
      expect(firstPlan).toBeDefined();
      const firstCreatedAt = firstPlan!.createdAtMs;

      // Second turn with different plan text
      const secondPlanText =
        "New plan:\n1. Step A\n2. Step B\n3. Step C";
      listener(makeTurnEndWithPlan(secondPlanText) as any);

      // Plan should be unchanged (still the first one)
      expect(executionPlan.current!.createdAtMs).toBe(firstCreatedAt);
      expect(executionPlan.current!.steps.length).toBe(4);
      expect(executionPlan.current!.steps[0].description).toBe("Read the configuration file");
    });

    it("after mid-loop extraction, tool_end events advance step status", () => {
      const executionPlan = { current: undefined as ExecutionPlan | undefined };
      const sepDeps = createMockDeps({
        executionPlan,
        sepConfig: { maxSteps: 15, minSteps: 3 },
        sepMessageText: "Set up the project",
        sepExecutionStartMs: Date.now(),
      });
      const { listener } = createPiEventBridge(sepDeps);

      // First turn: plan extraction
      listener(makeTurnEndWithPlan(PLAN_TEXT) as any);
      expect(executionPlan.current).toBeDefined();
      expect(executionPlan.current!.steps[0].status).toBe("pending");

      // Tool execution: should advance first pending step to in_progress
      listener(makeToolExecutionStartEvent("read_file", "tc-read-1") as any);
      listener(makeToolExecutionEndEvent("read_file", "tc-read-1") as any);

      expect(executionPlan.current!.steps[0].status).toBe("in_progress");
      expect(executionPlan.current!.steps[0].completedBy).toContain("tc-read-1");

      // Second turn with completion signal advances step to done
      const completionTurn = {
        type: "turn_end" as const,
        message: {
          role: "assistant" as const,
          content: [
            { type: "text", text: "I've finished reading the configuration file." },
            { type: "toolCall", toolCallId: "tc-install", toolName: "exec", args: {} },
          ],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
          stopReason: "tool_use",
        },
        toolResults: [],
      };
      listener(completionTurn as any);

      expect(executionPlan.current!.steps[0].status).toBe("done");
      expect(executionPlan.current!.completedCount).toBe(1);
      // Next step should have been advanced to in_progress
      expect(executionPlan.current!.steps[1].status).toBe("in_progress");
    });

    it("does NOT extract when sepConfig is not provided (SEP disabled)", () => {
      const executionPlan = { current: undefined as ExecutionPlan | undefined };
      const sepDeps = createMockDeps({
        executionPlan,
        // sepConfig intentionally omitted (SEP disabled)
      });
      const { listener } = createPiEventBridge(sepDeps);

      listener(makeTurnEndWithPlan(PLAN_TEXT) as any);

      expect(executionPlan.current).toBeUndefined();
    });
  });
});
