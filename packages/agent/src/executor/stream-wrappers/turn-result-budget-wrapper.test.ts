import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context, Message } from "@mariozechner/pi-ai";
import { createTurnResultBudgetWrapper } from "./turn-result-budget-wrapper.js";
import { createMockLogger, createMockStreamFn, makeAssistantMessage, makeContext } from "./__test-helpers.js";

describe("createTurnResultBudgetWrapper", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let base: ReturnType<typeof createMockStreamFn>;

  function makeToolResultMessage(
    toolName: string,
    text: string,
    toolCallId?: string,
  ): Message {
    return {
      role: "toolResult",
      toolCallId: toolCallId ?? `tc-${toolName}`,
      toolName,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    };
  }

  beforeEach(() => {
    logger = createMockLogger();
    base = createMockStreamFn();
  });

  it("passes through under-budget contexts unchanged", () => {
    const { wrapper } = createTurnResultBudgetWrapper(200_000, 500, logger);
    const wrappedFn = wrapper(base);

    // Two tool results well under 200K aggregate
    const assistantMsg = makeAssistantMessage([{ type: "text", text: "thinking" }]);
    const tool1 = makeToolResultMessage("bash", "x".repeat(1_000), "tc-1");
    const tool2 = makeToolResultMessage("read", "y".repeat(2_000), "tc-2");
    const context = makeContext([assistantMsg, tool1, tool2]);
    const model = {} as any;

    wrappedFn(model, context);

    // Should pass original context unchanged
    expect(base.mock.calls[0][1]).toBe(context);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("truncates over-budget contexts", () => {
    const { wrapper } = createTurnResultBudgetWrapper(10_000, 500, logger);
    const wrappedFn = wrapper(base);

    // Two tool results, each 8K chars = 16K total, budget is 10K
    const assistantMsg = makeAssistantMessage([{ type: "text", text: "thinking" }]);
    const tool1 = makeToolResultMessage("bash", "a".repeat(8_000), "tc-1");
    const tool2 = makeToolResultMessage("read", "b".repeat(8_000), "tc-2");
    const context = makeContext([assistantMsg, tool1, tool2]);
    const model = {} as any;

    wrappedFn(model, context);

    // Should pass modified context
    const calledContext = base.mock.calls[0][1] as Context;
    expect(calledContext).not.toBe(context);

    // Messages should be truncated
    const calledTool1 = calledContext.messages[1] as any;
    const calledTool2 = calledContext.messages[2] as any;
    const tool1Text = calledTool1.content[0].text;
    const tool2Text = calledTool2.content[0].text;

    // At least one tool should be truncated below original size
    const totalResultChars = tool1Text.length + tool2Text.length;
    expect(totalResultChars).toBeLessThan(16_000);

    // WARN should have been emitted
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnsExceeded: 1,
        maxTurnChars: 10_000,
        hint: expect.stringContaining("Per-turn aggregate"),
        errorKind: "resource",
      }),
      "Turn result budget exceeded",
    );
  });

  it("accumulates summary across multiple LLM calls", () => {
    const { wrapper, getTurnBudgetSummary } = createTurnResultBudgetWrapper(5_000, 500, logger);
    const wrappedFn = wrapper(base);

    // First LLM call: over budget
    const assistantMsg1 = makeAssistantMessage([{ type: "text", text: "turn 1" }]);
    const tool1 = makeToolResultMessage("bash", "x".repeat(10_000), "tc-1");
    const context1 = makeContext([assistantMsg1, tool1]);
    wrappedFn({} as any, context1);

    // Second LLM call: also over budget
    const assistantMsg2 = makeAssistantMessage([{ type: "text", text: "turn 2" }]);
    const tool2 = makeToolResultMessage("read", "y".repeat(8_000), "tc-2");
    const context2 = makeContext([assistantMsg2, tool2]);
    wrappedFn({} as any, context2);

    const summary = getTurnBudgetSummary();
    expect(summary.turnsExceeded).toBe(2);
    expect(summary.totalBudgetTruncatedChars).toBeGreaterThan(0);
  });

  it("returns zero summary when no budget exceeded", () => {
    const { wrapper, getTurnBudgetSummary } = createTurnResultBudgetWrapper(200_000, 500, logger);
    const wrappedFn = wrapper(base);

    const assistantMsg = makeAssistantMessage([{ type: "text", text: "ok" }]);
    const tool1 = makeToolResultMessage("bash", "short", "tc-1");
    const context = makeContext([assistantMsg, tool1]);
    wrappedFn({} as any, context);

    const summary = getTurnBudgetSummary();
    expect(summary.turnsExceeded).toBe(0);
    expect(summary.totalBudgetTruncatedChars).toBe(0);
  });

  it("invokes onTruncation callback for truncated tools", () => {
    const onTruncation = vi.fn();
    const { wrapper } = createTurnResultBudgetWrapper(5_000, 500, logger, onTruncation);
    const wrappedFn = wrapper(base);

    const assistantMsg = makeAssistantMessage([{ type: "text", text: "ok" }]);
    const tool1 = makeToolResultMessage("bash", "a".repeat(10_000), "tc-1");
    const context = makeContext([assistantMsg, tool1]);
    wrappedFn({} as any, context);

    expect(onTruncation).toHaveBeenCalledWith("tc-1", expect.objectContaining({
      fullChars: 10_000,
      returnedChars: expect.any(Number),
    }));
  });
});

